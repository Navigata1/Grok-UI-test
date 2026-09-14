import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addRow, readLedger, recordRead } from './ledger.js'
import { defaultProfile } from './profile.js'
import { dueReviews, exportTimeFrom, ingestInbox, loadRepackagePackage, matchLedgerRow, renderDigest, reviewQueue, runReviews } from './review.js'
import { DecisionDoc, type Baselines, type ProfileDoc } from './schema.js'
import { openStore, type Store } from './store.js'
import { resetThresholds } from './thresholds.js'

let root: string
let store: Store
const now = new Date('2026-09-14T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'booster-review-'))
  store = openStore(path.join(root, 'data'))
  resetThresholds()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function solidBaselines(overrides: Partial<Baselines> = {}): Baselines {
  return {
    computedAt: '2026-09-01T00:00:00Z',
    bucket: '48',
    n: 10,
    tier: 'solid',
    ctr: { median: 5, mad: 0.5, n: 10 },
    avpPct: { median: 40, mad: 3, n: 10 },
    retention30sPct: { median: 65, mad: 4, n: 10 },
    returningPct: { median: 40, mad: 5, n: 10 },
    views: { median: 5_000, mad: 800, n: 10 },
    impressions: { median: 20_000, mad: 3_000, n: 10 },
    shift: false,
    ...overrides,
  }
}

function profileWith(baselines?: Baselines): ProfileDoc {
  return { ...defaultProfile(), ...(baselines ? { baselines } : {}) }
}

/** Ten finished rows two weeks or more old, so 7-day medians exist (views 5,000, returning 35%). */
function seedHistory(): void {
  for (let i = 0; i < 10; i += 1) {
    const publishedAt = hoursAgo((14 + i * 7) * 24)
    addRow(store, { slug: `old-${i}`, title: `Old video ${i}`, publishedAt, now })
    recordRead(store, { slug: `old-${i}`, bucket: '48', read: { impressions: 20_000, ctr: 5, avpPct: 40, retention30sPct: 65 }, now: new Date(Date.parse(publishedAt) + 48 * 3_600_000) })
    recordRead(store, { slug: `old-${i}`, bucket: '168', read: { views: 5_000, ctr: 5, avpPct: 40, returningPct: 35, impressions: 60_000 }, lever: 'result concept won', now: new Date(Date.parse(publishedAt) + 168 * 3_600_000) })
  }
}

const STUDIO_HEADER = 'Content,Video title,Video publish time,Impressions,Impressions click-through rate (%),Views,Average view duration,Average percentage viewed (%)'

function writeInbox(name: string, lines: string[]): string {
  const inbox = path.join(root, 'inbox')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(path.join(inbox, name), [STUDIO_HEADER, ...lines, 'Total,,,50000,4.1,9000,0:05:00,40'].join('\n'))
  return inbox
}

describe('dueReviews', () => {
  it('wraps ledger.dueReads with the row attached', () => {
    addRow(store, { slug: 'solar', title: 'I built a solar generator', publishedAt: hoursAgo(50), now })
    const due = dueReviews(store, now)
    expect(due.map((d) => [d.slug, d.bucket, d.overdueHours])).toEqual([['solar', '24', 26], ['solar', '48', 2]])
    expect(due[0].row.title).toBe('I built a solar generator')
  })
})

describe('exportTimeFrom', () => {
  it('reads a date, a date with hour, a date with hour and minute, and a compact stamp; anything else is the fallback', () => {
    const fallback = new Date('2026-01-01T00:00:00Z')
    expect(exportTimeFrom('2026-09-14.csv', fallback).toISOString()).toBe('2026-09-14T00:00:00.000Z')
    expect(exportTimeFrom('studio-2026-09-14T18.csv', fallback).toISOString()).toBe('2026-09-14T18:00:00.000Z')
    expect(exportTimeFrom('2026-09-14T18-30.csv', fallback).toISOString()).toBe('2026-09-14T18:30:00.000Z')
    expect(exportTimeFrom('20260914-1830.csv', fallback).toISOString()).toBe('2026-09-14T18:30:00.000Z')
    expect(exportTimeFrom('Table data.csv', fallback)).toBe(fallback)
    expect(exportTimeFrom('2026-13-40.csv', fallback)).toBe(fallback)
  })
})

describe('matchLedgerRow', () => {
  it('matches by video id first, then by slugified title on either side', () => {
    addRow(store, { slug: 'solar', title: 'I built a solar generator', publishedAt: hoursAgo(48), videoId: 'abc123', now })
    addRow(store, { slug: 'cold-showers-30-days', title: 'Cold showers: 30 days', publishedAt: hoursAgo(48), now })
    const rows = readLedger(store)
    expect(matchLedgerRow({ title: 'Renamed later', views: 1, videoId: 'abc123' }, rows)?.matchedBy).toBe('videoId')
    expect(matchLedgerRow({ title: 'I BUILT a Solar Generator!', views: 1, videoId: 'zzz' }, rows)).toMatchObject({ matchedBy: 'title', row: { slug: 'solar' } })
    expect(matchLedgerRow({ title: 'Cold Showers - 30 Days', views: 1 }, rows)?.row.slug).toBe('cold-showers-30-days')
    expect(matchLedgerRow({ title: 'Something else', views: 1 }, rows)).toBeUndefined()
  })
})

describe('ingestInbox', () => {
  it('records reads by bucket from the export time, merges over typed numbers, refuses 7-day reads without a lever, and reports the rest', () => {
    addRow(store, { slug: 'solar', title: 'I built a solar generator', publishedAt: '2026-09-12T00:00:00Z', videoId: 'abc123', now })
    addRow(store, { slug: 'week-old', title: 'A week old video', publishedAt: '2026-09-07T00:00:00Z', videoId: 'def456', now })
    addRow(store, { slug: 'fresh', title: 'Twelve hours old', publishedAt: '2026-09-13T12:00:00Z', videoId: 'ghi789', now })
    recordRead(store, { slug: 'solar', bucket: '48', read: { retention30sPct: 62, returningPct: 38 }, now: new Date('2026-09-14T00:00:00Z') })
    const inbox = writeInbox('studio-2026-09-14.csv', [
      'abc123,I built a solar generator,"Sep 12, 2026",22000,2.0,900,0:04:10,42',
      'def456,A week old video,"Sep 7, 2026",60000,5.1,4000,0:05:00,44',
      'ghi789,Twelve hours old,"Sep 13, 2026",500,6,40,0:03:00,50',
      'xyz000,An old upload not in the ledger,"Jan 1, 2025",1,1,1,0:01:00,1',
    ])
    const report = ingestInbox(store, inbox, { now })
    expect(report.files).toEqual(['studio-2026-09-14.csv'])
    expect(report.recorded).toHaveLength(1)
    expect(report.recorded[0]).toMatchObject({ slug: 'solar', bucket: '48', outcome: 'merged', matchedBy: 'videoId' })
    const solar = store.get('ledger', 'solar')!
    expect(solar.reads['48']).toMatchObject({ impressions: 22_000, ctr: 2, views: 900, avdSec: 250, avpPct: 42, retention30sPct: 62, returningPct: 38, at: '2026-09-14T00:00:00.000Z' })
    expect(solar.source).toBe('agent:review')
    expect(report.needsLever).toHaveLength(1)
    expect(report.needsLever[0]).toMatchObject({ slug: 'week-old', bucket: '168', read: { impressions: 60_000, views: 4_000 } })
    expect(store.get('ledger', 'week-old')!.reads['168']).toBeUndefined()
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]).toMatchObject({ slug: 'fresh', reason: expect.stringMatching(/12 h after publish sits outside the tolerance/) })
    expect(report.unmatched).toHaveLength(1)
    expect(report.unmatched[0]).toMatchObject({ videoId: 'xyz000', reason: expect.stringMatching(/no ledger row/) })
    expect(existsSync(path.join(inbox, 'studio-2026-09-14.csv'))).toBe(true)

    const again = ingestInbox(store, inbox, { now })
    expect(again.recorded[0].outcome).toBe('unchanged')
    expect(store.get('ledger', 'solar')!.updatedAt).toBe(solar.updatedAt)

    recordRead(store, { slug: 'week-old', bucket: '48', read: {}, lever: 'stakes beat result', now })
    const third = ingestInbox(store, inbox, { now })
    expect(third.needsLever).toHaveLength(0)
    expect(third.recorded.find((r) => r.slug === 'week-old')).toMatchObject({ bucket: '168', outcome: 'recorded' })
  })

  it('is empty for a missing inbox and names unknown columns', () => {
    expect(ingestInbox(store, path.join(root, 'nowhere'), { now })).toMatchObject({ files: [], recorded: [], needsLever: [], skipped: [], unmatched: [] })
    addRow(store, { slug: 'solar', title: 'Solar', publishedAt: hoursAgo(24), videoId: 'abc123', now })
    const inbox = path.join(root, 'inbox')
    mkdirSync(inbox)
    writeFileSync(path.join(inbox, 'export.csv'), 'Content,Video title,Views,Mystery column\nabc123,Solar,100,7\n')
    writeFileSync(path.join(inbox, 'notes.txt'), 'ignored')
    const report = ingestInbox(store, inbox, { now })
    expect(report.files).toEqual(['export.csv'])
    expect(report.unknownColumns).toEqual({ 'export.csv': ['Mystery column'] })
    expect(report.recorded[0]).toMatchObject({ bucket: '24', outcome: 'recorded', read: { views: 100 } })
  })
})

describe('reviewQueue', () => {
  it('classifies every past hour mark as ready, awaiting data, reviewed, or applied', () => {
    addRow(store, { slug: 'solar', title: 'Solar', publishedAt: hoursAgo(50), now })
    recordRead(store, { slug: 'solar', bucket: '24', read: { impressions: 1_000 }, now: new Date(now.getTime() - 20 * 3_600_000) })
    recordRead(store, { slug: 'solar', bucket: '48', read: { impressions: 2_000, ctr: 4 }, now })
    store.upsert('decisions', DecisionDoc.parse({ id: 'solar:24', slug: 'solar', bucket: '24', decision: 'WAIT', updatedAt: hoursAgo(10), source: 'cli' }))
    addRow(store, { slug: 'done', title: 'Done', publishedAt: hoursAgo(100), now })
    recordRead(store, { slug: 'done', bucket: '48', read: { ctr: 2 }, now: new Date(now.getTime() - 40 * 3_600_000) })
    store.upsert('decisions', DecisionDoc.parse({ id: 'done:48', slug: 'done', bucket: '48', decision: 'REPACKAGE', updatedAt: hoursAgo(30), appliedAt: hoursAgo(20), source: 'cli' }))
    const queue = reviewQueue(store, now).map((q) => `${q.slug}:${q.bucket}=${q.status}`)
    expect(queue).toEqual(['solar:24=reviewed', 'solar:48=ready', 'done:24=awaiting-data', 'done:48=applied'])
  })
})

describe('loadRepackagePackage', () => {
  it('reads the builder shape and tolerates string titles, a concepts key and flat grades', () => {
    const file = path.join(root, 'package.json')
    expect(loadRepackagePackage(file)).toBeUndefined()
    writeFileSync(file, 'not json')
    expect(loadRepackagePackage(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ titles: ['Plain title', { title: 'Scored', score: 80 }, 7], concepts: [{ name: 'a', angle: 'result', grade: 'ship', score: 85 }, { name: 'b', angle: 'curiosity', qa: { grade: 'revise' } }, { angle: 'nameless' }], finalTitle: 'Scored', pair: { a: 'a', b: 'b' } }))
    expect(loadRepackagePackage(file)).toEqual({
      titles: [{ title: 'Plain title', score: 0 }, { title: 'Scored', score: 80 }],
      thumbnails: [{ name: 'a', angle: 'result', qa: { grade: 'ship', score: 85 } }, { name: 'b', angle: 'curiosity', qa: { grade: 'revise' } }],
      chosenTitle: 'Scored',
      abPick: { a: 'a', b: 'b' },
    })
  })
})

describe('runReviews', () => {
  function seedSolar(): void {
    addRow(store, { slug: 'solar', title: 'I built a solar generator from scrap', publishedAt: hoursAgo(48), videoId: 'abc123', now })
    recordRead(store, { slug: 'solar', bucket: '24', read: { impressions: 12_000 }, now: new Date(now.getTime() - 24 * 3_600_000) })
    recordRead(store, { slug: 'solar', bucket: '48', read: { impressions: 22_000, ctr: 2, avpPct: 42 }, now })
    // The agent already ran at 24 h and decided WAIT on that read.
    store.upsert('decisions', DecisionDoc.parse({ id: 'solar:24', slug: 'solar', bucket: '24', decision: 'WAIT', updatedAt: hoursAgo(23), source: 'agent:review' }))
    const pkgDir = path.join(root, 'packages', 'solar')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      titles: [{ title: 'I built a solar generator from scrap', score: 82 }, { title: 'This scrap-built solar generator runs my workshop', score: 78 }],
      chosenTitle: 'I built a solar generator from scrap',
      thumbnails: [{ name: 'result-1', angle: 'result', qa: { grade: 'ship', score: 88 } }, { name: 'stakes-1', angle: 'stakes', qa: { grade: 'ship', score: 84 } }, { name: 'curiosity-1', angle: 'curiosity', qa: { grade: 'ship', score: 81 } }, { name: 'contrast-1', angle: 'contrast', qa: { grade: 'revise', score: 55 } }],
      abPick: { a: 'result-1', b: 'stakes-1' },
    }))
  }

  it('diagnoses, decides REPACKAGE, prepares the swap, writes the decision, the row, the day file and the digest', () => {
    seedSolar()
    const outDir = path.join(root, 'data', 'reviews')
    const result = runReviews(store, { now, profile: profileWith(solidBaselines()), outDir, packagesDir: path.join(root, 'packages') })
    expect(result.reviews).toHaveLength(1)
    const r = result.reviews[0]
    expect(r).toMatchObject({ slug: 'solar', bucket: '48', title: 'I built a solar generator from scrap', readAt: now.toISOString(), changed: true })
    expect(r.diagnosis.bottleneck).toBe('packaging')
    expect(r.diagnosis.mode).toBe('established')
    expect(r.diagnosis.baselineUsed.source).toBe('computed')
    expect(r.decision.decision).toBe('REPACKAGE')
    expect(r.decision.id).toBe('solar:48')
    expect(r.decision.source).toBe('agent:review')
    expect(r.decision.numbers.expectedGainViews).toBe(1_650)
    expect(r.repackage?.thumbnail?.name).toBe('curiosity-1')
    expect(r.repackage?.title?.title).toBe('This scrap-built solar generator runs my workshop')
    expect(r.packageFile).toBe(path.join(root, 'packages', 'solar', 'package.json'))
    expect(r.awaiting).toEqual(['solar:48: approve the swap to "curiosity-1", apply it in Studio, then stamp it: booster decide approve solar --bucket 48 --by <name> --yes'])

    expect(store.get('decisions', 'solar:48')?.decision).toBe('REPACKAGE')
    const row = store.get('ledger', 'solar')!
    expect(row.bottleneck).toBe('packaging')
    expect(row.decision).toBe('REPACKAGE')
    expect(row.source).toBe('agent:review')

    expect(result.outFile).toBe(path.join(outDir, '2026-09-14.json'))
    const page = JSON.parse(readFileSync(result.outFile!, 'utf8'))
    expect(page.date).toBe('2026-09-14')
    expect(page.generatedAt).toBe(now.toISOString())
    expect(page.reviews).toHaveLength(1)
    expect(page.reviews[0].decision.decision).toBe('REPACKAGE')
    expect(page.awaitingData).toEqual([])
    expect(page.ingest).toBeUndefined()

    const d = result.digest
    expect(d).toMatch(/^# Review digest · 2026-09-14/)
    expect(d).toContain('## solar · 48 h')
    expect(d).toContain('Verdict: **packaging** (established)')
    expect(d).toMatch(/- CTR 2% vs baseline 5% \(0\.40x\)/)
    expect(d).toMatch(/\[house\]/)
    expect(d).toContain('Decision: **REPACKAGE**')
    expect(d).toContain('Flip: Expected gain 1,650 views clears the 500 floor.')
    expect(d).toContain('- thumbnail: curiosity-1 (curiosity, QA ship)')
    expect(d).toMatch(/## Awaiting a human\n\n- solar:48: approve the swap/)
  })

  it('is idempotent: a second run reviews nothing, a forced run keeps the approval, an applied bucket is closed', () => {
    seedSolar()
    const profile = profileWith(solidBaselines())
    const packagesDir = path.join(root, 'packages')
    runReviews(store, { now, profile, packagesDir })
    const later = new Date(now.getTime() + 3_600_000)
    const second = runReviews(store, { now: later, profile, packagesDir })
    expect(second.reviews).toEqual([])
    expect(second.digest).toContain('Nothing to review. Next read: solar at 168 h in 119 h.')
    expect(second.digest).toContain('- nothing')

    const approved = DecisionDoc.parse({ ...store.get('decisions', 'solar:48')!, approvedBy: 'jony', approvedAt: later.toISOString() })
    store.upsert('decisions', approved)
    const forced = runReviews(store, { now: later, profile, packagesDir, slug: 'solar', bucket: '48' })
    expect(forced.reviews).toHaveLength(1)
    expect(forced.reviews[0].changed).toBe(false)
    expect(forced.reviews[0].decision).toMatchObject({ decision: 'REPACKAGE', approvedBy: 'jony', approvedAt: later.toISOString() })
    expect(forced.digest).toContain('Decision: **REPACKAGE** (unchanged)')

    store.upsert('decisions', DecisionDoc.parse({ ...approved, appliedAt: later.toISOString() }))
    const closed = runReviews(store, { now: later, profile, packagesDir, slug: 'solar', bucket: '48' })
    expect(closed.reviews).toEqual([])
    expect(() => runReviews(store, { now: later, profile, packagesDir, slug: 'solar', bucket: '168' })).toThrow(/168-hour read is not due yet/)
    expect(() => runReviews(store, { now: later, profile, packagesDir, slug: 'missing', bucket: '48' })).toThrow(/no ledger row/)
  })

  it('reviews a forced slug with no read as WAIT and never touches the row', () => {
    addRow(store, { slug: 'quiet', title: 'Quiet', publishedAt: hoursAgo(30), now })
    const result = runReviews(store, { now, profile: profileWith(), packagesDir: path.join(root, 'packages'), slug: 'quiet' })
    expect(result.reviews.map((r) => [r.bucket, r.decision.decision, r.diagnosis.bottleneck])).toEqual([['24', 'WAIT', 'insufficient-data']])
    expect(result.reviews[0].diagnosis.mode).toBe('cold-start')
    expect(result.reviews[0].readAt).toBeUndefined()
    expect(store.get('ledger', 'quiet')?.decision).toBeUndefined()
    expect(result.awaitingData.map((d) => d.bucket)).toEqual(['24'])
    expect(result.digest).toMatch(/quiet:24: no numbers yet \(6 h overdue\)/)
  })

  it('judges the 7-day read on leave-one-out 168 h medians and decides SEQUEL', () => {
    seedHistory()
    addRow(store, { slug: 'hit', title: 'The hit', publishedAt: hoursAgo(170), now })
    recordRead(store, { slug: 'hit', bucket: '168', read: { views: 20_000, ctr: 5, avpPct: 42, returningPct: 40, impressions: 100_000 }, lever: 'curiosity angle won', now })
    const result = runReviews(store, { now, profile: profileWith(solidBaselines()), packagesDir: path.join(root, 'packages'), slug: 'hit', bucket: '168' })
    const r = result.reviews[0]
    expect(r.diagnosis.baselineUsed).toMatchObject({ source: 'computed', bucket: '168', n: 10, views: 5_000, returningPct: 35 })
    expect(r.decision.decision).toBe('SEQUEL')
    expect(r.decision.numbers.multiple).toBe(4)
    expect(r.awaiting[0]).toMatch(/^hit:168: brief the sequel this week/)
    expect(store.get('ledger', 'hit')?.decision).toBe('SEQUEL')
  })

  it('ingests the inbox first, lists 7-day reads waiting for a lever, and merges the day file across runs', () => {
    seedSolar()
    addRow(store, { slug: 'week-old', title: 'A week old video', publishedAt: hoursAgo(180), videoId: 'def456', now })
    const inbox = writeInbox('2026-09-14T12.csv', ['def456,A week old video,"Sep 7, 2026",60000,5.1,4000,0:05:00,44'])
    const outDir = path.join(root, 'reviews')
    const profile = profileWith(solidBaselines())
    const first = runReviews(store, { now, profile, inboxDir: inbox, outDir, packagesDir: path.join(root, 'packages') })
    expect(first.ingest?.needsLever.map((n) => n.slug)).toEqual(['week-old'])
    expect(first.reviews.map((r) => r.slug)).toEqual(['solar'])
    expect(first.digest).toContain('Inbox: 1 file, 0 reads recorded, 1 waiting for a lever.')
    expect(first.digest).toContain('- week-old:168: write the lever learned, then the read records itself on the next run: booster set week-old --bucket 168 --lever "<one sentence of learning>" --yes')
    expect(first.digest).toMatch(/- week-old:24: no numbers yet/)

    recordRead(store, { slug: 'week-old', bucket: '48', read: { impressions: 30_000, ctr: 5, avpPct: 40 }, lever: 'numbers beat adjectives', now })
    const later = new Date(now.getTime() + 2 * 3_600_000)
    const second = runReviews(store, { now: later, profile, inboxDir: inbox, outDir, packagesDir: path.join(root, 'packages') })
    expect(second.ingest?.recorded.map((r) => [r.slug, r.bucket, r.outcome])).toEqual([['week-old', '168', 'recorded']])
    expect(second.reviews.map((r) => `${r.slug}:${r.bucket}`).sort()).toEqual(['week-old:168', 'week-old:48'])
    const page = JSON.parse(readFileSync(path.join(outDir, '2026-09-14.json'), 'utf8'))
    expect(page.reviews.map((r: { slug: string; bucket: string }) => `${r.slug}:${r.bucket}`)).toEqual(['solar:48', 'week-old:48', 'week-old:168'])
    expect(page.ingest.files).toEqual(['2026-09-14T12.csv'])
    expect(page.ingest.inboxDir).toBeUndefined()
  })
})

describe('renderDigest', () => {
  it('says nothing is due without a next read and lists awaiting data with the typing command', () => {
    const digest = renderDigest({ date: '2026-09-14', reviews: [], awaitingData: [] })
    expect(digest).toBe('# Review digest · 2026-09-14\n\nNothing to review.\n\n## Awaiting a human\n\n- nothing')
    addRow(store, { slug: 'solar', title: 'Solar', publishedAt: hoursAgo(170), now })
    const withDue = renderDigest({ date: '2026-09-14', reviews: [], awaitingData: dueReviews(store, now) }, { rows: readLedger(store), now })
    expect(withDue).toContain('- solar:168: no numbers yet (2 h overdue); drop the Studio export in inbox/ or type them: booster set solar --bucket 168 --impressions N --ctr X --avp Y --views V --returning W --lever "<sentence>" --yes')
    expect(withDue).toContain('Nothing to review. Next read: solar at 672 h in 502 h.')
  })

  it('carries the --yes the lever gate asks for on every awaiting line that names it', () => {
    addRow(store, { slug: 'solar', title: 'Solar', publishedAt: hoursAgo(170), now })
    const digest = renderDigest({
      date: '2026-09-14',
      reviews: [],
      awaitingData: dueReviews(store, now),
      ingest: { inboxDir: root, files: ['x.csv'], recorded: [], needsLever: [{ file: 'x.csv', slug: 'solar', bucket: '168', read: { at: hoursAgo(1), views: 4_000 } }], skipped: [], unmatched: [], unknownColumns: {} },
    })
    const leverLines = digest.split('\n').filter((l) => l.includes('--lever'))
    expect(leverLines.length).toBe(2)
    for (const line of leverLines) expect(line).toContain('--yes')
  })
})
