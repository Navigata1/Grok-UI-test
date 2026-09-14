/**
 * Claude-powered engines. Each engine wraps one deterministic engine with a
 * model that can reason about a specific channel, and returns structured
 * output validated against a Zod schema.
 *
 * The playbook markdown under channel-booster/playbook and docs is loaded as
 * the system prompt so the model works from the strategist's rules, not
 * from generic advice. Nothing here runs in tests.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { readVideoRows } from '../csv.js'
import { computeOutliers, formatLift } from '../outliers.js'
import { scoreIdea } from '../ideas.js'
import { scoreTitle } from '../titles.js'
import { qaThumbnail } from '../thumbnails.js'
import { diagnose } from '../postmortem.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')

export const DEFAULT_MODEL = 'claude-opus-5'

type Flags = Record<string, string | boolean>

function flag(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function numFlag(flags: Flags, key: string): number | undefined {
  const v = flag(flags, key)
  if (v === undefined) return undefined
  const n = Number.parseFloat(v)
  return Number.isNaN(n) ? undefined : n
}

/** Concatenate the playbook and strategist docs into one stable system block (cached across calls). */
export function loadPlaybook(maxChars = 120_000): string {
  const files: string[] = []
  const docs = path.join(ROOT, 'docs')
  const playbook = path.join(ROOT, 'playbook')
  for (const dir of [docs, playbook]) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue
      if (name.startsWith('01-video-analysis')) continue // evidence notes, not rules
      files.push(path.join(dir, name))
    }
  }
  let text = ''
  for (const file of files) {
    const chunk = `\n\n<!-- ${path.relative(ROOT, file)} -->\n${readFileSync(file, 'utf8')}`
    if (text.length + chunk.length > maxChars) break
    text += chunk
  }
  return text.trim()
}

const SYSTEM_PREAMBLE = `You are the strategist inside the YouTube Channel Booster. You reason the way a packaging-first YouTube strategist does: an idea is only real once it has a title, a thumbnail, and a demand signal; the video is judged per upload, so a first upload can win; the biggest mistake is producing before packaging. Work from the playbook below. Be specific to the channel described in the request, never generic. Return only the structured object requested.`

function client(): Anthropic {
  return new Anthropic()
}

async function parse<T extends z.ZodType>(schema: T, user: string, flags: Flags): Promise<z.infer<T>> {
  const model = flag(flags, 'model') ?? process.env.BOOSTER_MODEL ?? DEFAULT_MODEL
  const effort = (flag(flags, 'effort') ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  const response = await client().messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [
      { type: 'text', text: SYSTEM_PREAMBLE },
      { type: 'text', text: loadPlaybook(), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: user }],
    output_config: { format: zodOutputFormat(schema), effort },
  })
  if (response.stop_reason === 'refusal') {
    throw new Error(`the model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`)
  }
  if (!response.parsed_output) throw new Error('the model returned no parsable output; retry with --effort high')
  return response.parsed_output
}

const IdeaBatch = z.object({
  channel_read: z.string().describe('two sentences on who this channel serves and what they click'),
  ideas: z.array(z.object({
    idea: z.string(),
    working_title: z.string(),
    thumbnail_concept: z.string().describe('one focal subject, at most three elements, three words of text or fewer'),
    demand_evidence: z.string().describe('which outlier or audience signal proves demand'),
    angle: z.string().describe('what makes it different from the outlier it borrows from'),
    scores: z.object({ demand: z.number(), packaging: z.number(), fit: z.number(), angle: z.number(), payoff: z.number(), feasibility: z.number() }),
  })).min(8).max(12),
})

const TitleBatch = z.object({
  titles: z.array(z.object({ title: z.string(), lever: z.string(), why: z.string() })).min(12).max(20),
  top_three: z.array(z.string()).length(3),
  thumbnail_pairing_note: z.string().describe('what the thumbnail must show so it does not repeat the title'),
})

const ThumbnailBatch = z.object({
  concepts: z.array(z.object({
    name: z.string(),
    focalSubject: z.string(),
    emotion: z.string(),
    elements: z.array(z.string()).max(4),
    text: z.string(),
    background: z.string(),
    colors: z.array(z.string()).max(3),
    composition: z.string(),
    designer_brief: z.string().describe('what to shoot or build, camera and lighting notes'),
  })).min(4).max(6),
  ab_pick: z.object({ a: z.string(), b: z.string(), reason: z.string() }),
})

const PackageReview = z.object({
  verdict: z.enum(['pass', 'revise', 'fail']),
  what_the_title_tells: z.string(),
  what_the_thumbnail_shows: z.string(),
  promise_the_video_must_keep: z.string(),
  issues: z.array(z.string()),
  rewrites: z.array(z.object({ title: z.string(), thumbnail_text: z.string(), why: z.string() })).max(3),
})

const RetentionMap = z.object({
  first_30_seconds_script: z.string().describe('word for word, states the promise inside 10 seconds'),
  payoff_ladder: z.array(z.object({ at: z.string(), moment: z.string() })),
  rehooks: z.array(z.object({ at: z.string(), device: z.string(), line: z.string() })),
  cuts: z.array(z.string()).describe('sections to remove or shorten'),
  chapter_titles: z.array(z.string()),
})

const PostMortemNarrative = z.object({
  bottleneck: z.enum(['idea', 'packaging', 'hook', 'retention', 'none', 'insufficient-data']),
  story: z.string().describe('three sentences on what happened, in plain language'),
  next_48_hours: z.array(z.string()).max(4),
  playbook_rule: z.string().describe('one sentence of learning to add to the playbook'),
  sequel_idea: z.string().optional(),
})

const ChannelAudit = z.object({
  positioning: z.string(),
  proven_formats: z.array(z.string()),
  packaging_patterns_in_winners: z.array(z.string()),
  packaging_patterns_in_losers: z.array(z.string()),
  next_five_videos: z.array(z.object({ title: z.string(), thumbnail: z.string(), why: z.string() })).length(5),
  one_rule: z.string(),
})

const AI_HELP = `booster ai <engine>

  idea-engine     --niche ".." --channel ".." [--csv competitors.csv] [--count 10]
  title-lab       --idea ".."  [--channel ".."]
  thumbnail-factory --idea ".." --title ".." [--channel ".."]
  package-review  --title ".." --thumb ".." [--idea ".."]
  retention-map   --idea ".." --title ".." (--script file.txt | --outline "..")
  postmortem      --title ".." --ctr .. [--impressions ..] [--avp ..] [--retention30 ..] [--hours ..] [--baseline-ctr ..] [--baseline-avp ..]
  channel-audit   --csv my-channel.csv --channel ".."

Options: --model ${DEFAULT_MODEL} · --effort low|medium|high|xhigh|max · --json
Needs ANTHROPIC_API_KEY or an "ant auth login" profile.
`

function print(value: unknown, flags: Flags, render: () => string): void {
  process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`)
}

function requireFlag(flags: Flags, key: string): string {
  const v = flag(flags, key)
  if (!v) throw new Error(`--${key} is required. Run: booster ai help`)
  return v
}

function outlierContext(csv: string | undefined): string {
  if (!csv) return 'No competitor CSV supplied; reason from the niche alone and say so.'
  const rows = readVideoRows(readFileSync(csv, 'utf8'))
  const ranked = computeOutliers(rows, { minAgeDays: 7 })
  const lifts = formatLift(ranked)
  const top = ranked.slice(0, 25).map((r) => `- ${r.multiplier.toFixed(1)}x (${r.views} views, ${r.channel ?? 'channel'}): "${r.title}" formats=${r.formats.join('/')}`)
  return `Outlier scan of ${rows.length} videos (views ÷ channel median):\n${top.join('\n')}\nFormat lift among winners: ${lifts.slice(0, 6).map((l) => `${l.format} ${l.lift.toFixed(2)}`).join(', ')}`
}

export async function runAiCommand(engine: string | undefined, _rest: string[], flags: Flags): Promise<number> {
  if (!engine || engine === 'help') {
    process.stdout.write(AI_HELP)
    return 0
  }
  const channel = flag(flags, 'channel') ?? 'not described'
  switch (engine) {
    case 'idea-engine': {
      const niche = requireFlag(flags, 'niche')
      const count = numFlag(flags, 'count') ?? 10
      const result = await parse(IdeaBatch, `Channel: ${channel}\nNiche: ${niche}\n\n${outlierContext(flag(flags, 'csv'))}\n\nProduce ${count} ideas. Every idea must borrow a proven format from an outlier and add an angle. Score each on the six axes (0-5) honestly; at least two ideas should be yellow or red so the ranking means something.`, flags)
      const ranked = result.ideas.map((i) => ({ ...i, verdict: scoreIdea(i.scores) })).sort((a, b) => b.verdict.total - a.verdict.total)
      print({ channel_read: result.channel_read, ideas: ranked }, flags, () => [result.channel_read, '', ...ranked.map((i, n) => `${n + 1}. [${i.verdict.verdict.toUpperCase()} ${i.verdict.total}] ${i.working_title}\n   idea: ${i.idea}\n   thumb: ${i.thumbnail_concept}\n   demand: ${i.demand_evidence}\n   angle: ${i.angle}`)].join('\n'))
      return 0
    }
    case 'title-lab': {
      const idea = requireFlag(flags, 'idea')
      const result = await parse(TitleBatch, `Channel: ${channel}\nIdea: ${idea}\n\nWrite 12-20 titles, each pulling a different lever (curiosity gap, stakes, specificity, contrast, identity, negativity, transformation, first-person test). Keep them 30-55 characters with the promise in the first 40. Then pick the top three and say what the thumbnail must show so it does not repeat the title.`, flags)
      const scored = result.titles.map((t) => ({ ...t, heuristic: scoreTitle(t.title).score })).sort((a, b) => b.heuristic - a.heuristic)
      print({ ...result, titles: scored }, flags, () => ['Score  Lever            Title', ...scored.map((t) => `${String(t.heuristic).padStart(5)}  ${t.lever.padEnd(16).slice(0, 16)} ${t.title}  — ${t.why}`), '', `Top three: ${result.top_three.join(' | ')}`, `Thumbnail must show: ${result.thumbnail_pairing_note}`].join('\n'))
      return 0
    }
    case 'thumbnail-factory': {
      const idea = requireFlag(flags, 'idea')
      const title = requireFlag(flags, 'title')
      const result = await parse(ThumbnailBatch, `Channel: ${channel}\nIdea: ${idea}\nTitle: ${title}\n\nDesign 4-6 thumbnail concepts. Each: one focal subject, at most three elements, three words of text or fewer, text that does not repeat the title, a specific emotion if a face is present, a high-contrast colour pair, a clean background. Give the designer a shoot/build brief per concept. Pick A and B for Test & Compare: the strongest and the most different.`, flags)
      const graded = result.concepts.map((c) => ({ ...c, qa: qaThumbnail({ focalSubject: c.focalSubject, emotion: c.emotion, elements: c.elements, text: c.text, background: c.background, colors: c.colors, title }) }))
      print({ ...result, concepts: graded }, flags, () => [...graded.map((c, i) => `${i + 1}. ${c.name} · QA ${c.qa.score}/100 ${c.qa.grade.toUpperCase()}\n   focal: ${c.focalSubject} (${c.emotion})\n   elements: ${c.elements.join(', ')}\n   text: ${c.text || '(none)'} · colours: ${c.colors.join('/')} · bg: ${c.background}\n   composition: ${c.composition}\n   brief: ${c.designer_brief}${c.qa.fixes.length ? `\n   fix: ${c.qa.fixes.join(' ')}` : ''}`), '', `A/B: ${result.ab_pick.a} vs ${result.ab_pick.b} — ${result.ab_pick.reason}`].join('\n'))
      return 0
    }
    case 'package-review': {
      const title = requireFlag(flags, 'title')
      const thumb = requireFlag(flags, 'thumb')
      const result = await parse(PackageReview, `Channel: ${channel}\nIdea: ${flag(flags, 'idea') ?? '(not given)'}\nTitle: ${title}\nThumbnail (described): ${thumb}\n\nReview the pair. The title tells, the thumbnail shows, and together they make one promise the video can keep. Name the issues and give up to three rewrites.`, flags)
      print(result, flags, () => [`Verdict: ${result.verdict.toUpperCase()}`, `Title tells: ${result.what_the_title_tells}`, `Thumbnail shows: ${result.what_the_thumbnail_shows}`, `Promise to keep: ${result.promise_the_video_must_keep}`, '', ...result.issues.map((i) => `  - ${i}`), '', ...result.rewrites.map((r) => `Rewrite: "${r.title}" + thumb text "${r.thumbnail_text}" — ${r.why}`)].join('\n'))
      return 0
    }
    case 'retention-map': {
      const idea = requireFlag(flags, 'idea')
      const title = requireFlag(flags, 'title')
      const scriptPath = flag(flags, 'script')
      const outline = scriptPath ? readFileSync(scriptPath, 'utf8') : flag(flags, 'outline')
      if (!outline) throw new Error('give --script file.txt or --outline "..."')
      const result = await parse(RetentionMap, `Channel: ${channel}\nIdea: ${idea}\nTitle: ${title}\n\nScript or outline:\n${outline.slice(0, 60_000)}\n\nWrite the first 30 seconds word for word (promise inside 10 seconds, no intro), a payoff ladder, a rehook every 60-90 seconds, the cuts, and chapter titles.`, flags)
      print(result, flags, () => [`First 30 seconds:\n${result.first_30_seconds_script}`, '', 'Payoff ladder:', ...result.payoff_ladder.map((p) => `  ${p.at}  ${p.moment}`), '', 'Rehooks:', ...result.rehooks.map((r) => `  ${r.at}  [${r.device}] ${r.line}`), '', 'Cuts:', ...result.cuts.map((c) => `  - ${c}`), '', `Chapters: ${result.chapter_titles.join(' · ')}`].join('\n'))
      return 0
    }
    case 'postmortem': {
      const title = requireFlag(flags, 'title')
      const local = diagnose({ impressions: numFlag(flags, 'impressions'), ctr: numFlag(flags, 'ctr'), avpPct: numFlag(flags, 'avp'), retention30sPct: numFlag(flags, 'retention30'), hoursSincePublish: numFlag(flags, 'hours'), baseline: { ctr: numFlag(flags, 'baseline-ctr'), avpPct: numFlag(flags, 'baseline-avp'), views: numFlag(flags, 'baseline-views') } })
      const result = await parse(PostMortemNarrative, `Channel: ${channel}\nVideo: ${title}\n\nDeterministic diagnosis: ${JSON.stringify(local)}\n\nExplain what happened in plain language, give the next 48 hours of actions, one playbook rule, and a sequel idea if the video is healthy. Do not contradict the deterministic bottleneck unless the evidence is clearly wrong; if you do, say why.`, flags)
      print({ deterministic: local, ...result }, flags, () => [`Bottleneck: ${result.bottleneck.toUpperCase()}`, result.story, '', 'Next 48 hours:', ...result.next_48_hours.map((a) => `  - ${a}`), '', `Playbook rule: ${result.playbook_rule}`, ...(result.sequel_idea ? [`Sequel: ${result.sequel_idea}`] : [])].join('\n'))
      return 0
    }
    case 'channel-audit': {
      const csv = requireFlag(flags, 'csv')
      const result = await parse(ChannelAudit, `Channel: ${channel}\n\n${outlierContext(csv)}\n\nAudit this channel: positioning, proven formats, what the winners' packaging has in common, what the losers' packaging has in common, the next five videos (title + thumbnail), and one rule for the playbook.`, flags)
      print(result, flags, () => [`Positioning: ${result.positioning}`, `Proven formats: ${result.proven_formats.join(', ')}`, '', 'Winners share:', ...result.packaging_patterns_in_winners.map((p) => `  + ${p}`), 'Losers share:', ...result.packaging_patterns_in_losers.map((p) => `  - ${p}`), '', 'Next five:', ...result.next_five_videos.map((v, i) => `  ${i + 1}. ${v.title} · thumb: ${v.thumbnail} · ${v.why}`), '', `Rule: ${result.one_rule}`].join('\n'))
      return 0
    }
    default:
      throw new Error(`unknown ai engine "${engine}".\n${AI_HELP}`)
  }
}
