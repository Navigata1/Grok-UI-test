import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { applyOverrides, resetThresholds } from './thresholds.js'
import { TITLE_BLANK, TITLE_FORMULAS, generateTitles, scoreTitle, templateArtifacts, titleShapes, titleThumbnailOverlap } from './titles.js'

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

describe('scoreTitle (template-fill guard)', () => {
  afterEach(() => resetThresholds())

  // The fills the examination saw rated 80-93 (FR-5, UX-3, EFF-2), each with the artifact its note must name.
  const FILLS: Array<[string, string]> = [
    ['I Did A $300 solar generator Until It Worked', '"Did A" starts the pasted-in topic with its article'],
    ['I Did Living off a $300 solar generator Until It Worked', 'around the lowercase phrase "off a $300 solar generator"'],
    ['I Did Solar generator for 200 dollars Until It Worked', 'around the lowercase phrase "Solar generator for 200 dollars"'],
    ['How I Living off a $300 solar generator (Step by Step)', '"How I Living" needs a past-tense verb'],
    ['I Tried I lived off a $300 solar generator for 30 days', '"Tried I" puts a pronoun straight after the frame'],
    ['The Truth About I lived off a $300 solar generator for 30 days', '"About I" puts a pronoun straight after the frame'],
    ['Why Cheap solar generator Is Not What You Think', 'Title Case frame words (Cheap, Is, Not, What, You, Think) around the lowercase phrase "solar generator"'],
    ['Stop Cheap solar generator Like This', 'around the lowercase phrase "solar generator"'],
    ['Stop A $300 solar generator Like This', '"Stop A" starts the pasted-in topic with its article'],
    ['Cheap vs Expensive A $300 solar generator', '"Expensive A" starts the pasted-in topic with its article'],
    ['Cheap vs Expensive Cooking pasta in a tiny van kitchen', 'around the lowercase phrase "Cooking pasta in a tiny van kitchen"'],
    ['The A $300 solar generator Mistake Everyone Makes', '"The A" starts the pasted-in topic with its article'],
    ['I Did Solar generator vs power station Until It Worked', 'around the lowercase phrase "Solar generator vs power station"'],
    ['Why Cold showers Is Not What You Think', 'around the lowercase phrase "Cold showers"'],
    ['I Tried cold showers for 30 days for 30 days', '"30 days" appears twice'],
    // A Start Case topic that already ends on the number: only the doubling gives the paste away.
    ['I Tried Cold Showers for 30 Days for 30 Days', '"30 days" appears twice'],
    ['Cold Showers for 30 Days: 30 Days Later', '"30 days" appears twice'],
    ['30 Days Cold Showers for 30 Days Ideas Ranked Worst to Best', '"30 days" appears twice'],
    ['Solar Generator asdf qwer Power Station Until It Broke', 'around the lowercase phrase "Generator asdf qwer"'],
  ]

  // Object cases: vitest reads "$300" in a printf-style name as a variable, so the name interpolates $title instead.
  it.each(FILLS.map(([title, artifact]) => ({ title, artifact })))('holds $title under the title gate and names the artifact', ({ title, artifact }) => {
    const s = scoreTitle(title)
    expect(s.score).toBeLessThan(60)
    expect(s.notes.some((n) => n.startsWith('template fill:') && n.includes(artifact)), s.notes.join(' | ')).toBe(true)
    expect(s.notes).toContain('template fill: held under the title gate (60 [house]); write the title in your own words')
  })

  it('keeps a fill under the gate even where a profile lowers it', () => {
    applyOverrides({ titleGateScore: 40 })
    expect(scoreTitle('I Did Solar generator for 200 dollars Until It Worked').score).toBeLessThan(40)
    expect(scoreTitle('I Did Solar generator for 200 dollars Until It Worked').notes).toContain('template fill: held under the title gate (40 [house]); write the title in your own words')
  })

  // Human-written titles: consistent Title Case (every content word capitalised, short function words
  // lowercase) and sentence case (only the first word, "I" and proper nouns capitalised). None is a fill.
  const TITLE_CASE = [
    'I Lived Off a $300 Solar Generator for 30 Days',
    'How I Lived Off a $300 Solar Generator for 30 Days',
    'The Truth About a $300 Solar Generator',
    'I Did a 30-Day Water Fast Until It Worked',
    'Why Did I Buy a $300 Solar Generator?',
    'Solar Generator vs Power Station: Which Runs a Van?',
    'Stop Taking Cold Showers Like This',
    'How I Bring My Van Back to Life',
    'Why the iPhone 15 Is Not Worth It for Vanlife',
    'I Tried 30 Days of Cold Showers',
    '$300 Solar Generator vs $3000 Solar Generator',
    '30 Days Without Sugar vs 30 Days Without Coffee',
  ]
  const SENTENCE_CASE = [
    'I lived off a $300 solar generator for 30 days',
    'How I lived off a $300 solar generator for 30 days',
    'How I powered my van from Austin to Denver with a Jackery',
    'Why my Tesla battery died in the cold',
    'Living off-grid: what I learned in 30 days',
    'I tried the cheapest solar generator on Amazon for a week',
    'Stop buying cheap panels before you read this',
    'I tried The Home Edit method for a week',
  ]

  // Every word capitalised, articles included ("Start Case"): a capital after "Did" or "Stop" is house style
  // there, not a topic pasted in with its article.
  const START_CASE = [
    'I Did A 24 Hour Fast And This Happened',
    'We Did A Full Van Build In 7 Days',
    'I Did A Backflip Every Day For 30 Days',
    'I Did A 7 Day Fridge Test On A $200 Solar Generator',
    'Stop A Leaking Roof In 10 Minutes',
    'Stop A Leak In 5 Minutes Without Tools',
  ]
  // A sentence inside the title opens on any word: an article or a pronoun after ":", "?" or "." is no paste,
  // and a number phrase restated in a new sentence is a person writing.
  const SENTENCE_BREAKS = [
    'Cheap vs Expensive: The Real Difference in 30 Days',
    'Why I Went Expensive: A $2,000 Van Power Setup',
    'Is Solar Worth It If You Go Cheap? A 30 Day Test',
    'Everything Was Expensive. We Built Our Own',
    '30 Days Of Cold Showers: What 30 Days Did To Me',
  ]
  // One all-caps word for emphasis in a sentence-case title: the same in every case style, so never Title Case.
  const EMPHASIS = [
    'Why cheap solar generators are NOT worth it',
    'I tried the WORST rated restaurant in my city',
    'The BEST budget solar generator for vans',
    'The TRUTH about solar generators',
    'This solar generator is a MISTAKE',
  ]

  it.each([...TITLE_CASE, ...SENTENCE_CASE, ...START_CASE, ...SENTENCE_BREAKS, ...EMPHASIS].map((title) => ({ title })))('does not penalise the human-written $title', ({ title }) => {
    expect(templateArtifacts(title)).toEqual([])
    expect(scoreTitle(title).notes.some((n) => n.startsWith('template fill'))).toBe(false)
  })

  it('leaves the score of a consistent title exactly where the lexical rules put it', () => {
    expect(scoreTitle('I Lived Off a $300 Solar Generator for 30 Days').score).toBe(85)
    expect(scoreTitle('I lived off a $300 solar generator for 30 days').score).toBe(85)
    expect(scoreTitle('I Did a 30-Day Water Fast Until It Worked').score).toBe(93)
    // The scores these titles had before the guard existed (the review's repro), not 28-55 under the gate.
    expect(scoreTitle('Why cheap solar generators are NOT worth it').score).toBe(85)
    expect(scoreTitle('I tried the WORST rated restaurant in my city').score).toBe(83)
    expect(scoreTitle('I Did A Backflip Every Day For 30 Days').score).toBe(93)
    expect(scoreTitle('Stop A Leaking Roof In 10 Minutes').score).toBe(88)
    expect(scoreTitle('Cheap vs Expensive: The Real Difference in 30 Days').score).toBe(90)
    expect(scoreTitle('Why I Went Expensive: A $2,000 Van Power Setup').score).toBe(100)
    expect(scoreTitle('30 Days Of Cold Showers: What 30 Days Did To Me').score).toBe(75)
  })

  it('still reads a lowercase topic after a capitalised article as a paste, and ALL CAPS never hides one', () => {
    // Start Case is style only when the whole title is in it: here the topic kept its lowercase words.
    expect(templateArtifacts('We Did A full van build in 7 days')).toContain('template fill: "Did A" starts the pasted-in topic with its article; no article belongs after "Did" here')
    expect(templateArtifacts('Stop A leaking roof Like This').some((n) => n.includes('"Stop A" starts the pasted-in topic'))).toBe(true)
    // An emphasis word is neither a frame word nor a break in the lowercase phrase; the Title Case frame still gives it away.
    expect(templateArtifacts('Why Cheap solar generator Is NOT What You Think').some((n) => n.includes('around the lowercase phrase "solar generator"'))).toBe(true)
  })
})

describe('titleShapes', () => {
  it('prints every formula with a blank, no score, no ranking, and the number, subject and audience filled in', () => {
    const shapes = titleShapes({ number: '30 Days' })
    expect(shapes[0]).toEqual({ title: 'I Tried ___ for 30 Days', formula: 'first-person test', example: 'I Tried 30 Days of Cold Showers', template: true, score: null })
    expect(shapes.every((s) => s.title.includes(TITLE_BLANK) && s.template === true && s.score === null)).toBe(true)
    // Formula order, not a ranking.
    const order = TITLE_FORMULAS.map((f) => f.name)
    expect(shapes.map((s) => order.indexOf(s.formula))).toEqual([...shapes.map((s) => order.indexOf(s.formula))].sort((a, b) => a - b))
    expect(titleShapes({ subject: 'Jackery', audience: 'van lifers' }).map((s) => s.title)).toEqual(expect.arrayContaining(['Jackery vs ___: Not Even Close', '___ for van lifers (Start Here)', 'Jackery Changed How I Think About ___']))
    expect(titleShapes().some((s) => s.formula === 'ranked list')).toBe(false)
  })

  it('takes every worked example from playbook/title-formulas.md', () => {
    const playbook = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playbook', 'title-formulas.md'), 'utf8')
    for (const f of TITLE_FORMULAS.filter((x) => x.example)) expect(playbook, f.name).toContain(`| ${f.example} |`)
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
