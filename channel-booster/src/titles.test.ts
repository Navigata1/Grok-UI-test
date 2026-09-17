import { describe, expect, it } from 'vitest'
import { generateTitles, scoreTitle, titleThumbnailOverlap } from './titles.js'

describe('scoreTitle', () => {
  it('prefers specific, mobile-length titles with a hook word', () => {
    const good = scoreTitle('I Tried 30 Days of Cold Showers')
    const bad = scoreTitle('MY NEW VIDEO!!! AMAZING CHANNEL UPDATE VLOG EPISODE 12 PLEASE WATCH NOW')
    expect(good.score).toBeGreaterThan(bad.score)
    expect(good.notes).toContain('contains a number (specificity)')
    expect(bad.notes.some((n) => n.includes('too long'))).toBe(true)
    expect(bad.notes.some((n) => n.includes('generic word'))).toBe(true)
  })
  it('stays within 0-100', () => {
    expect(scoreTitle('').score).toBeGreaterThanOrEqual(0)
    expect(scoreTitle('Why Nobody Tells You The Truth About The Secret Mistake').score).toBeLessThanOrEqual(100)
  })
})

describe('generateTitles', () => {
  it('produces at least ten ranked, unique candidates when number and subject are given', () => {
    const titles = generateTitles({ topic: 'building a solar generator', number: '30 days', subject: 'Jackery', audience: 'van lifers' })
    expect(titles.length).toBeGreaterThanOrEqual(10)
    const unique = new Set(titles.map((t) => t.title.toLowerCase()))
    expect(unique.size).toBe(titles.length)
    for (let i = 1; i < titles.length; i += 1) expect(titles[i - 1].score).toBeGreaterThanOrEqual(titles[i].score)
  })
  it('skips formulas whose inputs are missing', () => {
    const titles = generateTitles({ topic: 'cold showers' })
    expect(titles.some((t) => t.formula === 'ranked list')).toBe(false)
    expect(titles.some((t) => t.formula === 'identity')).toBe(false)
  })
})

describe('titleThumbnailOverlap', () => {
  it('measures repeated meaningful words', () => {
    expect(titleThumbnailOverlap('I Tried 30 Days of Cold Showers', 'cold showers')).toBe(1)
    expect(titleThumbnailOverlap('I Tried 30 Days of Cold Showers', 'day 30')).toBe(0)
    expect(titleThumbnailOverlap('Anything', undefined)).toBe(0)
  })
})
