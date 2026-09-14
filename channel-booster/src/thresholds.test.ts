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
  it('rejects unknown keys and non-numbers', () => {
    expect(() => applyOverrides({ nope: 1 } as never)).toThrow(/unknown threshold/)
    expect(() => applyOverrides({ ctrLowAbs: Number.NaN })).toThrow(/must be a number/)
  })
})
