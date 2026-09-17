import { afterEach, describe, expect, it } from 'vitest'
import { checkPromise, coverage, firstLine, firstWords, PROMISE_RULES, promiseTokens } from './promise.js'
import { applyOverrides, resetThresholds } from './thresholds.js'

const PROMISE = 'I built a solar generator from scrap for under $100'
// content tokens: built, solar, generator, from, scrap, under, $100 (7)

afterEach(() => resetThresholds())

describe('promiseTokens and coverage', () => {
  it('returns unique content tokens in order of first appearance', () => {
    expect(promiseTokens('The generator, the generator! A $100 generator')).toEqual(['generator', '$100'])
    expect(promiseTokens('')).toEqual([])
  })
  it('measures the share of promise tokens present in a text', () => {
    const c = coverage(['solar', 'generator', 'scrap'], 'a scrap-built SOLAR thing')
    expect(c.overlap).toBeCloseTo(2 / 3)
    expect(c.shared).toEqual(['solar', 'scrap'])
    expect(c.missing).toEqual(['generator'])
    expect(coverage([], 'anything')).toEqual({ overlap: 0, shared: [], missing: [] })
  })
  it('firstWords and firstLine trim to the head of a text', () => {
    expect(firstWords('  one two\nthree   four five', 3)).toBe('one two three')
    expect(firstWords('one two', 0)).toBe('')
    expect(firstLine('first line here \nsecond')).toBe('first line here')
    expect(firstLine('')).toBe('')
  })
})

describe('checkPromise: title', () => {
  it('passes when the promise starts inside 40 characters and the title carries at least half of it', () => {
    const r = checkPromise(PROMISE, { title: 'I Built a $100 Solar Generator From Scrap' })
    const t = r.surfaces.title!
    expect(t.pass).toBe(true)
    expect(t.overlap).toBeCloseTo(6 / 7)
    expect(t.headShared).toEqual(['built', 'solar', 'generator', 'from', '$100'])
    expect(t.missing).toEqual(['under'])
    expect(r.pass).toBe(true)
    expect(r.checked).toEqual(['title'])
    expect(r.drift).toEqual([])
  })
  it('fails when no promise word appears in the first 40 characters even if the tail carries them', () => {
    const title = 'Why Everyone Is Wrong About Van Life: Scrap Solar Generator Build'
    const t = checkPromise(PROMISE, { title }).surfaces.title!
    expect(title.slice(0, PROMISE_RULES.headChars.value)).not.toMatch(/solar|scrap|generator/i)
    expect(t.pass).toBe(false)
    expect(t.headShared).toEqual([])
    expect(t.reason).toContain('first 40 characters')
  })
  it('fails when the head shares a word but the whole title carries under half the promise', () => {
    const r = checkPromise(PROMISE, { title: 'Solar Panels Explained for Beginners' })
    const t = r.surfaces.title!
    expect(t.headShared).toEqual(['solar'])
    expect(t.overlap).toBeCloseTo(1 / 7)
    expect(t.pass).toBe(false)
    expect(r.drift[0]).toMatch(/^title: .*below 50%/)
  })
  it('counts a word cut at the 40th character only by its visible part', () => {
    // "Generators" is cut to "Generator" exactly at 40 characters and matches the promise token.
    const title = 'How I Made This Scrap Yard Solar Generators Kit'
    expect(title.slice(0, 40)).toBe('How I Made This Scrap Yard Solar Generat')
    const t = checkPromise(PROMISE, { title }).surfaces.title!
    expect(t.headShared).toEqual(['solar', 'scrap'])
  })
})

describe('checkPromise: scriptHead', () => {
  it('reads only the first 25 words of whatever script is passed', () => {
    const filler = Array.from({ length: 30 }, () => 'filler').join(' ')
    const late = `${filler} I built this solar generator from scrap for under $100`
    const early = `I built this solar generator from scrap for under $100. ${filler}`
    expect(checkPromise(PROMISE, { scriptHead: late }).surfaces.scriptHead!.pass).toBe(false)
    expect(checkPromise(PROMISE, { scriptHead: early }).surfaces.scriptHead!.pass).toBe(true)
    expect(checkPromise(PROMISE, { scriptHead: late }).surfaces.scriptHead!.overlap).toBe(0)
  })
  it('passes at exactly half coverage and reports the missing words below it', () => {
    // 4 of 7 tokens
    const half = checkPromise(PROMISE, { scriptHead: 'Solar generator, scrap parts, $100 total.' }).surfaces.scriptHead!
    expect(half.overlap).toBeCloseTo(4 / 7)
    expect(half.pass).toBe(true)
    // 3 of 7 tokens
    const under = checkPromise(PROMISE, { scriptHead: 'Solar generator from parts.' }).surfaces.scriptHead!
    expect(under.overlap).toBeCloseTo(3 / 7)
    expect(under.pass).toBe(false)
    expect(under.missing).toEqual(['built', 'scrap', 'under', '$100'])
  })
})

describe('checkPromise: descriptionLine1', () => {
  it('reads only the first line', () => {
    const desc = 'Links and gear below.\nI built a solar generator from scrap for under $100.'
    const d = checkPromise(PROMISE, { descriptionLine1: desc }).surfaces.descriptionLine1!
    expect(d.pass).toBe(false)
    expect(d.overlap).toBe(0)
    const good = checkPromise(PROMISE, { descriptionLine1: 'A scrap solar generator built for under $100.\nLinks below.' }).surfaces.descriptionLine1!
    expect(good.pass).toBe(true)
    expect(good.overlap).toBeCloseTo(6 / 7)
  })
})

describe('checkPromise: thumbnailText', () => {
  const title = 'I Built a $100 Solar Generator From Scrap'
  it('passes when empty: the image carries it', () => {
    const t = checkPromise(PROMISE, { title, thumbnailText: '  ' }).surfaces.thumbnailText!
    expect(t.pass).toBe(true)
    expect(t.overlap).toBe(0)
  })
  it('fails when it repeats the title, even if it shares a promise word', () => {
    const t = checkPromise(PROMISE, { title, thumbnailText: 'Solar Generator' }).surfaces.thumbnailText!
    expect(t.titleOverlap).toBe(1)
    expect(t.shared).toEqual(['solar', 'generator'])
    expect(t.pass).toBe(false)
    expect(t.reason).toContain('repeats')
  })
  it('fails when it shares no word with the promise', () => {
    const t = checkPromise(PROMISE, { title, thumbnailText: 'Day 30' }).surfaces.thumbnailText!
    expect(t.titleOverlap).toBe(0)
    expect(t.pass).toBe(false)
    expect(t.reason).toContain('shares no word')
  })
  it('passes when it shows a promise word without repeating the title', () => {
    const t = checkPromise(PROMISE, { title, thumbnailText: 'Scrap Only' }).surfaces.thumbnailText!
    expect(t.titleOverlap).toBe(0.5)
    expect(t.shared).toEqual(['scrap'])
    expect(t.pass).toBe(true)
  })
  it('treats title repetition as zero when no title is given', () => {
    const t = checkPromise(PROMISE, { thumbnailText: 'Solar Generator' }).surfaces.thumbnailText!
    expect(t.titleOverlap).toBe(0)
    expect(t.pass).toBe(true)
  })
  it('reads the repetition limit from thresholds', () => {
    applyOverrides({ titleThumbOverlapMax: 0.4 })
    const t = checkPromise(PROMISE, { title, thumbnailText: 'Scrap Only' }).surfaces.thumbnailText!
    expect(t.titleOverlap).toBe(0.5)
    expect(t.pass).toBe(false)
  })
})

describe('checkPromise: overall verdict', () => {
  it('passes only when every present surface passes and lists each drift', () => {
    const r = checkPromise(PROMISE, {
      title: 'I Built a $100 Solar Generator From Scrap',
      scriptHead: 'Hey everyone, welcome back to the channel, today we have a really fun one for you so let us get straight into it right now okay',
      descriptionLine1: 'Gear list below.',
      thumbnailText: 'Scrap Only',
    })
    expect(r.pass).toBe(false)
    expect(r.checked).toEqual(['title', 'scriptHead', 'descriptionLine1', 'thumbnailText'])
    expect(r.drift.map((d) => d.split(':')[0])).toEqual(['scriptHead', 'descriptionLine1'])
    expect(r.thresholdsUsed).toEqual(expect.arrayContaining([expect.stringContaining('minCoverage 0.5 [house]'), expect.stringContaining('titleThumbOverlapMax 0.67 [house]')]))
  })
  it('passes vacuously with no surfaces and a real promise', () => {
    const r = checkPromise(PROMISE, {})
    expect(r.pass).toBe(true)
    expect(r.checked).toEqual([])
    expect(r.promiseTokens).toHaveLength(7)
  })
  it('fails every surface, and the empty case, when the promise has no content words', () => {
    expect(checkPromise('', {}).pass).toBe(false)
    expect(checkPromise('to be or not', {}).drift[0]).toMatch(/no content words/)
    const r = checkPromise('the a', { title: 'Anything At All', scriptHead: 'anything', descriptionLine1: 'anything', thumbnailText: 'anything' })
    expect(r.pass).toBe(false)
    expect(r.drift).toHaveLength(4)
    for (const s of Object.values(r.surfaces)) expect(s.overlap).toBe(0)
  })
  it('is deterministic', () => {
    const a = checkPromise(PROMISE, { title: 'I Built a $100 Solar Generator From Scrap', thumbnailText: 'Scrap Only' })
    const b = checkPromise(PROMISE, { title: 'I Built a $100 Solar Generator From Scrap', thumbnailText: 'Scrap Only' })
    expect(a).toEqual(b)
  })
})
