import { describe, expect, it } from 'vitest'
import { computeOutliers, detectFormats, formatLift, median } from './outliers.js'

describe('median', () => {
  it('handles odd, even, and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('computeOutliers', () => {
  const rows = [
    { title: 'I Tried Living in a Van for 30 Days', views: 1_000_000, channel: 'A', published: '2026-01-01' },
    { title: 'Weekly update', views: 10_000, channel: 'A', published: '2026-02-01' },
    { title: 'Another update', views: 12_000, channel: 'A', published: '2026-03-01' },
    { title: 'Q&A', views: 8_000, channel: 'A', published: '2026-04-01' },
    { title: 'Brand new upload', views: 100, channel: 'A', published: '2026-09-13' },
    { title: 'Why Nobody Buys This Car', views: 60_000, channel: 'B', published: '2026-05-01' },
    { title: 'Car review', views: 10_000, channel: 'B', published: '2026-05-08' },
    { title: 'Car vlog', views: 9_000, channel: 'B', published: '2026-05-15' },
  ]

  it('computes per-channel multipliers and tiers, ignoring too-young videos in the baseline', () => {
    const out = computeOutliers(rows, { minAgeDays: 7, now: new Date('2026-09-14T00:00:00Z') })
    const van = out.find((r) => r.title.startsWith('I Tried'))!
    // Baseline for A excludes the 1-day-old upload: median of [1e6, 10k, 12k, 8k] = 11k
    expect(van.baseline).toBe(11_000)
    expect(van.multiplier).toBeCloseTo(1_000_000 / 11_000, 3)
    expect(van.tier).toBe('outlier')
    expect(van.formats).toContain('challenge')
    expect(van.velocity).toBeGreaterThan(0)
    const car = out.find((r) => r.title.startsWith('Why Nobody'))!
    expect(car.baseline).toBe(10_000)
    expect(car.tier).toBe('strong')
    expect(out[0].title).toBe(van.title)
  })

  it('falls back to all rows when fewer than three are old enough', () => {
    const out = computeOutliers(rows.slice(0, 2).map((r) => ({ ...r, published: '2026-09-13' })), { minAgeDays: 30, now: new Date('2026-09-14T00:00:00Z') })
    expect(out[0].baseline).toBe(505_000)
  })
})

describe('detectFormats', () => {
  it('recognises common format cues', () => {
    expect(detectFormats('Top 10 Mistakes New Creators Make')).toEqual(expect.arrayContaining(['list', 'negative']))
    expect(detectFormats('iPhone vs Pixel: Not Even Close')).toContain('versus')
    expect(detectFormats('How I Turned $100 Into $10,000')).toEqual(expect.arrayContaining(['how-to', 'money', 'transformation']))
    expect(detectFormats('Why This Works')).toContain('question')
  })
})

describe('formatLift', () => {
  it('ranks formats that over-index among winners', () => {
    const ranked = computeOutliers([
      { title: 'I Tried A', views: 100_000 },
      { title: 'I Tried B', views: 90_000 },
      { title: 'Update', views: 1_000 },
      { title: 'Update 2', views: 1_100 },
      { title: 'Update 3', views: 900 },
    ], { threshold: 10 })
    const lifts = formatLift(ranked)
    expect(lifts[0].format).toBe('challenge')
    expect(lifts[0].lift).toBeGreaterThan(1)
    expect(formatLift([])).toEqual([])
  })
})
