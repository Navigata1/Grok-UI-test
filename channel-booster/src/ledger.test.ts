import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addRow, baselineFrom, dueReads, leverTally, mad, ownOutliers, readLedger, recordRead, renderLedgerMarkdown, tierFor } from './ledger.js'
import { openStore, type Store } from './store.js'

let root: string
let store: Store
const now = new Date('2026-09-14T12:00:00Z')
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'booster-')); store = openStore(root) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function seed(n: number): void {
  for (let i = 0; i < n; i += 1) {
    const publishedAt = new Date(now.getTime() - (i + 2) * 7 * 86_400_000).toISOString()
    addRow(store, { slug: `v${i}`, title: `Video ${i}`, publishedAt, now })
    recordRead(store, { slug: `v${i}`, bucket: '48', read: { impressions: 10_000 + i * 500, ctr: 4 + (i % 3), avpPct: 40 + i, retention30sPct: 65 }, now })
    recordRead(store, { slug: `v${i}`, bucket: '168', read: { views: i === 3 ? 60_000 : 5_000 + i * 100, returningPct: 35 }, lever: i % 2 ? 'stakes concept won' : 'result concept won', now })
  }
}

describe('ledger', () => {
  it('computes MAD and tiers', () => {
    expect(mad([1, 2, 3, 4, 100])).toBe(1)
    expect(tierFor(3)).toBe('prior'); expect(tierFor(7)).toBe('thin'); expect(tierFor(12)).toBe('solid')
  })

  it('refuses a 7-day read without a lever and accepts one with it', () => {
    addRow(store, { slug: 'a', title: 'A', publishedAt: '2026-09-01T00:00:00Z', now })
    expect(() => recordRead(store, { slug: 'a', bucket: '168', read: { views: 100 }, now })).toThrow(/lever/)
    const row = recordRead(store, { slug: 'a', bucket: '168', read: { views: 100 }, lever: 'numbers beat adjectives', now })
    expect(row.lever).toBe('numbers beat adjectives')
    expect(() => recordRead(store, { slug: 'missing', bucket: '48', read: {}, now })).toThrow(/no ledger row/)
  })

  it('builds leave-one-out baselines over the trailing window, excluding young and repackaged rows', () => {
    seed(12)
    const b = baselineFrom(readLedger(store), { now, excludeSlug: 'v0' })
    expect(b.n).toBe(10)
    expect(b.tier).toBe('solid')
    expect(b.ctr?.median).toBeGreaterThan(3)
    expect(b.views).toBeUndefined() // views are a 168 read
    const b168 = baselineFrom(readLedger(store), { now, bucket: '168' })
    expect(b168.views?.n).toBe(10)
    const young = addRow(store, { slug: 'fresh', title: 'Fresh', publishedAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(), now })
    recordRead(store, { slug: young.slug, bucket: '48', read: { ctr: 50 }, now })
    expect(baselineFrom(readLedger(store), { now }).ctr?.median).toBeLessThan(10)
  })

  it('flags a baseline shift beyond one MAD', () => {
    seed(6)
    const previous = { ...baselineFrom(readLedger(store), { now }), ctr: { median: 1, mad: 0.1, n: 6 } }
    expect(baselineFrom(readLedger(store), { now, previous }).shift).toBe(true)
  })

  it('tallies levers, finds own outliers, and lists due reads', () => {
    seed(6)
    const rows = readLedger(store)
    const tally = leverTally(rows)
    expect(tally.map((t) => t.lever).sort()).toEqual(['result concept won', 'stakes concept won'])
    const winners = ownOutliers(rows)
    expect(winners).toHaveLength(1)
    expect(winners[0].row.slug).toBe('v3')
    addRow(store, { slug: 'new', title: 'New', publishedAt: new Date(now.getTime() - 50 * 3_600_000).toISOString(), now })
    const due = dueReads(readLedger(store), now)
    expect(due.filter((d) => d.slug === 'new').map((d) => d.bucket)).toEqual(['24', '48'])
    expect(renderLedgerMarkdown(rows)).toContain('| Published | Video |')
  })
})
