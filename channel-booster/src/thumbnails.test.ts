import { describe, expect, it } from 'vitest'
import { buildThumbnailBrief, qaThumbnail, renderImagePrompts } from './thumbnails.js'

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

describe('qaThumbnail: face detection', () => {
  it('does not treat "here" or "meter" as a face', () => {
    const qa = qaThumbnail({ focalSubject: 'a power meter reading zero, right here', elements: ['meter', 'text'], text: 'Zero' })
    expect(qa.failures).not.toContain('a face with no expression')
  })
  it('still treats a person as a face', () => {
    const qa = qaThumbnail({ focalSubject: 'the creator', elements: ['face'] })
    expect(qa.failures).toContain('a face with no expression')
  })
})

describe('qaThumbnail: channel signature', () => {
  const signature = { colors: ['yellow', 'black'], facePolicy: 'either' as const, maxWords: 3 }
  const clean = {
    focalSubject: 'my face, mid-shiver',
    emotion: 'shock',
    elements: ['face', 'ice bath', 'text'],
    text: 'Day 30',
    background: 'clean gradient',
    colors: ['yellow', 'black'],
    title: 'I Tried 30 Days of Cold Showers',
  }

  it('passes and records the match when the concept keeps the signature', () => {
    const qa = qaThumbnail(clean, signature)
    expect(qa.score).toBe(100)
    expect(qa.passes).toContain('matches the channel signature')
    expect(qa.failures).toEqual([])
  })

  it('deducts exactly 10 with a "signature drift" failure when the colour pair misses', () => {
    const without = qaThumbnail({ ...clean, colors: ['white', 'red'] })
    const withSig = qaThumbnail({ ...clean, colors: ['white', 'red'] }, signature)
    expect(without.failures).toEqual([])
    expect(withSig.score).toBe(without.score - 10)
    expect(withSig.failures).toEqual(['signature drift: colours white/red miss the signature pair yellow/black (no yellow, black)'])
    expect(withSig.fixes[0]).toMatch(/^Match the channel signature \(the yellow\/black colour pair, a face optional, at most 3 words of text\) or write the deliberate drift on the proof sheet\.$/)
  })

  it('joins several drift reasons into one failure and stacks with the other rules', () => {
    const qa = qaThumbnail({ ...clean, colors: ['white', 'red'], text: 'one two three four' }, { ...signature, facePolicy: 'never' })
    const drift = qa.failures.find((f) => f.startsWith('signature drift: '))
    expect(drift).toMatch(/colours white\/red .*; 4 words of text, signature allows at most 3; a face is in frame/)
    expect(qa.failures).toContain('4 words of text: hard to read on mobile')
    expect(qa.score).toBe(100 - 10 - 10)
  })

  it('leaves the result unchanged when no signature is given', () => {
    const qa = qaThumbnail(clean)
    expect(qa.passes).not.toContain('matches the channel signature')
    expect(qa.score).toBe(100)
  })

  it('never pushes the score below zero', () => {
    const qa = qaThumbnail({
      focalSubject: '', emotion: 'neutral', elements: ['a', 'b', 'c', 'd', 'e', 'f'], text: 'i tried thirty days of cold showers and this happened',
      background: 'busy', colors: ['blue', 'purple'], title: 'I tried thirty days of cold showers and this happened',
    }, { ...signature, facePolicy: 'always' })
    expect(qa.score).toBe(0)
    expect(qa.grade).toBe('rethink')
  })
})

describe('renderImagePrompts', () => {
  const signature = { colors: ['yellow', 'black'], facePolicy: 'always' as const, maxWords: 3, framing: 'subject in the lower third' }

  it('writes one prompt per brief concept, deterministically, with the signature sentence last', () => {
    const brief = buildThumbnailBrief('cold showers', 'I Tried 30 Days of Cold Showers', { subject: 'me', stake: 'hypothermia', result: 'a frozen beard' })
    const prompts = renderImagePrompts(brief.concepts, signature)
    expect(prompts).toHaveLength(5)
    expect(prompts).toEqual(renderImagePrompts(brief.concepts, signature))
    for (const p of prompts) {
      expect(p).toMatch(/^The [A-Za-z ]+: YouTube thumbnail, 16:9, 1280x720/)
      expect(p).toContain('Colours: yellow and black')
      expect(p).toMatch(/Keep the channel signature: the yellow\/black colour pair, always a face, at most 3 words of text, framing subject in the lower third\.$/)
    }
    const result = prompts[0]
    expect(result).toContain('Subject: a frozen beard')
    expect(result).toContain('Elements (2): a frozen beard; me reacting to it.')
    expect(result).toContain('No text, no letters')
    expect(result).toContain('Composition: Result fills 60% of the frame')
    const stakes = prompts[1]
    expect(stakes).toContain('Elements (3): me; hypothermia; the text "Or Else".')
    expect(stakes).toContain('Text: exactly the words "Or Else"')
    expect(stakes).not.toContain('No text')
  })

  it('renders a QA spec with its emotion, elements, colours and background, and no signature line without a signature', () => {
    const [p] = renderImagePrompts([{
      focalSubject: 'my face, mid-shiver', emotion: 'shock', elements: ['face', 'ice bath', 'text'], text: 'Day 30', background: 'clean gradient', colors: ['White', 'Red'],
    }])
    expect(p).toContain('Subject: my face, mid-shiver, expression shock')
    expect(p).toContain('Elements (3): face; ice bath; text.')
    expect(p).toContain('Colours: white and red')
    expect(p).toContain('Background: clean gradient.')
    expect(p).toContain('Text: exactly the words "Day 30"')
    expect(p).not.toContain('channel signature')
    expect(p).not.toContain('Composition:')
  })

  it('drops a neutral expression, falls back to the signature colours, and omits colours when neither is known', () => {
    const [withSig] = renderImagePrompts([{ focalSubject: 'a meter', emotion: 'none', elements: ['meter'] }], signature)
    expect(withSig).toContain('Subject: a meter, filling the frame')
    expect(withSig).not.toContain('expression')
    expect(withSig).toContain('Colours: yellow and black')
    const [bare] = renderImagePrompts([{ focalSubject: 'a meter', elements: ['meter'] }])
    expect(bare).not.toContain('Colours:')
    expect(renderImagePrompts([])).toEqual([])
  })
})
