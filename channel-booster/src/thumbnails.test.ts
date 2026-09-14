import { describe, expect, it } from 'vitest'
import { buildThumbnailBrief, qaThumbnail } from './thumbnails.js'

describe('qaThumbnail', () => {
  it('ships a clean concept', () => {
    const qa = qaThumbnail({
      focalSubject: 'my face, mid-shiver',
      emotion: 'shock',
      elements: ['face', 'ice bath', 'text'],
      text: 'Day 30',
      background: 'clean gradient',
      colors: ['yellow', 'black'],
      title: 'I Tried 30 Days of Cold Showers',
    })
    expect(qa.grade).toBe('ship')
    expect(qa.failures).toEqual([])
  })

  it('rethinks a cluttered, wordy, repetitive concept', () => {
    const qa = qaThumbnail({
      focalSubject: 'me',
      emotion: 'neutral',
      elements: ['face', 'shower', 'ice', 'calendar', 'logo', 'arrow'],
      text: 'I tried 30 days of cold showers and this happened',
      background: 'busy bathroom with lots of items',
      colors: ['blue', 'purple'],
      title: 'I Tried 30 Days of Cold Showers',
    })
    expect(qa.grade).toBe('rethink')
    expect(qa.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('elements'),
      expect.stringContaining('words of text'),
      'thumbnail text repeats the title',
      'a face with no expression',
      expect.stringContaining('low-contrast'),
      'busy background',
    ]))
    expect(qa.fixes.length).toBeGreaterThanOrEqual(5)
  })

  it('penalises a missing focal subject', () => {
    const qa = qaThumbnail({ focalSubject: '', elements: ['a', 'b'] })
    expect(qa.failures).toContain('no focal subject')
  })
})

describe('buildThumbnailBrief', () => {
  it('returns five concepts with distinct angles plus rules and a test plan', () => {
    const brief = buildThumbnailBrief('cold showers', 'I Tried 30 Days of Cold Showers', { subject: 'me', stake: 'hypothermia', result: 'a frozen beard' })
    expect(brief.concepts).toHaveLength(5)
    expect(new Set(brief.concepts.map((c) => c.angle)).size).toBe(5)
    expect(brief.concepts[0].focalSubject).toBe('a frozen beard')
    expect(brief.rules.length).toBeGreaterThan(5)
    expect(brief.testPlan[0]).toMatch(/Test & Compare/)
  })
})
