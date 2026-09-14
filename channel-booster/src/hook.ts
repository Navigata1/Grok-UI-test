/**
 * Story spine and hook gate (architecture 2.9).
 *
 * A deterministic checker any writer runs on a script or outline before the
 * shoot. It answers, without a model: is the promise stated in the first ~25
 * words, where does the thumbnail moment land, how long does the script go
 * without a rehook, and how much intro cruft sits in front of the promise.
 * The runner gates the shoot on `hookScore >= thresholds.hookGateScore`.
 *
 * Time model: a line that starts with a timestamp marker (`[1:30]`, `(1:30)`,
 * `0:00`, `1:02:03`, optionally followed by `-` or `:`) sets the clock to that
 * time; every spoken line then advances the clock by its word count at `wpm`.
 * With no markers the whole timeline is estimated from word count.
 * Headings (markdown `#`, ALL-CAPS lines of three or more letters, or lines of
 * at most six words ending in ":") are not spoken and do not advance the clock.
 *
 * Score: start at 100; minus 40 if the promise is not in the first 25 words;
 * minus 15 per gap over `rehookMaxGapSec` (cap 45); minus 10 per intro cruft
 * line (cap 20); minus 15 if the thumbnail moment is missing; minus 10 if it
 * sits in the first third of a script longer than three minutes. Clamped 0-100.
 */
import { checkPromise, coverage, firstWords, PROMISE_RULES, promiseTokens } from './promise.js'
import { tagged, thresholds } from './thresholds.js'

/**
 * Numeric rules of the hook gate other than `rehookMaxGapSec` and
 * `hookGateScore` (those live in thresholds.ts). House defaults, owned here
 * until the thresholds owner moves them (see integration notes).
 */
export const HOOK_RULES = {
  defaultWpm: { value: 150, evidence: 'house', note: 'spoken words per minute used to estimate timestamps when the script has no markers' },
  introCruftWindowSec: { value: 60, evidence: 'house', note: 'cruft is only counted inside this many seconds from the start; a closing "subscribe" is an outro, not the hook' },
  longScriptSec: { value: 180, evidence: 'house', note: 'above this length a thumbnail moment in the first third is spent too early' },
  promiseMissingPenalty: { value: 40, evidence: 'house', note: 'promise not in the first 25 words' },
  gapPenalty: { value: 15, evidence: 'house', note: 'per stretch longer than rehookMaxGapSec' },
  gapPenaltyCap: { value: 45, evidence: 'house', note: 'most points the gaps can cost' },
  cruftPenalty: { value: 10, evidence: 'house', note: 'per intro cruft line' },
  cruftPenaltyCap: { value: 20, evidence: 'house', note: 'most points cruft can cost' },
  thumbnailMissingPenalty: { value: 15, evidence: 'house', note: 'the thumbnail moment is not in the script' },
  thumbnailEarlyPenalty: { value: 10, evidence: 'house', note: 'the thumbnail moment is in the first third of a long script' },
} as const

export type ThumbnailMomentPosition = 'first-third' | 'middle' | 'final-third' | 'missing'
export type RehookDevice = 'question' | 'reveal' | 'escalation'

export interface HookOptions {
  /** The chosen title. Used as the promise when `promise` is blank. */
  title: string
  /** The promise sentence from the package. Blank falls back to the title. */
  promise: string
  /** A few words naming the moment the thumbnail shows, e.g. "the generator powers the fridge". */
  thumbnailMoment?: string
  /** Words per minute for estimated timestamps. Default 150. */
  wpm?: number
  /** Reference time for `computedAt`; inject in tests. */
  now?: Date
}

export interface Rehook {
  atSec: number
  line: string
  /** 0-based line index in the raw script. */
  lineIndex: number
  device: RehookDevice
}

export interface Gap {
  fromSec: number
  toSec: number
}

export interface Chapter {
  atSec: number
  title: string
}

export interface HookReport {
  hookScore: number
  /** `hookScore >= thresholds.hookGateScore`. */
  pass: boolean
  gateScore: number
  /** 0-based index of the first line inside the first 25 words that carries a promise word, or -1 when the promise is not in the first 25 words. */
  promiseLineIndex: number
  promiseInFirst25Words: boolean
  /** Where the promise tokens came from: the promise field or, when blank, the title. */
  promiseSource: 'promise' | 'title'
  /** Promise tokens the first 25 words lack; empty when the head passes. */
  promiseMissing: string[]
  thumbnailMomentPosition: ThumbnailMomentPosition
  thumbnailMomentAtSec?: number
  thumbnailMomentLineIndex?: number
  rehooks: Rehook[]
  /** Stretches longer than rehookMaxGapSec without a rehook, measured from 0 and to the end. */
  gaps: Gap[]
  /** Lines inside the intro window that match a cruft pattern. */
  introCruft: string[]
  estimatedDurationSec: number
  timestampSource: 'markers' | 'estimated'
  chapters: Chapter[]
  /** What to cut or move, one line each. */
  cuts: string[]
  /** Every deduction explained. */
  deductions: string[]
  thresholdsUsed: string[]
  computedAt: string
}

export interface ScriptLine {
  /** 0-based index in the raw script. */
  index: number
  /** Text with the timestamp marker removed and heading markup stripped. */
  text: string
  kind: 'spoken' | 'heading' | 'blank' | 'marker'
  atSec: number
  endSec: number
  words: number
  /** Explicit marker seconds when the line started with one. */
  marker?: number
}

export interface ParsedScript {
  lines: ScriptLine[]
  durationSec: number
  timestampSource: 'markers' | 'estimated'
  wpm: number
}

const MARKER_RE = /^\s*[[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?[\])]?(?:\s*[-–—:.])?(?=\s|$)\s*/
const HEADING_MD_RE = /^#{1,6}\s+\S/
const HEADING_CAPS_RE = /^[^a-z]*$/
const HEADING_COLON_RE = /:$/

/** Intro cruft patterns. Case-insensitive; matched against the spoken text of one line. */
export const INTRO_CRUFT_PATTERNS: RegExp[] = [
  /\bwelcome back\b/i,
  /\bbefore we (start|begin|get started|dive in|jump in)\b/i,
  /\bin (this|today's|todays) video\b/i,
  /\b(don't|dont|do not) forget to (subscribe|like|hit)\b/i,
  /\bmy name is\b/i,
  /\b(smash|hit) (that|the) (like|subscribe|bell)\b/i,
]

/** Reveal and escalation words that count as a rehook when they appear in a line. "but" only at a clause start. */
const REVEAL_RE = /(^|[.!?;:,—–-]\s*)but\b|\b(until|turns out|wait|except|what happened|the problem|the catch|the twist)\b/i
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?/g

function markerSeconds(m: RegExpExecArray): number {
  const a = Number(m[1])
  const b = Number(m[2])
  const c = m[3] === undefined ? undefined : Number(m[3])
  return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c
}

function isHeading(text: string): boolean {
  if (HEADING_MD_RE.test(text)) return true
  const letters = (text.match(/[A-Z]/g) ?? []).length
  if (HEADING_CAPS_RE.test(text) && letters >= 3) return true
  return HEADING_COLON_RE.test(text) && text.split(/\s+/).filter(Boolean).length <= 6
}

function headingTitle(text: string): string {
  return text.replace(/^#{1,6}\s+/, '').replace(/:$/, '').trim()
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Split a script into timed lines. Markers set the clock; spoken lines advance
 * it by word count at `wpm`; headings and blank lines do not. Line indexes are
 * 0-based positions in `script.split(/\r?\n/)`, so they match an editor.
 */
export function parseScript(script: string, wpm: number = HOOK_RULES.defaultWpm.value): ParsedScript {
  if (!Number.isFinite(wpm) || wpm <= 0) throw new Error(`wpm must be a positive number, got ${wpm}`)
  const raw = script.split(/\r?\n/)
  const lines: ScriptLine[] = []
  let clock = 0
  let timestampSource: ParsedScript['timestampSource'] = 'estimated'
  raw.forEach((rawLine, index) => {
    const m = MARKER_RE.exec(rawLine)
    let text = rawLine
    let marker: number | undefined
    if (m) {
      marker = markerSeconds(m)
      text = rawLine.slice(m[0].length)
      timestampSource = 'markers'
      clock = marker
    }
    text = text.trim()
    const base: Omit<ScriptLine, 'kind' | 'text' | 'words' | 'endSec'> = { index, atSec: clock, ...(marker === undefined ? {} : { marker }) }
    if (text.length === 0) {
      lines.push({ ...base, text: '', kind: m ? 'marker' : 'blank', words: 0, endSec: clock })
      return
    }
    if (isHeading(text)) {
      lines.push({ ...base, text: headingTitle(text), kind: 'heading', words: 0, endSec: clock })
      return
    }
    const words = countWords(text)
    const endSec = clock + (words / wpm) * 60
    lines.push({ ...base, text, kind: 'spoken', words, endSec })
    clock = endSec
  })
  return { lines, durationSec: clock, timestampSource, wpm }
}

/** Seconds as m:ss or h:mm:ss, for printing. */
export function formatSec(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`
}

function detectRehook(text: string, runningMax: number | undefined): { device: RehookDevice | undefined; max: number | undefined } {
  const nums = (text.match(NUMBER_RE) ?? []).map((n) => Number(n.replace(/[$,]/g, ''))).filter((n) => Number.isFinite(n))
  const lineMax = nums.length > 0 ? Math.max(...nums) : undefined
  let max = runningMax
  let escalates = false
  if (lineMax !== undefined) {
    if (runningMax !== undefined && lineMax > runningMax) escalates = true
    max = runningMax === undefined ? lineMax : Math.max(runningMax, lineMax)
  }
  if (text.includes('?')) return { device: 'question', max }
  if (REVEAL_RE.test(text)) return { device: 'reveal', max }
  if (escalates) return { device: 'escalation', max }
  return { device: undefined, max }
}

function chaptersOf(parsed: ParsedScript): Chapter[] {
  const chapters: Chapter[] = []
  let pending: 'paragraph' | 'heading' | 'none' = 'paragraph'
  for (const line of parsed.lines) {
    if (line.kind === 'heading') {
      chapters.push({ atSec: Math.round(line.atSec), title: line.text })
      pending = 'heading'
    } else if (line.kind === 'blank') {
      if (pending !== 'heading') pending = 'paragraph'
    } else if (line.kind === 'spoken') {
      if (pending === 'paragraph') chapters.push({ atSec: Math.round(line.atSec), title: firstWords(line.text, 6).replace(/[,.;:!?]+$/, '') })
      pending = 'none'
    }
  }
  return chapters
}

function locateThumbnailMoment(parsed: ParsedScript, moment: string | undefined): { position: ThumbnailMomentPosition; atSec?: number; lineIndex?: number } {
  const momentToks = promiseTokens(moment ?? '')
  if (momentToks.length === 0 || parsed.durationSec <= 0) return { position: 'missing' }
  const need = momentToks.length <= 2 ? 1 : 2
  let best: { shared: number; line: ScriptLine } | undefined
  for (const line of parsed.lines) {
    if (line.kind !== 'spoken') continue
    const shared = coverage(momentToks, line.text).shared.length
    // Best match wins; a tie goes to the later line (the payoff, not the tease in the open).
    if (shared >= need && (best === undefined || shared >= best.shared)) best = { shared, line }
  }
  if (!best) return { position: 'missing' }
  const ratio = best.line.atSec / parsed.durationSec
  const position: ThumbnailMomentPosition = ratio < 1 / 3 ? 'first-third' : ratio < 2 / 3 ? 'middle' : 'final-third'
  return { position, atSec: Math.round(best.line.atSec), lineIndex: best.line.index }
}

/**
 * Score a script's hook and story spine. See the module comment for the time
 * model and the score. Never reads the clock: pass `now` for `computedAt`.
 */
export function scoreHook(script: string, options: HookOptions): HookReport {
  const wpm = options.wpm ?? HOOK_RULES.defaultWpm.value
  const now = options.now ?? new Date()
  const parsed = parseScript(script, wpm)
  const spoken = parsed.lines.filter((l) => l.kind === 'spoken')
  const maxGap = thresholds.rehookMaxGapSec.value
  const gateScore = thresholds.hookGateScore.value
  const headWords = PROMISE_RULES.headWords.value
  const deductions: string[] = []
  const cuts: string[] = []
  const thresholdsUsed = [`hookGateScore ${tagged('hookGateScore')}`, `rehookMaxGapSec ${tagged('rehookMaxGapSec', 's')}`]
  for (const key of ['introCruftWindowSec', 'longScriptSec'] as const) thresholdsUsed.push(`${key} ${HOOK_RULES[key].value}s [${HOOK_RULES[key].evidence}]`)

  // Promise in the first 25 words. Blank promise: the title is the promise.
  const promiseSource: HookReport['promiseSource'] = promiseTokens(options.promise).length > 0 ? 'promise' : 'title'
  const promise = promiseSource === 'promise' ? options.promise : options.title
  const promiseToks = promiseTokens(promise)
  const headText = firstWords(spoken.map((l) => l.text).join(' '), headWords)
  const promiseReport = checkPromise(promise, { scriptHead: headText })
  const headCheck = promiseReport.surfaces.scriptHead!
  thresholdsUsed.push(...promiseReport.thresholdsUsed)
  let promiseLineIndex = -1
  if (headCheck.pass) {
    let budget = headWords
    for (const line of spoken) {
      if (budget <= 0) break
      const slice = firstWords(line.text, budget)
      budget -= countWords(slice)
      if (coverage(promiseToks, slice).shared.length > 0) {
        promiseLineIndex = line.index
        break
      }
    }
  }
  let score = 100
  if (!headCheck.pass) {
    score -= HOOK_RULES.promiseMissingPenalty.value
    deductions.push(`-${HOOK_RULES.promiseMissingPenalty.value}: ${headCheck.reason}`)
  }

  // Intro cruft inside the window; those lines are cuts, never rehooks.
  const cruftWindow = HOOK_RULES.introCruftWindowSec.value
  const introCruft: string[] = []
  const cruftIndexes = new Set<number>()
  for (const line of spoken) {
    if (line.atSec >= cruftWindow) break
    if (INTRO_CRUFT_PATTERNS.some((re) => re.test(line.text))) {
      introCruft.push(line.text)
      cruftIndexes.add(line.index)
      cuts.push(`Cut line ${line.index + 1} (${formatSec(line.atSec)}): "${line.text}"`)
    }
  }
  if (introCruft.length > 0) {
    const cost = Math.min(HOOK_RULES.cruftPenaltyCap.value, introCruft.length * HOOK_RULES.cruftPenalty.value)
    score -= cost
    deductions.push(`-${cost}: ${introCruft.length} intro cruft line(s) inside the first ${cruftWindow}s`)
  }

  // Rehooks and gaps.
  const rehooks: Rehook[] = []
  let runningMax: number | undefined
  for (const line of spoken) {
    const { device, max } = detectRehook(line.text, runningMax)
    runningMax = max
    if (device && !cruftIndexes.has(line.index)) rehooks.push({ atSec: Math.round(line.atSec), line: line.text, lineIndex: line.index, device })
  }
  const gaps: Gap[] = []
  const anchors = [0, ...rehooks.map((r) => r.atSec), parsed.durationSec]
  for (let i = 1; i < anchors.length; i += 1) {
    if (anchors[i] - anchors[i - 1] > maxGap) gaps.push({ fromSec: Math.round(anchors[i - 1]), toSec: Math.round(anchors[i]) })
  }
  for (const g of gaps) cuts.push(`Add a rehook (question, reveal, escalation) or cut between ${formatSec(g.fromSec)} and ${formatSec(g.toSec)} (${g.toSec - g.fromSec}s without one; limit ${maxGap}s)`)
  if (gaps.length > 0) {
    const cost = Math.min(HOOK_RULES.gapPenaltyCap.value, gaps.length * HOOK_RULES.gapPenalty.value)
    score -= cost
    deductions.push(`-${cost}: ${gaps.length} stretch(es) longer than ${maxGap}s without a rehook`)
  }

  // Thumbnail moment.
  const moment = locateThumbnailMoment(parsed, options.thumbnailMoment)
  if (moment.position === 'missing') {
    score -= HOOK_RULES.thumbnailMissingPenalty.value
    deductions.push(`-${HOOK_RULES.thumbnailMissingPenalty.value}: ${options.thumbnailMoment ? `the thumbnail moment "${options.thumbnailMoment}" is not in the script` : 'no thumbnail moment named'}`)
    cuts.push(options.thumbnailMoment ? `Write the thumbnail moment on screen: "${options.thumbnailMoment}" (it must happen in the video, not only in the packaging)` : 'Name the thumbnail moment so the script can be checked for it')
  } else if (moment.position === 'first-third' && parsed.durationSec > HOOK_RULES.longScriptSec.value) {
    score -= HOOK_RULES.thumbnailEarlyPenalty.value
    deductions.push(`-${HOOK_RULES.thumbnailEarlyPenalty.value}: the thumbnail moment lands at ${formatSec(moment.atSec!)}, in the first third of a ${formatSec(parsed.durationSec)} script`)
    cuts.push(`Move the thumbnail moment (line ${moment.lineIndex! + 1}) into the final third; tease it in the open instead of spending it`)
  }

  score = Math.max(0, Math.min(100, score))
  return {
    hookScore: score,
    pass: score >= gateScore,
    gateScore,
    promiseLineIndex,
    promiseInFirst25Words: headCheck.pass,
    promiseSource,
    promiseMissing: headCheck.pass ? [] : headCheck.missing,
    thumbnailMomentPosition: moment.position,
    ...(moment.atSec === undefined ? {} : { thumbnailMomentAtSec: moment.atSec, thumbnailMomentLineIndex: moment.lineIndex }),
    rehooks,
    gaps,
    introCruft,
    estimatedDurationSec: Math.round(parsed.durationSec),
    timestampSource: parsed.timestampSource,
    chapters: chaptersOf(parsed),
    cuts,
    deductions,
    thresholdsUsed,
    computedAt: now.toISOString(),
  }
}

/** Render a hook report as plain text lines for the CLI. */
export function renderHookReport(report: HookReport): string {
  const lines: string[] = []
  lines.push(`Hook score: ${report.hookScore}/100 (${report.pass ? 'pass' : 'FAIL'}, gate ${report.gateScore})`)
  lines.push(`Promise in first ${PROMISE_RULES.headWords.value} words: ${report.promiseInFirst25Words ? `yes (line ${report.promiseLineIndex + 1})` : `no (missing: ${report.promiseMissing.join(', ') || 'none'})`}${report.promiseSource === 'title' ? ' [promise blank; title used]' : ''}`)
  lines.push(`Thumbnail moment: ${report.thumbnailMomentPosition}${report.thumbnailMomentAtSec === undefined ? '' : ` at ${formatSec(report.thumbnailMomentAtSec)}`}`)
  lines.push(`Length: ${formatSec(report.estimatedDurationSec)} (${report.timestampSource})`)
  if (report.deductions.length > 0) {
    lines.push('Deductions:')
    for (const d of report.deductions) lines.push(`  ${d}`)
  }
  lines.push(`Rehooks (${report.rehooks.length}):`)
  for (const r of report.rehooks) lines.push(`  ${formatSec(r.atSec)}  [${r.device}] ${r.line}`)
  if (report.gaps.length > 0) {
    lines.push('Gaps:')
    for (const g of report.gaps) lines.push(`  ${formatSec(g.fromSec)} - ${formatSec(g.toSec)}`)
  }
  if (report.introCruft.length > 0) {
    lines.push('Intro cruft:')
    for (const c of report.introCruft) lines.push(`  ${c}`)
  }
  lines.push(`Chapters (${report.chapters.length}):`)
  for (const c of report.chapters) lines.push(`  ${formatSec(c.atSec)}  ${c.title}`)
  if (report.cuts.length > 0) {
    lines.push('Cuts:')
    for (const c of report.cuts) lines.push(`  - ${c}`)
  }
  lines.push(`Thresholds: ${report.thresholdsUsed.join('; ')}`)
  return lines.join('\n')
}
