import { afterEach, describe, expect, it } from 'vitest'
import { decide, describeDecision } from './decide.js'
import { baselineFrom, readAgeHours } from './ledger-core.js'
import { diagnose, type PostMortemInputV2 } from './postmortem.js'
import { DecisionDoc, type Baselines, type Bucket, type LedgerRead, type LedgerRow } from './schema.js'
import { applyOverrides, resetThresholds } from './thresholds.js'

afterEach(() => resetThresholds())

const now = new Date('2026-09-14T12:00:00Z')

function baselines(overrides: Partial<Baselines> = {}): Baselines {
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

/** A row published `hoursAgo` before `now`; its reads were taken `readAfterHours` after publish (default: now). */
function row(hoursAgo: number, reads: Partial<Record<Bucket, Omit<LedgerRead, 'at'>>>, extra: Partial<LedgerRow> = {}, readAfterHours = hoursAgo): LedgerRow {
  const publishedAt = new Date(now.getTime() - hoursAgo * 3_600_000).toISOString()
  const at = new Date(Date.parse(publishedAt) + readAfterHours * 3_600_000).toISOString()
  const withAt = Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, { ...v, at }])) as LedgerRow['reads']
  return { id: 'solar', slug: 'solar', publishedAt, title: 'I built a solar generator from scrap', reads: withAt, updatedAt: publishedAt, source: 'cli', ...extra }
}

/** Diagnose from the row's own read at the bucket, the way the review agent does: on the hours of data the read holds. */
function judge(r: LedgerRow, bucket: Bucket, given: Baselines | null = baselines(), extra: Partial<PostMortemInputV2> = {}) {
  const b = given ?? undefined
  const read = r.reads[bucket]
  const hours = read ? readAgeHours(r, read) : (now.getTime() - Date.parse(r.publishedAt)) / 3_600_000
  const prev = bucket === '48' ? r.reads['24'] : undefined
  const diagnosis = diagnose({ ...(read ?? {}), bucket, baselines: b, hoursSincePublish: hours, previousRead: prev, ...extra })
  return decide({ diagnosis, row: r, bucket, baselines: b, now })
}

describe('decide: WAIT', () => {
  it('waits when the read is missing, the data is insufficient, or the bucket is 24', () => {
    const missing = judge(row(48, {}), '48')
    expect(missing.decision).toBe('WAIT')
    expect(missing.id).toBe('solar:48')
    expect(missing.flipCondition).toMatch(/Record the 48-hour read/)
    const unsure = judge(row(48, { '48': { impressions: 20_000, ctr: 4, avpPct: 42 } }), '48')
    expect(unsure.decision).toBe('WAIT')
    expect(unsure.numbers.impressionsNeeded).toBeGreaterThan(20_000)
    expect(unsure.flipCondition).toMatch(/Flips once the video has about [\d,]+ impressions \([\d,]+ more\)/)
    const day1 = judge(row(24, { '24': { impressions: 12_000, ctr: 2 } }), '24')
    expect(day1.decision).toBe('WAIT')
    expect(day1.flipCondition).toMatch(/48-hour read/)
    const day1idea = judge(row(24, { '24': { impressions: 300, ctr: 6 } }), '24')
    expect(day1idea.decision).toBe('WAIT')
    expect(day1idea.numbers.bottleneck).toBe('idea')
    // Numbers a person can still record on this read: the flip says so, and names the read after it, never "the next read" in general.
    const bare = judge(row(48, { '48': { impressions: 5_000 } }), '48')
    expect(bare.decision).toBe('WAIT')
    expect(bare.flipCondition).toBe('Flips when a read clears the data gates (1000 [house] impressions and 24h [house]; cold start 2000 [house] or 72h [house]): record the missing numbers on the 48-hour read and review it again, or the 168-hour read judges it.')
    expect(judge(row(700, { '672': { impressions: 5_000 } }), '672').flipCondition).toMatch(/record the missing numbers on the 672-hour read and review it again\.$/)
  })
})

describe('decide: a cold-start read the gate held', () => {
  // A new channel's 48-hour read under 2,000 impressions. The schedule's next read is at 168 hours, so a WAIT
  // for "the next read" blocked the review stage until then, and a re-run after 72 wall-clock hours released
  // the verdict on the same numbers.
  it('holds a low CTR, swaps nothing on it, and says which re-recorded read could still reach a swap', () => {
    const cold = judge(row(48, { '48': { impressions: 1_500, ctr: 1.5, avpPct: 42 } }), '48', null)
    expect(cold.decision).toBe('HOLD')
    expect(cold.numbers).toMatchObject({ bottleneck: 'insufficient-data', readHours: 48, coldStartMinImpressions: 2_000, coldStartMinHours: 72 })
    expect(cold.flipCondition).toBe('Cold start: too early to call. CTR reads low, but a first upload gets no packaging verdict before 2000 [house] impressions or 72h [house] of data (this read: 1,500 impressions at 48 h), so nothing is swapped on it. The 168-hour read judges it on views against the 7-day median. Flips to REPACKAGE only if this read is re-recorded inside the 72-hour window with 2,000 impressions and CTR still low, then reviewed again (booster review run --slug solar --bucket 48).')
    // Past the window no swap is on offer, so the flip does not promise one.
    const closed = judge(row(80, { '48': { impressions: 1_500, ctr: 1.5, avpPct: 42 } }, {}, 48), '48', null)
    expect(closed.decision).toBe('HOLD')
    expect(closed.flipCondition).not.toMatch(/REPACKAGE/)
  })

  it('holds a healthy-looking read as too early, and a later review of the same numbers changes nothing', () => {
    const early = judge(row(30, { '48': { impressions: 1_500, ctr: 6, avpPct: 45 } }), '48', null)
    expect(early.decision).toBe('HOLD')
    expect(early.numbers.bottleneck).toBe('insufficient-data')
    expect(early.flipCondition).toBe('Cold start: too early to call. The numbers read healthy, but a first upload gets no verdict before 2000 [house] impressions or 72h [house] of data (this read: 1,500 impressions at 30 h); nothing to change. The 168-hour read judges it on views against the 7-day median.')
    // Reviewed again at 80 hours: the read still holds 48 hours of data, so the gate still holds it.
    const late = judge(row(80, { '48': { impressions: 1_500, ctr: 6, avpPct: 45 } }, {}, 48), '48', null)
    expect(late.numbers.bottleneck).toBe('insufficient-data')
    expect(late.flipCondition).toMatch(/^Cold start: too early to call\. The numbers read healthy/)
    // A read taken after 72 hours holds 72 hours of data: the gate is met and the read holds as healthy.
    expect(judge(row(80, { '48': { impressions: 1_500, ctr: 6, avpPct: 45 } }), '48', null).flipCondition).toMatch(/^Every stage is healthy; let it run/)
  })
})

describe('decide: REPACKAGE at 48 hours', () => {
  const good = row(48, { '24': { impressions: 12_000 }, '48': { impressions: 22_000, ctr: 2, avpPct: 42 } })

  it('repackages when every gate passes and records the numbers that made it', () => {
    const d = judge(good, '48')
    expect(d.decision).toBe('REPACKAGE')
    expect(d.id).toBe('solar:48')
    expect(d.numbers).toMatchObject({
      bucket: '48', hoursSincePublish: 48, bottleneck: 'packaging', mode: 'established', baselineSource: 'computed', baselineTier: 'solid',
      impressions: 22_000, ctr: 2, baselineCtr: 5, baselineAvp: 40, baselineViews: 5_000, ctrLowMark: 3.75,
      expectedImpressions: 20_000, impressionsShareOfExpected: 1.1, impressionGrowthPct: 83, stillServed: true,
      remainingImpressions: 55_000, remainingImpressionsMethod: 'current-rate-to-168h', ctrGapPoints: 3, retentionFactor: 1,
      expectedGainViews: 1_650, gainFloorViews: 500, repackageWindowHours: 72, oneSwapPerDays: 7,
    })
    expect(d.flipCondition).toBe('Expected gain 1,650 views clears the 500 floor. Flips to HOLD if impressions stop rising or the window (72h [house]) closes before the swap; thumbnail first, title only if the re-read is still under 3.75%.')
    expect(d.updatedAt).toBe(now.toISOString())
    expect(d.source).toBe('cli')
    expect(DecisionDoc.parse(d)).toEqual(d)
  })

  it('is deterministic and honours the source', () => {
    expect(judge(good, '48')).toEqual(judge(good, '48'))
    const diagnosis = diagnose({ ...good.reads['48'], bucket: '48', baselines: baselines(), hoursSincePublish: 48 })
    expect(decide({ diagnosis, row: good, bucket: '48', baselines: baselines(), now, source: 'agent:review' }).source).toBe('agent:review')
  })

  it('holds when the last swap was inside 7 days and names the date it flips', () => {
    const swapped = row(48, good.reads, { repackagedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString() })
    const d = judge(swapped, '48')
    expect(d.decision).toBe('HOLD')
    expect(d.numbers.daysSinceSwap).toBe(3)
    expect(d.flipCondition).toMatch(/one per 7d \[house\]/)
    expect(d.flipCondition).toContain('Flips to REPACKAGE on 2026-09-18')
    const old = row(48, good.reads, { repackagedAt: new Date(now.getTime() - 8 * 86_400_000).toISOString() })
    expect(judge(old, '48').decision).toBe('REPACKAGE')
  })

  it('holds once the 72-hour window has closed', () => {
    const late = row(80, { '48': { impressions: 22_000, ctr: 2, avpPct: 42 } })
    const d = judge(late, '48')
    expect(d.decision).toBe('HOLD')
    expect(d.numbers.hoursSincePublish).toBe(80)
    expect(d.flipCondition).toMatch(/past the 72h \[house\] window/)
  })

  it('holds when impressions are under 0.8x expected and not rising', () => {
    const stalled = row(48, { '24': { impressions: 9_500 }, '48': { impressions: 10_000, ctr: 2, avpPct: 42 } })
    const d = judge(stalled, '48')
    expect(d.decision).toBe('HOLD')
    expect(d.numbers).toMatchObject({ impressionsShareOfExpected: 0.5, impressionGrowthPct: 5, stillServed: false })
    expect(d.flipCondition).toMatch(/under 0.8x the expected 20,000 and not rising/)
    expect(d.flipCondition).toMatch(/if impressions reach 16,000/)
    // Still rising beats the share test.
    const rising = row(48, { '24': { impressions: 6_000 }, '48': { impressions: 10_000, ctr: 2, avpPct: 42 } })
    expect(judge(rising, '48').decision).toBe('REPACKAGE')
    expect(judge(rising, '48').numbers.stillServed).toBe(true)
  })

  it('holds when the expected gain is under the floor and says what remaining impressions would flip it', () => {
    const b = baselines({ impressions: undefined, views: { median: 1_000, mad: 100, n: 10 } })
    const small = row(70, { '48': { impressions: 3_000, ctr: 2, avpPct: 42 } })
    const d = judge(small, '48', b)
    expect(d.decision).toBe('HOLD')
    expect(d.numbers).toMatchObject({ stillServed: 'unknown', remainingImpressions: 4_200, expectedGainViews: 126, gainFloorViews: 500, retentionFactor: 1 })
    expect(d.flipCondition).toMatch(/about 126 views .* under the floor of 500 \(max of 500 \[house\] views and 5% \[house\] of median views\)/)
    expect(d.flipCondition).toMatch(/remaining impressions reach 16,667/)
  })

  it('scales the gain by retention and the floor by median views, and uses the 7-day median when it has one', () => {
    const b = baselines({ bucket: '168', views: { median: 40_000, mad: 5_000, n: 10 }, impressions: { median: 100_000, mad: 9_000, n: 10 } })
    const r = row(48, { '48': { impressions: 22_000, ctr: 2, avpPct: 20 } })
    const diagnosis = diagnose({ ...r.reads['48'], bucket: '48', baselines: b, hoursSincePublish: 48 })
    const d = decide({ diagnosis, row: r, bucket: '48', baselines: b, now })
    expect(d.numbers).toMatchObject({ remainingImpressions: 78_000, remainingImpressionsMethod: 'median-168h-minus-current', retentionFactor: 0.5, expectedGainViews: 1_170, gainFloorViews: 2_000 })
    expect(d.decision).toBe('HOLD')
  })

  it('reads the gates from the live threshold table', () => {
    applyOverrides({ repackageMinExpectedGainViews: 5_000 })
    const d = judge(good, '48')
    expect(d.decision).toBe('HOLD')
    expect(d.numbers.gainFloorViews).toBe(5_000)
    expect(d.flipCondition).toMatch(/5000 \[house\] views/)
  })
})

describe('decide: other 48-hour verdicts', () => {
  it('re-tests the title in the soft band inside the window', () => {
    const soft = row(48, { '48': { impressions: 50_000, ctr: 4, avpPct: 42 } })
    const d = judge(soft, '48')
    expect(d.decision).toBe('RE-TEST-TITLE')
    expect(d.numbers.ctrHealthyMark).toBe(4.5)
    expect(d.flipCondition).toMatch(/to REPACKAGE if a re-read inside the window falls under 3.75%/)
    expect(judge(row(80, soft.reads), '48').decision).toBe('HOLD')
    expect(judge(row(80, soft.reads), '48').flipCondition).toMatch(/Nothing flips this/)
    const swapped = row(48, soft.reads, { repackagedAt: new Date(now.getTime() - 2 * 86_400_000).toISOString() })
    expect(judge(swapped, '48').decision).toBe('HOLD')
    expect(judge(swapped, '48').flipCondition).toMatch(/Flips to RE-TEST-TITLE on 2026-09-19/)
  })

  it('holds on idea, hook, retention and none with the 7-day flip spelled out', () => {
    const idea = judge(row(48, { '48': { impressions: 8_000, ctr: 5, avpPct: 42 } }), '48')
    expect(idea.decision).toBe('HOLD')
    expect(idea.flipCondition).toMatch(/Flips to PARK at the 7-day read if views are under 0.7x \[house\] median \(3,500 views\)/)
    const hook = judge(row(48, { '48': { impressions: 22_000, ctr: 5, avpPct: 42, retention30sPct: 40 } }), '48')
    expect(hook.decision).toBe('HOLD')
    expect(hook.flipCondition).toMatch(/first 30 seconds/)
    const retention = judge(row(48, { '48': { impressions: 22_000, ctr: 5, avpPct: 30, retention30sPct: 70 } }), '48')
    expect(retention.decision).toBe('HOLD')
    expect(retention.flipCondition).toMatch(/retention dips/)
    const none = judge(row(48, { '48': { impressions: 22_000, ctr: 5.5, avpPct: 42 } }), '48')
    expect(none.decision).toBe('HOLD')
    expect(none.flipCondition).toMatch(/Flips to SEQUEL at the 7-day read if views reach 3x \[house\] median \(15,000\)/)
  })
})

describe('decide: 7-day and 28-day reads', () => {
  const b168 = baselines({ bucket: '168', impressions: { median: 60_000, mad: 5_000, n: 10 } })

  it('sequels a 3x video whose returning share and AVP hold, never recommending a swap', () => {
    const r = row(168, { '168': { impressions: 80_000, ctr: 5.5, avpPct: 42, views: 18_000, returningPct: 40 } })
    const d = judge(r, '168', b168)
    expect(d.decision).toBe('SEQUEL')
    expect(d.id).toBe('solar:168')
    expect(d.numbers).toMatchObject({ multiple: 3.6, returningPct: 40, baselineReturningPct: 40, returningRel: 1, avpRel: 1.05, sequelMultiple: 3, sequelReturningRel: 0.9, sequelAvpRel: 0.9 })
    expect(d.flipCondition).toMatch(/Flips to EXPAND if returning share on the sequel drops under 0.9x \[house\] baseline \(36%\)/)
  })

  it('downgrades a 3x video to EXPAND when returning share is missing, low, or AVP dropped', () => {
    const missing = judge(row(168, { '168': { impressions: 80_000, ctr: 5.5, avpPct: 42, views: 18_000 } }), '168', b168)
    expect(missing.decision).toBe('EXPAND')
    expect(missing.flipCondition).toMatch(/record the returning-viewer share/)
    const strangers = judge(row(168, { '168': { impressions: 80_000, ctr: 5.5, avpPct: 42, views: 18_000, returningPct: 30 } }), '168', b168)
    expect(strangers.decision).toBe('EXPAND')
    expect(strangers.numbers.returningRel).toBe(0.75)
    expect(strangers.flipCondition).toMatch(/returning share 30% is under 0.9x \[house\] baseline \(36%\): the views came from strangers/)
    const leaky = judge(row(168, { '168': { impressions: 80_000, ctr: 5.5, avpPct: 35, views: 18_000, returningPct: 40 } }), '168', b168)
    expect(leaky.decision).toBe('EXPAND')
    expect(leaky.flipCondition).toMatch(/AVP is 0.88x baseline, under 0.9x \[house\]/)
  })

  it('expands between 1.5x and 3x with healthy retention and holds when the hook is broken', () => {
    const d = judge(row(168, { '168': { impressions: 60_000, ctr: 5.5, avpPct: 42, views: 10_000, returningPct: 40 } }), '168', b168)
    expect(d.decision).toBe('EXPAND')
    expect(d.numbers.multiple).toBe(2)
    expect(d.flipCondition).toMatch(/Flips to SEQUEL at 3x \[house\]/)
    const hook = judge(row(168, { '168': { impressions: 60_000, ctr: 5.5, avpPct: 42, views: 10_000, retention30sPct: 40 } }), '168', b168)
    expect(hook.decision).toBe('HOLD')
    expect(hook.flipCondition).toMatch(/the hook is broken; expanding a leaky format/)
  })

  it('parks below 0.7x with an idea bottleneck and holds otherwise', () => {
    const park = judge(row(168, { '168': { impressions: 6_000, ctr: 5, avpPct: 42, views: 2_500 } }), '168', b168)
    expect(park.decision).toBe('PARK')
    expect(park.numbers).toMatchObject({ multiple: 0.5, bottleneck: 'idea', parkMultiple: 0.7 })
    expect(park.flipCondition).toMatch(/related outlier at 5x \[house\]/)
    const packaging = judge(row(168, { '168': { impressions: 80_000, ctr: 2, avpPct: 42, views: 2_500 } }), '168', b168)
    expect(packaging.decision).toBe('HOLD')
    expect(packaging.numbers.bottleneck).toBe('packaging')
    expect(packaging.flipCondition).toMatch(/the 72-hour swap window has closed. Write the lever/)
    const hook = judge(row(168, { '168': { impressions: 80_000, ctr: 5, avpPct: 42, views: 2_500, retention30sPct: 40 } }), '168', b168)
    expect(hook.decision).toBe('HOLD')
    expect(hook.flipCondition).toMatch(/a hook bottleneck: the topic had demand, the video did not deliver it/)
    const normal = judge(row(168, { '168': { impressions: 60_000, ctr: 5.5, avpPct: 42, views: 5_000 } }), '168', b168)
    expect(normal.decision).toBe('HOLD')
    expect(normal.flipCondition).toMatch(/1.00x median views: a normal video. Flips to EXPAND at 1.5x \[house\] \(7,500 views\)/)
  })

  it('holds when the multiple cannot be computed', () => {
    const noViews = judge(row(168, { '168': { impressions: 60_000, ctr: 5.5, avpPct: 42 } }), '168', b168)
    expect(noViews.decision).toBe('HOLD')
    expect(noViews.flipCondition).toMatch(/Record views on the 168-hour read/)
    const cold = judge(row(168, { '168': { impressions: 60_000, ctr: 5.5, avpPct: 42, views: 9_000 } }), '168', null)
    expect(cold.decision).toBe('HOLD')
    expect(cold.numbers.mode).toBe('cold-start')
    expect(cold.numbers).toMatchObject({ baselineViewsN: 0, baselineViewsTier: 'prior' })
    expect(cold.flipCondition).toBe('No 7-day median views yet (0 of 5 reads): the multiple cannot be computed, and a 48-hour or typed median never stands in for it. Flips to SEQUEL/EXPAND/PARK once 5 more videos have a 7-day read with views.')
  })

  it('records the views baseline behind the multiple: n and tier', () => {
    const d = judge(row(168, { '168': { impressions: 80_000, ctr: 5.5, avpPct: 42, views: 18_000, returningPct: 40 } }), '168', b168)
    expect(d.numbers).toMatchObject({ baselineViews: 5_000, baselineViewsN: 10, baselineViewsTier: 'solid' })
  })

  it('judges the 28-day read the same way', () => {
    const d = judge(row(672, { '672': { impressions: 90_000, ctr: 5.5, avpPct: 42, views: 20_000, returningPct: 41 } }), '672', b168)
    expect(d.decision).toBe('SEQUEL')
    expect(d.id).toBe('solar:672')
    expect(d.numbers.multiple).toBe(4)
  })
})

describe('decide: SEQUEL, EXPAND and PARK need five 7-day reads', () => {
  /** A 168-hour baseline whose views median rests on `n` reads. */
  const week = (n: number, median = 12_000) => baselines({ bucket: '168', n, tier: n < 5 ? 'prior' : n < 10 ? 'thin' : 'solid', views: { median, mad: 1_000, n }, impressions: { median: 200_000, mad: 9_000, n } })
  const hit = row(192, { '168': { impressions: 150_000, ctr: 5.5, avpPct: 42, retention30sPct: 70, views: 40_000, returningPct: 40 } })

  it('holds a 3.33x video on a median of one other video, keeps the multiple and says why', () => {
    // Before the fix this was SEQUEL (multiple 3.33 over one read), a false win for the flywheel.
    const d = judge(hit, '168', week(1))
    expect(d.decision).toBe('HOLD')
    expect(d.numbers).toMatchObject({ multiple: 3.33, baselineViews: 12_000, baselineViewsN: 1, baselineViewsTier: 'prior' })
    expect(d.flipCondition).toBe('3.33x median views, but the 7-day median rests on 1 of 5 reads; SEQUEL/EXPAND/PARK wait for 5. Flips once 4 more videos have a 7-day read with views.')
  })

  it('opens at exactly five reads, the boundary where tierFor() leaves prior', () => {
    expect(judge(hit, '168', week(4)).decision).toBe('HOLD')
    expect(judge(hit, '168', week(4)).flipCondition).toMatch(/rests on 4 of 5 reads; .* Flips once 1 more video has a 7-day read/)
    const five = judge(hit, '168', week(5))
    expect(five.decision).toBe('SEQUEL')
    expect(five.numbers).toMatchObject({ baselineViewsN: 5, baselineViewsTier: 'thin' })
    // EXPAND and PARK are gated the same way, at 168 and at 672 hours.
    const expand = row(192, { '168': { impressions: 90_000, ctr: 5.5, avpPct: 42, views: 24_000, returningPct: 40 } })
    expect(judge(expand, '168', week(4)).decision).toBe('HOLD')
    expect(judge(expand, '168', week(5)).decision).toBe('EXPAND')
    const flop = row(700, { '672': { impressions: 6_000, ctr: 5, avpPct: 42, views: 2_500 } })
    const parked = judge(flop, '672', week(5, 5_000))
    expect(parked.decision).toBe('PARK')
    // Forced established so the diagnosis still reads idea on the thin median: the gate alone holds it.
    const thin = judge(flop, '672', week(3, 5_000), { mode: 'established' })
    expect(thin.decision).toBe('HOLD')
    expect(thin.numbers).toMatchObject({ multiple: 0.5, bottleneck: 'idea', baselineViewsN: 3 })
  })

  it('carries the broken stage into the held call', () => {
    const packaging = judge(row(192, { '168': { impressions: 200_000, ctr: 2, avpPct: 42, views: 30_000 } }), '168', week(2))
    expect(packaging.decision).toBe('HOLD')
    expect(packaging.flipCondition).toMatch(/rests on 2 of 5 reads; SEQUEL\/EXPAND\/PARK wait for 5\. CTR was the bottleneck and the swap window has closed: write the lever/)
    const hook = judge(row(192, { '168': { impressions: 200_000, ctr: 5.5, avpPct: 42, retention30sPct: 40, views: 30_000 } }), '168', week(2))
    expect(hook.flipCondition).toMatch(/The hook is broken: fix it in the next edit\./)
  })

  it('never lets a 48-hour median or a typed number stand in for the 7-day median', () => {
    // A 48-hour set passed at the 7-day read: the old code multiplied against its 5,000 views (EXPAND at 2x).
    const read = row(192, { '168': { impressions: 150_000, ctr: 5.5, avpPct: 42, views: 10_000, returningPct: 40 } })
    const on48 = judge(read, '168', baselines())
    expect(on48.decision).toBe('HOLD')
    expect(on48.numbers.multiple).toBeUndefined()
    expect(on48.numbers.baselineViews).toBeUndefined()
    expect(on48.flipCondition).toMatch(/^No 7-day median views yet \(0 of 5 reads\)/)
    // A typed or profile number (the flat baseline) at the 7-day read: the old code called SEQUEL at 3.3x.
    const typed = judge(read, '168', null, { baseline: { ctr: 5, avpPct: 40, views: 3_000 } })
    expect(typed.decision).toBe('HOLD')
    expect(typed.numbers.multiple).toBeUndefined()
    // The 48-hour decision still reads the 48-hour median views for its floor and flips.
    expect(judge(row(48, { '48': { impressions: 22_000, ctr: 5.5, avpPct: 42 } }), '48').flipCondition).toMatch(/median \(15,000\)/)
  })
})

describe('decide: the gates that belong to one window stay in it', () => {
  it('reaches a 7-day decision on a CTR the 48-hour certainty gate would still be waiting on', () => {
    // 150,000 impressions at 3.1% straddle the low mark (0.75 x 4.1%): the 7-day read used to be WAIT until ~1.83M impressions.
    const week = baselines({ bucket: '168', ctr: { median: 4.1, mad: 0.2, n: 6 }, avpPct: { median: 42, mad: 1, n: 6 }, views: { median: 9_000, mad: 900, n: 6 }, n: 6, tier: 'thin' })
    const d = judge(row(192, { '168': { impressions: 150_000, ctr: 3.1, avpPct: 42, views: 9_000 } }), '168', week)
    expect(d.decision).toBe('HOLD')
    expect(d.numbers).toMatchObject({ bottleneck: 'packaging-soft', multiple: 1 })
    expect(d.numbers.impressionsNeeded).toBeUndefined()
    // The 48-hour read of the same numbers still waits for the band to be certain.
    const at48 = judge(row(48, { '48': { impressions: 150_000, ctr: 3.1, avpPct: 42 } }), '48', baselines({ ctr: { median: 4.1, mad: 0.2, n: 10 }, avpPct: { median: 42, mad: 1, n: 10 }, impressions: { median: 150_000, mad: 9_000, n: 10 } }))
    expect(at48.decision).toBe('WAIT')
    expect(at48.numbers.impressionsNeeded).toBe(1_831_948)
  })

  it('never calls a cold-start read healthy before the gate', () => {
    const early = judge(row(30, { '48': { impressions: 1_500, ctr: 6, avpPct: 45 } }), '48', null)
    expect(early.numbers.bottleneck).toBe('insufficient-data')
    expect(early.flipCondition).not.toMatch(/Every stage is healthy/)
  })
})

describe('decide and the diagnosis tell one story', () => {
  // The diagnosis is printed right above the decision (booster decide, the digest, the Desk review card), so
  // a healthy verdict must never prescribe the sequel that decide() holds back.
  const prescribesSequel = /double down|make the sequel(?! when the decision says SEQUEL)/i

  /** `others` earlier videos with a 7-day read at `views` views, and the target at 180 h, all judged at 168 h as the review agent does. */
  function weekCall(others: number, target: Omit<LedgerRead, 'at'>) {
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
    const back: LedgerRow[] = Array.from({ length: others }, (_, i) => ({
      id: `back-${i}`, slug: `back-${i}`, title: `b${i}`, publishedAt: at((40 + i) * 24), updatedAt: at(0), source: 'cli',
      reads: { '168': { at: at((33 + i) * 24), impressions: 200_000, ctr: 4.1, views: 12_000, avpPct: 42, retention30sPct: 62, returningPct: 30 } },
    }))
    const r: LedgerRow = { id: 'target', slug: 'target', title: 'T', publishedAt: at(180), updatedAt: at(0), source: 'cli', reads: { '168': { at: at(12), ...target } } }
    const b = baselineFrom([...back, r], { bucket: '168', now, excludeSlug: 'target' })
    const read = r.reads['168']!
    const diagnosis = diagnose({ ...read, bucket: '168', baselines: b, hoursSincePublish: readAgeHours(r, read), returningViewerPct: read.returningPct })
    return { diagnosis, doc: decide({ diagnosis, row: r, bucket: '168', baselines: b, now }) }
  }

  it('holds a 3x video on a 7-day median of one read without the diagnosis saying "make the sequel"', () => {
    const { diagnosis, doc } = weekCall(1, { impressions: 150_000, ctr: 4.3, views: 40_000, avpPct: 42, retention30sPct: 62, returningPct: 30 })
    expect(diagnosis.bottleneck).toBe('none')
    expect(doc.decision).toBe('HOLD')
    expect(doc.flipCondition).toMatch(/rests on 1 of 5 reads; SEQUEL\/EXPAND\/PARK wait for 5/)
    expect([diagnosis.headline, ...diagnosis.actions].join('\n')).not.toMatch(prescribesSequel)
    expect(diagnosis.actions[0]).toBe('Every stage is healthy. Make the sequel when the decision says SEQUEL: views at 3x [house] the 7-day median, with enough 7-day reads behind that median, not healthy rates alone.')
  })

  it('never prescribes the sequel from a healthy verdict unless the decision is SEQUEL, at any scheduled read', () => {
    const cases = [
      weekCall(1, { impressions: 150_000, ctr: 4.3, views: 40_000, avpPct: 42, retention30sPct: 62, returningPct: 30 }),
      weekCall(6, { impressions: 150_000, ctr: 4.3, views: 12_000, avpPct: 42, retention30sPct: 62, returningPct: 30 }),
      weekCall(6, { impressions: 150_000, ctr: 4.3, views: 24_000, avpPct: 42, retention30sPct: 62, returningPct: 30 }),
      weekCall(6, { impressions: 150_000, ctr: 4.3, views: 40_000, avpPct: 42, retention30sPct: 62, returningPct: 30 }),
    ]
    const at48 = judge(row(48, { '48': { impressions: 22_000, ctr: 5.5, avpPct: 45, retention30sPct: 70 } }), '48')
    const d48 = diagnose({ ...row(48, { '48': { impressions: 22_000, ctr: 5.5, avpPct: 45, retention30sPct: 70 } }).reads['48']!, bucket: '48', baselines: baselines(), hoursSincePublish: 48 })
    expect(d48.bottleneck).toBe('none')
    expect(at48.decision).toBe('HOLD')
    expect([d48.headline, ...d48.actions].join('\n')).not.toMatch(prescribesSequel)
    expect(cases.map((c) => c.doc.decision)).toEqual(['HOLD', 'HOLD', 'EXPAND', 'SEQUEL'])
    for (const { diagnosis, doc } of cases) {
      expect(diagnosis.bottleneck).toBe('none')
      if (doc.decision !== 'SEQUEL') expect([diagnosis.headline, ...diagnosis.actions].join('\n')).not.toMatch(prescribesSequel)
    }
    // A one-off postmortem with no bucket has no decision after it, and keeps its plain advice.
    expect(diagnose({ impressions: 22_000, ctr: 5.5, avpPct: 45, retention30sPct: 70, baselines: baselines() }).headline).toBe('Packaging and retention are both at or above baseline. Double down.')
  })
})

describe('describeDecision', () => {
  it('prints the decision, the numbers and the flip', () => {
    const d = judge(row(48, { '24': { impressions: 12_000 }, '48': { impressions: 22_000, ctr: 2, avpPct: 42 } }), '48')
    const text = describeDecision(d)
    expect(text.split('\n')[0]).toBe('Decision: REPACKAGE (solar at 48 h)')
    expect(text).toContain('expectedGainViews=1,650')
    expect(text).toContain('Flip: Expected gain 1,650 views')
  })
})
