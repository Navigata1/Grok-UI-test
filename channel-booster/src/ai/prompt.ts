/**
 * Prompt assembly for the Claude engines: the doctrine loader and the pure
 * `assemblePrompt()` that turns an engine name plus CLI flags into the
 * system blocks and the user message `index.ts` sends to the model.
 *
 * The doctrine is the one this build ships (`shippedDoctrine()`: embedded in
 * the packaged bin, read from the checkout from source), never whatever sits
 * next to the code on disk. On top of it the loader lays the channel
 * playbook folder: the channel's compiled learned rules and the rules a
 * person accepted into its playbook.
 *
 * Nothing here touches the network. File reads (the channel playbook folder,
 * `--csv`, `--script`, `--previous`) go through injectable loaders so tests
 * pass strings and `--dry-run` shows exactly what a real run would send.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cliName } from '../build-info.js'
import { readVideoRows } from '../csv.js'
import { computeOutliers, formatLift } from '../outliers.js'
import { diagnose } from '../postmortem.js'
import { isShippedPlaybookDir } from '../rules.js'
import type { PostMortemInput } from '../types.js'
import { CODE_ROOT } from '../workspace.js'
import { DOCTRINE_FILE, doctrineVersion, LEARNED_RULES_NAME, shippedDoctrine, type DoctrineFile, type ShippedDoctrine } from './doctrine.js'
import { ENGINES, ENGINE_NAMES, isEngineName, type EngineName } from './schemas.js'

export { DOCTRINE_FILE }

/** The module root (`channel-booster/` in a source checkout). The doctrine comes from `shippedDoctrine()`, never from a read under this folder. */
export const ROOT = CODE_ROOT

/** CLI flags as `cli/shared.ts` parses them: `--key value` is a string, a bare `--key` is `true`. */
export type Flags = Record<string, string | boolean>

/** The five effort levels the API accepts in `output_config.effort`. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

/** Default effort when `--effort` is absent. */
export const DEFAULT_EFFORT: Effort = 'high'

/** Upper bound on the concatenated doctrine, so the cached system block stays well inside the context window (house default). */
export const PLAYBOOK_MAX_CHARS = 120_000

/** The compiled rules file as the legacy layout names it; loaded second when present, ahead of the rest of the playbook. Its rules are observations under test, not doctrine (see SYSTEM_PREAMBLE). */
export const LEARNED_RULES_FILE = path.posix.join('playbook', LEARNED_RULES_NAME)

/**
 * How the prompt names a file from a channel playbook folder that is not the
 * shipped one (`channel playbook/00-learned-rules.md`), so the model never
 * mistakes a channel's file for the shipped playbook file of the same name.
 */
export const OVERLAY_LABEL = 'channel playbook'

/** The doctrine hash a run reports when `--no-doctrine` left the shipped doctrine out. */
export const NO_DOCTRINE_HASH = 'none'

/** What the cached block says in place of the doctrine under `--no-doctrine`. */
export const NO_DOCTRINE_NOTE = 'This run has no doctrine (--no-doctrine): the evidence-tagged rules of docs/02-strategist-playbook.md and playbook/*.md were not loaded. Say so wherever one of those rules would normally decide, and never invent an evidence tag.'

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
  'The compiled learned rules (00-learned-rules.md, each with its tests, wins, win rate and confidence) are observations under test from this channel\'s own small sample, not doctrine. They never override the doctrine: where one disagrees with it, follow the doctrine. Mention a learned rule only as a hypothesis worth testing, with its evidence count. Rules a person accepted (marked [accepted by ...] or [pinned], or listed under "## Learned rules" in a playbook file) are part of the playbook. A file named "channel playbook/<file>" comes from this channel\'s own playbook folder: its compiled 00-learned-rules.md follows docs/02, and its other files follow the shipped playbook.',
  'Every rule and figure in the doctrine carries an evidence tag: [sourced], [unverified] or [house]. Never state an [unverified] platform mechanic as fact; say it is unverified or reason without it.',
  'When you cite a threshold (a CTR band, a retention mark, a multiplier, a character count), name its tag next to the number, for example "60% [unverified]" or "10x [house]".',
  'Return only the structured object requested.',
].join(' ')

/** The file reads `loadPlaybook()` makes in the channel playbook folder, so tests inject strings. */
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

/** The shipped doctrine a prompt carries: its hash and file names, in load order. */
export interface DoctrineSummary {
  hash: string
  files: string[]
}

/** What `loadPlaybook()` returns: the concatenated text, every file in load order, and where each came from. */
export interface LoadedPlaybook {
  text: string
  /** Every file loaded, in load order, as its `<!-- name -->` header names it. */
  files: string[]
  /** The shipped doctrine loaded: its hash and files (`none` and no files under `--no-doctrine`). */
  doctrine: DoctrineSummary
  /** The channel playbook files loaded on top of it, as `playbook/<file>`. */
  overlay: string[]
  /** The channel playbook folder read, when there was one. */
  overlayDir?: string
}

export interface LoadPlaybookOptions {
  /** Stop adding files once the text would exceed this many characters. */
  maxChars?: number
  /** File access for the channel playbook folder; defaults to node:fs. */
  fs?: PlaybookFs
  /** The shipped doctrine; defaults to `shippedDoctrine()`. */
  doctrine?: ShippedDoctrine
  /** Leave the shipped doctrine out (`--no-doctrine`); the text says the run has none. */
  noDoctrine?: boolean
  /** The shipped playbook folder; a channel folder equal to it is the legacy layout. Defaults to channel-booster/playbook. */
  shippedDir?: string
}

const EMPTY_DOCTRINE = 'This build ships no doctrine: docs/02-strategist-playbook.md and playbook/*.md are missing, so the engines would reason without their rules. Reinstall channel-booster (from source, restore channel-booster/docs and channel-booster/playbook), or pass --no-doctrine to run without doctrine on purpose.'

/** One file on its way into the cached block. */
interface Chunk {
  label: string
  read: () => string
  shipped?: DoctrineFile
  overlay?: string
}

/**
 * Load the doctrine in a fixed order: `docs/02-strategist-playbook.md`, then
 * the channel's compiled `00-learned-rules.md` when `overlayDir` holds one,
 * then the shipped `playbook/*.md` files in their shipped order, then every
 * other `*.md` in `overlayDir` alphabetically (the rules a person accepted
 * into this channel's playbook). The doctrine comes from `shippedDoctrine()`,
 * so never `docs/01-*`, `docs/03-*` or `research/*`: those are evidence notes
 * and design, not rules. Each file is wrapped in an HTML comment naming it so
 * the model can cite where a rule came from; a channel file is named
 * `channel playbook/<file>`. When `overlayDir` is the shipped playbook folder
 * itself (a source checkout's legacy layout) only its compiled rules are
 * taken from it, so the prompt is the one this loader has always built.
 * Files that would push the text past `maxChars` are left out, and `files`
 * lists only what was loaded. Throws when the build ships no doctrine, unless
 * `noDoctrine` is set.
 */
export function loadPlaybook(overlayDir?: string, options: LoadPlaybookOptions = {}): LoadedPlaybook {
  const fs = options.fs ?? nodeFs
  const maxChars = options.maxChars ?? PLAYBOOK_MAX_CHARS
  const shipped = options.noDoctrine ? undefined : options.doctrine ?? shippedDoctrine()
  if (shipped && shipped.files.length === 0) throw new Error(EMPTY_DOCTRINE)
  const legacy = overlayDir !== undefined && isShippedPlaybookDir(overlayDir, options.shippedDir)

  const channel: Chunk[] = []
  if (overlayDir !== undefined && fs.exists(overlayDir)) {
    for (const name of [...fs.readdir(overlayDir)].sort()) {
      if (!name.endsWith('.md')) continue
      // The legacy folder is the shipped playbook: its other files are already in the doctrine.
      if (legacy && name !== LEARNED_RULES_NAME) continue
      channel.push({ label: `${legacy ? 'playbook' : OVERLAY_LABEL}/${name}`, read: () => fs.readFile(path.join(overlayDir, name)), overlay: `playbook/${name}` })
    }
  }
  const fromShipped = (f: DoctrineFile): Chunk => ({ label: f.name, read: () => f.text, shipped: f })
  const shippedFiles = shipped?.files ?? []
  const learned = channel.filter((c) => c.overlay === LEARNED_RULES_FILE)
  const wanted: Chunk[] = [
    ...shippedFiles.filter((f) => f.name === DOCTRINE_FILE).map(fromShipped),
    ...learned,
    ...shippedFiles.filter((f) => f.name !== DOCTRINE_FILE).map(fromShipped),
    ...channel.filter((c) => !learned.includes(c)),
  ]

  const chunks: string[] = shipped ? [] : [`<!-- no doctrine -->\n${NO_DOCTRINE_NOTE}`]
  const files: string[] = []
  const loadedShipped: DoctrineFile[] = []
  const overlay: string[] = []
  let length = chunks.reduce((n, c) => n + c.length, 0)
  for (const c of wanted) {
    const chunk = `<!-- ${c.label} -->\n${c.read().trim()}`
    const cost = chunk.length + (chunks.length ? 2 : 0)
    if (length + cost > maxChars) break
    chunks.push(chunk)
    files.push(c.label)
    length += cost
    if (c.shipped) loadedShipped.push(c.shipped)
    if (c.overlay) overlay.push(c.overlay)
  }
  const doctrine: DoctrineSummary = shipped
    ? { hash: loadedShipped.length === shipped.files.length ? shipped.hash : doctrineVersion(loadedShipped, shipped.packageFixTemplate), files: loadedShipped.map((f) => f.name) }
    : { hash: NO_DOCTRINE_HASH, files: [] }
  return { text: chunks.join('\n\n'), files, doctrine, overlay, ...(overlayDir !== undefined ? { overlayDir } : {}) }
}

/** `doctrine <hash> (<n> files)`, or `doctrine none (--no-doctrine)`. */
export function describeDoctrine(doctrine: DoctrineSummary): string {
  if (doctrine.hash === NO_DOCTRINE_HASH) return 'doctrine none (--no-doctrine)'
  return `doctrine ${doctrine.hash} (${doctrine.files.length} file${doctrine.files.length === 1 ? '' : 's'})`
}

/** `overlay <folder>: <files>`, or that there was no channel playbook folder to read. */
export function describeOverlay(files: string[], dir: string | undefined): string {
  if (dir === undefined) return 'overlay: none (no channel workspace)'
  return `overlay ${dir}: ${files.join(', ') || '(none)'}`
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
  /** The shipped doctrine inside playbookText, echoed for the provenance line. */
  doctrine?: DoctrineSummary
  /** The channel playbook files inside playbookText, as `playbook/<file>`. */
  overlay?: string[]
  /** The channel playbook folder they came from. */
  overlayDir?: string
  /** `describeProfile(channel.json)`; used as the channel line when `--channel` is absent. */
  profileText?: string
  /** `package-fix`: the gate fixes, when called from code rather than the CLI. */
  fixes?: string[]
  /** `package-fix`: the previous round's output, when called from code. */
  previous?: unknown
  /** `package-fix`: the fix-round template with `{{fixes}}` and `{{previous}}` (the shipped doctrine's `packageFixTemplate`). */
  packageFixTemplate?: string
  /** `postmortem`: the computed baseline from the profile; `--baseline-*` flags override it. */
  baseline?: PostMortemInput['baseline']
  /** Reads `--csv`, `--script`, `--fixes-file` and `--previous`; defaults to node:fs. */
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
  /** The shipped doctrine in the cached block, when the caller loaded it. */
  doctrine?: DoctrineSummary
  /** The channel playbook files in the cached block, as `playbook/<file>`. */
  overlay: string[]
  /** The channel playbook folder they came from. */
  overlayDir?: string
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
  if (!v) throw new Error(`--${key} is required. Run: ${cliName()} ai help`)
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
    else throw new Error(`--fixes "a; b" or --fixes-file fixes.txt is required. Run: ${cliName()} ai help`)
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
  const template = ctx.packageFixTemplate
  if (!template?.trim()) throw new Error('package-fix needs the fix-round template (prompts/package-fix.md), and this build ships none. Reinstall channel-booster, or restore channel-booster/prompts/package-fix.md in a source checkout.')
  const head = [`Channel: ${channel}`, `Idea: ${flag(flags, 'idea') ?? '(not given)'}`, `Title: ${flag(flags, 'title') ?? '(not given)'}`].join('\n')
  return `${head}\n\n${renderPackageFixUser(fixes, previous, template)}`
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
    ...(context.doctrine ? { doctrine: { hash: context.doctrine.hash, files: [...context.doctrine.files] } } : {}),
    overlay: [...(context.overlay ?? [])],
    ...(context.overlayDir !== undefined ? { overlayDir: context.overlayDir } : {}),
  }
}

/**
 * The `--dry-run` view: the doctrine and the channel playbook files it
 * carries, every system block, the user message and the playbook files, in
 * the order sent.
 */
export function formatDryRun(assembled: AssembledPrompt): string {
  const lines: string[] = [`engine: ${assembled.engine}`, `schema: ${assembled.engine} -> ${Object.keys(ENGINES[assembled.engine].shape).join(', ')}`]
  if (assembled.doctrine) lines.push(describeDoctrine(assembled.doctrine), describeOverlay(assembled.overlay, assembled.overlayDir))
  lines.push(`playbook files (${assembled.playbookFiles.length}): ${assembled.playbookFiles.join(', ') || '(none)'}`)
  assembled.system.forEach((block, i) => {
    lines.push('', `--- system[${i}]${block.cache ? ' (cached)' : ''} ---`, block.text)
  })
  lines.push('', '--- user ---', assembled.user)
  return lines.join('\n')
}
