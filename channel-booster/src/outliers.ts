import type { OutlierOptions, OutlierRow, VideoRow } from './types.js'

export const DEFAULT_OUTLIER_THRESHOLD = 10

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
  ['first-person', /\b(i|my|me|we|our)\b/i],
]

/** Extract the format cues present in a title. */
export function detectFormats(title: string): string[] {
  return FORMAT_PATTERNS.filter(([, re]) => re.test(title)).map(([label]) => label)
}

function ageDays(published: string | undefined, now: Date): number | undefined {
  if (!published) return undefined
  const t = Date.parse(published)
  if (Number.isNaN(t)) return undefined
  return Math.max(0, (now.getTime() - t) / 86_400_000)
}

/**
 * Rank videos by how far they outperform their channel's typical video.
 *
 * The baseline for each channel is the median view count of that channel's
 * videos in the input (after dropping videos younger than `minAgeDays`).
 * The multiplier is views ÷ baseline, which is the same idea 1of10-style
 * outlier tools use: a 10x video is a format the audience is telling you
 * they want more of.
 */
export function computeOutliers(rows: VideoRow[], options: OutlierOptions = {}): OutlierRow[] {
  const threshold = options.threshold ?? DEFAULT_OUTLIER_THRESHOLD
  const minAgeDays = options.minAgeDays ?? 0
  const now = options.now ?? new Date()

  const byChannel = new Map<string, VideoRow[]>()
  for (const row of rows) {
    const key = row.channel ?? 'default'
    const list = byChannel.get(key) ?? []
    list.push(row)
    byChannel.set(key, list)
  }

  const baselines = new Map<string, number>()
  for (const [channel, list] of byChannel) {
    const eligible = list.filter((r) => {
      const age = ageDays(r.published, now)
      return age === undefined || age >= minAgeDays
    })
    const pool = eligible.length >= 3 ? eligible : list
    baselines.set(channel, median(pool.map((r) => r.views)))
  }

  const out: OutlierRow[] = rows.map((row) => {
    const baseline = baselines.get(row.channel ?? 'default') ?? 0
    const multiplier = baseline > 0 ? row.views / baseline : 0
    const age = ageDays(row.published, now)
    const velocity = age !== undefined && age > 0 ? row.views / age : undefined
    const tier: OutlierRow['tier'] = multiplier >= threshold ? 'outlier' : multiplier >= threshold / 2 ? 'strong' : 'normal'
    const result: OutlierRow = { ...row, multiplier, baseline, tier, formats: detectFormats(row.title) }
    if (velocity !== undefined) result.velocity = velocity
    return result
  })

  return out.sort((a, b) => b.multiplier - a.multiplier)
}

export interface FormatLift {
  format: string
  /** Share of outlier+strong titles carrying this format. */
  shareInWinners: number
  /** Share of all titles carrying this format. */
  shareOverall: number
  /** shareInWinners ÷ shareOverall; > 1 means the format over-indexes among winners. */
  lift: number
  count: number
}

/** Which title formats over-index among the winners in a ranked set. */
export function formatLift(rows: OutlierRow[]): FormatLift[] {
  if (rows.length === 0) return []
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
  const lifts: FormatLift[] = []
  for (const [format, c] of counts) {
    const shareOverall = c.all / rows.length
    const shareInWinners = winners.length > 0 ? c.winners / winners.length : 0
    lifts.push({
      format,
      shareInWinners,
      shareOverall,
      lift: shareOverall > 0 ? shareInWinners / shareOverall : 0,
      count: c.all,
    })
  }
  return lifts.sort((a, b) => b.lift - a.lift || b.count - a.count)
}
