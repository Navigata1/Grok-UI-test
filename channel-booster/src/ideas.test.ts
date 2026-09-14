import { describe, expect, it } from 'vitest'
import { parseIdeaScore, scoreIdea } from './ideas.js'

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
})
