import { describe, expect, it } from 'vitest'
import { diagnose } from './postmortem.js'

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
