import { describe, expect, it } from 'vitest'
import type { Signature } from './schema.js'
import { checkSignature, describeSignature, looksLikePerson } from './signature.js'

const sig: Signature = { colors: ['yellow', 'black'], facePolicy: 'either', maxWords: 3 }

describe('checkSignature', () => {
  it('passes a concept that keeps the colour pair, the word budget and the face policy', () => {
    const r = checkSignature({ focalSubject: 'my face, mid-shiver', emotion: 'shock', elements: ['face'], text: 'Day 30', colors: ['yellow', 'black'] }, sig)
    expect(r).toEqual({ drift: false, reasons: [] })
  })

  it('flags a colour pair that misses a signature colour, case-insensitively', () => {
    const r = checkSignature({ focalSubject: 'a frozen beard', elements: ['beard'], colors: ['Yellow', 'red'] }, sig)
    expect(r.drift).toBe(true)
    expect(r.reasons).toEqual(['colours yellow/red miss the signature pair yellow/black (no black)'])
  })

  it('accepts a spec that adds a third colour on top of the pair', () => {
    expect(checkSignature({ focalSubject: 'a beard', elements: ['beard'], colors: ['black', 'yellow', 'white'] }, sig).drift).toBe(false)
  })

  it('does not judge colours when the spec names none', () => {
    expect(checkSignature({ focalSubject: 'a beard', elements: ['beard'] }, sig).drift).toBe(false)
  })

  it('flags text above maxWords and respects a zero budget', () => {
    expect(checkSignature({ focalSubject: 'a beard', elements: ['beard'], text: 'thirty days of ice' }, sig).reasons).toEqual(['4 words of text, signature allows at most 3'])
    expect(checkSignature({ focalSubject: 'a beard', elements: ['beard'], text: 'Day 30' }, { ...sig, maxWords: 0 }).reasons).toEqual(['2 words of text, signature allows at most 0'])
    expect(checkSignature({ focalSubject: 'a beard', elements: ['beard'], text: '   ' }, { ...sig, maxWords: 0 }).drift).toBe(false)
  })

  it('flags a face under facePolicy never and a missing face under always', () => {
    const never = checkSignature({ focalSubject: 'the creator', elements: ['face'] }, { ...sig, facePolicy: 'never' })
    expect(never.reasons).toEqual(['a face is in frame ("the creator") but the signature never shows one'])
    const always = checkSignature({ focalSubject: 'a power meter reading zero, right here', elements: ['meter'] }, { ...sig, facePolicy: 'always' })
    expect(always.reasons).toEqual(['no face in frame but the signature always shows one'])
    expect(checkSignature({ focalSubject: 'the creator', elements: ['face'] }, { ...sig, facePolicy: 'always' }).drift).toBe(false)
    expect(checkSignature({ focalSubject: 'a meter', elements: ['meter'] }, { ...sig, facePolicy: 'never' }).drift).toBe(false)
  })

  it('reports every missed rule in a fixed order: colours, words, face', () => {
    const r = checkSignature({ focalSubject: 'me', elements: ['face'], text: 'one two three four', colors: ['blue', 'purple'] }, { ...sig, facePolicy: 'never' })
    expect(r.reasons).toHaveLength(3)
    expect(r.reasons[0]).toMatch(/^colours/)
    expect(r.reasons[1]).toMatch(/^4 words/)
    expect(r.reasons[2]).toMatch(/^a face is in frame/)
  })
})

describe('describeSignature', () => {
  it('writes one sentence with the pair, the face policy and the word budget', () => {
    expect(describeSignature(sig)).toBe('Keep the channel signature: the yellow/black colour pair, a face optional, at most 3 words of text.')
  })
  it('includes framing, typeface and notes, and phrases always/never and singular words', () => {
    const s = describeSignature({ colors: ['white', 'red'], facePolicy: 'always', maxWords: 1, framing: 'subject in the lower third', typeface: 'condensed caps', notes: 'red arrow on every reveal.' })
    expect(s).toBe('Keep the channel signature: the white/red colour pair, always a face, at most 1 word of text, framing subject in the lower third, typeface condensed caps, red arrow on every reveal.')
    expect(s.split('. ').length).toBe(1)
    expect(describeSignature({ colors: ['yellow'], facePolicy: 'never', maxWords: 0 })).toBe('Keep the channel signature: the yellow colour accent, never a face, no text.')
  })
})

describe('looksLikePerson', () => {
  it('matches people and not words that contain "me" or "her"', () => {
    expect(looksLikePerson('the creator')).toBe(true)
    expect(looksLikePerson('a woman laughing')).toBe(true)
    expect(looksLikePerson('a power meter, right here, with herbs')).toBe(false)
    expect(looksLikePerson(undefined)).toBe(false)
  })
})
