import { afterEach, describe, expect, it } from 'vitest'
import { applyOverrides, DEFAULT_THRESHOLDS, resetThresholds, tagged, thresholds } from './thresholds.js'

afterEach(() => resetThresholds())

describe('thresholds', () => {
  it('every entry carries a value, an evidence tag, and a note', () => {
    for (const [key, t] of Object.entries(DEFAULT_THRESHOLDS)) {
      expect(typeof t.value, key).toBe('number')
      expect(['sourced', 'unverified', 'house'], key).toContain(t.evidence)
      expect(t.note.length, key).toBeGreaterThan(10)
    }
  })
  it('applies overrides, retags them as house, and resets', () => {
    applyOverrides({ ctrHealthyAbs: 3.5 })
    expect(thresholds.ctrHealthyAbs.value).toBe(3.5)
    expect(thresholds.ctrHealthyAbs.evidence).toBe('house')
    expect(tagged('ctrHealthyAbs', '%')).toBe('3.5% [house]')
    resetThresholds()
    expect(thresholds.ctrHealthyAbs.value).toBe(3)
    expect(tagged('retention30Healthy', '%')).toBe('60% [unverified]')
  })
  it('carries the diagnosis v2 and decision gates with their tags', () => {
    expect(tagged('wilsonZ')).toBe('1.96 [house]')
    expect(tagged('coldStartGrowthPct', '%')).toBe('30% [house]')
    expect(tagged('notAlgorithmicBrowseSuggestedPct', '%')).toBe('40% [house]')
    expect(tagged('impressionsLowVsExpectedRel', 'x')).toBe('0.5x [house]')
    expect(tagged('repackageMinExpectedGainViews')).toBe('500 [house]')
    expect(tagged('repackageMinExpectedGainPctOfBaseline', '%')).toBe('5% [house]')
    expect(tagged('repackageImpressionsShareOfExpected', 'x')).toBe('0.8x [house]')
    expect(tagged('oneSwapPerDays', 'd')).toBe('7d [house]')
    expect(tagged('sequelMultiple', 'x')).toBe('3x [house]')
    expect(tagged('sequelReturningRel', 'x')).toBe('0.9x [house]')
    expect(tagged('sequelAvpRel', 'x')).toBe('0.9x [house]')
    expect(tagged('expandMultipleLow', 'x')).toBe('1.5x [house]')
    expect(tagged('parkMultiple', 'x')).toBe('0.7x [house]')
    // Held for other engines until their owners point at this table.
    expect(thresholds.bucketTolerance.value).toBe(0.2)
    expect(thresholds.freshMaxAgeDays.value).toBe(21)
    expect(thresholds.freshVelocityMultiplier.value).toBe(3)
    expect(thresholds.formatLiftMinCount.value).toBe(3)
    expect(thresholds.demandMatchMultiplier.value).toBe(5)
  })
  it('carries the Test & Compare gates apart from the funnel cold-start gates', () => {
    // One key, one number: the judge waits a week where a packaging verdict waits three days.
    expect(tagged('testMinImpressions')).toBe('1000 [house]')
    expect(tagged('testMinHours', ' h')).toBe('72 h [house]')
    expect(tagged('testColdStartMinImpressions')).toBe('2000 [house]')
    expect(tagged('testColdStartMinHours', ' h')).toBe('168 h [house]')
    expect(tagged('overPromiseDropPct', '%')).toBe('10% [house]')
    expect(tagged('noDifferenceSharePts', ' pts')).toBe('3 pts [house]')
    expect(tagged('noDifferenceRelPct', '%')).toBe('3% [house]')
    expect(thresholds.coldStartMinHours.value).toBe(72)
  })
  it('rejects unknown keys and non-numbers', () => {
    expect(() => applyOverrides({ nope: 1 } as never)).toThrow(/unknown threshold/)
    expect(() => applyOverrides({ ctrLowAbs: Number.NaN })).toThrow(/must be a number/)
  })
})
