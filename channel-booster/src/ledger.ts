/**
 * The packaging ledger: one row per published video, reads at 24/48/168/672 h,
 * and everything derived from it (baselines, own outliers, lever tally).
 * Derived numbers are never typed by hand.
 */
import { LedgerRow, type Bucket, type LedgerRead } from './schema.js'
import type { Store } from './store.js'

export * from './ledger-core.js'

export function readLedger(store: Store): LedgerRow[] {
  return store.read('ledger').sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
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
