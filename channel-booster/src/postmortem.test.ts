import { afterEach, describe, expect, it } from 'vitest'
import { ALLOWED_VERDICTS, describeBaselineUsed, diagnose, impressionsToSettle, wilsonCtrInterval } from './postmortem.js'
import type { Baselines } from './schema.js'
import { applyOverrides, resetThresholds } from './thresholds.js'

afterEach(() => resetThresholds())

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

describe('diagnose', () => {
  it('asks for data when there is none', () => {
    expect(diagnose({}).bottleneck).toBe('insufficient-data')
    expect(diagnose({ impressions: 200, ctr: 5, hoursSincePublish: 6 }).bottleneck).toBe('insufficient-data')
  })

  it('blames packaging when CTR is low and recommends a repackage inside 72 hours', () => {
    const d = diagnose({ impressions: 20_000, ctr: 2, avpPct: 45, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 5_000 } })
    expect(d.bottleneck).toBe('packaging')
    expect(d.repackage).toBe(true)
  })

  it('blames the idea when impressions never came despite healthy CTR', () => {
    const d = diagnose({ impressions: 3_000, ctr: 6, avpPct: 42, baseline: { ctr: 5, avpPct: 40, views: 20_000 } })
    expect(d.bottleneck).toBe('idea')
    expect(d.repackage).toBe(false)
  })

  it('blames the hook when 30-second retention collapses', () => {
    const d = diagnose({ impressions: 50_000, ctr: 6, retention30sPct: 45, avpPct: 30, baseline: { ctr: 5, avpPct: 40 } })
    expect(d.bottleneck).toBe('hook')
  })

  it('blames retention when the open holds but the middle sags', () => {
    const d = diagnose({ impressions: 50_000, ctr: 6, retention30sPct: 75, avpPct: 30, baseline: { ctr: 5, avpPct: 40 } })
    expect(d.bottleneck).toBe('retention')
  })

  it('celebrates a healthy funnel and derives AVP from duration', () => {
    const d = diagnose({ impressions: 50_000, ctr: 6, avdSec: 300, durationSec: 600, baseline: { ctr: 5, avpPct: 40 } })
    expect(d.bottleneck).toBe('none')
    expect(d.evidence.some((e) => e.includes('50%'))).toBe(true)
  })
})

describe('diagnose: verified defects', () => {
  it('reaches the idea bottleneck without a baseline views figure once a day has passed', () => {
    const d = diagnose({ impressions: 300, ctr: 6, avpPct: 45, hoursSincePublish: 60 })
    expect(d.bottleneck).toBe('idea')
    expect(d.baselineSource).toBe('default')
    expect(d.evidence[0]).toMatch(/baseline is borrowed/)
  })
  it('never calls a sub-1000-impression video healthy', () => {
    const d = diagnose({ impressions: 800, ctr: 6, avpPct: 45, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 200 } })
    expect(d.bottleneck).toBe('insufficient-data')
  })
  it('routes the borderline CTR band to packaging-soft with no repackage', () => {
    // 50,000 impressions: the Wilson interval on 4% (3.83-4.17%) clears both the low (3.75%) and healthy (4.5%) marks.
    const d = diagnose({ impressions: 50_000, ctr: 4, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 5_000 } })
    expect(d.bottleneck).toBe('packaging-soft')
    expect(d.repackage).toBe(false)
    expect(d.thresholdsUsed.join(' ')).toMatch(/ctrHealthyRel 0.9x \[house\]/)
  })
})

describe('diagnose v2: Wilson interval', () => {
  it('computes a Wilson interval in percent and the sample that settles it', () => {
    const i = wilsonCtrInterval(4, 20_000)
    expect(i.low).toBeCloseTo(3.74, 1)
    expect(i.high).toBeCloseTo(4.27, 1)
    expect(i.z).toBe(1.96)
    expect(wilsonCtrInterval(0, 10).low).toBe(0)
    expect(wilsonCtrInterval(100, 10).high).toBe(100)
    const n = impressionsToSettle(4, [3.75], 20_000)!
    expect(n).toBeGreaterThan(20_000)
    expect(n).toBeLessThan(30_000)
    expect(wilsonCtrInterval(4, n).low).toBeGreaterThanOrEqual(3.75)
    expect(wilsonCtrInterval(4, n - 1).low).toBeLessThan(3.75)
    expect(impressionsToSettle(4, [4])).toBeUndefined()
    expect(impressionsToSettle(4, [3.75], 100_000)).toBe(100_000)
  })

  it('returns insufficient-data with the impressions still needed when the interval straddles the low mark', () => {
    const d = diagnose({ impressions: 20_000, ctr: 4, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 5_000 } })
    expect(d.bottleneck).toBe('insufficient-data')
    expect(d.ctrInterval?.low).toBeLessThan(3.75)
    expect(d.impressionsNeeded).toBeGreaterThan(20_000)
    expect(d.actions[0]).toMatch(/Collect about [\d,]+ more impressions \([\d,]+ total\) before calling CTR soft/)
    expect(d.evidence.join('\n')).toMatch(/straddles the low threshold 3.75%: about [\d,]+ more impressions needed/)
    expect(d.thresholdsUsed).toContain('wilsonZ 1.96 [house]')
  })

  it('does not call a thin sample healthy or low when the interval crosses the mark', () => {
    // 6% on 1,200 impressions vs a 5% baseline: interval ~4.8-7.5% crosses the healthy mark 4.5%? No: it clears it.
    const healthy = diagnose({ impressions: 1_200, ctr: 6, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 500 } })
    expect(healthy.bottleneck).toBe('none')
    // 5% on 1,200 impressions: interval ~3.9-6.4% crosses 4.5%.
    const unsure = diagnose({ impressions: 1_200, ctr: 5, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 500 } })
    expect(unsure.bottleneck).toBe('insufficient-data')
    expect(unsure.headline).toMatch(/reads healthy/)
    // 3% on 1,200 impressions: interval ~2.2-4.2% crosses the low mark 3.75%.
    const low = diagnose({ impressions: 1_200, ctr: 3, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 500 } })
    expect(low.bottleneck).toBe('insufficient-data')
    expect(low.headline).toMatch(/reads low/)
    expect(low.repackage).toBe(false)
  })

  it('still calls a clearly low CTR packaging on a large sample', () => {
    const d = diagnose({ impressions: 200_000, ctr: 3.5, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 5_000 } })
    expect(d.bottleneck).toBe('packaging')
    expect(d.ctrInterval?.high).toBeLessThan(3.75)
  })

  it('never lets the certainty gate block the 7 or 28-day read: the swap window is closed', () => {
    // 150,000 impressions at 3.1% against a low mark of 3.07% (0.75 x 4.1%): the interval straddles it.
    const flat = { ctr: 4.1, avpPct: 42, views: 4_450 }
    const at48 = diagnose({ impressions: 150_000, ctr: 3.1, avpPct: 42, bucket: '48', hoursSincePublish: 48, baseline: flat })
    expect(at48.bottleneck).toBe('insufficient-data')
    expect(at48.impressionsNeeded).toBe(1_831_948)
    // The same read at 168 h used to say "about 1,681,948 more impressions needed" and deadlock the 7-day stage.
    const at168 = diagnose({ impressions: 150_000, ctr: 3.1, avpPct: 42, bucket: '168', baseline: flat })
    expect(at168.bottleneck).toBe('packaging-soft')
    expect(at168.repackage).toBe(false)
    expect(at168.impressionsNeeded).toBeUndefined()
    expect(at168.ctrInterval?.low).toBeLessThan(3.075)
    expect(at168.ctrInterval?.high).toBeGreaterThan(3.075)
    expect(at168.evidence.join('\n')).toMatch(/CTR 95% interval 3\.01% to 3\.19% over 150,000 impressions/)
    expect(at168.evidence.join('\n')).toContain('the interval straddles the low threshold 3.07%; the swap window is closed at the 168-hour read, so the band is called on the point estimate, not a certain one')
    // Low and healthy bands are called the same way at 168 and 672 hours; no swap is ever recommended.
    const low = diagnose({ impressions: 150_000, ctr: 3, avpPct: 42, bucket: '672', hoursSincePublish: 672, baseline: flat })
    expect(low.bottleneck).toBe('packaging')
    expect(low.repackage).toBe(false)
    expect(diagnose({ impressions: 150_000, ctr: 3.7, avpPct: 42, bucket: '168', baseline: flat }).bottleneck).toBe('none')
    expect(diagnose({ impressions: 150_000, ctr: 3.7, avpPct: 42, bucket: '48', hoursSincePublish: 48, baseline: flat }).bottleneck).toBe('insufficient-data')
  })

  it('reads the hook before an uncertain CTR band', () => {
    const d = diagnose({ impressions: 1_200, ctr: 5, retention30sPct: 40, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40, views: 500 } })
    expect(d.bottleneck).toBe('hook')
  })
})

describe('diagnose v2: baselines and evidence', () => {
  it('prefers computed baselines over the flat object and opens the evidence with them', () => {
    const d = diagnose({ impressions: 22_000, ctr: 2, avpPct: 42, bucket: '48', baselines: baselines(), baseline: { ctr: 9, avpPct: 70 } })
    expect(d.bottleneck).toBe('packaging')
    expect(d.mode).toBe('established')
    expect(d.baselineSource).toBe('provided')
    expect(d.baselineUsed).toMatchObject({ ctr: 5, avpPct: 40, retention30sPct: 65, views: 5_000, impressions: 20_000, returningPct: 40, source: 'computed', tier: 'solid', n: 10, bucket: '48', borrowed: [] })
    expect(d.evidence[0]).toBe('baseline used: computed from your ledger (solid tier, n=10, 48 h reads): CTR judged vs baseline 5%, AVP vs 40%, 30 s vs 65%, views vs 5,000, expected impressions 20,000, returning vs 40%')
    expect(d.evidence.join('\n')).toContain('impressions 22,000 vs expected 20,000 at this read (1.10x)')
  })

  it('names a flat caller baseline and the priors it borrowed', () => {
    const d = diagnose({ impressions: 20_000, ctr: 2, avpPct: 42, hoursSincePublish: 48, baseline: { ctr: 5, avpPct: 40 } })
    expect(d.evidence[0]).toBe('baseline used: provided by the caller (tier unknown): CTR judged vs baseline 5%, AVP vs 40%; borrowed from priors: 30 s 60% [unverified]')
    expect(d.baselineUsed.borrowed).toEqual(['retention30sPct'])
    expect(describeBaselineUsed({ ctr: 4, avpPct: 40, retention30sPct: 60, source: 'default', borrowed: ['ctr', 'avpPct', 'retention30sPct'], tier: 'prior', n: 2 })).toBe('baseline is borrowed: CTR 4% [unverified], AVP 40% [house], 30 s 60% [unverified] (no channel history given; ledger tier prior, n=2)')
  })

  it('ignores the impressions median when the baselines were computed for another bucket', () => {
    const d = diagnose({ impressions: 6_000, ctr: 5, avpPct: 42, bucket: '168', baselines: baselines({ bucket: '48' }) })
    expect(d.baselineUsed.impressions).toBeUndefined()
    // Falls back to 2x median views: 6,000 < 10,000 reads idea.
    expect(d.bottleneck).toBe('idea')
    expect(d.thresholdsUsed).toContain('impressionsHealthyVsMedianViews 2x [house]')
  })

  it('reads the idea stage from the channel\'s own expected impressions', () => {
    const d = diagnose({ impressions: 8_000, ctr: 5, avpPct: 42, bucket: '48', baselines: baselines() })
    expect(d.bottleneck).toBe('idea')
    expect(d.thresholdsUsed).toContain('impressionsLowVsExpectedRel 0.5x [house]')
    const fine = diagnose({ impressions: 12_000, ctr: 5.5, avpPct: 42, bucket: '48', baselines: baselines() })
    expect(fine.bottleneck).toBe('none')
  })

  it('reports traffic and loyalty reads on every verdict', () => {
    const d = diagnose({ impressions: 22_000, ctr: 5.5, avpPct: 42, bucket: '48', baselines: baselines(), browseSuggestedPct: 25, subscriberSharePct: 55, returningViewerPct: 38 })
    expect(d.algorithmic).toBe(false)
    expect(d.evidence).toEqual(expect.arrayContaining([
      expect.stringMatching(/^not yet algorithmic: browse \+ suggested 25% of impressions, under 40% \[house\]/),
      expect.stringMatching(/^subscribers 55% of views/),
      'returning viewers 38% of views (0.95x baseline 40%)',
    ]))
    expect(d.thresholdsUsed).toContain('notAlgorithmicBrowseSuggestedPct 40% [house]')
    const algo = diagnose({ impressions: 22_000, ctr: 5.5, avpPct: 42, bucket: '48', baselines: baselines(), browseSuggestedPct: 61 })
    expect(algo.algorithmic).toBe(true)
    expect(algo.evidence.join('\n')).toMatch(/the system is recommending it/)
    expect(diagnose({ impressions: 22_000, ctr: 5.5, bucket: '48', baselines: baselines() }).algorithmic).toBeUndefined()
  })

  it('reads overridden thresholds from the live table', () => {
    applyOverrides({ notAlgorithmicBrowseSuggestedPct: 20 })
    const d = diagnose({ impressions: 22_000, ctr: 5.5, avpPct: 42, bucket: '48', baselines: baselines(), browseSuggestedPct: 25 })
    expect(d.algorithmic).toBe(true)
  })
})

describe('diagnose v2: buckets', () => {
  it('lists the allowed verdicts per bucket', () => {
    expect(ALLOWED_VERDICTS['24']).toEqual(['insufficient-data', 'idea'])
    expect(ALLOWED_VERDICTS['168']).toContain('packaging')
    expect(diagnose({ impressions: 22_000, ctr: 2, bucket: '48', baselines: baselines() }).allowedVerdicts).toEqual(ALLOWED_VERDICTS['48'])
    expect(diagnose({ impressions: 22_000, ctr: 2, baselines: baselines() }).allowedVerdicts).toEqual(ALLOWED_VERDICTS['48'])
  })

  it('at 24 hours returns only insufficient-data or idea, never packaging', () => {
    const low = diagnose({ impressions: 22_000, ctr: 2, avpPct: 42, bucket: '24', baselines: baselines() })
    expect(low.bottleneck).toBe('insufficient-data')
    expect(low.bucket).toBe('24')
    expect(low.repackage).toBe(false)
    expect(low.headline).toMatch(/CTR reads low \(2%\) but a 24-hour read cannot call packaging/)
    expect(low.evidence.join('\n')).toMatch(/the first day is distribution, not judgment/)
    const idea = diagnose({ impressions: 300, ctr: 6, bucket: '24', baseline: { ctr: 5, avpPct: 40, views: 5_000 } })
    expect(idea.bottleneck).toBe('idea')
    expect(idea.evidence.join('\n')).toMatch(/confirm the idea verdict at the 48-hour read/)
    // Impressions alone are enough for the distribution read.
    expect(diagnose({ impressions: 300, bucket: '24', baseline: { ctr: 5, avpPct: 40, views: 5_000 } }).bottleneck).toBe('idea')
    expect(diagnose({ impressions: 30_000, bucket: '24', baselines: baselines() }).bottleneck).toBe('insufficient-data')
  })

  it('takes the hours from the bucket when none are given', () => {
    // Without a bucket, hours default to 48 and 300 impressions read idea; at the 24 bucket the same read still passes the floor gate (24 >= 24).
    expect(diagnose({ impressions: 300, ctr: 6, avpPct: 45, bucket: '24', baseline: { ctr: 5, avpPct: 40 } }).bottleneck).toBe('idea')
  })

  it('never recommends a swap at the 168 or 672-hour read', () => {
    const d168 = diagnose({ impressions: 22_000, ctr: 2, avpPct: 42, bucket: '168', baselines: baselines({ bucket: '168' }) })
    expect(d168.bottleneck).toBe('packaging')
    expect(d168.repackage).toBe(false)
    const d672 = diagnose({ impressions: 22_000, ctr: 2, avpPct: 42, bucket: '672', hoursSincePublish: 48, baselines: baselines() })
    expect(d672.bottleneck).toBe('packaging')
    expect(d672.repackage).toBe(false)
    const d48 = diagnose({ impressions: 22_000, ctr: 2, avpPct: 42, bucket: '48', baselines: baselines() })
    expect(d48.repackage).toBe(true)
  })
})

describe('diagnose v2: cold start', () => {
  it('enters cold-start mode when there is no baseline or the tier is prior, and says so', () => {
    const none = diagnose({ impressions: 5_000, ctr: 3.9, avpPct: 42, hoursSincePublish: 48 })
    expect(none.mode).toBe('cold-start')
    expect(none.evidence[0]).toMatch(/^baseline is borrowed/)
    expect(none.evidence[1]).toMatch(/^cold-start mode/)
    const prior = diagnose({ impressions: 5_000, ctr: 3.9, avpPct: 42, bucket: '48', baselines: baselines({ tier: 'prior', n: 3 }) })
    expect(prior.mode).toBe('cold-start')
    expect(prior.baselineUsed).toMatchObject({ ctr: 4, avpPct: 40, retention30sPct: 60, source: 'default', tier: 'prior', n: 3, borrowed: ['ctr', 'avpPct', 'retention30sPct'] })
    expect(prior.evidence[0]).toContain('ledger tier prior, n=3')
    expect(diagnose({ impressions: 5_000, ctr: 3.9, bucket: '48', baselines: baselines({ tier: 'prior', n: 3 }), mode: 'established' }).baselineUsed.ctr).toBe(5)
    expect(diagnose({ impressions: 5_000, ctr: 3.9, bucket: '48', baselines: baselines(), mode: 'cold-start' }).mode).toBe('cold-start')
  })

  it('withholds a packaging verdict before 2,000 impressions or 72 hours', () => {
    const early = diagnose({ impressions: 1_500, ctr: 1.5, avpPct: 42, bucket: '48' })
    expect(early.bottleneck).toBe('insufficient-data')
    expect(early.actions[0]).toBe('Cold start: no packaging verdict before 2,000 impressions or 72 hours (1,500 impressions at 48h: 500 more impressions or 24 more hours).')
    expect(early.thresholdsUsed).toEqual(expect.arrayContaining(['coldStartMinImpressions 2000 [house]', 'coldStartMinHours 72h [house]']))
    const byImpressions = diagnose({ impressions: 40_000, ctr: 1.5, avpPct: 42, bucket: '48' })
    expect(byImpressions.bottleneck).toBe('packaging')
    expect(byImpressions.repackage).toBe(true)
    const byHours = diagnose({ impressions: 1_500, ctr: 1.5, avpPct: 42, hoursSincePublish: 80 })
    expect(byHours.bottleneck).toBe('packaging')
    expect(byHours.repackage).toBe(false)
    // The soft band is gated the same way.
    expect(diagnose({ impressions: 1_500, ctr: 3.3, avpPct: 42, bucket: '48' }).bottleneck).toBe('insufficient-data')
    expect(diagnose({ impressions: 1_500, ctr: 3.3, avpPct: 42, bucket: '48' }).headline).toMatch(/reads soft but the cold-start gate is not met/)
  })

  it('holds good news too: a healthy-looking cold-start sample gets no verdict before the gate', () => {
    // postmortem --ctr 6 --impressions 1500 --avp 45 --hours 30 --mode cold-start used to say "Double down" and "Make the sequel".
    const early = diagnose({ ctr: 6, impressions: 1_500, avpPct: 45, hoursSincePublish: 30, mode: 'cold-start' })
    expect(early.bottleneck).toBe('insufficient-data')
    expect(early.repackage).toBe(false)
    expect(early.headline).toBe('The numbers look healthy so far, but a cold-start upload gets no verdict before the gate: too early to call it healthy.')
    expect(early.actions[0]).toBe('Cold start: no healthy verdict before 2,000 impressions or 72 hours (1,500 impressions at 30h: 500 more impressions or 42 more hours).')
    expect([early.headline, ...early.actions].join('\n')).not.toMatch(/double down|make the sequel/i)
    expect(early.thresholdsUsed).toEqual(expect.arrayContaining(['coldStartMinImpressions 2000 [house]', 'coldStartMinHours 72h [house]']))
    // Retention alone (no CTR) is held the same way.
    expect(diagnose({ impressions: 1_500, avpPct: 45, hoursSincePublish: 30, mode: 'cold-start' }).bottleneck).toBe('insufficient-data')
    // The same gate and thresholds: met by impressions or by hours, and established channels are untouched.
    expect(diagnose({ ctr: 6, impressions: 2_500, avpPct: 45, hoursSincePublish: 30, mode: 'cold-start' }).bottleneck).toBe('none')
    expect(diagnose({ ctr: 6, impressions: 1_500, avpPct: 45, hoursSincePublish: 80, mode: 'cold-start' }).bottleneck).toBe('none')
    expect(diagnose({ ctr: 6, impressions: 1_500, avpPct: 45, hoursSincePublish: 30, baseline: { ctr: 4, avpPct: 40 } }).bottleneck).toBe('none')
    // Idea, hook and retention verdicts read before the gate, as before.
    expect(diagnose({ ctr: 6, impressions: 1_500, avpPct: 45, retention30sPct: 40, hoursSincePublish: 30, mode: 'cold-start' }).bottleneck).toBe('hook')
    expect(diagnose({ ctr: 6, impressions: 1_500, avpPct: 25, retention30sPct: 70, hoursSincePublish: 30, mode: 'cold-start' }).bottleneck).toBe('retention')
    expect(diagnose({ ctr: 6, impressions: 1_500, avpPct: 45, hoursSincePublish: 48, bucket: '48', mode: 'cold-start', previousRead: { impressions: 1_400 } }).bottleneck).toBe('idea')
  })

  it('reads 24-to-48 hour impression growth when the previous read exists', () => {
    const rising = diagnose({ impressions: 6_000, ctr: 5, avpPct: 42, bucket: '48', previousRead: { impressions: 4_000 } })
    expect(rising.growthPct).toBeCloseTo(50, 5)
    expect(rising.bottleneck).toBe('none')
    expect(rising.evidence.join('\n')).toContain('24-to-48 h impression growth +50% (4,000 -> 6,000); healthy above 30% [house]')
    const stalled = diagnose({ impressions: 4_800, ctr: 5, avpPct: 42, bucket: '48', previousRead: { impressions: 4_000 } })
    expect(stalled.growthPct).toBeCloseTo(20, 5)
    expect(stalled.bottleneck).toBe('idea')
    expect(stalled.headline).toMatch(/stalled between the 24 and 48-hour reads/)
    expect(stalled.evidence.join('\n')).toContain('distribution has stalled')
    expect(stalled.thresholdsUsed).toContain('coldStartGrowthPct 30% [house]')
    // Established channels print the growth but judge impressions against their own history.
    const est = diagnose({ impressions: 22_000, ctr: 5.5, avpPct: 42, bucket: '48', baselines: baselines(), previousRead: { impressions: 20_000 } })
    expect(est.growthPct).toBeCloseTo(10, 5)
    expect(est.bottleneck).toBe('none')
    // Not read at the 7-day bucket.
    expect(diagnose({ impressions: 22_000, ctr: 5.5, avpPct: 42, bucket: '168', baselines: baselines({ bucket: '168' }), previousRead: { impressions: 20_000 } }).growthPct).toBeUndefined()
  })

  it('caps repackage inside the window and reads overridden priors', () => {
    applyOverrides({ priorCtr: 6 })
    const d = diagnose({ impressions: 40_000, ctr: 3.5, avpPct: 42, bucket: '48' })
    expect(d.baselineUsed.ctr).toBe(6)
    expect(d.bottleneck).toBe('packaging')
  })
})
