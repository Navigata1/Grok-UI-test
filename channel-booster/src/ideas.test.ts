import { describe, expect, it } from 'vitest'
import { DEMAND_AUTO, DEMAND_MATCH_MULTIPLIER, IDEA_AXIS_QUESTIONS, parseIdeaScore, resolveDemand, scoreIdea, suggestDemand } from './ideas.js'
import { computeOutliers } from './outliers.js'

const now = new Date('2026-09-14T00:00:00Z')

/** ISO date `days` days before `now`. */
function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

describe('scoreIdea', () => {
  it('rewards demand and packaging most', () => {
    const strong = scoreIdea({ demand: 5, packaging: 5, fit: 4, angle: 4, payoff: 4, feasibility: 4 })
    expect(strong.total).toBeGreaterThanOrEqual(85)
    expect(strong.verdict).toBe('green')
    expect(strong.fixes).toEqual([])
  })

  it('hard-gates ideas with no demand even when everything else is perfect', () => {
    const noDemand = scoreIdea({ demand: 1, packaging: 5, fit: 5, angle: 5, payoff: 5, feasibility: 5 })
    expect(noDemand.verdict).toBe('red')
    expect(noDemand.fixes[0]).toMatch(/Demand is unproven/)
  })

  it('caps a green at yellow when any axis is at or below 1', () => {
    const shaky = scoreIdea({ demand: 5, packaging: 5, fit: 5, angle: 5, payoff: 5, feasibility: 1 })
    expect(shaky.verdict).toBe('yellow')
  })

  it('clamps out-of-range values', () => {
    const clamped = scoreIdea({ demand: 9, packaging: -3, fit: 3, angle: 3, payoff: 3, feasibility: 3 })
    expect(clamped.score.demand).toBe(5)
    expect(clamped.score.packaging).toBe(0)
  })

  it('refuses an unresolved demand=auto sentinel with a clear message', () => {
    expect(DEMAND_AUTO).toBe(-1)
    expect(() => scoreIdea({ demand: DEMAND_AUTO, packaging: 5, fit: 5, angle: 5, payoff: 5, feasibility: 5 })).toThrow(/suggestDemand/)
    // Other negatives are still clamped, not treated as the sentinel.
    expect(scoreIdea({ demand: -3, packaging: 5, fit: 5, angle: 5, payoff: 5, feasibility: 5 }).score.demand).toBe(0)
  })
})

describe('parseIdeaScore', () => {
  it('accepts named and positional forms', () => {
    expect(parseIdeaScore('demand=4 packaging=3 fit=5 angle=2 payoff=4 feasibility=3')).toEqual({ demand: 4, packaging: 3, fit: 5, angle: 2, payoff: 4, feasibility: 3 })
    expect(parseIdeaScore('4,3,5,2,4,3')).toEqual({ demand: 4, packaging: 3, fit: 5, angle: 2, payoff: 4, feasibility: 3 })
  })
  it('rejects unknown axes and wrong counts', () => {
    expect(() => parseIdeaScore('foo=1')).toThrow(/Unknown axis/)
    expect(() => parseIdeaScore('1,2,3')).toThrow(/6 numbers/)
  })
  it('accepts demand=auto in both forms as the -1 sentinel and rejects auto elsewhere', () => {
    expect(parseIdeaScore('demand=auto,packaging=3,fit=5,angle=2,payoff=4,feasibility=3').demand).toBe(DEMAND_AUTO)
    expect(parseIdeaScore('demand=AUTO packaging=3').demand).toBe(DEMAND_AUTO)
    expect(parseIdeaScore('auto,3,5,2,4,3')).toEqual({ demand: DEMAND_AUTO, packaging: 3, fit: 5, angle: 2, payoff: 4, feasibility: 3 })
    expect(() => parseIdeaScore('packaging=auto')).toThrow(/Only demand accepts "auto"/)
    expect(() => parseIdeaScore('3,auto,5,2,4,3')).toThrow(/Only demand accepts "auto"/)
    expect(IDEA_AXIS_QUESTIONS.demand).toMatch(/"auto"/)
  })
})

describe('suggestDemand', () => {
  const ranked = [
    { title: 'I Tried Van Life for 30 Days', multiplier: 12, channel: 'A', published: daysAgo(20) },
    { title: 'Van Life: The Truth', multiplier: 11, channel: 'B', published: daysAgo(40) },
    { title: 'Why I Almost Quit Van Life', multiplier: 10, channel: 'C', published: daysAgo(80), url: 'https://example.test/quit' },
    { title: 'Van Life Costs, Honestly', multiplier: 15, channel: 'A', published: daysAgo(200) },
    { title: 'Solar Setup Explained', multiplier: 0.8, channel: 'B', published: daysAgo(10) },
    { title: 'Van tour 2026', multiplier: 1.1, channel: 'A', published: daysAgo(10) },
  ]

  it('scores 5 for three >= 10x matches inside the window and lists them strongest first', () => {
    const s = suggestDemand('van life', ranked, { now })
    expect(s.score).toBe(5)
    expect(s.windowDays).toBe(90)
    expect(s.evidence.map((e) => e.title)).toEqual(['I Tried Van Life for 30 Days', 'Van Life: The Truth', 'Why I Almost Quit Van Life'])
    expect(s.evidence[0]).toEqual({ title: 'I Tried Van Life for 30 Days', multiplier: 12, channel: 'A', ageDays: 20, published: daysAgo(20) })
    expect(s.evidence[2].url).toBe('https://example.test/quit')
    expect(s.staleMatches).toBe(1)
    expect(s.reason).toMatch(/3 matches at >= 10x inside 90 days/)
  })

  it('needs two shared content words, so "Van tour" does not count for "van life"', () => {
    const s = suggestDemand('van life', ranked, { now })
    expect(s.evidence.some((e) => e.title.startsWith('Van tour'))).toBe(false)
    // A single-word topic needs one shared word.
    const solar = suggestDemand('solar', ranked, { now })
    expect(solar.evidence.map((e) => e.title)).toEqual(['Solar Setup Explained'])
    expect(solar.score).toBe(0)
    expect(solar.reason).toMatch(/all below channel median/)
  })

  it('scores 3 for one >= 5x match and narrows with the window', () => {
    const s = suggestDemand('van life', ranked, { now, windowDays: 30 })
    expect(s.score).toBe(3)
    expect(s.evidence).toHaveLength(1)
    expect(s.staleMatches).toBe(3)
    expect(s.reason).toMatch(/1 match at >= 5x inside 30 days/)
    expect(DEMAND_MATCH_MULTIPLIER).toBe(5)
  })

  it('interpolates 4 for two >= 10x or three >= 5x, and 1-2 for matches that do not over-perform', () => {
    const two10 = suggestDemand('van life', ranked.slice(0, 2), { now })
    expect(two10.score).toBe(4)
    expect(two10.reason).toMatch(/2 matches at >= 10x/)
    const three5 = suggestDemand('van life', ranked.slice(0, 3).map((r) => ({ ...r, multiplier: 6 })), { now })
    expect(three5.score).toBe(4)
    expect(three5.reason).toMatch(/3 matches at >= 5x/)
    const one10 = suggestDemand('van life', ranked.slice(0, 1), { now })
    expect(one10.score).toBe(3)
    const two5 = suggestDemand('van life', ranked.slice(0, 2).map((r) => ({ ...r, multiplier: 7 })), { now })
    expect(two5.score).toBe(3)
    const recurring = suggestDemand('van life', ranked.slice(0, 2).map((r) => ({ ...r, multiplier: 1.5 })), { now })
    expect(recurring.score).toBe(2)
    const single = suggestDemand('van life', ranked.slice(0, 1).map((r) => ({ ...r, multiplier: 1.5 })), { now })
    expect(single.score).toBe(1)
    expect(single.reason).toMatch(/one match at >= 1x/)
    const flops = suggestDemand('van life', ranked.slice(0, 2).map((r) => ({ ...r, multiplier: 0.4 })), { now })
    expect(flops.score).toBe(0)
    expect(flops.evidence).toHaveLength(2)
  })

  it('scores 0 with an explanation when nothing matches, only stale rows match, or the topic has no content words', () => {
    const none = suggestDemand('cold showers', ranked, { now })
    expect(none).toMatchObject({ score: 0, evidence: [], staleMatches: 0 })
    expect(none.reason).toMatch(/no match inside 90 days/)
    const stale = suggestDemand('van life', ranked, { now, windowDays: 5 })
    expect(stale).toMatchObject({ score: 0, evidence: [], staleMatches: 4 })
    expect(stale.reason).toMatch(/4 older/)
    const empty = suggestDemand('the best', ranked, { now })
    expect(empty.score).toBe(0)
    expect(empty.reason).toMatch(/no content words/)
  })

  it('scores a fresh-tier row on its velocity multiplier and treats undated rows as inside the window', () => {
    const fresh = suggestDemand('van life', [
      { title: 'Van Life Reset', multiplier: 0.4, tier: 'fresh', velocityMultiplier: 6, channel: 'D', published: daysAgo(3) },
    ], { now })
    expect(fresh.score).toBe(3)
    expect(fresh.evidence[0]).toMatchObject({ multiplier: 0.4, velocityMultiplier: 6, ageDays: 3 })
    const notFresh = suggestDemand('van life', [
      { title: 'Van Life Reset', multiplier: 0.4, tier: 'normal', velocityMultiplier: 6 },
    ], { now })
    expect(notFresh.score).toBe(0)
    expect(notFresh.evidence[0].velocityMultiplier).toBeUndefined()
    expect(notFresh.evidence[0].ageDays).toBeUndefined()
    expect(notFresh.evidence[0].published).toBeUndefined()
  })

  it('accepts computeOutliers() output directly', () => {
    const scan = computeOutliers([
      { title: 'I Tried Van Life for 30 Days', views: 600_000, channel: 'A', published: daysAgo(20) },
      { title: 'Van Life Costs, Honestly', views: 300_000, channel: 'A', published: daysAgo(30) },
      { title: 'Weekly update', views: 10_000, channel: 'A', published: daysAgo(40) },
      { title: 'Grocery haul', views: 12_000, channel: 'A', published: daysAgo(50) },
      { title: 'Morning routine', views: 8_000, channel: 'A', published: daysAgo(60) },
    ], { minAgeDays: 7, now })
    const s = suggestDemand('van life', scan, { now })
    expect(s.score).toBe(4)
    expect(s.evidence.map((e) => e.multiplier)).toEqual([50, 25])
  })
})

describe('resolveDemand', () => {
  it('replaces only the -1 sentinel and never mutates its input', () => {
    const auto = parseIdeaScore('demand=auto packaging=4 fit=4 angle=3 payoff=4 feasibility=4')
    const resolved = resolveDemand(auto, { score: 5 })
    expect(resolved.demand).toBe(5)
    expect(auto.demand).toBe(DEMAND_AUTO)
    expect(scoreIdea(resolved).verdict).toBe('green')
    const typed = { ...auto, demand: 2 }
    expect(resolveDemand(typed, { score: 5 })).toEqual(typed)
    expect(resolveDemand(typed, { score: 5 })).not.toBe(typed)
  })
})
