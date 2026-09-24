/**
 * Pure ledger math: baselines, tallies, winners, due reads, rendering.
 * No store, no zod, so the browser bundle can use it. ledger.ts re-exports
 * everything here and adds the store operations.
 */
import { median } from './outliers.js'
import { BUCKET_HOURS } from './buckets.js'
import type { Baselines, Bucket, LedgerRead, LedgerRow, Stat } from './schema.js'
import { thresholds } from './thresholds.js'

/** Median absolute deviation. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0
  const m = median(values)
  return median(values.map((v) => Math.abs(v - m)))
}

function stat(values: number[]): Stat | undefined {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v))
  if (clean.length === 0) return undefined
  return { median: median(clean), mad: mad(clean), n: clean.length }
}

export function tierFor(n: number): Baselines['tier'] {
  return n < 5 ? 'prior' : n < 10 ? 'thin' : 'solid'
}

export interface BaselineOptions {
  bucket?: Extract<Bucket, '48' | '168'>
  now?: Date
  /** Rows younger than this are excluded (they have not finished earning). */
  minAgeDays?: number
  /** Trailing window size. */
  window?: number
  /** Exclude this slug (leave-one-out for judging that video). */
  excludeSlug?: string
  previous?: Baselines
}

/**
 * Baselines from the channel's own history: median and MAD over the trailing
 * `window` rows aged at least `minAgeDays`, excluding repackaged rows (their
 * numbers mix two packages) and, when judging a video, that video itself.
 */
export function baselineFrom(rows: LedgerRow[], options: BaselineOptions = {}): Baselines {
  const bucket = options.bucket ?? '48'
  const now = options.now ?? new Date()
  const minAgeDays = options.minAgeDays ?? 7
  const window = options.window ?? 10
  const eligible = rows
    .filter((r) => r.slug !== options.excludeSlug)
    .filter((r) => !r.repackagedAt)
    .filter((r) => (now.getTime() - Date.parse(r.publishedAt)) / 86_400_000 >= minAgeDays)
    .filter((r) => r.reads[bucket] !== undefined)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, window)
  const reads = eligible.map((r) => r.reads[bucket] as LedgerRead)
  const pick = (key: keyof LedgerRead) => stat(reads.map((r) => r[key] as number).filter((v) => v !== undefined))
  const baselines: Baselines = {
    computedAt: now.toISOString(),
    bucket,
    n: eligible.length,
    tier: tierFor(eligible.length),
    ctr: pick('ctr'),
    avpPct: pick('avpPct'),
    retention30sPct: pick('retention30sPct'),
    returningPct: pick('returningPct'),
    views: pick('views'),
    impressions: pick('impressions'),
    shift: false,
  }
  if (options.previous?.ctr && baselines.ctr && baselines.ctr.mad > 0) {
    baselines.shift = Math.abs(baselines.ctr.median - options.previous.ctr.median) > baselines.ctr.mad
  }
  return baselines
}

/** Which levers won and lost, from the free-text lever line and the recorded decision. */
export function leverTally(rows: LedgerRow[]): Array<{ lever: string; count: number; slugs: string[] }> {
  const tally = new Map<string, string[]>()
  for (const r of rows) {
    // Normalise before the per-row Set: a lever line and a hypothesis lever that differ only in case are one test, not two.
    const levers = new Set<string>([...(r.hypothesis?.levers ?? []), ...(r.lever ? [r.lever] : [])].map((l) => l.trim().toLowerCase()))
    for (const key of levers) {
      if (!key) continue
      tally.set(key, [...(tally.get(key) ?? []), r.slug])
    }
  }
  return [...tally.entries()].map(([lever, slugs]) => ({ lever, count: slugs.length, slugs })).sort((a, b) => b.count - a.count)
}

/** Your own winners: rows whose 168-hour views are at least `ownWinnerMultiplier` times the median. */
export function ownOutliers(rows: LedgerRow[], multiplier = thresholds.ownWinnerMultiplier.value): Array<{ row: LedgerRow; multiple: number }> {
  const withViews = rows.filter((r) => r.reads['168']?.views !== undefined)
  const med = median(withViews.map((r) => r.reads['168']!.views!))
  if (med <= 0) return []
  return withViews
    .map((row) => ({ row, multiple: row.reads['168']!.views! / med }))
    .filter((x) => x.multiple >= multiplier)
    .sort((a, b) => b.multiple - a.multiple)
}

/** Hours since publish for a row at `now`. */
export function ageHours(row: LedgerRow, now: Date = new Date()): number {
  return (now.getTime() - Date.parse(row.publishedAt)) / 3_600_000
}

/**
 * How many hours of data a read holds: its own timestamp minus the publish
 * time, never below 0. The data gates judge this, not `ageHours()` at review
 * time, so re-running a review later on the same numbers cannot clear a gate
 * the numbers themselves did not.
 */
export function readAgeHours(row: LedgerRow, read: Pick<LedgerRead, 'at'>): number {
  return Math.max(0, (Date.parse(read.at) - Date.parse(row.publishedAt)) / 3_600_000)
}

/** Which reads are due: a bucket whose hour mark has passed and has no read yet. */
export function dueReads(rows: LedgerRow[], now: Date = new Date()): Array<{ slug: string; bucket: Bucket; overdueHours: number }> {
  const out: Array<{ slug: string; bucket: Bucket; overdueHours: number }> = []
  for (const row of rows) {
    const age = ageHours(row, now)
    for (const bucket of Object.keys(BUCKET_HOURS) as Bucket[]) {
      if (age >= BUCKET_HOURS[bucket] && row.reads[bucket] === undefined) out.push({ slug: row.slug, bucket, overdueHours: Math.round(age - BUCKET_HOURS[bucket]) })
    }
  }
  return out.sort((a, b) => b.overdueHours - a.overdueHours)
}

