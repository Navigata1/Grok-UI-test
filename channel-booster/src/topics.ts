/**
 * Topic radar: group ranked outliers across channels by what they are about,
 * diff two scans, and measure how many channels already carry a format.
 *
 * A topic key is built from a title's content tokens (titles.tokens()) with the
 * format and function words removed, so "I Tried Van Life for 30 Days" and
 * "Van Life: The Truth" both key to "life+van".
 */
import { ageInDays } from './outliers.js'
import { tokens } from './titles.js'
import type { OutlierRow, VideoRow } from './types.js'

/**
 * Words that describe a format or a frame, not a topic. tokens() already drops
 * the short stop words; this list removes the packaging vocabulary FORMAT_PATTERNS
 * detects so two titles about the same subject share a key regardless of frame.
 */
const TOPIC_STOP = new Set([
  'how', 'why', 'what', 'when', 'where', 'which', 'who', 'will', 'can', 'does', 'did', 'should', 'could', 'would',
  'into', 'from', 'about', 'than', 'then', 'they', 'them', 'their', 'there', 'these', 'those', 'this', 'here',
  'have', 'has', 'had', 'been', 'being', 'just', 'like', 'over', 'after', 'before', 'ever', 'every', 'all', 'any',
  'tried', 'trying', 'try', 'spent', 'survived', 'lived', 'living', 'built', 'build', 'building', 'made', 'make', 'making',
  'day', 'days', 'hour', 'hours', 'week', 'weeks', 'month', 'months', 'year', 'years', 'seconds', 'minutes',
  'thing', 'things', 'ways', 'tips', 'reasons', 'mistake', 'mistakes', 'secret', 'secrets', 'truth', 'nobody', 'one',
  'best', 'worst', 'top', 'new', 'most', 'only', 'really', 'actually', 'never', 'stop', 'dont', 'don', 'you', 'your',
  'versus', 'challenge', 'review', 'reviewed', 'tested', 'testing', 'ranked', 'ranking', 'guide', 'tutorial', 'explained',
  'update', 'vlog', 'video', 'episode', 'part', 'not', 'even', 'close', 'went', 'wrong', 'ruined', 'broke', 'quit',
  'get', 'got', 'until', 'while', 'with', 'without', 'more', 'less', 'much', 'many', 'some', 'very', 'still', 'again',
  'almost', 'always', 'cheap', 'expensive', 'cheaper', 'free', 'first', 'last', 'real', 'good', 'bad', 'big', 'small',
])

/** Content tokens of a title with format words and bare numbers removed, deduplicated in order of appearance. */
export function topicTokens(title: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens(title)) {
    if (TOPIC_STOP.has(t)) continue
    if (/^\$?\d+$/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * The topic key of a title: its two longest content tokens (ties broken
 * alphabetically), sorted alphabetically and joined with "+". One token when
 * only one survives; "" when nothing does.
 */
export function topicKey(title: string): string {
  const ranked = [...topicTokens(title)].sort((a, b) => b.length - a.length || a.localeCompare(b))
  return ranked.slice(0, 2).sort((a, b) => a.localeCompare(b)).join('+')
}

/** The fields of a ranked row that topicDemand() reads; OutlierRow and OutlierRowV2 both qualify. */
export type RankedLike = Pick<OutlierRow, 'title' | 'multiplier'> & Partial<Pick<OutlierRow, 'channel' | 'published' | 'views'>> & {
  tier?: string
  stale?: boolean
  velocityMultiplier?: number
}

export interface TopicDemand {
  topicKey: string
  /** Ranked rows that share the key. */
  count: number
  /** Highest multiplier among them. */
  bestMultiplier: number
  /** Title of the row with the highest multiplier. */
  bestTitle: string
  /** Distinct channels carrying the topic, in order of first appearance. */
  channels: string[]
  /** Rows in the "fresh" tier (momentum, not yet earned views). */
  fresh: number
  /** Rows flagged stale (outside the scan's window). */
  stale: number
}

/**
 * Group ranked rows by topic key. A topic three channels have each hit with an
 * outlier is demand; a topic one channel hit once may be that channel.
 * Rows with no content tokens are skipped. Sorted by best multiplier, then count.
 */
export function topicDemand(rows: ReadonlyArray<RankedLike>): TopicDemand[] {
  const groups = new Map<string, TopicDemand>()
  for (const row of rows) {
    const key = topicKey(row.title)
    if (!key) continue
    const channel = row.channel ?? 'default'
    const g = groups.get(key) ?? { topicKey: key, count: 0, bestMultiplier: -Infinity, bestTitle: row.title, channels: [], fresh: 0, stale: 0 }
    g.count += 1
    if (row.multiplier > g.bestMultiplier) {
      g.bestMultiplier = row.multiplier
      g.bestTitle = row.title
    }
    if (!g.channels.includes(channel)) g.channels.push(channel)
    if (row.tier === 'fresh') g.fresh += 1
    if (row.stale) g.stale += 1
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.bestMultiplier - a.bestMultiplier || b.count - a.count || a.topicKey.localeCompare(b.topicKey))
}

/** The fields diffScans() needs from a stored or freshly computed scan row. */
export type ScanRowLike = Pick<OutlierRow, 'title' | 'multiplier'> & Partial<Pick<OutlierRow, 'channel' | 'videoId' | 'url'>> & { tier?: string }

export interface MultiplierChange<T extends ScanRowLike = ScanRowLike> {
  row: T
  before: number
  after: number
  /** after - before */
  delta: number
  /** Tier before and after, when both scans carry one. */
  tierBefore?: string
  tierAfter?: string
}

export interface ScanDiff<T extends ScanRowLike = ScanRowLike> {
  /** Rows in `next` that were not in `prev`. */
  added: T[]
  /** Rows in `prev` that are gone from `next`. */
  removed: T[]
  /** Rows in both whose multiplier moved by at least `minDelta`, largest move first. */
  changed: MultiplierChange<T>[]
}

/** [house] Smallest multiplier move diffScans() reports by default; belongs in thresholds.ts as scanDiffMinDelta. */
export const SCAN_DIFF_MIN_DELTA = 0.5

function scanKey(row: ScanRowLike): string {
  if (row.videoId) return `id:${row.videoId}`
  if (row.url) return `url:${row.url.trim().toLowerCase()}`
  return `t:${(row.channel ?? 'default').toLowerCase()}|${row.title.trim().toLowerCase()}`
}

/**
 * What changed between last scan and this one: new titles, titles that
 * dropped out, and multiplier moves of at least `minDelta`. Rows match by
 * video id, else URL, else channel + title (case-insensitive).
 */
export function diffScans<T extends ScanRowLike>(prev: ReadonlyArray<T>, next: ReadonlyArray<T>, options: { minDelta?: number } = {}): ScanDiff<T> {
  const minDelta = options.minDelta ?? SCAN_DIFF_MIN_DELTA
  const before = new Map(prev.map((r) => [scanKey(r), r] as const))
  const after = new Map(next.map((r) => [scanKey(r), r] as const))
  const added = next.filter((r) => !before.has(scanKey(r)))
  const removed = prev.filter((r) => !after.has(scanKey(r)))
  const changed: MultiplierChange<T>[] = []
  for (const [key, row] of after) {
    const old = before.get(key)
    if (!old) continue
    const delta = row.multiplier - old.multiplier
    if (Math.abs(delta) < minDelta) continue
    const change: MultiplierChange<T> = { row, before: old.multiplier, after: row.multiplier, delta }
    if (old.tier !== undefined) change.tierBefore = old.tier
    if (row.tier !== undefined) change.tierAfter = row.tier
    changed.push(change)
  }
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.row.title.localeCompare(b.row.title))
  return { added, removed, changed }
}

export interface FormatSaturation {
  format: string
  /** Channels with at least one in-window title carrying the format. */
  channels: number
  /** Channels with at least one in-window title. */
  totalChannels: number
  /** channels / totalChannels */
  share: number
  /** share >= SATURATION_SHARE: most channels already carry it, so it is a copy, not a trend. */
  saturated: boolean
}

/** [house] Share of channels above which a format counts as saturated; belongs in thresholds.ts as saturationShare. */
export const SATURATION_SHARE = 0.5

/** The fields saturation() needs from a row: any ranked row qualifies. */
export type FormatRowLike = Partial<Pick<VideoRow, 'channel' | 'published'>> & { formats: ReadonlyArray<string> }

/**
 * Share of channels carrying each format among titles published within
 * `windowDays` of `now` (undated rows count as inside the window). A format
 * most competitors already run is discounted as an idea source: the audience
 * has seen it, so the lift belongs to whoever ran it first. Sorted by share.
 */
export function saturation(rows: ReadonlyArray<FormatRowLike>, windowDays = 90, now: Date = new Date()): FormatSaturation[] {
  const inWindow = rows.filter((r) => {
    const age = ageInDays(r.published, now)
    return age === undefined || age <= windowDays
  })
  const allChannels = new Set(inWindow.map((r) => r.channel ?? 'default'))
  const byFormat = new Map<string, Set<string>>()
  for (const row of inWindow) {
    for (const f of row.formats) {
      const set = byFormat.get(f) ?? new Set<string>()
      set.add(row.channel ?? 'default')
      byFormat.set(f, set)
    }
  }
  const total = allChannels.size
  const out: FormatSaturation[] = []
  for (const [format, set] of byFormat) {
    const share = total > 0 ? set.size / total : 0
    out.push({ format, channels: set.size, totalChannels: total, share, saturated: share >= SATURATION_SHARE })
  }
  return out.sort((a, b) => b.share - a.share || b.channels - a.channels || a.format.localeCompare(b.format))
}
