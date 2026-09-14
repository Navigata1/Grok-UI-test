/**
 * The packaging ledger: one row per published video, reads at 24/48/168/672 h,
 * and everything derived from it (baselines, own outliers, lever tally).
 * Derived numbers are never typed by hand.
 */
import { median } from './outliers.js'
import { BUCKET_HOURS, LedgerRow, type Baselines, type Bucket, type LedgerRead, type Stat } from './schema.js'
import type { Store } from './store.js'
import { thresholds } from './thresholds.js'

export function readLedger(store: Store): LedgerRow[] {
  return store.read('ledger').sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
}

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
    const levers = new Set<string>([...(r.hypothesis?.levers ?? []), ...(r.lever ? [r.lever] : [])])
    for (const l of levers) {
      const key = l.trim().toLowerCase()
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

export interface RecordReadInput {
  slug: string
  bucket: Bucket
  read: Omit<LedgerRead, 'at'> & { at?: string }
  lever?: string
  bottleneck?: string
  decision?: string
  source?: string
  now?: Date
}

/** Add a read to a row. A 168-hour read without a lever (on the row or in the input) is refused. */
export function recordRead(store: Store, input: RecordReadInput): LedgerRow {
  const row = store.get('ledger', input.slug)
  if (!row) throw new Error(`no ledger row for "${input.slug}". Publish it first (booster publish confirm) or add it (booster ledger add).`)
  const now = input.now ?? new Date()
  const lever = input.lever ?? row.lever
  if (input.bucket === '168' && !lever) throw new Error('a 7-day read needs the lever learned: pass --lever "one sentence of learning"')
  const next: LedgerRow = {
    ...row,
    reads: { ...row.reads, [input.bucket]: { ...input.read, at: input.read.at ?? now.toISOString() } },
    lever,
    bottleneck: input.bottleneck ?? row.bottleneck,
    decision: input.decision ?? row.decision,
    updatedAt: now.toISOString(),
    source: input.source ?? row.source,
  }
  return store.upsert('ledger', LedgerRow.parse(next))
}

export interface AddRowInput {
  slug: string
  title: string
  publishedAt: string
  videoId?: string
  thumbA?: string
  thumbB?: string
  sequelOf?: string
  hypothesis?: LedgerRow['hypothesis']
  source?: string
  now?: Date
}

export function addRow(store: Store, input: AddRowInput): LedgerRow {
  const now = input.now ?? new Date()
  const existing = store.get('ledger', input.slug)
  const row: LedgerRow = LedgerRow.parse({
    ...(existing ?? {}),
    id: input.slug,
    slug: input.slug,
    title: input.title,
    publishedAt: input.publishedAt,
    videoId: input.videoId ?? existing?.videoId,
    thumbA: input.thumbA ?? existing?.thumbA,
    thumbB: input.thumbB ?? existing?.thumbB,
    sequelOf: input.sequelOf ?? existing?.sequelOf,
    hypothesis: input.hypothesis ?? existing?.hypothesis,
    reads: existing?.reads ?? {},
    updatedAt: now.toISOString(),
    source: input.source ?? existing?.source ?? 'cli',
  })
  return store.upsert('ledger', row)
}

function fmtNum(v: number | undefined, suffix = ''): string {
  return v === undefined ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`
}

/** The ledger as the Markdown table the playbook describes. */
export function renderLedgerMarkdown(rows: LedgerRow[]): string {
  const lines = ['| Published | Video | A / B | Winner | Impr. 48h | CTR 48h | AVP 48h | 30s | Views 7d | Bottleneck | Decision | Lever learned |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const r of rows) {
    const r48 = r.reads['48']
    const r168 = r.reads['168']
    lines.push(`| ${r.publishedAt.slice(0, 10)} | ${r.title} | ${r.thumbA ?? '—'} / ${r.thumbB ?? '—'} | ${r.winner ?? '—'} | ${fmtNum(r48?.impressions)} | ${fmtNum(r48?.ctr, '%')} | ${fmtNum(r48?.avpPct, '%')} | ${fmtNum(r48?.retention30sPct, '%')} | ${fmtNum(r168?.views)} | ${r.bottleneck ?? '—'} | ${r.decision ?? '—'} | ${r.lever ?? '—'} |`)
  }
  return lines.join('\n')
}
