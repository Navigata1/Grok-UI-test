/**
 * Prompt assembly for the Claude engines: the doctrine loader and the pure
 * `assemblePrompt()` that turns an engine name plus CLI flags into the
 * system blocks and the user message `index.ts` sends to the model.
 *
 * Nothing here touches the network. File reads (the playbook, `--csv`,
 * `--script`, `--previous`, the fix-round template) go through an
 * injectable loader so tests pass strings and `--dry-run` shows exactly
 * what a real run would send.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVideoRows } from '../csv.js'
import { computeOutliers, formatLift } from '../outliers.js'
import { diagnose } from '../postmortem.js'
import type { PostMortemInput } from '../types.js'
import { ENGINES, ENGINE_NAMES, isEngineName, type EngineName } from './schemas.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The module root (`channel-booster/`), where `docs/` and `playbook/` live. */
export const ROOT = path.resolve(here, '..', '..')

/** CLI flags as `cli/shared.ts` parses them: `--key value` is a string, a bare `--key` is `true`. */
export type Flags = Record<string, string | boolean>

/** The five effort levels the API accepts in `output_config.effort`. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

/** Default effort when `--effort` is absent. */
export const DEFAULT_EFFORT: Effort = 'high'

/** Upper bound on the concatenated doctrine, so the cached system block stays well inside the context window (house default). */
export const PLAYBOOK_MAX_CHARS = 120_000

/** The doctrine file: the R-table with evidence tags; loaded first, always. */
export const DOCTRINE_FILE = path.posix.join('docs', '02-strategist-playbook.md')

/** The compiled rules file; loaded second when present, ahead of the hand-written playbook. Its rules are observations under test, not doctrine (see SYSTEM_PREAMBLE). */
export const LEARNED_RULES_FILE = path.posix.join('playbook', '00-learned-rules.md')

/** The fix-round template `ai package-fix` fills with `{{fixes}}` and `{{previous}}`. */
export const PACKAGE_FIX_TEMPLATE_PATH = path.join(ROOT, 'prompts', 'package-fix.md')

/** Hard cap on how much of a `--script` file goes to the model (house default). */
export const SCRIPT_MAX_CHARS = 60_000

/** How many ranked outliers and format lifts the idea and audit engines see (house default). */
export const OUTLIER_CONTEXT_ROWS = 25
const OUTLIER_CONTEXT_LIFTS = 6

/**
 * The stable first system block. It names the standing of the compiled
 * learned rules (observations under test from the channel's own small sample,
 * never doctrine and never an override of it; a rule a person accepted is
 * playbook), the evidence discipline (an [unverified] mechanic is never
 * stated as fact) and the threshold rule (cite the tag with the number).
 */
export const SYSTEM_PREAMBLE = [
  'You are the strategist inside the YouTube Channel Booster. You reason the way a packaging-first YouTube strategist does: an idea is only real once it has a title, a thumbnail, and a demand signal; the video is judged per upload, so a first upload can win; the biggest mistake is producing before packaging.',
  'Work from the playbook below. Be specific to the channel described in the request, never generic.',
  'The compiled learned rules (playbook/00-learned-rules.md, each with its tests, wins, win rate and confidence) are observations under test from this channel\'s own small sample, not doctrine. They never override the doctrine: where one disagrees with it, follow the doctrine. Mention a learned rule only as a hypothesis worth testing, with its evidence count. Rules a person accepted (marked [accepted by ...] or [pinned], or listed under "## Learned rules" in a playbook file) are part of the playbook.',
  'Every rule and figure in the doctrine carries an evidence tag: [sourced], [unverified] or [house]. Never state an [unverified] platform mechanic as fact; say it is unverified or reason without it.',
  'When you cite a threshold (a CTR band, a retention mark, a multiplier, a character count), name its tag next to the number, for example "60% [unverified]" or "10x [house]".',
  'Return only the structured object requested.',
].join(' ')

/** The file reads `loadPlaybook()` makes, so tests inject strings. */
export interface PlaybookFs {
  exists(file: string): boolean
  readdir(dir: string): string[]
  readFile(file: string): string
}

const nodeFs: PlaybookFs = {
  exists: (file) => existsSync(file),
  readdir: (dir) => readdirSync(dir),
  readFile: (file) => readFileSync(file, 'utf8'),
}

/** What `loadPlaybook()` returns: the concatenated text and the files it came from, in load order, relative to the root. */
export interface LoadedPlaybook {
  text: string
  files: string[]
}

export interface LoadPlaybookOptions {
  /** Stop adding files once the text would exceed this many characters. */
  maxChars?: number
  /** File access; defaults to node:fs. */
  fs?: PlaybookFs
}

/**
 * Load the doctrine in a fixed order: `docs/02-strategist-playbook.md`, then
 * `playbook/00-learned-rules.md` when it exists, then the other `playbook/*.md`
 * files alphabetically. Never `docs/01-*`, `docs/03-*` or `research/*`: those
 * are evidence notes and design, not rules. Each file is wrapped in an HTML
 * comment naming it so the model can cite where a rule came from. Files that
 * would push the text past `maxChars` are left out, and `files` lists only
 * what was loaded.
 */
export function loadPlaybook(rootDir: string = ROOT, options: LoadPlaybookOptions = {}): LoadedPlaybook {
  const fs = options.fs ?? nodeFs
  const maxChars = options.maxChars ?? PLAYBOOK_MAX_CHARS
  const wanted: string[] = []
  const doctrine = path.join(rootDir, DOCTRINE_FILE)
  if (fs.exists(doctrine)) wanted.push(DOCTRINE_FILE)
  const learned = path.join(rootDir, LEARNED_RULES_FILE)
  if (fs.exists(learned)) wanted.push(LEARNED_RULES_FILE)
  const playbookDir = path.join(rootDir, 'playbook')
  if (fs.exists(playbookDir)) {
    for (const name of [...fs.readdir(playbookDir)].sort()) {
      if (!name.endsWith('.md')) continue
      const rel = path.posix.join('playbook', name)
      if (rel === LEARNED_RULES_FILE) continue
      wanted.push(rel)
    }
  }
  const chunks: string[] = []
  const files: string[] = []
  let length = 0
  for (const rel of wanted) {
    const body = fs.readFile(path.join(rootDir, rel)).trim()
    const chunk = `<!-- ${rel} -->\n${body}`
    const cost = chunk.length + (chunks.length ? 2 : 0)
    if (length + cost > maxChars) break
    chunks.push(chunk)
    files.push(rel)
    length += cost
  }
  return { text: chunks.join('\n\n'), files }
}

/** Validate `--effort` against the five levels; absent means `high`. */
export function parseEffort(flags: Flags): Effort {
  const raw = flags.effort
  if (raw === undefined) return DEFAULT_EFFORT
  if (typeof raw === 'string' && (EFFORT_LEVELS as readonly string[]).includes(raw)) return raw as Effort
  throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(', ')}; got "${String(raw)}"`)
}

/** Everything `assemblePrompt()` may need beyond the flags. */
export interface PromptContext {
  /** The doctrine text; the second (cached) system block. Empty when omitted. */
  playbookText?: string
  /** The files the doctrine came from, echoed in the result for the provenance line. */
  playbookFiles?: string[]
  /** `describeProfile(channel.json)`; used as the channel line when `--channel` is absent. */
  profileText?: string
  /** `package-fix`: the gate fixes, when called from code rather than the CLI. */
  fixes?: string[]
  /** `package-fix`: the previous round's output, when called from code. */
  previous?: unknown
  /** `postmortem`: the computed baseline from the profile; `--baseline-*` flags override it. */
  baseline?: PostMortemInput['baseline']
  /** Reads `--csv`, `--script`, `--fixes-file`, `--previous` and the fix template; defaults to node:fs. */
  readFile?: (file: string) => string
}

/** One system block; `cache` marks the block that carries `cache_control: ephemeral`. */
export interface SystemBlock {
  text: string
  cache: boolean
}

/** The output of `assemblePrompt()`: what a real run sends, minus the schema. */
export interface AssembledPrompt {
  engine: EngineName
  system: SystemBlock[]
  user: string
  playbookFiles: string[]
}

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

function requireFlag(flags: Flags, key: string): string {
  const v = flag(flags, key)
  if (!v) throw new Error(`--${key} is required. Run: booster ai help`)
  return v
}

/** The outlier scan block the idea engine and the audit share; says so when no CSV was given. */
export function outlierContext(csvText: string | undefined): string {
  if (csvText === undefined) return 'No competitor CSV supplied; reason from the niche alone and say so.'
  const rows = readVideoRows(csvText)
  const ranked = computeOutliers(rows, { minAgeDays: 7 })
  const lifts = formatLift(ranked)
  const top = ranked.slice(0, OUTLIER_CONTEXT_ROWS).map((r) => `- ${r.multiplier.toFixed(1)}x (${r.views} views, ${r.channel ?? 'channel'}): "${r.title}" formats=${r.formats.join('/')}`)
  return `Outlier scan of ${rows.length} videos (views ÷ channel median):\n${top.join('\n')}\nFormat lift among winners: ${lifts.slice(0, OUTLIER_CONTEXT_LIFTS).map((l) => `${l.format} ${l.lift.toFixed(2)}`).join(', ')}`
}

/**
 * Fill the fix-round template: `{{fixes}}` becomes one line per fix,
 * `{{previous}}` the previous round as JSON (or as given when it is a string).
 */
export function renderPackageFixUser(fixes: string[], previous: unknown, template: string): string {
  const fixText = fixes.length ? fixes.map((f) => `- ${f}`).join('\n') : '- (none)'
  const prevText = typeof previous === 'string' ? previous : JSON.stringify(previous ?? null, null, 2)
  return template.replace(/\{\{fixes\}\}/g, fixText).replace(/\{\{previous\}\}/g, prevText)
}

function splitFixes(text: string): string[] {
  return text.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean)
}

function packageFixUser(flags: Flags, channel: string, ctx: PromptContext, read: (file: string) => string): string {
  let fixes = ctx.fixes
  if (fixes === undefined) {
    const inline = flag(flags, 'fixes')
    const file = flag(flags, 'fixes-file')
    if (inline !== undefined) fixes = splitFixes(inline)
    else if (file !== undefined) fixes = splitFixes(read(file))
    else throw new Error('--fixes "a; b" or --fixes-file fixes.txt is required. Run: booster ai help')
  }
  let previous: unknown = ctx.previous
  if (previous === undefined) {
    const file = flag(flags, 'previous')
    const inline = flag(flags, 'previous-json')
    const raw = file !== undefined ? read(file) : inline
    if (raw !== undefined) {
      try {
        previous = JSON.parse(raw)
      } catch {
        previous = raw
      }
    } else {
      previous = '(no previous round supplied)'
    }
  }
  const head = [`Channel: ${channel}`, `Idea: ${flag(flags, 'idea') ?? '(not given)'}`, `Title: ${flag(flags, 'title') ?? '(not given)'}`].join('\n')
  return `${head}\n\n${renderPackageFixUser(fixes, previous, read(PACKAGE_FIX_TEMPLATE_PATH))}`
}

/**
 * Build the system blocks and the user message for one engine from its flags.
 * Pure: the same flags and context always produce the same prompt, and the
 * only file reads go through `context.readFile`. Throws on an unknown engine
 * or a missing required flag, with the same messages the CLI shows.
 */
export function assemblePrompt(engine: string, flags: Flags, context: PromptContext = {}): AssembledPrompt {
  if (!isEngineName(engine)) throw new Error(`unknown ai engine "${engine}". Engines: ${ENGINE_NAMES.join(', ')}`)
  const read = context.readFile ?? nodeFs.readFile
  const channel = flag(flags, 'channel') ?? context.profileText ?? 'not described'
  let user: string
  switch (engine) {
    case 'idea-engine': {
      const niche = requireFlag(flags, 'niche')
      const count = numFlag(flags, 'count') ?? 10
      const csv = flag(flags, 'csv')
      user = `Channel: ${channel}\nNiche: ${niche}\n\n${outlierContext(csv === undefined ? undefined : read(csv))}\n\nProduce ${count} ideas. Every idea must borrow a proven format from an outlier and add an angle. Score each on the six axes (0-5) honestly; at least two ideas should be yellow or red so the ranking means something.`
      break
    }
    case 'title-lab': {
      const idea = requireFlag(flags, 'idea')
      user = `Channel: ${channel}\nIdea: ${idea}\n\nWrite 12-20 titles, each pulling a different lever (curiosity gap, stakes, specificity, contrast, identity, negativity, transformation, first-person test). Keep them 30-55 characters with the promise in the first 40. Then pick the top three and say what the thumbnail must show so it does not repeat the title.`
      break
    }
    case 'thumbnail-factory': {
      const idea = requireFlag(flags, 'idea')
      const title = requireFlag(flags, 'title')
      user = `Channel: ${channel}\nIdea: ${idea}\nTitle: ${title}\n\nDesign 4-6 thumbnail concepts. Each: one focal subject, at most three elements, three words of text or fewer, text that does not repeat the title, a specific emotion if a face is present, a high-contrast colour pair, a clean background. Give the designer a shoot/build brief per concept. Pick A and B for Test & Compare: the strongest and the most different.`
      break
    }
    case 'package-fix': {
      user = packageFixUser(flags, channel, context, read)
      break
    }
    case 'package-review': {
      const title = requireFlag(flags, 'title')
      const thumb = requireFlag(flags, 'thumb')
      user = `Channel: ${channel}\nIdea: ${flag(flags, 'idea') ?? '(not given)'}\nTitle: ${title}\nThumbnail (described): ${thumb}\n\nReview the pair. The title tells, the thumbnail shows, and together they make one promise the video can keep. Name the issues and give up to three rewrites.`
      break
    }
    case 'retention-map': {
      const idea = requireFlag(flags, 'idea')
      const title = requireFlag(flags, 'title')
      const scriptPath = flag(flags, 'script')
      const outline = scriptPath ? read(scriptPath) : flag(flags, 'outline')
      if (!outline) throw new Error('give --script file.txt or --outline "..."')
      user = `Channel: ${channel}\nIdea: ${idea}\nTitle: ${title}\n\nScript or outline:\n${outline.slice(0, SCRIPT_MAX_CHARS)}\n\nWrite the first 30 seconds word for word (promise inside 10 seconds, no intro), a payoff ladder, a rehook every 60-90 seconds, the cuts, and chapter titles.`
      break
    }
    case 'postmortem': {
      const title = requireFlag(flags, 'title')
      const typed = { ctr: numFlag(flags, 'baseline-ctr'), avpPct: numFlag(flags, 'baseline-avp'), views: numFlag(flags, 'baseline-views') }
      const hasTyped = typed.ctr !== undefined || typed.avpPct !== undefined || typed.views !== undefined
      const local = diagnose({
        impressions: numFlag(flags, 'impressions'),
        ctr: numFlag(flags, 'ctr'),
        avpPct: numFlag(flags, 'avp'),
        retention30sPct: numFlag(flags, 'retention30'),
        hoursSincePublish: numFlag(flags, 'hours'),
        baseline: hasTyped ? typed : context.baseline,
      })
      user = `Channel: ${channel}\nVideo: ${title}\n\nDeterministic diagnosis: ${JSON.stringify(local)}\n\nExplain what happened in plain language, give the next 48 hours of actions, one playbook rule, and a sequel idea if the video is healthy. Do not contradict the deterministic bottleneck unless the evidence is clearly wrong; if you do, say why.`
      break
    }
    case 'channel-audit': {
      const csv = requireFlag(flags, 'csv')
      user = `Channel: ${channel}\n\n${outlierContext(read(csv))}\n\nAudit this channel: positioning, proven formats, what the winners' packaging has in common, what the losers' packaging has in common, the next five videos (title + thumbnail), and one rule for the playbook.`
      break
    }
  }
  const playbookText = context.playbookText ?? ''
  return {
    engine,
    system: [
      { text: SYSTEM_PREAMBLE, cache: false },
      { text: playbookText, cache: true },
    ],
    user,
    playbookFiles: [...(context.playbookFiles ?? [])],
  }
}

/** The `--dry-run` view: every system block, the user message and the playbook files, in the order sent. */
export function formatDryRun(assembled: AssembledPrompt): string {
  const lines: string[] = [`engine: ${assembled.engine}`, `schema: ${assembled.engine} -> ${Object.keys(ENGINES[assembled.engine].shape).join(', ')}`, `playbook files (${assembled.playbookFiles.length}): ${assembled.playbookFiles.join(', ') || '(none)'}`]
  assembled.system.forEach((block, i) => {
    lines.push('', `--- system[${i}]${block.cache ? ' (cached)' : ''} ---`, block.text)
  })
  lines.push('', '--- user ---', assembled.user)
  return lines.join('\n')
}
