import { describe, expect, it } from 'vitest'
import { computeOutliers } from './outliers.js'
import { SATURATION_SHARE, diffScans, saturation, topicDemand, topicKey, topicTokens } from './topics.js'

const now = new Date('2026-09-14T00:00:00Z')

/** ISO date `days` days before `now`. */
function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

describe('topicTokens', () => {
  it('drops format words, function words and bare numbers, and deduplicates', () => {
    expect(topicTokens('I Tried Van Life for 30 Days')).toEqual(['van', 'life'])
    expect(topicTokens('$500 Van Kitchen Build')).toEqual(['van', 'kitchen'])
    expect(topicTokens('Van vs Van: Which Van?')).toEqual(['van'])
    expect(topicTokens('The Best Update Ever')).toEqual([])
  })
})

describe('topicKey', () => {
  it('joins the two longest content tokens alphabetically', () => {
    expect(topicKey('I Tried Van Life for 30 Days')).toBe('life+van')
    expect(topicKey('Van Life: The Truth')).toBe('life+van')
    expect(topicKey('The Solar Mistake That Ruined My Batteries')).toBe('batteries+solar')
    expect(topicKey('How I Built a Solar Generator for $300')).toBe('generator+solar')
  })

  it('breaks length ties alphabetically before choosing', () => {
    // basics (6) wins outright; power and solar tie at 5, power sorts first.
    expect(topicKey('Solar Power Basics')).toBe('basics+power')
    expect(topicKey('Power Solar Basics')).toBe('basics+power')
  })

  it('returns one token or an empty key when fewer content tokens survive', () => {
    expect(topicKey('Cheap vs Expensive Van Build: Not Even Close')).toBe('van')
    expect(topicKey('Weekly Q&A')).toBe('weekly')
    expect(topicKey('30 Days')).toBe('')
    expect(topicKey('')).toBe('')
  })
})

describe('topicDemand', () => {
  it('groups ranked rows across channels by topic key, keeping the best row and channel list', () => {
    const rows = [
      { title: 'I Tried Van Life for 30 Days', multiplier: 12, channel: 'A', tier: 'outlier', stale: false },
      { title: 'Van Life: The Truth', multiplier: 8, channel: 'B', tier: 'strong', stale: true },
      { title: 'Why I Almost Quit Van Life', multiplier: 0.9, channel: 'A', tier: 'fresh', stale: false },
      { title: '$500 Van Kitchen Build', multiplier: 6, channel: 'A', tier: 'strong', stale: false },
      { title: '30 Days', multiplier: 50, channel: 'C', tier: 'outlier', stale: false },
    ]
    const demand = topicDemand(rows)
    expect(demand.map((d) => d.topicKey)).toEqual(['life+van', 'kitchen+van'])
    expect(demand[0]).toEqual({
      topicKey: 'life+van',
      count: 3,
      bestMultiplier: 12,
      bestTitle: 'I Tried Van Life for 30 Days',
      channels: ['A', 'B'],
      fresh: 1,
      stale: 1,
    })
    expect(demand[1]).toMatchObject({ count: 1, bestMultiplier: 6, channels: ['A'], fresh: 0, stale: 0 })
  })

  it('accepts computeOutliers() output directly and defaults the channel', () => {
    const ranked = computeOutliers([
      { title: 'Solar Setup Explained', views: 50_000 },
      { title: 'Solar Setup Mistakes', views: 5_000 },
      { title: 'Weekly update', views: 4_000 },
    ], { now })
    const demand = topicDemand(ranked)
    expect(demand[0]).toMatchObject({ topicKey: 'setup+solar', count: 2, bestMultiplier: 10, channels: ['default'] })
    expect(topicDemand([])).toEqual([])
  })

  it('orders by best multiplier, then count, then key', () => {
    const demand = topicDemand([
      { title: 'Alpha Beta', multiplier: 3 },
      { title: 'Gamma Delta', multiplier: 3 },
      { title: 'Gamma Delta Again', multiplier: 1 },
      { title: 'Omega Sigma', multiplier: 9 },
    ])
    expect(demand.map((d) => d.topicKey)).toEqual(['omega+sigma', 'delta+gamma', 'alpha+beta'])
  })
})

describe('diffScans', () => {
  const prev = [
    { title: 'Steady', channel: 'X', multiplier: 2 },
    { title: 'Falling', channel: 'X', multiplier: 10, tier: 'outlier' },
    { title: 'Gone', channel: 'Y', multiplier: 1 },
    { title: 'Drifting', channel: 'Y', multiplier: 1.0 },
  ]
  const next = [
    { title: '  steady ', channel: 'x', multiplier: 2.1 },
    { title: 'Falling', channel: 'X', multiplier: 6, tier: 'strong' },
    { title: 'Brand New', channel: 'Y', multiplier: 12, tier: 'outlier' },
    { title: 'Drifting', channel: 'Y', multiplier: 1.4 },
  ]

  it('lists new titles, dropped titles and multiplier moves at or above the default delta', () => {
    const diff = diffScans(prev, next)
    expect(diff.added.map((r) => r.title)).toEqual(['Brand New'])
    expect(diff.removed.map((r) => r.title)).toEqual(['Gone'])
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]).toMatchObject({ before: 10, after: 6, delta: -4, tierBefore: 'outlier', tierAfter: 'strong' })
    expect(diff.changed[0].row.title).toBe('Falling')
  })

  it('matches titles case- and whitespace-insensitively and honours minDelta', () => {
    const diff = diffScans(prev, next, { minDelta: 0.1 })
    expect(diff.added.map((r) => r.title)).toEqual(['Brand New'])
    expect(diff.changed.map((c) => c.row.title)).toEqual(['Falling', 'Drifting', '  steady '])
    expect(diff.changed[1].delta).toBeCloseTo(0.4, 9)
    expect(diff.changed[2].tierBefore).toBeUndefined()
  })

  it('prefers the video id over the title so a retitled video is a change, not an add', () => {
    const before = [{ videoId: 'v1', title: 'Old title', multiplier: 3 }]
    const after = [{ videoId: 'v1', title: 'New title after a repackage', multiplier: 4 }]
    const diff = diffScans(before, after)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed[0]).toMatchObject({ before: 3, after: 4, delta: 1 })
    expect(diffScans([], [])).toEqual({ added: [], removed: [], changed: [] })
  })
})

describe('saturation', () => {
  const rows = [
    { channel: 'A', published: daysAgo(10), formats: ['list', 'versus'] },
    { channel: 'B', published: daysAgo(20), formats: ['list'] },
    { channel: 'C', published: daysAgo(200), formats: ['versus'] },
    { published: daysAgo(5), formats: [] },
  ]

  it('reports the share of in-window channels carrying each format', () => {
    const sat = saturation(rows, 90, now)
    expect(sat).toEqual([
      { format: 'list', channels: 2, totalChannels: 3, share: 2 / 3, saturated: true },
      { format: 'versus', channels: 1, totalChannels: 3, share: 1 / 3, saturated: false },
    ])
  })

  it('widens with the window, counts undated rows as inside it, and flags at the house share', () => {
    const sat = saturation(rows, 365, now)
    expect(sat.map((s) => s.format)).toEqual(['list', 'versus'])
    expect(sat.every((s) => s.totalChannels === 4 && s.share === 0.5 && s.saturated)).toBe(true)
    expect(SATURATION_SHARE).toBe(0.5)
    const undated = saturation([{ formats: ['story'] }, { channel: 'Z', formats: ['story'] }], 1, now)
    expect(undated[0]).toMatchObject({ format: 'story', channels: 2, totalChannels: 2, share: 1 })
    expect(saturation([], 90, now)).toEqual([])
  })

  it('accepts computeOutliers() output', () => {
    const ranked = computeOutliers([
      { title: 'Cheap vs Expensive Van Build', views: 100, channel: 'A', published: daysAgo(10) },
      { title: 'Van tour', views: 100, channel: 'B', published: daysAgo(10) },
    ], { now })
    expect(saturation(ranked, 90, now)[0]).toMatchObject({ format: 'versus', channels: 1, totalChannels: 2 })
  })
})
