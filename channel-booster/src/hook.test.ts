import { afterEach, describe, expect, it } from 'vitest'
import { formatSec, HOOK_RULES, INTRO_CRUFT_PATTERNS, parseScript, renderHookReport, scoreHook } from './hook.js'
import { applyOverrides, resetThresholds } from './thresholds.js'

const NOW = new Date('2026-09-14T12:00:00Z')
const TITLE = 'I Built a $100 Solar Generator From Scrap'
const PROMISE = 'I built a solar generator from scrap for under $100'
const MOMENT = 'powering the fridge'

/** 150 words = 60 seconds at 150 wpm. No question marks, no reveal words, no digits. */
const filler = (words: number): string => Array.from({ length: words }, (_, i) => (i % 2 ? 'along' : 'and')).join(' ')

const GOOD = [
  '[0:00] This solar generator runs my whole workshop. I built it from scrap for under $100.',
  '[0:10] The catch? Every part came from a junkyard, and the first one caught fire.',
  '[1:00] But then I found the panel that changed everything.',
  '[2:00] Wait, it actually charged the battery in 40 minutes?',
  '[3:00] And here it is powering the fridge for the first time.',
  '[3:30] Can it run the fridge overnight, though?',
  '[4:00] Next week I take it off grid for seven days.',
].join('\n')

afterEach(() => resetThresholds())

describe('parseScript', () => {
  it('estimates timestamps from word count at the given wpm when there are no markers', () => {
    const p = parseScript(`${filler(150)}\n${filler(75)}`, 150)
    expect(p.timestampSource).toBe('estimated')
    expect(p.lines[0]).toMatchObject({ index: 0, kind: 'spoken', atSec: 0, endSec: 60, words: 150 })
    expect(p.lines[1]).toMatchObject({ index: 1, kind: 'spoken', atSec: 60, endSec: 90, words: 75 })
    expect(p.durationSec).toBe(90)
    expect(parseScript(filler(150), 300).durationSec).toBe(30)
  })
  it('reads [m:ss], m:ss, (m:ss) and h:mm:ss markers at line start and lets words advance between them', () => {
    const p = parseScript('[0:00] one two three\n1:30 - four\n(2:00) five\n1:02:03: six\nseven eight')
    expect(p.timestampSource).toBe('markers')
    expect(p.lines.map((l) => [l.marker, l.atSec, l.text])).toEqual([
      [0, 0, 'one two three'],
      [90, 90, 'four'],
      [120, 120, 'five'],
      [3723, 3723, 'six'],
      [undefined, 3723.4, 'seven eight'],
    ])
    expect(p.durationSec).toBeCloseTo(3724.2)
  })
  it('does not treat a ratio or a time inside a sentence as a marker', () => {
    const p = parseScript('a 2:1 ratio is fine\nwe met at 10:30 in town')
    expect(p.timestampSource).toBe('estimated')
    expect(p.lines.every((l) => l.marker === undefined)).toBe(true)
  })
  it('keeps headings, blank lines and marker-only lines off the clock', () => {
    const p = parseScript('# Open\nSTEP ONE\nThe hook:\n\n[0:30]\nspoken words here\nOK.')
    expect(p.lines.map((l) => [l.kind, l.text])).toEqual([
      ['heading', 'Open'],
      ['heading', 'STEP ONE'],
      ['heading', 'The hook'],
      ['blank', ''],
      ['marker', ''],
      ['spoken', 'spoken words here'],
      ['spoken', 'OK.'],
    ])
    expect(p.lines[5].atSec).toBe(30)
    expect(p.durationSec).toBeCloseTo(30 + (4 / 150) * 60)
  })
  it('rejects a non-positive wpm', () => {
    expect(() => parseScript('x', 0)).toThrow(/wpm/)
    expect(() => parseScript('x', Number.NaN)).toThrow(/wpm/)
  })
})

describe('scoreHook: a script that does everything right', () => {
  const r = scoreHook(GOOD, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
  it('scores 100 and passes the gate', () => {
    expect(r.hookScore).toBe(100)
    expect(r.pass).toBe(true)
    expect(r.gateScore).toBe(70)
    expect(r.deductions).toEqual([])
    expect(r.cuts).toEqual([])
    expect(r.computedAt).toBe('2026-09-14T12:00:00.000Z')
  })
  it('finds the promise on line 0', () => {
    expect(r.promiseInFirst25Words).toBe(true)
    expect(r.promiseLineIndex).toBe(0)
    expect(r.promiseSource).toBe('promise')
    expect(r.promiseMissing).toEqual([])
  })
  it('lists rehooks with their device and flags no gaps', () => {
    expect(r.rehooks.map((h) => [h.atSec, h.device, h.lineIndex])).toEqual([[10, 'question', 1], [60, 'reveal', 2], [120, 'question', 3], [210, 'question', 5]])
    expect(r.gaps).toEqual([])
    expect(r.introCruft).toEqual([])
  })
  it('places the thumbnail moment in the final third using markers', () => {
    expect(r.thumbnailMomentPosition).toBe('final-third')
    expect(r.thumbnailMomentAtSec).toBe(180)
    expect(r.thumbnailMomentLineIndex).toBe(4)
    expect(r.timestampSource).toBe('markers')
    expect(r.estimatedDurationSec).toBe(244)
  })
  it('prints every threshold with its evidence tag', () => {
    expect(r.thresholdsUsed).toEqual(expect.arrayContaining(['hookGateScore 70 [house]', 'rehookMaxGapSec 90s [house]', expect.stringContaining('minCoverage 0.5 [house]')]))
  })
})

describe('scoreHook: promise placement', () => {
  it('deducts 40 when the promise is not in the first 25 words, even if it arrives on word 26', () => {
    const script = `${filler(25)} I built a solar generator from scrap for under $100.`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: 'solar generator', now: NOW })
    expect(r.promiseInFirst25Words).toBe(false)
    expect(r.promiseLineIndex).toBe(-1)
    expect(r.promiseMissing).toEqual(['built', 'solar', 'generator', 'from', 'scrap', 'under', '$100'])
    expect(r.hookScore).toBe(60)
    expect(r.deductions[0]).toMatch(/^-40: /)
  })
  it('reports the raw line index of the first line carrying a promise word inside the window', () => {
    const script = '# Cold open\n\nNobody expected this.\n[0:03] I built a solar generator from scrap for under $100.'
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.promiseInFirst25Words).toBe(true)
    expect(r.promiseLineIndex).toBe(3)
  })
  it('only counts the words of a line that fall inside the window', () => {
    const script = `${filler(20)} solar\n${filler(6)} generator scrap built $100`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, now: NOW })
    // Window = 20 filler + "solar" + 4 filler words of line 2: 1 of 7 tokens.
    expect(r.promiseInFirst25Words).toBe(false)
    expect(r.promiseLineIndex).toBe(-1)
  })
  it('falls back to the title as the promise when the promise is blank', () => {
    const r = scoreHook('I built a $100 solar generator from scrap.', { title: TITLE, promise: '  ', now: NOW })
    expect(r.promiseSource).toBe('title')
    expect(r.promiseInFirst25Words).toBe(true)
    expect(renderHookReport(r)).toContain('[promise blank; title used]')
  })
})

describe('scoreHook: rehooks and gaps', () => {
  const open = 'I built a solar generator from scrap for under $100.'
  it('flags each stretch longer than rehookMaxGapSec, from the start and to the end, at 15 points each', () => {
    // open (~5s) + 150 filler words (60s) => first question at ~65s; then 300 words (120s) => second at ~185s; then 300 words to the end.
    const script = `${open}\n${filler(150)}\nWhy did it catch fire?\n${filler(300)}\nWhat happened next?\n${filler(300)}`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: 'solar generator', now: NOW })
    expect(r.rehooks.map((h) => h.device)).toEqual(['question', 'question'])
    expect(r.gaps).toHaveLength(2)
    expect(r.gaps[0].fromSec).toBe(r.rehooks[0].atSec)
    expect(r.gaps[0].toSec).toBe(r.rehooks[1].atSec)
    expect(r.gaps[1].toSec).toBe(r.estimatedDurationSec)
    expect(r.gaps.every((g) => g.toSec - g.fromSec > 90)).toBe(true)
    expect(r.deductions).toEqual(expect.arrayContaining([expect.stringMatching(/^-30: 2 stretch/)]))
    expect(r.cuts.filter((c) => c.startsWith('Add a rehook'))).toHaveLength(2)
  })
  it('caps the gap deduction at 45', () => {
    const script = `${open}\n${filler(300)}\nWhy?\n${filler(300)}\nWhy?\n${filler(300)}\nWhy?\n${filler(300)}`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: 'solar generator', now: NOW })
    expect(r.gaps).toHaveLength(4)
    expect(r.hookScore).toBe(100 - 45 - 10)
    expect(r.deductions).toEqual(expect.arrayContaining([expect.stringMatching(/^-45: 4 stretch/)]))
  })
  it('does not flag a stretch of exactly the limit', () => {
    // A marker-only last line ends the script at exactly 3:00, so the last stretch is exactly 90 s.
    const script = `[0:00] ${open}\n[1:30] Why?\n[3:00]`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.estimatedDurationSec).toBe(180)
    expect(r.gaps).toEqual([])
    // One spoken word after the marker makes it 90.4 s, which is flagged.
    expect(scoreHook(`${script} end`, { title: TITLE, promise: PROMISE, now: NOW }).gaps).toEqual([{ fromSec: 90, toSec: 180 }])
  })
  it('reads the gap limit from thresholds', () => {
    applyOverrides({ rehookMaxGapSec: 30 })
    const r = scoreHook(`[0:00] ${open}\n[0:45] Why?`, { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.gaps).toEqual([{ fromSec: 0, toSec: 45 }])
    expect(r.thresholdsUsed).toContain('rehookMaxGapSec 30s [house]')
  })
  it('detects reveal words, clause-initial "but", and an increasing number', () => {
    const script = [
      '[0:00] Day 1. I started with 5 panels.',
      '[0:30] Nothing but net all day.',
      '[1:00] It worked, but the battery died.',
      '[1:30] Turns out the wiring was backwards.',
      '[2:00] Day 2 and now 8 panels.',
      '[2:30] Down to 3 panels again.',
      '[3:00] The problem was the inverter.',
    ].join('\n')
    const r = scoreHook(script, { title: TITLE, promise: 'day 1 panels', now: NOW })
    expect(r.rehooks.map((h) => [h.atSec, h.device])).toEqual([[60, 'reveal'], [90, 'reveal'], [120, 'escalation'], [180, 'reveal']])
  })
  it('never counts an intro cruft line as a rehook', () => {
    const r = scoreHook('Welcome back, are you ready?\nI built a solar generator from scrap for under $100.', { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.introCruft).toEqual(['Welcome back, are you ready?'])
    expect(r.rehooks).toEqual([])
  })
})

describe('scoreHook: intro cruft', () => {
  it('matches every documented pattern', () => {
    const lines = ['Welcome back to the channel', 'Before we start, one thing', 'In this video we build', "Don't forget to subscribe", 'My name is Dave', 'Smash that like button']
    for (const line of lines) expect(INTRO_CRUFT_PATTERNS.some((re) => re.test(line))).toBe(true)
    expect(INTRO_CRUFT_PATTERNS.some((re) => re.test('The generator runs the fridge'))).toBe(false)
  })
  it('deducts 10 per line, capped at 20, and lists each as a cut', () => {
    const script = "Hey guys, welcome back!\nMy name is Dave.\nBefore we start, don't forget to subscribe.\nI built a solar generator from scrap for under $100."
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: 'solar generator', now: NOW })
    expect(r.introCruft).toHaveLength(3)
    expect(r.deductions).toEqual(expect.arrayContaining([expect.stringMatching(/^-20: 3 intro cruft/)]))
    expect(r.cuts.filter((c) => c.startsWith('Cut line'))).toEqual([
      expect.stringContaining('Cut line 1 (0:00)'),
      expect.stringContaining('Cut line 2'),
      expect.stringContaining('Cut line 3'),
    ])
  })
  it('ignores a closing call to action outside the intro window', () => {
    const script = `[0:00] I built a solar generator from scrap for under $100.\n[0:30] Why?\n[1:30] Don't forget to subscribe.`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.introCruft).toEqual([])
    expect(HOOK_RULES.introCruftWindowSec.value).toBe(60)
  })
})

describe('scoreHook: thumbnail moment', () => {
  const open = 'I built a solar generator from scrap for under $100.'
  it('deducts 15 when no moment is named or it is not in the script', () => {
    const none = scoreHook(open, { title: TITLE, promise: PROMISE, now: NOW })
    expect(none.thumbnailMomentPosition).toBe('missing')
    expect(none.thumbnailMomentAtSec).toBeUndefined()
    expect(none.hookScore).toBe(85)
    expect(none.cuts[0]).toMatch(/Name the thumbnail moment/)
    const absent = scoreHook(open, { title: TITLE, promise: PROMISE, thumbnailMoment: 'frozen beard', now: NOW })
    expect(absent.thumbnailMomentPosition).toBe('missing')
    expect(absent.hookScore).toBe(85)
    expect(absent.cuts[0]).toContain('"frozen beard"')
  })
  it('does not penalise a first-third moment in a script of three minutes or less', () => {
    const r = scoreHook(`[0:00] ${open}\n[0:05] Here it is powering the fridge.\n[0:30] Why?\n[1:30] Why?\n[2:30] Why?\n[2:55] end`, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    expect(r.thumbnailMomentPosition).toBe('first-third')
    expect(r.estimatedDurationSec).toBeLessThanOrEqual(180)
    expect(r.hookScore).toBe(100)
  })
  it('deducts 10 for a first-third moment in a script longer than three minutes', () => {
    const r = scoreHook(`[0:00] ${open}\n[0:05] Here it is powering the fridge.\n[0:30] Why?\n[1:30] Why?\n[2:30] Why?\n[3:30] Why?\n[3:40] end`, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    expect(r.thumbnailMomentPosition).toBe('first-third')
    expect(r.hookScore).toBe(90)
    expect(r.cuts).toEqual([expect.stringContaining('Move the thumbnail moment (line 2)')])
  })
  it('classifies middle by start time over duration', () => {
    const r = scoreHook(`[0:00] ${open}\n[1:00] Why?\n[1:30] powering the fridge now\n[2:30] Why?\n[3:00] end`, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    expect(r.thumbnailMomentPosition).toBe('middle')
    expect(r.thumbnailMomentAtSec).toBe(90)
  })
  it('prefers the strongest match and, on a tie, the later line so a tease in the open does not count', () => {
    const script = `[0:00] ${open} By the end this thing is powering a fridge.\n[1:00] Why?\n[2:00] Why?\n[2:40] It is powering the fridge right now, look.\n[3:00] end`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    expect(r.thumbnailMomentLineIndex).toBe(3)
    expect(r.thumbnailMomentPosition).toBe('final-third')
  })
  it('needs two shared words when the moment is described in three or more', () => {
    const script = `[0:00] ${open}\n[1:00] Why?\n[2:00] Why?\n[2:40] the beard is completely frozen\n[3:00] end`
    const loose = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: 'me holding the frozen beard by the ice bath', now: NOW })
    expect(loose.thumbnailMomentPosition).toBe('final-third')
    const tooLoose = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: 'me holding the frozen mug by the ice bath', now: NOW })
    expect(tooLoose.thumbnailMomentPosition).toBe('missing')
  })
})

describe('scoreHook: chapters', () => {
  it('uses headings when present and paragraph breaks otherwise, never both for one block', () => {
    const script = '# The open\n\nI built a solar generator from scrap for under $100.\nMore of the open.\n\nSecond paragraph starts a chapter, yes it does.\n## Payoff\nHere it is powering the fridge.'
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    // Paragraph chapters take the first six words, trailing punctuation stripped.
    expect(r.chapters.map((c) => c.title)).toEqual(['The open', 'Second paragraph starts a chapter, yes', 'Payoff'])
    expect(r.chapters[0].atSec).toBe(0)
    expect(r.chapters[1].atSec).toBeGreaterThan(0)
    expect(r.chapters[2].atSec).toBeGreaterThan(r.chapters[1].atSec)
  })
  it('gives a script with no breaks one chapter at 0:00', () => {
    const r = scoreHook(GOOD, { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.chapters).toEqual([{ atSec: 0, title: 'This solar generator runs my whole' }])
  })
  it('returns no chapters for an empty script', () => {
    const r = scoreHook('', { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.chapters).toEqual([])
    expect(r.estimatedDurationSec).toBe(0)
    expect(r.hookScore).toBe(45)
  })
})

describe('scoreHook: score floor and rendering', () => {
  it('never goes below 0', () => {
    const script = `Hey guys, welcome back!\nMy name is Dave.\nBefore we start, don't forget to subscribe.\n${filler(300)}\nWhy?\n${filler(300)}\nWhy?\n${filler(300)}\nWhy?\n${filler(300)}`
    const r = scoreHook(script, { title: TITLE, promise: PROMISE, now: NOW })
    // -40 promise, -45 gaps, -20 cruft, -15 thumbnail = -120
    expect(r.hookScore).toBe(0)
    expect(r.pass).toBe(false)
  })
  it('reads the gate from thresholds', () => {
    applyOverrides({ hookGateScore: 90 })
    const r = scoreHook('I built a solar generator from scrap for under $100.', { title: TITLE, promise: PROMISE, now: NOW })
    expect(r.hookScore).toBe(85)
    expect(r.pass).toBe(false)
    expect(r.gateScore).toBe(90)
  })
  it('renders every section as plain text', () => {
    const r = scoreHook(GOOD, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    const text = renderHookReport(r)
    expect(text).toContain('Hook score: 100/100 (pass, gate 70)')
    expect(text).toContain('Promise in first 25 words: yes (line 1)')
    expect(text).toContain('Thumbnail moment: final-third at 3:00')
    expect(text).toContain('0:10  [question] The catch?')
    expect(text).toContain('Chapters (1):')
    expect(text).not.toContain('Deductions:')
  })
  it('formats seconds', () => {
    expect(formatSec(0)).toBe('0:00')
    expect(formatSec(65.4)).toBe('1:05')
    expect(formatSec(3723)).toBe('1:02:03')
  })
  it('is deterministic for the same input and clock', () => {
    const a = scoreHook(GOOD, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    const b = scoreHook(GOOD, { title: TITLE, promise: PROMISE, thumbnailMoment: MOMENT, now: NOW })
    expect(a).toEqual(b)
  })
})
