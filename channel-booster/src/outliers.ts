import { thresholds } from './thresholds.js'
import type { OutlierOptions, OutlierRow, VideoRow } from './types.js'

export const DEFAULT_OUTLIER_THRESHOLD = 10

/**
 * Fresh tier: a video at most this many days old whose velocity is at least
 * FRESH_VELOCITY_MULTIPLIER times its channel's median velocity is "fresh":
 * it has not had time to earn an outlier multiplier but is on pace for one.
 * [house] Both numbers belong in thresholds.ts (freshMaxAgeDays,
 * freshVelocityMultiplier); they live here until the thresholds owner moves them.
 */
export const FRESH_MAX_AGE_DAYS = 21
export const FRESH_VELOCITY_MULTIPLIER = 3

/** [house] Smallest baseline pool before the miner widens the window (then drops the age filter). */
const MIN_BASELINE_POOL = 3

/** Tier of a ranked row. "fresh" is new in v2 and is not part of types.ts's OutlierRow union. */
export type OutlierTier = 'outlier' | 'strong' | 'fresh' | 'normal'

/**
 * Outlier row v2: the shipped OutlierRow plus the demand-radar fields.
 * `tier` is widened to include "fresh", so an OutlierRowV2[] is NOT assignable
 * to OutlierRow[] (the CLI owner can widen OutlierRow['tier'] in types.ts to
 * make the two identical; see integration notes). Every other field is the same.
 */
export interface OutlierRowV2 extends Omit<OutlierRow, 'tier'> {
  tier: OutlierTier
  /** Published more than `sinceDays` ago: still ranked, but outside the demand window. */
  stale: boolean
  /** Views per day divided by the channel's median views per day (baseline pool). */
  velocityMultiplier?: number
}

/** Options for computeOutliers(). Every field of the shipped OutlierOptions still applies. */
export interface OutlierOptionsV2 extends OutlierOptions {
  /**
   * Only videos published within this many days enter the baseline pool; older
   * videos are still ranked but flagged `stale`. Default: thresholds.demandWindowDays (90).
   */
  sinceDays?: number
  /** Override FRESH_MAX_AGE_DAYS. */
  freshMaxAgeDays?: number
  /** Override FRESH_VELOCITY_MULTIPLIER. */
  freshVelocityMultiplier?: number
}

/** Median of a numeric list; 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Title-format cues. Each entry is a label plus the regex that detects it. */
const FORMAT_PATTERNS: Array<[string, RegExp]> = [
  ['list', /\b(top|best|worst)\s+\d+\b|\b\d+\s+(things|ways|tips|reasons|mistakes|secrets|tools|ideas|habits|rules|signs|lessons)\b/i],
  ['challenge', /\b(i tried|i spent|i survived|i lived|24 hours|48 hours|7 days|30 days|challenge|for a week|for a month|for a year)\b/i],
  ['versus', /\b(vs\.?|versus)\b/i],
  ['transformation', /\b(from .* to|turned|transformed|before and after|became|into a)\b/i],
  ['how-to', /\b(how to|how i|how we|how you|tutorial|guide|step by step)\b/i],
  ['question', /^(why|what|how|is|are|can|does|do|should|will)\b|\?$/i],
  ['extreme', /\b(world'?s|most|biggest|smallest|cheapest|fastest|slowest|hardest|easiest|impossible|insane|extreme|ultimate|only)\b|\$\d/i],
  ['reveal', /\b(secret|truth|nobody|no one|exposed|revealed|hidden|actually|really|real reason)\b/i],
  ['negative', /\b(never|stop|worst|mistake|mistakes|don'?t|wrong|fail|failed|ruined|broke|quit|dead|killed)\b/i],
  ['timebox', /\bin\s+\d+\s+(seconds|minutes|hours|days|weeks|months)\b/i],
  ['money', /\$\s?\d|\b\d+\s?[km]\b|\b(million|billion|money|rich|broke|cost|price|free)\b/i],
  ['story', /\b(the day|the time|story|what happened|happened when|until)\b/i],
  ['test', /\b(tested|testing|review|reviewed|rating|ranking|ranked|tier list)\b/i],
  // Sentence-initial only: "I Tried..." is first-person, "...Ruined My Batteries" is not.
  ['first-person', /^\s*(i|my|we|our)\b/i],
]

/** Extract the format cues present in a title. */
export function detectFormats(title: string): string[] {
  return FORMAT_PATTERNS.filter(([, re]) => re.test(title)).map(([label]) => label)
}

/** Days between a publish date and `now`; undefined when the date is missing or unparseable. Never negative. */
export function ageInDays(published: string | undefined, now: Date): number | undefined {
  if (!published) return undefined
  const t = Date.parse(published)
  if (Number.isNaN(t)) return undefined
  return Math.max(0, (now.getTime() - t) / 86_400_000)
}

/** Views per day since publish, counting the first day whole so a six-hour-old upload is not multiplied by four. */
function velocityOf(views: number, age: number | undefined): number | undefined {
  if (age === undefined) return undefined
  return views / Math.max(1, age)
}

/**
 * Rank videos by how far they outperform their channel's typical video.
 *
 * The baseline for each channel is the median view count of that channel's
 * videos in the input. The pool is narrowed in two steps: videos younger than
 * `minAgeDays` are dropped (they have not had time to earn views), then videos
 * older than `sinceDays` are dropped (the window the scorecard promises). If
 * fewer than three videos survive a step, the miner widens back to the previous
 * pool, so a small export still gets a baseline. Videos older than `sinceDays`
 * are ranked anyway and flagged `stale`.
 *
 * The multiplier is views / baseline, the same idea 1of10-style outlier tools
 * use: a 10x video is a format the audience is telling you they want more of.
 * `velocityMultiplier` is views per day against the pool's median views per day.
 * Videos younger than `minAgeDays` cannot have earned a multiplier yet, so they
 * are ranked by `velocityMultiplier` instead; everything else ranks by multiplier.
 *
 * Tiers: "outlier" at >= threshold, "strong" at >= half the threshold, "fresh"
 * for a normal-multiplier video aged <= FRESH_MAX_AGE_DAYS with
 * velocityMultiplier >= FRESH_VELOCITY_MULTIPLIER, else "normal".
 */
export function computeOutliers(rows: VideoRow[], options: OutlierOptionsV2 = {}): OutlierRowV2[] {
  const threshold = options.threshold ?? DEFAULT_OUTLIER_THRESHOLD
  const minAgeDays = options.minAgeDays ?? 0
  const sinceDays = options.sinceDays ?? thresholds.demandWindowDays.value
  const freshMaxAge = options.freshMaxAgeDays ?? thresholds.freshMaxAgeDays.value
  const freshVelocity = options.freshVelocityMultiplier ?? thresholds.freshVelocityMultiplier.value
  const now = options.now ?? new Date()

  const byChannel = new Map<string, VideoRow[]>()
  for (const row of rows) {
    const key = row.channel ?? 'default'
    const list = byChannel.get(key) ?? []
    list.push(row)
    byChannel.set(key, list)
  }

  const baselines = new Map<string, { views: number; velocity: number }>()
  for (const [channel, list] of byChannel) {
    const aged = list.filter((r) => {
      const age = ageInDays(r.published, now)
      return age === undefined || age >= minAgeDays
    })
    const windowed = aged.filter((r) => {
      const age = ageInDays(r.published, now)
      return age === undefined || age <= sinceDays
    })
    const pool = windowed.length >= MIN_BASELINE_POOL ? windowed : aged.length >= MIN_BASELINE_POOL ? aged : list
    const velocities = pool
      .map((r) => velocityOf(r.views, ageInDays(r.published, now)))
      .filter((v): v is number => v !== undefined)
    baselines.set(channel, { views: median(pool.map((r) => r.views)), velocity: median(velocities) })
  }

  const scored = rows.map((row) => {
    const base = baselines.get(row.channel ?? 'default') ?? { views: 0, velocity: 0 }
    const multiplier = base.views > 0 ? row.views / base.views : 0
    const age = ageInDays(row.published, now)
    const velocity = velocityOf(row.views, age)
    const velocityMultiplier = velocity !== undefined && base.velocity > 0 ? velocity / base.velocity : undefined
    const stale = age !== undefined && age > sinceDays
    const young = age !== undefined && age < minAgeDays
    let tier: OutlierTier = multiplier >= threshold ? 'outlier' : multiplier >= threshold / 2 ? 'strong' : 'normal'
    if (tier === 'normal' && age !== undefined && age <= freshMaxAge && velocityMultiplier !== undefined && velocityMultiplier >= freshVelocity) {
      tier = 'fresh'
    }
    const result: OutlierRowV2 = { ...row, multiplier, baseline: base.views, tier, stale, formats: detectFormats(row.title) }
    if (velocity !== undefined) result.velocity = velocity
    if (velocityMultiplier !== undefined) result.velocityMultiplier = velocityMultiplier
    const rank = young ? (velocityMultiplier ?? multiplier) : multiplier
    return { result, rank }
  })

  return scored
    .sort((a, b) => b.rank - a.rank || b.result.multiplier - a.result.multiplier || b.result.views - a.result.views)
    .map((s) => s.result)
}

export interface FormatLift {
  format: string
  /** Raw share of winning (outlier, strong, fresh) titles carrying this format. */
  shareInWinners: number
  /** Raw share of all titles carrying this format. */
  shareOverall: number
  /**
   * Laplace-smoothed shareInWinners / shareOverall; > 1 means the format
   * over-indexes among winners. Smoothing adds `alpha` pseudo-hits and `alpha`
   * pseudo-misses to both shares, so one winner in five rows lifts a format to
   * about 2.3, not 5.0.
   */
  lift: number
  /** Titles carrying this format. */
  count: number
  /** Winning titles carrying this format. */
  winners: number
  /** Fewer than `minCount` titles carry the format: the lift is a guess. Thin formats sort after solid ones. */
  thin: boolean
}

export interface FormatLiftOptions {
  /** Formats carried by fewer titles than this are flagged `thin` and ranked last. [house] Default 3. */
  minCount?: number
  /** Laplace pseudo-count applied to every share. Default 1. */
  alpha?: number
}

/** [house] Default minCount for formatLift(); belongs in thresholds.ts as formatLiftMinCount. */
export const FORMAT_LIFT_MIN_COUNT = 3

/** Rows formatLift() needs: any shipped OutlierRow or OutlierRowV2 qualifies. */
type LiftRow = { tier: OutlierTier; formats: ReadonlyArray<string> }

/**
 * Which title formats over-index among the winners in a ranked set.
 *
 * Nothing is dropped: a format carried by fewer than `minCount` titles is kept
 * with `thin: true` and sorted after the solid formats, so a five-row scan still
 * reports something and a 300-row scan is not led by a one-off.
 */
export function formatLift(rows: ReadonlyArray<LiftRow>, options: FormatLiftOptions = {}): FormatLift[] {
  if (rows.length === 0) return []
  const minCount = options.minCount ?? thresholds.formatLiftMinCount.value
  const alpha = options.alpha ?? 1
  const winners = rows.filter((r) => r.tier !== 'normal')
  const counts = new Map<string, { all: number; winners: number }>()
  for (const row of rows) {
    for (const f of row.formats) {
      const c = counts.get(f) ?? { all: 0, winners: 0 }
      c.all += 1
      if (row.tier !== 'normal') c.winners += 1
      counts.set(f, c)
    }
  }
  const smooth = (hits: number, n: number): number => (hits + alpha) / (n + 2 * alpha)
  const lifts: FormatLift[] = []
  for (const [format, c] of counts) {
    const shareOverall = c.all / rows.length
    const shareInWinners = winners.length > 0 ? c.winners / winners.length : 0
    const smoothedOverall = smooth(c.all, rows.length)
    const smoothedWinners = winners.length > 0 ? smooth(c.winners, winners.length) : 0
    lifts.push({
      format,
      shareInWinners,
      shareOverall,
      lift: smoothedOverall > 0 ? smoothedWinners / smoothedOverall : 0,
      count: c.all,
      winners: c.winners,
      thin: c.all < minCount,
    })
  }
  return lifts.sort((a, b) => Number(a.thin) - Number(b.thin) || b.lift - a.lift || b.count - a.count || a.format.localeCompare(b.format))
}
