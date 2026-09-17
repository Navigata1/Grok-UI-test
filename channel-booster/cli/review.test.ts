import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../cli/booster.js'
import { addRow, recordRead } from '../src/ledger.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'
import type { Baselines, Bucket, LedgerRead } from '../src/schema.js'

/** Fixed clock so every decision is reproducible. */
const NOW = '2026-09-14T12:00:00Z'
const nowMs = Date.parse(NOW)

let tmp: string
let data: string
let profile: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-review-'))
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  resetThresholds()
  rmSync(tmp, { recursive: true, force: true })
})

/** Every command runs against the temp store and temp profile, never channel-booster/data or channel.json. */
function scoped(argv: string[]): string[] {
  return [...argv, '--data', data, '--path', profile]
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true })
  try {
    const code = await main(scoped(argv))
    return { code, out, err }
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
}

async function json(argv: string[]): Promise<any> {
  const { code, out } = await run([...argv, '--json'])
  expect(code).toBe(0)
  return JSON.parse(out)
}

async function fails(argv: string[]): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await main(scoped(argv))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
  throw new Error(`expected "${argv.join(' ')}" to fail`)
}

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
    views: { median: 5000, mad: 800, n: 10 },
    impressions: { median: 20000, mad: 3000, n: 10 },
    shift: false,
    ...overrides,
  }
}

function writeProfile(baselines?: Baselines): void {
  writeFileSync(profile, JSON.stringify({ positioning: 'Van builds for first-timers', ...(baselines ? { baselines } : {}) }, null, 2))
}

/** Ten older videos with identical 48 h and 168 h reads: a solid baseline (CTR 5, AVP 40, views 5,000, impressions 20,000, returning 40). */
function seedHistory(): void {
  const store = openStore(data)
  for (let i = 0; i < 10; i += 1) {
    const publishedAt = new Date(nowMs - (30 + i * 7) * 86_400_000).toISOString()
    const slug = `old-${i}`
    addRow(store, { slug, title: `Old video ${i}`, publishedAt, now: new Date(NOW) })
    recordRead(store, { slug, bucket: '48', read: { impressions: 20000, ctr: 5, avpPct: 40, retention30sPct: 65, views: 3000, returningPct: 40 }, now: new Date(NOW) })
    recordRead(store, { slug, bucket: '168', read: { impressions: 60000, ctr: 5, avpPct: 40, views: 5000, returningPct: 40 }, lever: 'the payoff in the thumbnail beat the face', now: new Date(NOW) })
  }
}

function seedRow(slug: string, hoursAgo: number, reads: Partial<Record<Bucket, Omit<LedgerRead, 'at'>>>, extra: { repackagedAt?: string } = {}): void {
  const store = openStore(data)
  const publishedAt = new Date(nowMs - hoursAgo * 3_600_000).toISOString()
  addRow(store, { slug, title: `Video ${slug}`, publishedAt, now: new Date(NOW) })
  for (const [bucket, read] of Object.entries(reads) as Array<[Bucket, Omit<LedgerRead, 'at'>]>) {
    recordRead(store, { slug, bucket, read: { ...read, at: publishedAt }, lever: bucket === '168' ? 'lever noted' : undefined, now: new Date(NOW) })
  }
  if (extra.repackagedAt) {
    const row = store.get('ledger', slug)!
    store.upsert('ledger', { ...row, repackagedAt: extra.repackagedAt })
  }
}

const PACKAGE = {
  title: 'I Built a Solar Generator From Scrap',
  chosenTitle: 'I Built a Solar Generator From Scrap',
  titles: [
    { title: 'I Built a Solar Generator From Scrap', score: 82 },
    { title: 'Scrap to Solar: 300W for Just $40', score: 78 },
    { title: 'Can Junk Power a House?', score: 71 },
  ],
  thumbnails: [
    { name: 'result-panel', angle: 'result', qa: { grade: 'ship', score: 90 } },
    { name: 'stakes-bill', angle: 'stakes', qa: { grade: 'ship', score: 85 } },
    { name: 'curiosity-box', angle: 'curiosity', qa: { grade: 'ship', score: 82 } },
    { name: 'identity-me', angle: 'identity', qa: { grade: 'revise', score: 70 } },
    { name: 'no-qa-yet', angle: 'contrast' },
  ],
  abPick: { a: 'result-panel', b: 'stakes-bill' },
}

function writePackage(slug: string, body: unknown = PACKAGE): string {
  const dir = path.join(tmp, 'packages', slug)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'package.json')
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  return file
}

describe('booster help', () => {
  it('lists postmortem, decide and repackage prepare', async () => {
    const { out } = await run(['help'])
    expect(out).toMatch(/postmortem --ctr 4\.2 .*--bucket 24\|48\|168\|672.*--mode established\|cold-start.*--returning pct.*--sub-share pct.*--browse-suggested pct.*--prev-impressions N/)
    expect(out).toMatch(/decide --slug <slug> --bucket 48\|168\|672 \[--now ISO\] \[--record\]/)
    expect(out).toMatch(/repackage prepare <slug> \[--bucket 48\] \[--out packages\/<slug>\/repackage\.json\] \[--root dir\]/)
  })
})

describe('booster postmortem', () => {
  it('keeps the typed-flag diagnosis and JSON shape and prints mode, baseline and the Wilson interval', async () => {
    const d = await json(['postmortem', '--impressions', '24000', '--ctr', '2.1', '--avp', '44', '--hours', '48', '--baseline-ctr', '4.5', '--baseline-avp', '40', '--baseline-views', '6000'])
    expect(d.bottleneck).toBe('packaging')
    expect(d.repackage).toBe(true)
    expect(d.mode).toBe('established')
    expect(d.baselineSource).toBe('provided')
    expect(d.baselineUsed).toMatchObject({ source: 'provided', ctr: 4.5, avpPct: 40, views: 6000 })
    expect(d.ctrInterval.impressions).toBe(24000)
    expect(d.impressionsNeeded).toBeUndefined()
    expect(d.evidence[0]).toMatch(/^baseline used: provided by the caller/)
    expect(Array.isArray(d.actions)).toBe(true)
    expect(Array.isArray(d.thresholdsUsed)).toBe(true)

    const { code, out } = await run(['postmortem', '--impressions', '24000', '--ctr', '2.1', '--avp', '44', '--hours', '48', '--baseline-ctr', '4.5', '--baseline-avp', '40', '--baseline-views', '6000'])
    expect(code).toBe(0)
    expect(out).toContain('Bottleneck: PACKAGING · REPACKAGE NOW')
    expect(out).toContain('Mode: established')
    expect(out).toMatch(/Baseline used: provided: CTR 4\.5% \/ AVP 40% \/ 30 s \d+% \/ views 6,000/)
    expect(out).toMatch(/CTR 95% interval: \d+\.\d\d% to \d+\.\d\d% over 24,000 impressions/)
    expect(out).not.toContain('Impressions needed')
    // No profile on disk: the profile line shows the borrowed priors and the prior tier.
    expect(out).toMatch(/Profile baseline CTR [\d.]+% \/ AVP [\d.]+% \/ 30 s [\d.]+% \[default, prior, n=0\]/)
    expect(out).toContain('Do this:')
    expect(out).toContain('Thresholds:')
  })

  it('prints impressions-needed when the CTR interval straddles a threshold', async () => {
    const d = await json(['postmortem', '--impressions', '20000', '--ctr', '4', '--avp', '42', '--hours', '48', '--baseline-ctr', '5', '--baseline-avp', '40'])
    expect(d.bottleneck).toBe('insufficient-data')
    expect(d.impressionsNeeded).toBeGreaterThan(20000)
    const { out } = await run(['postmortem', '--impressions', '20000', '--ctr', '4', '--avp', '42', '--hours', '48', '--baseline-ctr', '5', '--baseline-avp', '40'])
    expect(out).toMatch(/Impressions needed: [\d,]+ total \([\d,]+ more\) before the CTR band is certain/)
  })

  it('uses the profile baselines with their tier when nothing is typed', async () => {
    writeProfile(solidBaselines())
    const d = await json(['postmortem', '--impressions', '22000', '--ctr', '2', '--avp', '42', '--bucket', '48'])
    expect(d.bottleneck).toBe('packaging')
    expect(d.bucket).toBe('48')
    expect(d.mode).toBe('established')
    expect(d.baselineUsed).toMatchObject({ source: 'computed', tier: 'solid', n: 10, bucket: '48', ctr: 5, avpPct: 40, retention30sPct: 65, views: 5000, impressions: 20000, borrowed: [] })
    expect(d.evidence[0]).toContain('computed from your ledger (solid tier, n=10, 48 h reads)')
    const { out } = await run(['postmortem', '--impressions', '22000', '--ctr', '2', '--avp', '42', '--bucket', '48'])
    expect(out).toContain('Mode: established (48 h read)')
    expect(out).toContain('Baseline used: computed (solid tier, n=10, 48 h reads): CTR 5% / AVP 40% / 30 s 65% / views 5,000 / expected impressions 20,000')
    expect(out).toContain('Profile baseline CTR 5% / AVP 40% / 30 s 65% / views 5000 [computed, solid, n=10, 48 h]')
  })

  it('lets typed --baseline-* flags win over the profile and fills the rest from it', async () => {
    writeProfile(solidBaselines())
    const d = await json(['postmortem', '--impressions', '22000', '--ctr', '2', '--avp', '42', '--baseline-ctr', '4.5'])
    expect(d.baselineUsed).toMatchObject({ source: 'provided', ctr: 4.5, avpPct: 40, views: 5000 })
    expect(d.baselineUsed.tier).toBeUndefined()
    expect(d.evidence[0]).toMatch(/provided by the caller .*CTR judged vs baseline 4\.5%, AVP vs 40%/)
  })

  it('goes cold-start on a prior-tier profile and borrows the priors', async () => {
    writeProfile(solidBaselines({ tier: 'prior', n: 2 }))
    const d = await json(['postmortem', '--impressions', '1500', '--ctr', '1.5', '--avp', '42', '--hours', '48'])
    expect(d.mode).toBe('cold-start')
    expect(d.bottleneck).toBe('insufficient-data')
    expect(d.baselineUsed.source).toBe('default')
    expect(d.baselineUsed.borrowed).toEqual(['ctr', 'avpPct', 'retention30sPct'])
    expect(d.evidence.some((e: string) => /cold-start mode/.test(e))).toBe(true)
    const { out } = await run(['postmortem', '--impressions', '1500', '--ctr', '1.5', '--avp', '42', '--hours', '48'])
    expect(out).toContain('Mode: cold-start')
    expect(out).toContain('(borrowed from priors: ctr, avpPct, retention30sPct)')
    expect(out).toMatch(/Profile baseline .*\[default, prior, n=2, 48 h\]/)
  })

  it('takes --mode, --returning, --sub-share, --browse-suggested and --prev-impressions', async () => {
    writeProfile(solidBaselines())
    const d = await json(['postmortem', '--impressions', '22000', '--ctr', '6', '--avp', '44', '--bucket', '48', '--mode', 'cold-start', '--returning', '48', '--sub-share', '35', '--browse-suggested', '70', '--prev-impressions', '12000'])
    expect(d.mode).toBe('cold-start')
    expect(d.algorithmic).toBe(true)
    expect(d.growthPct).toBeCloseTo(83.33, 1)
    expect(d.evidence.some((e: string) => /browse \+ suggested 70% of impressions: the system is recommending it/.test(e))).toBe(true)
    expect(d.evidence.some((e: string) => /subscribers 35% of views/.test(e))).toBe(true)
    expect(d.evidence.some((e: string) => /returning viewers 48% of views \(1\.20x baseline 40%\)/.test(e))).toBe(true)
    expect(d.evidence.some((e: string) => /24-to-48 h impression growth \+83% \(12,000 -> 22,000\)/.test(e))).toBe(true)
    const { out } = await run(['postmortem', '--impressions', '22000', '--ctr', '6', '--avp', '44', '--bucket', '48', '--returning', '48', '--browse-suggested', '20', '--prev-impressions', '12000'])
    expect(out).toContain('Impression growth since the previous read: +83%')
    expect(out).toContain('Algorithmic: not yet')
  })

  it('judges a 7-day read against the 7-day baselines, and falls back to the 48-hour set without them', async () => {
    const baselines168 = solidBaselines({ bucket: '168', ctr: { median: 4, mad: 0.4, n: 10 }, views: { median: 12000, mad: 2000, n: 10 } })
    writeFileSync(profile, JSON.stringify({ positioning: 'Van builds', baselines: solidBaselines(), baselines168 }, null, 2))

    const read = ['postmortem', '--impressions', '80000', '--ctr', '4', '--avp', '40', '--views', '11000']
    const week = await json([...read, '--bucket', '168'])
    expect(week.baselineUsed).toMatchObject({ bucket: '168', tier: 'solid', n: 10, ctr: 4, views: 12000 })
    // The same read at 48 h is a different question, judged against the 48 h medians.
    const day = await json([...read, '--bucket', '48'])
    expect(day.baselineUsed).toMatchObject({ bucket: '48', ctr: 5, views: 5000 })

    const { out } = await run([...read, '--bucket', '168'])
    expect(out).toContain('computed (solid tier, n=10, 168 h reads): CTR 4% / AVP 40% / 30 s 65% / views 12,000')
    expect(out).toContain('Profile baseline CTR 4% / AVP 40% / 30 s 65% / views 12000 [computed, solid, n=10, 168 h]')

    // A profile written before baselines168 existed borrows the 48 h set rather than the priors.
    writeProfile(solidBaselines())
    expect((await json([...read, '--bucket', '168'])).baselineUsed).toMatchObject({ bucket: '48', ctr: 5, views: 5000 })
  })

  it('never recommends a swap on a 168-hour read and rejects bad --bucket and --mode', async () => {
    const d = await json(['postmortem', '--impressions', '80000', '--ctr', '2', '--avp', '42', '--bucket', '168', '--baseline-ctr', '5', '--baseline-avp', '40'])
    expect(d.bottleneck).toBe('packaging')
    expect(d.repackage).toBe(false)
    expect(d.allowedVerdicts).toContain('packaging')
    expect(await fails(['postmortem', '--ctr', '4', '--bucket', '96'])).toContain('--bucket must be one of 24|48|168|672')
    expect(await fails(['postmortem', '--ctr', '4', '--mode', 'warm'])).toContain('--mode must be established or cold-start')
  })
})

describe('booster decide', () => {
  it('needs a slug, a decidable bucket and a ledger row', async () => {
    expect(await fails(['decide', '--bucket', '48'])).toContain('--slug is required')
    expect(await fails(['decide', '--slug', 'solar'])).toContain('--bucket is required')
    expect(await fails(['decide', '--slug', 'solar', '--bucket', '24'])).toContain('--bucket must be one of 48|168|672')
    expect(await fails(['decide', '--slug', 'solar', '--bucket', '48', '--now', NOW])).toContain('no ledger row for "solar"')
  })

  it('decides REPACKAGE from the ledger with leave-one-out baselines and records only with --record', async () => {
    seedHistory()
    seedRow('solar', 48, { '24': { impressions: 12000 }, '48': { impressions: 22000, ctr: 2, avpPct: 42 } })
    const d = await json(['decide', '--slug', 'solar', '--bucket', '48', '--now', NOW])
    expect(d.id).toBe('solar:48')
    expect(d.decision).toBe('REPACKAGE')
    expect(d.recorded).toBe(false)
    expect(d.updatedAt).toBe(new Date(NOW).toISOString())
    expect(d.baselines).toMatchObject({ bucket: '48', n: 10, tier: 'solid', ctr: { median: 5 }, impressions: { median: 20000 } })
    expect(d.diagnosis.bottleneck).toBe('packaging')
    expect(d.diagnosis.mode).toBe('established')
    expect(d.diagnosis.growthPct).toBeCloseTo(83.33, 1)
    expect(d.numbers).toMatchObject({ bucket: '48', bottleneck: 'packaging', baselineSource: 'computed', baselineTier: 'solid', impressions: 22000, ctr: 2, baselineCtr: 5, baselineViews: 3000, expectedImpressions: 20000, stillServed: true, ctrGapPoints: 3 })
    expect(d.numbers.expectedGainViews).toBeGreaterThanOrEqual(d.numbers.gainFloorViews)
    expect(d.flipCondition).toMatch(/^Expected gain [\d,]+ views clears the [\d,]+ floor/)
    expect(openStore(data).read('decisions')).toHaveLength(0)

    const { code, out } = await run(['decide', '--slug', 'solar', '--bucket', '48', '--now', NOW, '--record'])
    expect(code).toBe(0)
    expect(out).toContain('Video solar (solar), 48 h read at')
    expect(out).toContain('Bottleneck: PACKAGING · mode established · baseline used: computed from your ledger (solid tier, n=10, 48 h reads)')
    expect(out).toContain('Decision: REPACKAGE (solar at 48 h)')
    expect(out).toMatch(/Numbers: bucket=48, hoursSincePublish=48/)
    expect(out).toMatch(/Flip: Expected gain/)
    expect(out).toContain('Recorded decisions/solar:48')
    expect(out).toContain('Next: booster repackage prepare solar --bucket 48')
    const stored = openStore(data).read('decisions')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: 'solar:48', slug: 'solar', bucket: '48', decision: 'REPACKAGE', source: 'cli' })
    expect(stored[0].approvedBy).toBeUndefined()

    // Idempotent: the same read at the same clock upserts the same document.
    const again = await json(['decide', '--slug', 'solar', '--bucket', '48', '--now', NOW, '--record'])
    expect(again.recorded).toBe(true)
    expect(openStore(data).read('decisions')).toEqual(stored)
  })

  it('waits when the read is missing and holds after a recent swap', async () => {
    seedHistory()
    seedRow('empty', 60, {})
    const wait = await json(['decide', '--slug', 'empty', '--bucket', '48', '--now', NOW])
    expect(wait.decision).toBe('WAIT')
    expect(wait.flipCondition).toContain('Record the 48-hour read for empty')
    const { out } = await run(['decide', '--slug', 'empty', '--bucket', '48', '--now', NOW])
    expect(out).toContain('48 h read missing')
    expect(out).toContain('Not recorded: add --record')

    seedRow('swapped', 48, { '24': { impressions: 12000 }, '48': { impressions: 22000, ctr: 2, avpPct: 42 } }, { repackagedAt: new Date(nowMs - 2 * 86_400_000).toISOString() })
    const hold = await json(['decide', '--slug', 'swapped', '--bucket', '48', '--now', NOW])
    expect(hold.decision).toBe('HOLD')
    expect(hold.numbers.daysSinceSwap).toBe(2)
    expect(hold.flipCondition).toMatch(/last swap was 2 days ago/)
  })

  it('judges the 7-day read on the multiple with 168-hour baselines (SEQUEL)', async () => {
    seedHistory()
    seedRow('hit', 200, { '48': { impressions: 30000, ctr: 6, avpPct: 44 }, '168': { impressions: 150000, ctr: 6, views: 20000, avpPct: 42, returningPct: 45 } })
    const d = await json(['decide', '--slug', 'hit', '--bucket', '168', '--now', NOW])
    expect(d.baselines).toMatchObject({ bucket: '168', n: 10, tier: 'solid', views: { median: 5000 }, returningPct: { median: 40 } })
    expect(d.diagnosis.bucket).toBe('168')
    expect(d.diagnosis.repackage).toBe(false)
    expect(d.decision).toBe('SEQUEL')
    expect(d.numbers).toMatchObject({ multiple: 4, returningPct: 45, baselineReturningPct: 40, returningRel: 1.13 })
    expect(d.flipCondition).toMatch(/Flips to EXPAND if returning share on the sequel drops/)
  })
})

describe('booster repackage prepare', () => {
  it('refuses without a recorded decision, a package or a known sub-command', async () => {
    expect(await fails(['repackage'])).toContain('unknown repackage command')
    expect(await fails(['repackage', 'prepare', '--root', tmp])).toContain('a slug is required')
    expect(await fails(['repackage', 'prepare', 'solar', '--root', tmp])).toContain('run booster decide --slug solar --bucket 48 --record first')
    seedHistory()
    seedRow('solar', 48, { '24': { impressions: 12000 }, '48': { impressions: 22000, ctr: 2, avpPct: 42 } })
    await json(['decide', '--slug', 'solar', '--bucket', '48', '--now', NOW, '--record'])
    expect(await fails(['repackage', 'prepare', 'solar', '--root', tmp])).toContain('package.json not found')
    writePackage('solar', '{not json')
    expect(await fails(['repackage', 'prepare', 'solar', '--root', tmp])).toContain('is not valid JSON')
    writePackage('solar', { title: 'x' })
    expect(await fails(['repackage', 'prepare', 'solar', '--root', tmp])).toContain('has no titles or thumbnails')
    expect(existsSync(path.join(tmp, 'packages', 'solar', 'repackage.json'))).toBe(false)
  })

  it('writes the swap plan from the recorded REPACKAGE decision and never applies it', async () => {
    seedHistory()
    seedRow('solar', 48, { '24': { impressions: 12000 }, '48': { impressions: 22000, ctr: 2, avpPct: 42 } })
    await json(['decide', '--slug', 'solar', '--bucket', '48', '--now', NOW, '--record'])
    writePackage('solar')
    const plan = await json(['repackage', 'prepare', 'solar', '--root', tmp, '--now', NOW])
    expect(plan).toMatchObject({ slug: 'solar', decisionId: 'solar:48', decision: 'REPACKAGE', bucket: '48', preparedAt: new Date(NOW).toISOString(), applied: false })
    // curiosity is the ship-graded angle farthest from the result/stakes pair that ran; the un-QA'd concept is never picked.
    expect(plan.thumbnail).toEqual({ name: 'curiosity-box', angle: 'curiosity', qa: { grade: 'ship', score: 82 } })
    expect(plan.title).toEqual({ title: 'Scrap to Solar: 300W for Just $40', score: 78 })
    expect(plan.instructions[0]).toMatch(/^Thumbnail first: replace result-panel \/ stakes-bill with "curiosity-box"/)
    expect(plan.instructions.some((i: string) => /Only if CTR is still under 3\.75%/.test(i))).toBe(true)
    expect(plan.instructions.at(-1)).toContain('a person applies the swap in Studio and approves decision solar:48')
    const file = path.join(tmp, 'packages', 'solar', 'repackage.json')
    expect(plan.out).toBe(file)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written).toMatchObject({ slug: 'solar', decisionId: 'solar:48', applied: false, thumbnail: { name: 'curiosity-box' } })
    expect(written.out).toBeUndefined()
    // The ledger row and the decision are untouched: no repackagedAt, no approval.
    const row = openStore(data).get('ledger', 'solar')!
    expect(row.repackagedAt).toBeUndefined()
    expect(openStore(data).get('decisions', 'solar:48')!.appliedAt).toBeUndefined()

    const { code, out } = await run(['repackage', 'prepare', 'solar', '--root', tmp, '--now', NOW])
    expect(code).toBe(0)
    expect(out).toContain('Decision solar:48: REPACKAGE')
    expect(out).toContain('Thumbnail: curiosity-box (curiosity)')
    expect(out).toContain('Title: Scrap to Solar: 300W for Just $40 (score 78)')
    expect(out).toMatch(/One swap per 7 days \[house\]; thumbnail before title\./)
    expect(out).toContain(`Plan written to ${file}. Nothing applied`)
  })

  it('honours --out and --bucket and prepares nothing for a HOLD decision', async () => {
    seedHistory()
    seedRow('hit', 200, { '48': { impressions: 30000, ctr: 6, avpPct: 44 }, '168': { impressions: 150000, ctr: 6, views: 6000, avpPct: 42, returningPct: 45 } })
    const decision = await json(['decide', '--slug', 'hit', '--bucket', '168', '--now', NOW, '--record'])
    expect(decision.decision).toBe('HOLD')
    writePackage('hit')
    const outFile = path.join(tmp, 'plans', 'hit-168.json')
    expect(await fails(['repackage', 'prepare', 'hit', '--root', tmp])).toContain('no recorded decision for "hit" at 48 h')
    const plan = await json(['repackage', 'prepare', 'hit', '--bucket', '168', '--root', tmp, '--out', outFile, '--now', NOW])
    expect(plan).toMatchObject({ decisionId: 'hit:168', decision: 'HOLD', bucket: '168', out: outFile })
    expect(plan.thumbnail).toBeUndefined()
    expect(plan.title).toBeUndefined()
    expect(plan.instructions[0]).toBe('Decision HOLD for hit at 168 h calls for no packaging change; nothing prepared.')
    expect(existsSync(outFile)).toBe(true)
    expect(existsSync(path.join(tmp, 'packages', 'hit', 'repackage.json'))).toBe(false)
    expect(await fails(['repackage', 'prepare', 'hit', '--bucket', '24', '--root', tmp])).toContain('--bucket must be one of 48|168|672')
  })
})
