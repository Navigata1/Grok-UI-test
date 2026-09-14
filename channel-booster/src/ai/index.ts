/**
 * Claude-powered engines. Each engine wraps one deterministic engine with a
 * model that can reason about a specific channel and returns structured
 * output validated against the engine's Zod schema (`./schemas.ts`).
 *
 * The prompt is assembled by `./prompt.ts` (pure, tested); this file is the
 * only place that talks to the network. The doctrine under `docs/02` and
 * `playbook/` is the cached system block, and `channel.json` supplies the
 * channel line when `--channel` is absent. `--dry-run` prints exactly what
 * would be sent and stops. Nothing here runs in tests.
 */
import { writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { scoreIdea } from '../ideas.js'
import type { GenerateHooks } from '../package.js'
import { describeProfile, diagnoseBaseline, loadProfile, profileExists } from '../profile.js'
import { scoreTitle } from '../titles.js'
import { qaThumbnail } from '../thumbnails.js'
import { assemblePrompt, DEFAULT_EFFORT, formatDryRun, loadPlaybook, parseEffort, ROOT, type AssembledPrompt, type Flags, type PromptContext } from './prompt.js'
import {
  ENGINES, ENGINE_NAMES, isEngineName,
  type ChannelAudit, type EngineName, type EngineOutput, type IdeaBatch, type PackageReview, type PostMortemNarrative, type RetentionMap, type ThumbnailBatch, type TitleBatch,
} from './schemas.js'

export { assemblePrompt, formatDryRun, loadPlaybook, parseEffort, ROOT } from './prompt.js'
export { ENGINES, ENGINE_NAMES, isEngineName } from './schemas.js'
export type { EngineName, EngineOutput } from './schemas.js'
export type { AssembledPrompt, Flags, PromptContext } from './prompt.js'

export const DEFAULT_MODEL = 'claude-opus-5'

/** Output budget per call; the largest engine (a 12-idea batch with scores) fits in a quarter of it. */
export const MAX_TOKENS = 16_000

function flag(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

/** The model for a run: `--model`, then `BOOSTER_MODEL`, then the default. */
export function modelFrom(flags: Flags): string {
  return flag(flags, 'model') ?? process.env.BOOSTER_MODEL ?? DEFAULT_MODEL
}

/**
 * The channel line and the diagnosis baseline from channel.json (`--path`
 * honoured), when the file exists and parses. `--channel` still wins inside
 * `assemblePrompt()`; a broken profile is ignored here because the CLI
 * already warned about it at startup.
 */
export function profileContext(flags: Flags): Pick<PromptContext, 'profileText' | 'baseline'> {
  const file = flag(flags, 'path')
  if (!profileExists(file)) return {}
  try {
    const profile = loadProfile(file)
    return { profileText: describeProfile(profile), baseline: diagnoseBaseline(profile) }
  } catch {
    return {}
  }
}

/** Assemble the prompt for an engine with the doctrine and the profile loaded from disk. */
export function preparePrompt(engine: string, flags: Flags, context: PromptContext = {}): AssembledPrompt {
  const playbook = loadPlaybook(ROOT)
  return assemblePrompt(engine, flags, { playbookText: playbook.text, playbookFiles: playbook.files, ...profileContext(flags), ...context })
}

function client(): Anthropic {
  return new Anthropic()
}

/**
 * One structured call: the assembled system blocks (the doctrine block
 * cached), the engine's schema as the output format, adaptive thinking and
 * the requested effort. A refusal or an empty parse is an error, never a
 * silent fallback.
 */
export async function runEngine<E extends EngineName>(engine: E, flags: Flags, context: PromptContext = {}): Promise<EngineOutput<E>> {
  const assembled = preparePrompt(engine, flags, context)
  const system = assembled.system
    .filter((b) => b.text.trim().length > 0)
    .map((b) => (b.cache ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const } } : { type: 'text' as const, text: b.text }))
  const response = await client().messages.parse({
    model: modelFrom(flags),
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: assembled.user }],
    output_config: { format: zodOutputFormat(ENGINES[engine]), effort: parseEffort(flags) },
  })
  if (response.stop_reason === 'refusal') {
    throw new Error(`the model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`)
  }
  if (!response.parsed_output) throw new Error('the model returned no parsable output; retry with --effort high')
  return response.parsed_output as EngineOutput<E>
}

/**
 * The hooks `buildPackage()` calls when the model is on: title-lab and
 * thumbnail-factory on round 1, then title-lab with the gate fixes appended
 * and package-fix with the fixes plus the previous concepts on later rounds.
 * The chosen title of the round reaches the concepts hook through
 * `FixContext.title`, so the concepts are designed against the title the
 * gates score.
 */
export function packageHooks(flags: Flags, input: { idea: string; promise: string }): GenerateHooks {
  const base: Flags = { ...flags, idea: input.idea }
  return {
    titles: async ({ round, fixes }) => {
      const idea = round === 1 || fixes.length === 0
        ? `${input.idea}\nPromise the video keeps: ${input.promise}`
        : `${input.idea}\nPromise the video keeps: ${input.promise}\n\nThe last round failed these gates; fix every one:\n${fixes.map((f) => `- ${f}`).join('\n')}`
      const result = await runEngine('title-lab', { ...base, idea })
      return result.titles.map((t) => ({ title: t.title, lever: t.lever, notes: [t.why] }))
    },
    concepts: async ({ round, fixes, previous, title }) => {
      const withTitle: Flags = { ...base, title: title?.trim() || input.idea }
      const result = round === 1 || !previous
        ? await runEngine('thumbnail-factory', withTitle)
        : await runEngine('package-fix', withTitle, { fixes, previous })
      return result.concepts.map((c) => ({
        name: c.name,
        angle: c.lever,
        focalSubject: c.focalSubject,
        emotion: c.emotion,
        elements: c.elements,
        text: c.text,
        background: c.background,
        colors: c.colors,
        composition: c.composition,
        designerBrief: c.designer_brief,
      }))
    },
  }
}

export const AI_HELP = `booster ai <engine> [--dry-run] [--out result.json] [--json]

  idea-engine       --niche ".." [--channel ".."] [--csv competitors.csv] [--count 10]
  title-lab         --idea ".."  [--channel ".."]
  thumbnail-factory --idea ".." --title ".." [--channel ".."]
  package-fix       --idea ".." --title ".." (--fixes "a; b" | --fixes-file fixes.txt) [--previous round.json | --previous-json '{..}']
  package-review    --title ".." --thumb ".." [--idea ".."]
  retention-map     --idea ".." --title ".." (--script file.txt | --outline "..")
  postmortem        --title ".." --ctr .. [--impressions ..] [--avp ..] [--retention30 ..] [--hours ..] [--baseline-ctr ..] [--baseline-avp ..] [--baseline-views ..]
  channel-audit     --csv my-channel.csv [--channel ".."]

Options: --model ${DEFAULT_MODEL} · --effort low|medium|high|xhigh|max (default ${DEFAULT_EFFORT}) · --dry-run prints the prompt and stops · --out writes the JSON result
--channel ".." describes the channel; without it the description comes from channel.json (--path). Engines: ${ENGINE_NAMES.join(', ')}.
Needs ANTHROPIC_API_KEY or an "ant auth login" profile.
`

function print(value: unknown, flags: Flags, render: () => string): void {
  process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`)
}

/** Run the deterministic scorer over the model's output and render both: the JSON the CLI prints with --json and the text without it. */
export function renderResult(engine: EngineName, result: unknown, flags: Flags): { json: unknown; text: string } {
  switch (engine) {
    case 'idea-engine': {
      const r = result as IdeaBatch
      const ranked = r.ideas.map((i) => ({ ...i, verdict: scoreIdea(i.scores) })).sort((a, b) => b.verdict.total - a.verdict.total)
      const json = { channel_read: r.channel_read, ideas: ranked }
      return { json, text: [r.channel_read, '', ...ranked.map((i, n) => `${n + 1}. [${i.verdict.verdict.toUpperCase()} ${i.verdict.total}] ${i.working_title}\n   idea: ${i.idea}\n   thumb: ${i.thumbnail_concept}\n   demand: ${i.demand_evidence}\n   angle: ${i.angle}`), '', 'Bank the greens: booster bank import <file> after --out file.json'].join('\n') }
    }
    case 'title-lab': {
      const r = result as TitleBatch
      const scored = r.titles.map((t) => ({ ...t, heuristic: scoreTitle(t.title).score })).sort((a, b) => b.heuristic - a.heuristic)
      return { json: { ...r, titles: scored }, text: ['Score  Lever            Title', ...scored.map((t) => `${String(t.heuristic).padStart(5)}  ${t.lever.padEnd(16).slice(0, 16)} ${t.title}  — ${t.why}`), '', `Top three: ${r.top_three.join(' | ')}`, `Thumbnail must show: ${r.thumbnail_pairing_note}`].join('\n') }
    }
    case 'thumbnail-factory':
    case 'package-fix': {
      const r = result as ThumbnailBatch
      const title = flag(flags, 'title')
      const graded = r.concepts.map((c) => ({ ...c, qa: qaThumbnail({ focalSubject: c.focalSubject, emotion: c.emotion, elements: c.elements, text: c.text, background: c.background, colors: c.colors, title }) }))
      return { json: { ...r, concepts: graded }, text: [...graded.map((c, i) => `${i + 1}. ${c.name} (${c.lever}) · QA ${c.qa.score}/100 ${c.qa.grade.toUpperCase()}\n   focal: ${c.focalSubject} (${c.emotion})\n   elements: ${c.elements.join(', ')}\n   text: ${c.text || '(none)'} · colours: ${c.colors.join('/')} · bg: ${c.background}\n   composition: ${c.composition}\n   brief: ${c.designer_brief}${c.qa.fixes.length ? `\n   fix: ${c.qa.fixes.join(' ')}` : ''}`), '', `A/B: ${r.ab_pick.a} vs ${r.ab_pick.b} — ${r.ab_pick.reason}`].join('\n') }
    }
    case 'package-review': {
      const r = result as PackageReview
      return { json: r, text: [`Verdict: ${r.verdict.toUpperCase()}`, `Title tells: ${r.what_the_title_tells}`, `Thumbnail shows: ${r.what_the_thumbnail_shows}`, `Promise to keep: ${r.promise_the_video_must_keep}`, '', ...r.issues.map((i) => `  - ${i}`), '', ...r.rewrites.map((w) => `Rewrite: "${w.title}" + thumb text "${w.thumbnail_text}" — ${w.why}`)].join('\n') }
    }
    case 'retention-map': {
      const r = result as RetentionMap
      return { json: r, text: [`First 30 seconds:\n${r.first_30_seconds_script}`, '', 'Payoff ladder:', ...r.payoff_ladder.map((p) => `  ${p.at}  ${p.moment}`), '', 'Rehooks:', ...r.rehooks.map((h) => `  ${h.at}  [${h.device}] ${h.line}`), '', 'Cuts:', ...r.cuts.map((c) => `  - ${c}`), '', `Chapters: ${r.chapter_titles.join(' · ')}`].join('\n') }
    }
    case 'postmortem': {
      const r = result as PostMortemNarrative
      return { json: r, text: [`Bottleneck: ${r.bottleneck.toUpperCase()}`, r.story, '', 'Next 48 hours:', ...r.next_48_hours.map((a) => `  - ${a}`), '', `Playbook rule: ${r.playbook_rule}`, ...(r.sequel_idea ? [`Sequel: ${r.sequel_idea}`] : []), '', 'Accept the rule only after the 7-day read: booster retro --accept-rule ".." --into playbook/<file>.md'].join('\n') }
    }
    case 'channel-audit': {
      const r = result as ChannelAudit
      return { json: r, text: [`Positioning: ${r.positioning}`, `Proven formats: ${r.proven_formats.join(', ')}`, '', 'Winners share:', ...r.packaging_patterns_in_winners.map((p) => `  + ${p}`), 'Losers share:', ...r.packaging_patterns_in_losers.map((p) => `  - ${p}`), '', 'Next five:', ...r.next_five_videos.map((v, i) => `  ${i + 1}. ${v.title} · thumb: ${v.thumbnail} · ${v.why}`), '', `Rule: ${r.one_rule}`].join('\n') }
    }
  }
}

export async function runAiCommand(engine: string | undefined, _rest: string[], flags: Flags): Promise<number> {
  if (!engine || engine === 'help' || flags.help === true) {
    process.stdout.write(AI_HELP)
    return 0
  }
  if (!isEngineName(engine)) throw new Error(`unknown ai engine "${engine}".\n${AI_HELP}`)
  if (flags['dry-run'] === true) {
    const assembled = preparePrompt(engine, flags)
    process.stdout.write(`${formatDryRun(assembled)}\n`)
    return 0
  }
  const result = await runEngine(engine, flags)
  const rendered = renderResult(engine, result, flags)
  const outFile = flag(flags, 'out')
  if (outFile) writeFileSync(outFile, `${JSON.stringify(rendered.json, null, 2)}\n`)
  print(rendered.json, flags, () => (outFile ? `${rendered.text}\nWrote ${outFile}` : rendered.text))
  return 0
}
