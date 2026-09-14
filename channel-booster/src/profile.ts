/**
 * The channel profile: one JSON document (`channel-booster/channel.json`, or
 * `BOOSTER_PROFILE`) that says who the channel serves, what it looks like,
 * who it competes with, how often it publishes, which thresholds it overrides,
 * and the baselines computed from its own ledger. Replaces the free-text
 * `--channel` flag on the AI engines and the typed `--baseline-*` flags on
 * `postmortem`: every verdict reads the baseline from here and prints its tier.
 *
 * Numbers are never typed into the profile by hand: `refreshBaselines()` derives
 * them from ledger rows with `ledger.baselineFrom`, and `baselineInputFrom()`
 * falls back to the cold-start priors in `thresholds.ts` when the tier is
 * `prior`, saying so on the result.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { baselineFrom } from './ledger.js'
import { ProfileDoc, type Baselines, type Bucket, type LedgerRow, type Signature, type Stat } from './schema.js'
import { applyOverrides, thresholds, type ThresholdKey } from './thresholds.js'
import type { PostMortemInput } from './types.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The profile path: an explicit path, else `BOOSTER_PROFILE`, else `channel-booster/channel.json`. */
export function resolveProfilePath(profilePath?: string): string {
  const env = process.env.BOOSTER_PROFILE
  return path.resolve(profilePath ?? (env && env.trim() ? env : path.resolve(here, '..', 'channel.json')))
}

/** A profile with every default and nothing described: what `loadProfile()` returns before `profile init` runs. */
export function defaultProfile(): ProfileDoc {
  return ProfileDoc.parse({})
}

/** Validate a raw object against the profile schema; the error names the file and the failing fields. */
export function parseProfile(raw: unknown, label = 'channel.json'): ProfileDoc {
  const parsed = ProfileDoc.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => `${x.path.join('.') || '(root)'} ${x.message}`).join('; ')
    throw new Error(`${label} does not match the profile schema: ${issues}`)
  }
  return parsed.data
}

/** True when a channel.json exists at the resolved path (so `profile show` can say "not initialised"). */
export function profileExists(profilePath?: string): boolean {
  return existsSync(resolveProfilePath(profilePath))
}

/**
 * Read and validate channel.json. A missing file is not an error: the defaults
 * come back so every command works on a fresh checkout. Invalid JSON or a
 * schema mismatch throws with the path and the field.
 */
export function loadProfile(profilePath?: string): ProfileDoc {
  const file = resolveProfilePath(profilePath)
  if (!existsSync(file)) return defaultProfile()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  return parseProfile(raw, file)
}

/**
 * Validate and write the profile as pretty JSON (atomic: temp file then rename),
 * stamping `updatedAt` from `options.now`. Returns the document as written.
 */
export function saveProfile(profile: ProfileDoc, profilePath?: string, options: { now?: Date } = {}): ProfileDoc {
  const file = resolveProfilePath(profilePath)
  const doc = parseProfile({ ...profile, updatedAt: (options.now ?? new Date()).toISOString() }, file)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
  renameSync(tmp, file)
  return doc
}

/** Answers `booster profile init` collects. Lists accept an array or a comma-separated string. */
export interface InitAnswers {
  /** Who watches, what they get every time, why they come back. */
  positioning?: string
  /** The returning viewer in one sentence. */
  persona?: string
  /** Signature colour pair, e.g. ["yellow", "black"] or "yellow,black". Required for any other signature field. */
  colors?: string[] | string
  facePolicy?: Signature['facePolicy']
  maxWords?: number
  framing?: string
  typeface?: string
  signatureNotes?: string
  competitors?: string[] | string
  series?: Array<{ name: string; promise: string; cadence?: string; parentSlug?: string }>
  maxPerWeek?: number
  publishDay?: ProfileDoc['publishDay']
  solo?: boolean
  store?: ProfileDoc['store']
  thresholds?: Record<string, number>
  neverAgain?: string[] | string
  /** Injected clock for `updatedAt`. */
  now?: Date
}

/** Split "a, b / c" into trimmed, de-duplicated entries. `separators` decides which characters split. */
function splitList(value: string[] | string | undefined, separators: RegExp): string[] {
  if (value === undefined) return []
  const parts = Array.isArray(value) ? value : value.split(separators)
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const clean = part.trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/** Colour lists split on comma, slash or pipe ("yellow/black"). */
export function parseColors(value: string[] | string | undefined): string[] {
  return splitList(value, /[,/|]+/).map((c) => c.toLowerCase())
}

function clean(value: string | undefined): string | undefined {
  const s = value?.trim()
  return s ? s : undefined
}

/**
 * Build a first profile from the init answers. Strings are trimmed, lists
 * de-duplicated, and the signature is only created when a colour pair exists
 * (a face policy or word cap without colours is refused so the registry never
 * holds half a signature).
 */
export function initProfile(answers: InitAnswers = {}): ProfileDoc {
  const colors = parseColors(answers.colors)
  const wantsSignature = answers.facePolicy !== undefined || answers.maxWords !== undefined || clean(answers.framing) || clean(answers.typeface) || clean(answers.signatureNotes)
  if (colors.length === 0 && wantsSignature) throw new Error('a signature needs at least one colour: give colors like "yellow,black"')
  const signature = colors.length > 0
    ? {
        colors,
        ...(answers.facePolicy !== undefined ? { facePolicy: answers.facePolicy } : {}),
        ...(answers.maxWords !== undefined ? { maxWords: answers.maxWords } : {}),
        ...(clean(answers.framing) ? { framing: clean(answers.framing) } : {}),
        ...(clean(answers.typeface) ? { typeface: clean(answers.typeface) } : {}),
        ...(clean(answers.signatureNotes) ? { notes: clean(answers.signatureNotes) } : {}),
      }
    : undefined
  const series = (answers.series ?? [])
    .map((s) => ({ name: s.name.trim(), promise: s.promise.trim(), ...(clean(s.cadence) ? { cadence: clean(s.cadence) } : {}), ...(clean(s.parentSlug) ? { parentSlug: clean(s.parentSlug) } : {}) }))
    .filter((s) => s.name && s.promise)
  const raw = {
    ...(clean(answers.positioning) ? { positioning: clean(answers.positioning) } : {}),
    ...(clean(answers.persona) ? { persona: clean(answers.persona) } : {}),
    series,
    ...(signature ? { signature } : {}),
    competitors: splitList(answers.competitors, /[,;\n]+/),
    ...(answers.maxPerWeek !== undefined ? { maxPerWeek: answers.maxPerWeek } : {}),
    ...(answers.publishDay !== undefined ? { publishDay: answers.publishDay } : {}),
    ...(answers.solo !== undefined ? { solo: answers.solo } : {}),
    ...(answers.store !== undefined ? { store: answers.store } : {}),
    thresholds: answers.thresholds ?? {},
    neverAgain: splitList(answers.neverAgain, /[;\n]+/),
    updatedAt: (answers.now ?? new Date()).toISOString(),
  }
  return parseProfile(raw, 'profile init')
}

export interface RefreshOptions {
  /** Reference clock: rows younger than `minAgeDays` at this instant are excluded. */
  now: Date
  /** Trailing window size passed to `baselineFrom` (its default is 10). */
  window?: number
  /** Minimum row age in days passed to `baselineFrom` (its default is 7). */
  minAgeDays?: number
}

export interface RefreshResult {
  /** The profile with `baselines` (48 h), `previousBaselines`, and `updatedAt` set. Not yet saved. */
  profile: ProfileDoc
  baselines48: Baselines
  /** The 7-day baselines, also stored on the profile as `baselines168`: what a 168 or 672 h read is judged against. */
  baselines168: Baselines
  /** What `profile.baselines` was before this refresh. */
  previous?: Baselines
  /** True when any metric's median moved by more than one MAD since `previous`. */
  shift: boolean
  /** The metrics that moved. */
  shifted: string[]
}

const STAT_KEYS = ['ctr', 'avpPct', 'retention30sPct', 'returningPct', 'views', 'impressions'] as const
type StatKey = (typeof STAT_KEYS)[number]

/** Metrics whose median moved by more than one MAD (the current MAD) between two baseline computations. */
export function shiftedMetrics(next: Baselines, previous: Baselines | undefined): string[] {
  if (!previous) return []
  const out: string[] = []
  for (const key of STAT_KEYS) {
    const a: Stat | undefined = next[key]
    const b: Stat | undefined = previous[key]
    if (!a || !b || a.mad <= 0) continue
    if (Math.abs(a.median - b.median) > a.mad) out.push(key)
  }
  return out
}

/**
 * What a refresh would change about the numbers verdicts are judged against:
 * the tier, and every metric whose median moves at all. Empty means the rewrite
 * is a no-op, so `profile refresh` can save it without asking anyone.
 */
export function movedMetrics(next: Baselines, previous: Baselines | undefined): string[] {
  if (!previous) return []
  const out: string[] = next.tier !== previous.tier ? ['tier'] : []
  for (const key of STAT_KEYS) {
    if (next[key]?.median !== previous[key]?.median) out.push(key)
  }
  return out
}

/**
 * Recompute the channel baselines from ledger rows (`ledger.baselineFrom`) for
 * the 48-hour and 7-day buckets. The 48-hour result is stored in
 * `profile.baselines`, the old one moves to `previousBaselines`, and `shift`
 * is set when a median moved more than one MAD. Pure: save with `saveProfile`.
 */
export function refreshBaselines(profile: ProfileDoc, rows: LedgerRow[], options: RefreshOptions): RefreshResult {
  const previous = profile.baselines
  const common = { now: options.now, window: options.window, minAgeDays: options.minAgeDays }
  const b48 = baselineFrom(rows, { ...common, bucket: '48', previous })
  const baselines168 = baselineFrom(rows, { ...common, bucket: '168' })
  const shifted = shiftedMetrics(b48, previous)
  const baselines48: Baselines = { ...b48, shift: shifted.length > 0 }
  const next = parseProfile({ ...profile, baselines: baselines48, baselines168, previousBaselines: previous, updatedAt: options.now.toISOString() }, 'profile refresh')
  return { profile: next, baselines48, baselines168, previous, shift: baselines48.shift, shifted }
}

/**
 * Push `profile.thresholds` into the live threshold table (`thresholds.applyOverrides`).
 * Every key is checked before any is applied, so a typo leaves the table untouched.
 * Returns the keys applied.
 */
export function applyProfileThresholds(profile: ProfileDoc): ThresholdKey[] {
  const entries = Object.entries(profile.thresholds)
  if (entries.length === 0) return []
  for (const [key, value] of entries) {
    if (!(key in thresholds)) throw new Error(`channel.json thresholds: unknown threshold "${key}"`)
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`channel.json thresholds: threshold "${key}" must be a number`)
  }
  applyOverrides(profile.thresholds as Partial<Record<ThresholdKey, number>>)
  return entries.map(([key]) => key as ThresholdKey)
}

/** The baseline a verdict compares against, with where it came from. */
export interface BaselineInput {
  /** Click-through rate, percent. */
  ctr: number
  /** Average percentage viewed, percent. */
  avpPct: number
  /** Share of viewers still watching at 30 seconds, percent. */
  retention30sPct: number
  /** Median views in the baseline bucket; absent when the ledger has none (diagnose then uses the absolute floor). */
  views?: number
  /** `computed` from the ledger, or `default` cold-start priors (tier `prior` or no baselines). */
  source: 'computed' | 'default'
  tier: Baselines['tier']
  /** Rows behind the computed baseline (0 for defaults). */
  n: number
  bucket?: Baselines['bucket']
  computedAt?: string
  /** Fields that fell back to the priors because the ledger never carried them. */
  borrowed: string[]
  /** The baseline moved by more than one MAD at the last refresh. */
  shift: boolean
}

/**
 * The baseline set a read at `bucket` is judged against: the 7-day medians for
 * a 168 or 672 h read, the 48-hour medians otherwise. A profile written before
 * `baselines168` existed falls back to the 48-hour set rather than to priors.
 */
export function baselinesForBucket(profile: ProfileDoc, bucket?: Bucket): Baselines | undefined {
  if (bucket === '168' || bucket === '672') return profile.baselines168 ?? profile.baselines
  return profile.baselines
}

/**
 * The baseline `diagnose()` and the decision engine should use. Computed
 * medians when the tier is `thin` or `solid`; the cold-start priors from
 * `thresholds.ts` (CTR, AVP, 30 s) when the tier is `prior` or the profile has
 * no baselines. A field the ledger never carried falls back to its prior and is
 * listed in `borrowed`, so every verdict can say what it compared against.
 * `bucket` picks the set: a 7-day read is never judged against 48-hour medians.
 */
export function baselineInputFrom(profile: ProfileDoc, bucket?: Bucket): BaselineInput {
  const b = baselinesForBucket(profile, bucket)
  const usable = b !== undefined && b.tier !== 'prior'
  const borrowed: string[] = []
  const pick = (key: StatKey, prior: number): number => {
    if (usable && b[key]) return b[key]!.median
    borrowed.push(key)
    return prior
  }
  const ctr = pick('ctr', thresholds.priorCtr.value)
  const avpPct = pick('avpPct', thresholds.priorAvp.value)
  const retention30sPct = pick('retention30sPct', thresholds.priorRetention30.value)
  const views = usable && b.views ? b.views.median : undefined
  const computed = usable && (b.ctr !== undefined || b.avpPct !== undefined)
  return {
    ctr,
    avpPct,
    retention30sPct,
    ...(views !== undefined ? { views } : {}),
    source: computed ? 'computed' : 'default',
    tier: b?.tier ?? 'prior',
    n: b?.n ?? 0,
    ...(b ? { bucket: b.bucket, computedAt: b.computedAt } : {}),
    borrowed,
    shift: b?.shift ?? false,
  }
}

/**
 * The `baseline` argument for `diagnose()`: the computed numbers for the read's
 * bucket, or `undefined` when only priors exist so the diagnosis prints its own
 * "baseline is borrowed" line.
 */
export function diagnoseBaseline(profile: ProfileDoc, bucket?: Bucket): PostMortemInput['baseline'] {
  const input = baselineInputFrom(profile, bucket)
  if (input.source === 'default') return undefined
  return { ctr: input.ctr, avpPct: input.avpPct, ...(input.views !== undefined ? { views: input.views } : {}) }
}

function pct(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

/** One line for a verdict: "baseline CTR 4.5% / AVP 41% / 30 s 62% [computed, solid, n=10, 48 h; borrowed: retention30sPct]". */
export function describeBaselineInput(input: BaselineInput): string {
  const tags = [input.source, input.tier, `n=${input.n}`]
  if (input.bucket) tags.push(`${input.bucket} h`)
  if (input.shift) tags.push('shifted')
  const borrowed = input.borrowed.length > 0 && input.source === 'computed' ? `; borrowed: ${input.borrowed.join(', ')}` : ''
  const views = input.views !== undefined ? ` / views ${Math.round(input.views)}` : ''
  return `baseline CTR ${pct(input.ctr)} / AVP ${pct(input.avpPct)} / 30 s ${pct(input.retention30sPct)}${views} [${tags.join(', ')}${borrowed}]`
}

const DAY_NAMES: Record<ProfileDoc['publishDay'], string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

function sentence(s: string): string {
  const t = s.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/** The signature as one clause: "yellow/black, face either, at most 3 words of text, framing ..., typeface ...". */
export function describeSignatureText(signature: Signature): string {
  const parts = [signature.colors.join('/'), `face ${signature.facePolicy}`, `at most ${signature.maxWords} word${signature.maxWords === 1 ? '' : 's'} of text`]
  if (signature.framing) parts.push(`framing ${signature.framing}`)
  if (signature.typeface) parts.push(`typeface ${signature.typeface}`)
  if (signature.notes) parts.push(signature.notes)
  return parts.join(', ')
}

function describeCadence(profile: ProfileDoc): string {
  const n = profile.maxPerWeek
  const rate = n === 0 ? 'no fixed cadence' : n < 1 ? `one upload every ${Math.round(1 / n)} weeks` : `at most ${n} upload${n === 1 ? '' : 's'} per week`
  return `Cadence: ${rate}, publish day ${DAY_NAMES[profile.publishDay]}, ${profile.solo ? 'solo creator' : 'with a team'}.`
}

/**
 * One paragraph for the AI prompts' "Channel:" line: positioning, persona,
 * series, signature, competitors, cadence, the never-again list, and the
 * baseline tier. Says so when nothing is described yet.
 */
export function describeProfile(profile: ProfileDoc): string {
  const parts: string[] = []
  if (profile.positioning) parts.push(`Positioning: ${sentence(profile.positioning)}`)
  if (profile.persona) parts.push(`Returning viewer: ${sentence(profile.persona)}`)
  if (profile.series.length > 0) parts.push(`Series: ${profile.series.map((s) => `${s.name} (${s.promise}${s.cadence ? `, ${s.cadence}` : ''})`).join('; ')}.`)
  if (profile.signature) parts.push(`Visual signature: ${describeSignatureText(profile.signature)}.`)
  if (profile.competitors.length > 0) parts.push(`Competitor set: ${profile.competitors.join(', ')}.`)
  if (parts.length === 0) return 'Channel not described yet: run booster profile init.'
  parts.push(describeCadence(profile))
  if (profile.neverAgain.length > 0) parts.push(`Never again: ${profile.neverAgain.join('; ')}.`)
  const b = profile.baselines
  if (b) {
    const nums = [b.ctr ? `CTR ${pct(b.ctr.median)}` : '', b.avpPct ? `AVP ${pct(b.avpPct.median)}` : '', b.retention30sPct ? `30 s ${pct(b.retention30sPct.median)}` : '', b.views ? `views ${Math.round(b.views.median)}` : ''].filter(Boolean)
    parts.push(`Own baselines at ${b.bucket} h (${b.tier}, n=${b.n}${b.shift ? ', shifted since last refresh' : ''}): ${nums.length > 0 ? nums.join(', ') : 'no metrics yet'}.`)
  }
  return parts.join(' ')
}

function statLine(label: string, stat: Stat | undefined, suffix: string): string {
  return stat ? `  ${label}: median ${Number.isInteger(stat.median) ? stat.median : stat.median.toFixed(1)}${suffix}, MAD ${stat.mad.toFixed(1)}, n=${stat.n}` : `  ${label}: not in the ledger`
}

/** Multi-line text for `booster profile show`. */
export function renderProfileText(profile: ProfileDoc, options: { path?: string; exists?: boolean } = {}): string {
  const lines: string[] = []
  if (options.path) lines.push(`Profile: ${options.path}${options.exists === false ? ' (not created yet: defaults shown; run booster profile init)' : ''}`)
  lines.push(`Positioning: ${profile.positioning ?? '—'}`)
  lines.push(`Persona: ${profile.persona ?? '—'}`)
  lines.push(`Series: ${profile.series.length > 0 ? profile.series.map((s) => `${s.name} (${s.promise}${s.cadence ? `, ${s.cadence}` : ''}${s.parentSlug ? `, parent ${s.parentSlug}` : ''})`).join('; ') : '—'}`)
  lines.push(`Signature: ${profile.signature ? describeSignatureText(profile.signature) : '—'}`)
  lines.push(`Competitors: ${profile.competitors.length > 0 ? profile.competitors.join(', ') : '—'}`)
  lines.push(describeCadence(profile))
  lines.push(`Store: ${profile.store}`)
  const overrides = Object.entries(profile.thresholds)
  lines.push(`Threshold overrides: ${overrides.length > 0 ? overrides.map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`)
  lines.push(`Never again: ${profile.neverAgain.length > 0 ? profile.neverAgain.join('; ') : '—'}`)
  const b = profile.baselines
  if (b) {
    lines.push(`Baselines (${b.bucket} h, ${b.tier}, n=${b.n}, computed ${b.computedAt.slice(0, 10)}${b.shift ? ', SHIFTED since previous' : ''}):`)
    lines.push(statLine('CTR', b.ctr, '%'), statLine('AVP', b.avpPct, '%'), statLine('30 s retention', b.retention30sPct, '%'), statLine('returning share', b.returningPct, '%'), statLine('views', b.views, ''), statLine('impressions', b.impressions, ''))
  } else {
    lines.push('Baselines: none computed (run booster profile refresh once the ledger has rows aged 7 days or more)')
  }
  lines.push(`For verdicts: ${describeBaselineInput(baselineInputFrom(profile))}`)
  if (profile.updatedAt) lines.push(`Updated: ${profile.updatedAt}`)
  return lines.join('\n')
}
