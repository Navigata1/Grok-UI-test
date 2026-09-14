/**
 * Direction: the channel's bets (proven formats, series with their
 * returning-share trend, the "never again" packaging list) and the shot list
 * a shoot runs from. Section 2.8 of docs/03-system-architecture.md.
 *
 * `buildDirection()` reads the profile, the ledger, the audit's own scan and
 * the bank; it is pure and deterministic (no clock, no store, no network).
 * `shotList()` turns a package and a story report into named setups: one per
 * A/B thumbnail concept, one shot per payoff-ladder moment, B-roll per rehook,
 * and the first 30 seconds. Both have a Markdown renderer.
 *
 * Doctrine: playbook/channel-audit.md (proven formats at 5x, bottom quartile
 * is the never-again list, format lift picks the next five), R6, R7, R9 of
 * docs/02-strategist-playbook.md, and playbook/first-30-seconds.md.
 */
import { formatSec, type RehookDevice, type ThumbnailMomentPosition } from './hook.js'
import { ownOutliers } from './ledger-core.js'
import { detectFormats, formatLift, median, type OutlierTier } from './outliers.js'
import type { IdeaDoc, LedgerRow, ProfileDoc } from './schema.js'
import { thresholds } from './thresholds.js'
import type { WorkflowFormat } from './types.js'
import { slugify } from './workflow.js'

/**
 * [house] Returning share must move by at least this many percentage points
 * between the earlier and later half of a series before the trend is called
 * up or down; inside the band it is flat. Belongs in thresholds.ts as
 * `seriesReturningTrendPts` once the thresholds owner adds it.
 */
export const RETURNING_TREND_DELTA_PTS = 3

/**
 * [house] A packaging pattern joins the never-again list when at least this
 * share of the bottom-quartile titles carry it and it is more common there
 * than among the rest. Belongs in thresholds.ts as `neverAgainMinShare`.
 */
export const NEVER_AGAIN_MIN_SHARE = 0.5

/** [house] Fewest ledger rows with a 168-hour view count before a bottom quartile is computed (a quartile of three is one video). */
export const NEVER_AGAIN_MIN_ROWS = 4

/** [house] How many bets `buildDirection` names. */
export const BET_COUNT = 3

/**
 * Words that make a title generic: they name the container, not the promise.
 * A bottom-quartile title carrying one is flagged "generic words".
 */
export const GENERIC_TITLE_WORDS: readonly string[] = [
  'update', 'vlog', 'q&a', 'qa', 'thoughts', 'random', 'stuff', 'things', 'my day', 'new video', 'episode', 'part',
  'chat', 'talk', 'ramble', 'rambling', 'misc', 'monthly', 'weekly', 'recap', 'news', 'announcement', 'channel', 'life',
]

/** A row from the audit scan as `formatLift` needs it: any `OutlierRow` or `OutlierRowV2` qualifies. */
export interface ScanRowLike {
  title: string
  tier: OutlierTier
  formats: ReadonlyArray<string>
  multiplier?: number
  videoId?: string
  slug?: string
}

/** A format the channel has proven, with where the proof comes from. */
export interface ProvenFormat {
  format: string
  /** Ledger slugs (own outliers) and scan titles (winners carrying the format). */
  evidence: string[]
  /** Own-outlier rows carrying the format. */
  ledgerWins: number
  /** `formatLift` on the audit scan, when the scan was given and the format was not thin. */
  lift?: number
  source: 'ledger' | 'scan' | 'both'
}

export type ReturningTrend = 'up' | 'flat' | 'down' | 'unknown'

/** One series from the profile with the ledger videos that belong to it. */
export interface SeriesDirection {
  name: string
  promise: string
  cadence?: string
  parentSlug?: string
  /** Ledger slugs in publish order. */
  videos: string[]
  /** 168-hour returning share per video, in publish order, for the videos that have one. */
  returningPcts: number[]
  returningTrend: ReturningTrend
  /** Bank ideas tagged to this series. */
  ideas: number
}

/** A never-again pattern with its evidence. */
export interface NeverAgainFinding {
  pattern: string
  /** Bottom-quartile slugs carrying the pattern. */
  slugs: string[]
  /** Rows in the bottom quartile. */
  bottomCount: number
  /** Share of the bottom quartile carrying the pattern. */
  share: number
  /** Share of the other rows carrying the pattern. */
  restShare: number
}

/** One bet: a format or a series to lean on next. */
export interface DirectionBet {
  kind: 'format' | 'series'
  name: string
  reason: string
}

export interface Direction {
  positioning?: string
  persona?: string
  provenFormats: ProvenFormat[]
  series: SeriesDirection[]
  /** `profile.neverAgain` plus the bottom-quartile findings, de-duplicated. */
  neverAgain: string[]
  neverAgainFindings: NeverAgainFinding[]
  bets: DirectionBet[]
  /** Bank ideas keyed by series name; series the bank names that the profile does not are included too. */
  ideasBySeries: Record<string, IdeaDoc[]>
  /** Bank ideas with no series. */
  unassignedIdeas: IdeaDoc[]
  /** Ledger rows with a 168-hour view count (the sample behind the quartile). */
  sampleSize: number
  thresholdsUsed: string[]
}

export interface DirectionInput {
  profile: ProfileDoc
  ledgerRows: LedgerRow[]
  /** The audit's ranked scan of the channel's own uploads. */
  ownScan?: ReadonlyArray<ScanRowLike>
  /** The bank. */
  ideas?: ReadonlyArray<IdeaDoc>
}

function views168(row: LedgerRow): number | undefined {
  return row.reads['168']?.views
}

function byPublish(a: LedgerRow, b: LedgerRow): number {
  return Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.slug.localeCompare(b.slug)
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = v.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/** Proven formats: own outliers' title cues, plus formats with lift > 1 on the audit scan. */
function provenFormatsFrom(rows: LedgerRow[], scan: ReadonlyArray<ScanRowLike> | undefined): ProvenFormat[] {
  const map = new Map<string, ProvenFormat>()
  for (const { row } of ownOutliers(rows)) {
    for (const format of detectFormats(row.title)) {
      const entry = map.get(format) ?? { format, evidence: [], ledgerWins: 0, source: 'ledger' }
      entry.evidence.push(row.slug)
      entry.ledgerWins += 1
      map.set(format, entry)
    }
  }
  if (scan && scan.length > 0) {
    for (const lift of formatLift(scan)) {
      if (lift.thin || lift.lift <= 1 || lift.winners === 0) continue
      const titles = scan.filter((r) => r.tier !== 'normal' && r.formats.includes(lift.format)).map((r) => r.title)
      const existing = map.get(lift.format)
      if (existing) {
        existing.lift = lift.lift
        existing.source = 'both'
        existing.evidence.push(...titles)
      } else {
        map.set(lift.format, { format: lift.format, evidence: titles, ledgerWins: 0, lift: lift.lift, source: 'scan' })
      }
    }
  }
  return [...map.values()]
    .map((f) => ({ ...f, evidence: unique(f.evidence) }))
    .sort((a, b) => b.ledgerWins - a.ledgerWins || (b.lift ?? 0) - (a.lift ?? 0) || b.evidence.length - a.evidence.length || a.format.localeCompare(b.format))
}

/** True when the row belongs to the series by parent slug, sequel chain, slug prefix, title mention, or a bank idea's package id. */
function belongsToSeries(row: LedgerRow, series: ProfileDoc['series'][number], rows: LedgerRow[], ideas: ReadonlyArray<IdeaDoc>): boolean {
  if (series.parentSlug && row.slug === series.parentSlug) return true
  if (series.parentSlug) {
    const seen = new Set<string>()
    let cursor: LedgerRow | undefined = row
    while (cursor?.sequelOf && !seen.has(cursor.slug)) {
      seen.add(cursor.slug)
      if (cursor.sequelOf === series.parentSlug) return true
      const parentSlug: string = cursor.sequelOf
      cursor = rows.find((r) => r.slug === parentSlug)
    }
  }
  const key = slugify(series.name)
  if (key !== 'video' && row.slug.startsWith(`${key}-`)) return true
  if (row.title.toLowerCase().includes(series.name.toLowerCase())) return true
  return ideas.some((i) => i.series === series.name && i.packageId === row.slug)
}

/**
 * Trend of returning share across a series: the median of the later half
 * against the median of the earlier half, called up or down only past
 * `RETURNING_TREND_DELTA_PTS`. Fewer than two readings is `unknown`.
 */
export function returningTrendOf(returningPcts: ReadonlyArray<number>, deltaPts = RETURNING_TREND_DELTA_PTS): ReturningTrend {
  if (returningPcts.length < 2) return 'unknown'
  const split = Math.floor(returningPcts.length / 2)
  const earlier = median(returningPcts.slice(0, split))
  const later = median(returningPcts.slice(split))
  if (later - earlier >= deltaPts) return 'up'
  if (earlier - later >= deltaPts) return 'down'
  return 'flat'
}

function seriesFrom(profile: ProfileDoc, rows: LedgerRow[], ideas: ReadonlyArray<IdeaDoc>): SeriesDirection[] {
  const sorted = [...rows].sort(byPublish)
  return profile.series.map((s) => {
    const videos = sorted.filter((r) => belongsToSeries(r, s, rows, ideas))
    const returningPcts = videos.map((r) => r.reads['168']?.returningPct).filter((v): v is number => typeof v === 'number')
    return {
      name: s.name,
      promise: s.promise,
      ...(s.cadence ? { cadence: s.cadence } : {}),
      ...(s.parentSlug ? { parentSlug: s.parentSlug } : {}),
      videos: videos.map((r) => r.slug),
      returningPcts,
      returningTrend: returningTrendOf(returningPcts),
      ideas: ideas.filter((i) => i.series === s.name).length,
    }
  })
}

/** Format cues that carry a stake or a question; a title with none of them is flat. */
const STAKE_FORMATS = ['question', 'extreme', 'negative', 'reveal', 'money', 'challenge']

/** Packaging patterns a title can carry, in the order the never-again list prints them. Built per call so threshold overrides apply. */
function titlePatterns(): Array<{ pattern: string; test: (title: string) => boolean }> {
  const maxChars = thresholds.titleMaxChars.value
  return [
    { pattern: 'no number in the title', test: (t) => !/\d/.test(t) },
    { pattern: `title over ${maxChars} characters`, test: (t) => t.trim().length > maxChars },
    { pattern: 'generic words in the title', test: (t) => hasGenericWord(t) },
    { pattern: 'no stake or question in the title', test: (t) => detectFormats(t).every((f) => !STAKE_FORMATS.includes(f)) },
  ]
}

/** True when the title carries one of `GENERIC_TITLE_WORDS` as a whole word. */
export function hasGenericWord(title: string): boolean {
  const lower = ` ${title.toLowerCase().replace(/[^a-z0-9&]+/g, ' ')} `
  return GENERIC_TITLE_WORDS.some((w) => lower.includes(` ${w} `))
}

/**
 * The bottom quartile of the ledger by 168-hour views and what its titles
 * share. Needs `NEVER_AGAIN_MIN_ROWS` rows with a 168-hour read.
 */
export function neverAgainFrom(rows: LedgerRow[]): NeverAgainFinding[] {
  const withViews = rows.filter((r) => views168(r) !== undefined).sort((a, b) => views168(a)! - views168(b)! || byPublish(a, b))
  if (withViews.length < NEVER_AGAIN_MIN_ROWS) return []
  const cut = Math.max(1, Math.floor(withViews.length / 4))
  const bottom = withViews.slice(0, cut)
  const rest = withViews.slice(cut)
  const findings: NeverAgainFinding[] = []
  for (const { pattern, test } of titlePatterns()) {
    const hits = bottom.filter((r) => test(r.title))
    const share = hits.length / bottom.length
    const restShare = rest.length > 0 ? rest.filter((r) => test(r.title)).length / rest.length : 0
    if (share >= NEVER_AGAIN_MIN_SHARE && share > restShare) findings.push({ pattern, slugs: hits.map((r) => r.slug), bottomCount: bottom.length, share, restShare })
  }
  return findings
}

function describeFinding(f: NeverAgainFinding): string {
  return `${f.pattern} (${f.slugs.length} of the bottom ${f.bottomCount} by 7-day views: ${f.slugs.join(', ')})`
}

function pct(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

function betsFrom(formats: ProvenFormat[], series: SeriesDirection[]): DirectionBet[] {
  const bets: DirectionBet[] = []
  const trendRank: Record<ReturningTrend, number> = { up: 0, flat: 1, unknown: 2, down: 3 }
  const rankedSeries = [...series].sort((a, b) => trendRank[a.returningTrend] - trendRank[b.returningTrend] || b.videos.length - a.videos.length || b.ideas - a.ideas || a.name.localeCompare(b.name))
  const seriesBet = (s: SeriesDirection): DirectionBet => {
    const trend = s.returningTrend === 'up' ? `returning share rising (${s.returningPcts.map(pct).join(' → ')})` : s.returningTrend === 'flat' ? `returning share holding (${s.returningPcts.map(pct).join(' → ')})` : s.returningTrend === 'unknown' ? 'returning share not read yet' : `returning share falling (${s.returningPcts.map(pct).join(' → ')})`
    return { kind: 'series', name: s.name, reason: `${s.videos.length} video${s.videos.length === 1 ? '' : 's'}, ${s.ideas} banked idea${s.ideas === 1 ? '' : 's'}, ${trend}` }
  }
  const formatBet = (f: ProvenFormat): DirectionBet => {
    const parts: string[] = []
    if (f.ledgerWins > 0) parts.push(`${f.ledgerWins} own outlier${f.ledgerWins === 1 ? '' : 's'} (${f.evidence.slice(0, f.ledgerWins).join(', ')})`)
    if (f.lift !== undefined) parts.push(`lift ${f.lift.toFixed(1)}x among winners`)
    return { kind: 'format', name: f.format, reason: parts.join('; ') }
  }
  for (const s of rankedSeries.filter((x) => x.returningTrend === 'up')) bets.push(seriesBet(s))
  for (const f of formats) bets.push(formatBet(f))
  for (const s of rankedSeries.filter((x) => x.returningTrend === 'flat' || x.returningTrend === 'unknown')) bets.push(seriesBet(s))
  return bets.slice(0, BET_COUNT)
}

/**
 * The channel's direction: positioning and persona from the profile, proven
 * formats from the ledger's own outliers (`ownWinnerMultiplier`) and the scan's
 * format lift, each profile series with its videos and returning trend, the
 * never-again list (profile plus bottom-quartile findings), the bets to lean
 * on next, and the bank grouped by series. Pure.
 */
export function buildDirection(input: DirectionInput): Direction {
  const { profile, ledgerRows } = input
  const ideas = input.ideas ?? []
  const provenFormats = provenFormatsFrom(ledgerRows, input.ownScan)
  const series = seriesFrom(profile, ledgerRows, ideas)
  const neverAgainFindings = neverAgainFrom(ledgerRows)
  const neverAgain = unique([...profile.neverAgain, ...neverAgainFindings.map(describeFinding)])
  const ideasBySeries: Record<string, IdeaDoc[]> = {}
  for (const s of profile.series) ideasBySeries[s.name] = []
  const unassignedIdeas: IdeaDoc[] = []
  for (const idea of ideas) {
    if (!idea.series) {
      unassignedIdeas.push(idea)
      continue
    }
    ;(ideasBySeries[idea.series] ??= []).push(idea)
  }
  return {
    ...(profile.positioning ? { positioning: profile.positioning } : {}),
    ...(profile.persona ? { persona: profile.persona } : {}),
    provenFormats,
    series,
    neverAgain,
    neverAgainFindings,
    bets: betsFrom(provenFormats, series),
    ideasBySeries,
    unassignedIdeas,
    sampleSize: ledgerRows.filter((r) => views168(r) !== undefined).length,
    thresholdsUsed: [
      `ownWinnerMultiplier=${thresholds.ownWinnerMultiplier.value} [${thresholds.ownWinnerMultiplier.evidence}]`,
      `titleMaxChars=${thresholds.titleMaxChars.value} [${thresholds.titleMaxChars.evidence}]`,
      `formatLiftMinCount=${thresholds.formatLiftMinCount.value} [${thresholds.formatLiftMinCount.evidence}]`,
      `returningTrendDeltaPts=${RETURNING_TREND_DELTA_PTS} [house]`,
      `neverAgainMinShare=${NEVER_AGAIN_MIN_SHARE} [house]`,
    ],
  }
}

/** Markdown for `booster direction`: positioning, bets, proven formats, series, never again, bank by series. */
export function renderDirectionMarkdown(direction: Direction): string {
  const lines: string[] = []
  lines.push('# Direction')
  lines.push('')
  lines.push(`Positioning: ${direction.positioning ?? '— (run booster profile init)'}`)
  lines.push('')
  lines.push(`Returning viewer: ${direction.persona ?? '—'}`)
  lines.push('')
  lines.push('## Bets')
  lines.push('')
  if (direction.bets.length === 0) lines.push('- No bets yet: the ledger has no 5x winner and the profile no series. Run booster audit and add a series to channel.json.')
  for (const b of direction.bets) lines.push(`- ${b.kind === 'series' ? 'Series' : 'Format'} **${b.name}**: ${b.reason}`)
  lines.push('')
  lines.push('## Proven formats')
  lines.push('')
  if (direction.provenFormats.length === 0) {
    lines.push('None yet: no ledger row at the own-winner multiple and no format over-indexing in the scan.')
  } else {
    lines.push('| Format | Own wins | Lift | Evidence |')
    lines.push('| --- | --- | --- | --- |')
    for (const f of direction.provenFormats) lines.push(`| ${f.format} | ${f.ledgerWins} | ${f.lift === undefined ? '—' : `${f.lift.toFixed(1)}x`} | ${f.evidence.join('; ')} |`)
  }
  lines.push('')
  lines.push('## Series')
  lines.push('')
  if (direction.series.length === 0) {
    lines.push('No series in channel.json. A series is a promise the returning viewer comes back for (R7).')
  } else {
    lines.push('| Series | Promise | Videos | Returning trend | Banked ideas |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const s of direction.series) {
      const trend = s.returningPcts.length > 0 ? `${s.returningTrend} (${s.returningPcts.map(pct).join(' → ')})` : s.returningTrend
      lines.push(`| ${s.name} | ${s.promise}${s.cadence ? ` (${s.cadence})` : ''} | ${s.videos.length > 0 ? s.videos.join(', ') : '—'} | ${trend} | ${s.ideas} |`)
    }
  }
  lines.push('')
  lines.push('## Never again')
  lines.push('')
  if (direction.neverAgain.length === 0) {
    lines.push(`Nothing yet (needs ${NEVER_AGAIN_MIN_ROWS} ledger rows with a 7-day read, or entries in channel.json).`)
  } else {
    for (const n of direction.neverAgain) lines.push(`- ${n}`)
  }
  lines.push('')
  lines.push('## Bank by series')
  lines.push('')
  const names = Object.keys(direction.ideasBySeries)
  if (names.length === 0 && direction.unassignedIdeas.length === 0) lines.push('The bank is empty.')
  for (const name of names) {
    const list = direction.ideasBySeries[name]
    const known = direction.series.some((s) => s.name === name)
    lines.push(`- ${name}${known ? '' : ' (not in channel.json)'}: ${list.length === 0 ? 'no ideas banked' : list.map((i) => `${i.idea} [${i.status}]`).join('; ')}`)
  }
  if (direction.unassignedIdeas.length > 0) lines.push(`- No series: ${direction.unassignedIdeas.map((i) => `${i.idea} [${i.status}]`).join('; ')}`)
  lines.push('')
  lines.push(`Thresholds: ${direction.thresholdsUsed.join(', ')}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Shot list
// ---------------------------------------------------------------------------

/** A thumbnail concept as the package records it; every field past `name`, `focalSubject` and `elements` is optional. */
export interface ShotListThumbnail {
  name: string
  focalSubject: string
  emotion?: string
  elements: string[]
  text?: string
  background?: string
  colors?: string[]
  composition?: string
}

/** The subset of `packages/<slug>/package.json` the shot list needs. */
export interface ShotListPackage {
  chosenTitle?: string
  promise: string
  thumbnails: ShotListThumbnail[]
  /** The Test & Compare pair by concept name; without it every concept gets a setup. */
  abPick?: { a: string; b: string }
}

/** The subset of `packages/<slug>/story.json` the shot list needs. */
export interface ShotListStory {
  payoffLadder: Array<{ atSec: number; moment: string }>
  rehooks: Array<{ atSec: number; line: string; device?: RehookDevice }>
  thumbnailMomentPosition?: ThumbnailMomentPosition
  thumbnailMomentAtSec?: number
}

export interface ShotListInput {
  pkg: ShotListPackage
  story: ShotListStory
  format?: WorkflowFormat
}

export interface Shot {
  shot: string
  framing: string
  notes: string
}

export interface ShotSetup {
  name: string
  purpose: string
  shots: Shot[]
}

export interface ShotList {
  title: string
  promise: string
  setups: ShotSetup[]
  /** The format's production note, when a format was given. */
  formatNotes: string[]
}

/** Production notes per format, in the style of workflow.ts FORMAT_EXTRAS; only the shoot-side lines. */
export const SHOT_FORMAT_NOTES: Record<WorkflowFormat, string[]> = {
  'talking-head': ['Record the first 30 seconds three times; pick the take that states the promise fastest.', 'Capture B-roll for every claim you make.'],
  documentary: ['Shoot the ending first so the open can tease it honestly.', 'Record ambient sound and a wide establishing shot for every location.'],
  tutorial: ['Show the finished result before step one: shoot the result plate first.', 'Record screen and face separately; get an insert of every step the hands do.'],
  challenge: ['State the rules and the stake on camera in the first take.', 'Film every failure; failures are the retention. Keep a camera rolling between attempts.'],
  vlog: ['Decide the one story before you start the day; everything else is B-roll.', 'Film the moment of change, not the setup.'],
  listicle: ['Get a concrete visual for every item.', 'Shoot the number-one item with the most care; it is teased in the open.'],
  interview: ['Record a clean reaction shot of the host for every story.', 'Light for two cameras so the cut never waits on a question.'],
}

const REHOOK_FRAMING: Record<RehookDevice, string> = {
  question: 'insert of the thing being asked about, held long enough to read',
  reveal: 'close on the reveal, then a wide to see the reaction',
  escalation: 'wide on the stake, then a tighter push-in',
}

/** Verb families that mark a payoff as a result, a failure, or a setup; inflections included so "fails" and "breaks" read the same as "fail" and "broke". */
const RESULT_MOMENT = /\b(reveals?|revealed|results?|finally|works?|worked|succeeds?|succeeded|success|wins?|won)\b/
const FAILURE_MOMENT = /\b(fails?|failed|failure|failing|broke|breaks?|broken|wrong|disaster|lost|loses?|dies?|died)\b/
const SETUP_MOMENT = /\b(before|starts?|started|setup|set up|plans?)\b/

/** Framing for a payoff-ladder moment from its wording; results push in, failures go wide, setups establish. */
export function framingFor(moment: string): string {
  const lower = moment.toLowerCase()
  if (RESULT_MOMENT.test(lower)) return 'medium to close, push in on the result'
  if (FAILURE_MOMENT.test(lower)) return 'wide so the failure reads, then close on the face'
  if (SETUP_MOMENT.test(lower)) return 'wide establishing, then medium'
  return 'medium, cover with a wide and an insert'
}

function pickConcepts(pkg: ShotListPackage): Array<{ label: string; concept: ShotListThumbnail }> {
  const byName = (name: string): ShotListThumbnail | undefined => pkg.thumbnails.find((t) => t.name === name)
  if (pkg.abPick) {
    const picked = [
      { label: 'A', concept: byName(pkg.abPick.a) },
      { label: 'B', concept: byName(pkg.abPick.b) },
    ].filter((x): x is { label: string; concept: ShotListThumbnail } => x.concept !== undefined)
    if (picked.length > 0) return picked
  }
  return pkg.thumbnails.map((concept, i) => ({ label: String.fromCharCode(65 + i), concept }))
}

function thumbnailSetup(label: string, concept: ShotListThumbnail, story: ShotListStory): ShotSetup {
  const focal = concept.focalSubject.trim()
  const props = concept.elements.map((e) => e.trim()).filter((e) => e && e.toLowerCase() !== focal.toLowerCase() && (!concept.text || e.toLowerCase() !== concept.text.toLowerCase()))
  const emotion = concept.emotion && concept.emotion.toLowerCase() !== 'none' ? concept.emotion : undefined
  const framing = concept.composition ?? `tight on ${focal}${props.length > 0 ? `, ${props[0]} in frame` : ''}`
  const when = story.thumbnailMomentAtSec !== undefined ? `at ${formatSec(story.thumbnailMomentAtSec)} in the script` : story.thumbnailMomentPosition === 'missing' || story.thumbnailMomentPosition === undefined ? 'not in the script yet: stage it and write it in' : `in the ${story.thumbnailMomentPosition.replace('-', ' ')} of the script`
  const shots: Shot[] = [
    {
      shot: `Hero frame: ${focal}${emotion ? `, ${emotion}` : ''}`,
      framing,
      notes: `${emotion ? `Hold the ${emotion} expression for three seconds; ` : ''}shoot stills and video of the same frame. The moment happens on screen, ${when}.`,
    },
  ]
  if (props.length > 0) shots.push({ shot: `Props: ${props.join(', ')}`, framing: 'same frame, props readable at 120px wide', notes: 'One subject, one support; anything the eye does not land on first comes out.' })
  if (concept.background) shots.push({ shot: `Background: ${concept.background}`, framing: 'clean plate of the background without the subject', notes: 'Gives the designer a plate to composite against.' })
  if (concept.colors && concept.colors.length > 0) shots.push({ shot: `Colours: ${concept.colors.join('/')}`, framing: 'light and dress so the pair dominates', notes: 'Check contrast against the channel signature before the shoot wraps.' })
  if (concept.text) shots.push({ shot: `Leave room for text "${concept.text}"`, framing: 'negative space on the side opposite the subject', notes: 'Text is added in the design pass; do not put it in the frame.' })
  return {
    name: `Thumbnail moment (${label}: ${concept.name})`,
    purpose: `The frame the ${label} thumbnail shows, shot for real so the promise is kept on screen.`,
    shots,
  }
}

/**
 * The shot list for a shoot: one setup per A/B thumbnail concept (expression,
 * props from the elements, background, colours), one shot per payoff-ladder
 * moment, B-roll per rehook, and the first 30 seconds. `format` adds the
 * shoot-side production notes from `SHOT_FORMAT_NOTES`.
 */
export function shotList(input: ShotListInput): ShotList {
  const { pkg, story } = input
  const title = pkg.chosenTitle ?? pkg.promise
  const setups: ShotSetup[] = pickConcepts(pkg).map(({ label, concept }) => thumbnailSetup(label, concept, story))
  if (setups.length === 0) {
    setups.push({
      name: 'Thumbnail moment',
      purpose: 'The frame the thumbnail shows, shot for real so the promise is kept on screen.',
      shots: [{ shot: 'No thumbnail concept in the package', framing: '—', notes: 'Build the package first (booster package build); the thumbnail moment cannot be staged without a concept.' }],
    })
  }

  const ladder = [...story.payoffLadder].sort((a, b) => a.atSec - b.atSec)
  setups.push({
    name: 'Payoff ladder',
    purpose: 'One shot per payoff moment: proof the video delivers, in story order.',
    shots: ladder.length === 0
      ? [{ shot: 'No payoff moments in the story', framing: '—', notes: 'story.json has an empty payoffLadder: run booster ai retention-map --script <file> --out payoffs.json, then booster hook score --script <file> --slug <slug> --payoffs payoffs.json, then plan shots again.' }]
      : ladder.map((m, i) => ({
          shot: `${formatSec(m.atSec)} ${m.moment}`,
          framing: framingFor(m.moment),
          notes: i === ladder.length - 1 ? 'The biggest payoff: shoot it first so the open can tease it honestly.' : 'Get the moment and the reaction; the cut needs both.',
        })),
  })

  const rehooks = [...story.rehooks].sort((a, b) => a.atSec - b.atSec)
  setups.push({
    name: 'B-roll for rehooks',
    purpose: `Cover for every rehook so the cut never sits on a face while a new question lands (max gap ${thresholds.rehookMaxGapSec.value} s).`,
    shots: rehooks.length === 0
      ? [{ shot: 'No rehooks in the story', framing: '—', notes: 'Every 60 to 90 s needs a new question, reveal or escalation; write them in, then shoot their B-roll.' }]
      : rehooks.map((r) => ({
          shot: `B-roll under "${r.line}" (${formatSec(r.atSec)})`,
          framing: r.device ? REHOOK_FRAMING[r.device] : 'insert that shows the thing the line is about',
          notes: `${r.device ?? 'rehook'}: the picture must earn the next 60 s on its own.`,
        })),
  })

  const firstPayoff = ladder[0]
  setups.push({
    name: 'First 30 seconds',
    purpose: 'Prove inside ten seconds that the click was right (playbook/first-30-seconds.md).',
    shots: [
      { shot: `0-5 s: show or state the promise "${pkg.promise}"`, framing: 'tight, eye line to lens', notes: `The viewer must see the thing they clicked for. Title on the desk: "${title}".` },
      { shot: '5-15 s: the stake or the question', framing: 'medium, cut to the tease of the thumbnail moment', notes: `Tease the thumbnail frame${story.thumbnailMomentAtSec !== undefined ? ` (it lands at ${formatSec(story.thumbnailMomentAtSec)})` : ''}; show it, do not describe it.` },
      { shot: '15-30 s: the roadmap in one line, then start', framing: 'medium, then straight into the first beat', notes: `No channel intro, no "before we begin", no logo.${firstPayoff ? ` First payoff lands at ${formatSec(firstPayoff.atSec)}.` : ''}` },
    ],
  })

  return { title, promise: pkg.promise, setups, formatNotes: input.format ? SHOT_FORMAT_NOTES[input.format] : [] }
}

/** Markdown for `booster plan shots <slug>`: one section per setup, a table of shots, format notes at the end. */
export function renderShotListMarkdown(list: ShotList): string {
  const lines: string[] = []
  lines.push(`# Shot list: ${list.title}`)
  lines.push('')
  lines.push(`Promise: ${list.promise}`)
  lines.push('')
  list.setups.forEach((setup, i) => {
    lines.push(`## ${i + 1}. ${setup.name}`)
    lines.push('')
    lines.push(setup.purpose)
    lines.push('')
    lines.push('| Shot | Framing | Notes |')
    lines.push('| --- | --- | --- |')
    for (const s of setup.shots) lines.push(`| ${s.shot} | ${s.framing} | ${s.notes} |`)
    lines.push('')
  })
  if (list.formatNotes.length > 0) {
    lines.push('## Format notes')
    lines.push('')
    for (const n of list.formatNotes) lines.push(`- ${n}`)
    lines.push('')
  }
  return lines.join('\n')
}
