import { describe, expect, it } from 'vitest'
import { FRESH_MAX_AGE_DAYS, FRESH_VELOCITY_MULTIPLIER, ageInDays, computeOutliers, detectFormats, formatLift, median } from './outliers.js'

const now = new Date('2026-09-14T00:00:00Z')

/** ISO date `days` days before `now`. */
function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

describe('median', () => {
  it('handles odd, even, and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('ageInDays', () => {
  it('returns whole and fractional days, never negative, undefined for missing or bad dates', () => {
    expect(ageInDays('2026-09-13T00:00:00Z', now)).toBe(1)
    expect(ageInDays('2026-09-13T12:00:00Z', now)).toBe(0.5)
    expect(ageInDays('2026-09-20', now)).toBe(0)
    expect(ageInDays(undefined, now)).toBeUndefined()
    expect(ageInDays('not a date', now)).toBeUndefined()
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
    const out = computeOutliers(rows, { minAgeDays: 7, now })
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
    const out = computeOutliers(rows.slice(0, 2).map((r) => ({ ...r, published: '2026-09-13' })), { minAgeDays: 30, now })
    expect(out[0].baseline).toBe(505_000)
  })

  it('flags rows outside the sinceDays window as stale but still ranks them', () => {
    const out = computeOutliers(rows, { minAgeDays: 7, now })
    // Every dated row here is older than 90 days except the 1-day-old upload.
    expect(out.find((r) => r.title.startsWith('I Tried'))!.stale).toBe(true)
    expect(out.find((r) => r.title === 'Brand new upload')!.stale).toBe(false)
    expect(out.find((r) => r.title === 'Car vlog')!.stale).toBe(true)
    expect(out).toHaveLength(rows.length)
    const wide = computeOutliers(rows, { minAgeDays: 7, sinceDays: 365, now })
    expect(wide.every((r) => !r.stale)).toBe(true)
  })

  it('bounds the baseline pool to the window when at least three videos fall inside it', () => {
    const channel = [
      { title: 'Old smash hit', views: 500_000, channel: 'C', published: daysAgo(200) },
      { title: 'Old normal 1', views: 50_000, channel: 'C', published: daysAgo(180) },
      { title: 'Old normal 2', views: 50_000, channel: 'C', published: daysAgo(160) },
      { title: 'Recent 1', views: 10_000, channel: 'C', published: daysAgo(60) },
      { title: 'Recent 2', views: 12_000, channel: 'C', published: daysAgo(45) },
      { title: 'Recent 3', views: 8_000, channel: 'C', published: daysAgo(30) },
    ]
    const windowed = computeOutliers(channel, { minAgeDays: 7, sinceDays: 90, now })
    expect(windowed[0].baseline).toBe(10_000)
    expect(windowed.find((r) => r.title === 'Old smash hit')).toMatchObject({ multiplier: 50, stale: true, tier: 'outlier' })
    // With only two recent rows the miner widens back to the age-eligible pool.
    const thin = computeOutliers(channel.slice(0, 5), { minAgeDays: 7, sinceDays: 90, now })
    expect(thin[0].baseline).toBe(50_000)
  })

  it('leaves undated rows in every pool and gives them no velocity', () => {
    const out = computeOutliers([
      { title: 'A', views: 100 },
      { title: 'B', views: 200 },
      { title: 'C', views: 3_000 },
    ], { minAgeDays: 7, now })
    expect(out[0]).toMatchObject({ title: 'C', baseline: 200, multiplier: 15, tier: 'outlier', stale: false })
    expect(out[0].velocity).toBeUndefined()
    expect(out[0].velocityMultiplier).toBeUndefined()
  })

  it('computes velocity against the channel median velocity, counting the first day whole', () => {
    const channel = [
      { title: 'Steady 1', views: 3_000, channel: 'V', published: daysAgo(30) }, // 100/day
      { title: 'Steady 2', views: 4_000, channel: 'V', published: daysAgo(40) }, // 100/day
      { title: 'Steady 3', views: 5_000, channel: 'V', published: daysAgo(50) }, // 100/day
      { title: 'Half a day old', views: 250, channel: 'V', published: daysAgo(0.5) },
    ]
    const out = computeOutliers(channel, { minAgeDays: 7, now })
    const young = out.find((r) => r.title === 'Half a day old')!
    expect(young.velocity).toBe(250)
    expect(young.velocityMultiplier).toBeCloseTo(2.5, 6)
    expect(out.find((r) => r.title === 'Steady 1')!.velocityMultiplier).toBeCloseTo(1, 6)
  })

  it('marks a young, fast video as fresh and ranks too-young rows by velocity multiplier', () => {
    const channel = [
      { title: 'Steady 1', views: 3_000, channel: 'F', published: daysAgo(30) },
      { title: 'Steady 2', views: 4_000, channel: 'F', published: daysAgo(40) },
      { title: 'Steady 3', views: 5_000, channel: 'F', published: daysAgo(50) },
      { title: 'Rising fast', views: 1_200, channel: 'F', published: daysAgo(3) }, // 400/day = 4x median velocity
      { title: 'Rising slowly', views: 210, channel: 'F', published: daysAgo(3) }, // 70/day = 0.7x
    ]
    const out = computeOutliers(channel, { minAgeDays: 7, now })
    const fast = out.find((r) => r.title === 'Rising fast')!
    expect(fast.tier).toBe('fresh')
    expect(fast.velocityMultiplier).toBeCloseTo(4, 6)
    expect(fast.multiplier).toBeLessThan(1)
    expect(out.find((r) => r.title === 'Rising slowly')!.tier).toBe('normal')
    // Velocity ranks the fresh row above every mature normal row.
    expect(out[0].title).toBe('Rising fast')
    expect(out[1].title).toBe('Steady 3')
    expect(out[out.length - 1].title).toBe('Rising slowly')
  })

  it('does not call a video fresh past the age bar, and lets outlier and strong win over fresh', () => {
    const channel = [
      { title: 'Steady 1', views: 3_000, channel: 'G', published: daysAgo(60) },
      { title: 'Steady 2', views: 4_000, channel: 'G', published: daysAgo(70) },
      { title: 'Steady 3', views: 5_000, channel: 'G', published: daysAgo(80) },
      { title: 'Fast but old', views: 8_000, channel: 'G', published: daysAgo(FRESH_MAX_AGE_DAYS + 1) }, // ~364/day, but too old
      { title: 'Fast and already strong', views: 30_000, channel: 'G', published: daysAgo(10) },
    ]
    const out = computeOutliers(channel, { minAgeDays: 7, now })
    const old = out.find((r) => r.title === 'Fast but old')!
    expect(old.velocityMultiplier).toBeGreaterThan(FRESH_VELOCITY_MULTIPLIER)
    expect(old.tier).toBe('normal')
    expect(out.find((r) => r.title === 'Fast and already strong')!.tier).toBe('strong')
    const relaxed = computeOutliers(channel, { minAgeDays: 7, freshMaxAgeDays: 30, now })
    expect(relaxed.find((r) => r.title === 'Fast but old')!.tier).toBe('fresh')
  })
})

describe('detectFormats', () => {
  it('recognises common format cues', () => {
    expect(detectFormats('Top 10 Mistakes New Creators Make')).toEqual(expect.arrayContaining(['list', 'negative']))
    expect(detectFormats('iPhone vs Pixel: Not Even Close')).toContain('versus')
    expect(detectFormats('How I Turned $100 Into $10,000')).toEqual(expect.arrayContaining(['how-to', 'money', 'transformation']))
    expect(detectFormats('Why This Works')).toContain('question')
  })

  it('counts first-person only when the sentence starts with it', () => {
    expect(detectFormats('I Tried Every Portable Power Station')).toContain('first-person')
    expect(detectFormats('  My Van Build, One Year Later')).toContain('first-person')
    expect(detectFormats('We Drove 3,000 Miles in a Van')).toContain('first-person')
    expect(detectFormats('The Solar Mistake That Ruined My Batteries')).not.toContain('first-person')
    expect(detectFormats('Why Nobody Tells You This About Van Life')).not.toContain('first-person')
    expect(detectFormats('Impossible Odds')).not.toContain('first-person')
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

  it('reports raw shares and winner counts alongside the smoothed lift', () => {
    const ranked = computeOutliers([
      { title: 'I Tried A', views: 100_000 },
      { title: 'I Tried B', views: 90_000 },
      { title: 'Update', views: 1_000 },
      { title: 'Update 2', views: 1_100 },
      { title: 'Update 3', views: 900 },
    ], { threshold: 10 })
    const challenge = formatLift(ranked).find((l) => l.format === 'challenge')!
    expect(challenge).toMatchObject({ count: 2, winners: 2, shareInWinners: 1, shareOverall: 0.4, thin: true })
    // Smoothed: (2+1)/(2+2) over (2+1)/(5+2)
    expect(challenge.lift).toBeCloseTo(0.75 / (3 / 7), 6)
  })

  it('stops one winner from producing a 5.0 lift', () => {
    const rows = [
      { tier: 'outlier', formats: ['versus'] },
      { tier: 'normal', formats: [] },
      { tier: 'normal', formats: [] },
      { tier: 'normal', formats: [] },
      { tier: 'normal', formats: [] },
    ] as const
    const [versus] = formatLift(rows)
    expect(versus.format).toBe('versus')
    expect(versus.shareInWinners / versus.shareOverall).toBe(5) // what the raw ratio would have said
    expect(versus.lift).toBeLessThan(3)
    expect(versus.lift).toBeCloseTo((2 / 3) / (2 / 7), 6)
    expect(versus.thin).toBe(true)
    // alpha = 0 restores the raw ratio for anyone who wants it.
    expect(formatLift(rows, { alpha: 0 })[0].lift).toBe(5)
  })

  it('keeps thin formats but sorts them after solid ones', () => {
    const rows = [
      { tier: 'outlier', formats: ['list', 'money'] },
      { tier: 'outlier', formats: ['list'] },
      { tier: 'strong', formats: ['list'] },
      { tier: 'normal', formats: ['list'] },
      { tier: 'normal', formats: [] },
      { tier: 'normal', formats: [] },
    ] as const
    const lifts = formatLift(rows)
    expect(lifts.map((l) => l.format)).toEqual(['list', 'money'])
    expect(lifts[0].thin).toBe(false)
    expect(lifts[1].thin).toBe(true)
    // money alone would out-lift list; the thin flag, not a drop, moves it down.
    expect(lifts[1].lift).toBeGreaterThan(lifts[0].lift)
    expect(formatLift(rows, { minCount: 1 }).map((l) => l.format)).toEqual(['money', 'list'])
  })

  it('counts fresh rows as winners', () => {
    const rows = [
      { tier: 'fresh', formats: ['question'] },
      { tier: 'normal', formats: ['question'] },
      { tier: 'normal', formats: [] },
    ] as const
    expect(formatLift(rows)[0]).toMatchObject({ format: 'question', winners: 1, shareInWinners: 1 })
  })
})
