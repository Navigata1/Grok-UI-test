import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COLOR_PAIR,
  DEFAULT_ROUNDS,
  PACKAGE_FIX_PROMPT_PATH,
  buildPackage,
  conceptToSpec,
  readPackage,
  renderFixPrompt,
  renderPackageMarkdown,
  reviewPackage,
  verdictFor,
  writePackage,
  type ConceptInput,
  type FixContext,
  type PackageDoc,
  type TitleInput,
} from './package.js'
import { stableId } from './schema.js'
import { applyOverrides, resetThresholds } from './thresholds.js'
import { buildThumbnailBrief } from './thumbnails.js'

const NOW = new Date('2026-09-14T09:00:00.000Z')
const TITLE = 'I Tried 30 Days of Cold Showers'

/** Two ship-grade concepts on different levers, with text that keeps the promise and never repeats the title. */
const GOOD_CONCEPTS: ConceptInput[] = [
  { name: 'The Result', angle: 'result', focalSubject: 'the finished generator', emotion: 'none', elements: ['generator', 'me reacting'], text: 'Under $100', background: 'clean gradient', colors: ['yellow', 'black'], composition: 'generator fills 60%', designerBrief: 'shoot at golden hour' },
  { name: 'The Stakes', angle: 'stakes', focalSubject: 'me', emotion: 'worried', elements: ['me', 'smoking battery', 'text'], text: 'Scrap Fire', background: 'blurred workshop', colors: ['yellow', 'black'], composition: 'me centre-left' },
]

const BAD_CONCEPT: ConceptInput = {
  name: 'Collage',
  angle: 'result',
  focalSubject: 'me',
  emotion: 'neutral',
  elements: ['me', 'generator', 'battery', 'calendar', 'logo', 'arrow'],
  text: 'I built a solar generator from scrap',
  background: 'busy workshop with lots of items',
  colors: ['blue', 'purple'],
}

const SOLAR = {
  idea: 'solar generator from scrap',
  promise: 'I build a solar generator from scrap for under $100',
  number: '30 days',
  subject: 'me',
  stake: 'the battery catching fire',
  result: 'the finished solar generator',
  now: NOW,
}

describe('reviewPackage (fast path, no spec)', () => {
  it('passes a strong title with complementary short text', () => {
    const r = reviewPackage({ title: TITLE, thumbnailText: 'Day 30', elements: ['face', 'ice bath', 'text'] })
    expect(r.verdict).toBe('pass')
    expect(r.issues).toEqual([])
    expect(r.titleScore).toBeGreaterThanOrEqual(60)
    expect(r.overlap).toBe(0)
    expect(r.gateReport.pass).toBe(true)
    expect(r.gateReport.titleGate.reason).toContain('[house]')
    expect(r.gateReport.thumbGate.reason).toContain('no spec given')
    expect(r.gateReport.promiseGate.reason).toContain('no promise given')
    expect(r.qa).toBeUndefined()
    expect(r.promiseCheck).toBeUndefined()
    expect(r.gateReport.thresholdsUsed).toEqual(expect.arrayContaining([expect.stringContaining('titleGateScore 60'), expect.stringContaining('titleThumbOverlapMax 0.67')]))
  })

  it('revises when the thumbnail text repeats the title (one issue)', () => {
    const r = reviewPackage({ title: TITLE, thumbnailText: 'Cold Showers' })
    expect(r.overlap).toBe(1)
    expect(r.verdict).toBe('revise')
    expect(r.gateReport.overlapGate.pass).toBe(false)
    expect(r.gateReport.pass).toBe(false)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatch(/repeats 100% of the title/)
  })

  it('fails a weak title with long text and too many elements (several issues)', () => {
    const r = reviewPackage({ title: 'Vlog 3', thumbnailText: 'this is way too many words', elements: ['a', 'b', 'c', 'd', 'e'] })
    expect(r.verdict).toBe('fail')
    expect(r.gateReport.titleGate.pass).toBe(false)
    expect(r.gateReport.thumbGate.pass).toBe(false)
    expect(r.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('below 60 [house]'),
      expect.stringContaining('6 words, longer than 3 [house]'),
      expect.stringContaining('5 elements; cut to 3 [house]'),
    ]))
  })

  it('treats absent thumbnail text as the image carrying it', () => {
    const r = reviewPackage({ title: TITLE })
    expect(r.thumbnailText).toBe('')
    expect(r.gateReport.overlapGate.reason).toBe('no thumbnail text: nothing to repeat')
    expect(r.verdict).toBe('pass')
  })
})

describe('reviewPackage (spec path)', () => {
  it('calls qaThumbnail so colour, emotion and background rules are judged', () => {
    const r = reviewPackage({
      title: TITLE,
      spec: { focalSubject: 'me', emotion: 'neutral', elements: ['face', 'shower', 'ice', 'calendar', 'logo', 'arrow'], text: 'I tried 30 days of cold showers and this happened', background: 'busy bathroom with lots of items', colors: ['blue', 'purple'] },
    })
    expect(r.qa).toBeDefined()
    expect(r.qa!.grade).toBe('rethink')
    expect(r.verdict).toBe('fail')
    expect(r.gateReport.thumbGate.pass).toBe(false)
    expect(r.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('thumbnail: a face with no expression'),
      expect.stringContaining('thumbnail: low-contrast colour pair'),
      'thumbnail: busy background',
    ]))
  })

  it('takes the text from the spec, defaults the spec title to the reviewed title, and ships a clean concept', () => {
    const r = reviewPackage({
      title: TITLE,
      thumbnailText: 'ignored when the spec has text',
      spec: { focalSubject: 'my face, mid-shiver', emotion: 'shock', elements: ['face', 'ice bath', 'text'], text: 'Day 30', background: 'clean gradient', colors: ['yellow', 'black'] },
    })
    expect(r.thumbnailText).toBe('Day 30')
    expect(r.qa!.grade).toBe('ship')
    expect(r.qa!.passes).toContain('thumbnail text complements the title')
    expect(r.verdict).toBe('pass')
    expect(r.gateReport.thumbGate.reason).toMatch(/QA 100\/100 SHIP/)
  })

  it('notes a signature drift without failing a ship-grade concept', () => {
    const r = reviewPackage({
      title: TITLE,
      spec: { focalSubject: 'ice bath', elements: ['ice bath', 'text'], text: 'Day 30', colors: ['white', 'red'] },
      signature: { colors: ['yellow', 'black'], facePolicy: 'either', maxWords: 3 },
    })
    expect(r.qa!.grade).toBe('ship')
    expect(r.qa!.failures[0]).toMatch(/^signature drift/)
    expect(r.verdict).toBe('pass')
    expect(r.gateReport.thumbGate.reason).toContain('noted: signature drift')
  })
})

describe('reviewPackage (promise gate)', () => {
  it('passes when the promise survives on the title and the text', () => {
    const r = reviewPackage({ title: TITLE, thumbnailText: 'Sleep Fixed', promise: 'I tried 30 days of cold showers to fix my sleep' })
    expect(r.promiseCheck).toBeDefined()
    expect(r.gateReport.promiseGate.pass).toBe(true)
    expect(r.verdict).toBe('pass')
    expect(r.gateReport.thresholdsUsed).toEqual(expect.arrayContaining([expect.stringContaining('promise minCoverage')]))
  })

  it('fails when the title drops the promise', () => {
    const r = reviewPackage({ title: TITLE, thumbnailText: 'Day 30', promise: 'I rebuild a vintage motorcycle engine in a weekend' })
    expect(r.gateReport.promiseGate.pass).toBe(false)
    expect(r.issues.some((i) => i.startsWith('promise: title:'))).toBe(true)
    expect(r.verdict).not.toBe('pass')
  })
})

describe('reviewPackage (thresholds)', () => {
  afterEach(() => resetThresholds())

  it('reads the title gate from thresholds so a profile override moves it', () => {
    applyOverrides({ titleGateScore: 90 })
    const r = reviewPackage({ title: TITLE, thumbnailText: 'Day 30' })
    expect(r.titleScore).toBeLessThan(90)
    expect(r.gateReport.titleGate.pass).toBe(false)
    expect(r.verdict).toBe('revise')
  })
})

describe('verdictFor', () => {
  it('maps issue counts to the playbook verdicts', () => {
    expect(verdictFor([])).toBe('pass')
    expect(verdictFor(['one'])).toBe('revise')
    expect(verdictFor(['one', 'two'])).toBe('fail')
  })
})

describe('conceptToSpec', () => {
  const brief = buildThumbnailBrief('solar generator from scrap', TITLE, { subject: 'me', stake: 'fire', result: 'the generator' })

  it('derives at most three elements, a per-lever emotion, the title, and the default colour pair', () => {
    const stakes = brief.concepts.find((c) => c.angle === 'stakes')!
    const spec = conceptToSpec(stakes, TITLE)
    expect(spec.elements).toEqual(['me', 'fire', 'text "Or Else"'])
    expect(spec.emotion).toBe('worried')
    expect(spec.title).toBe(TITLE)
    expect(spec.colors).toEqual([...DEFAULT_COLOR_PAIR])
    const result = conceptToSpec(brief.concepts.find((c) => c.angle === 'result')!, TITLE)
    expect(result.elements).toHaveLength(2)
    expect(result.text).toBe('')
  })

  it('uses the signature colours when a signature is given', () => {
    const spec = conceptToSpec(brief.concepts[0]!, TITLE, { colors: ['white', 'red'], facePolicy: 'either', maxWords: 3 })
    expect(spec.colors).toEqual(['white', 'red'])
  })
})

describe('buildPackage (offline)', () => {
  it('builds a passing package from generateTitles and buildThumbnailBrief in one round', async () => {
    const doc = await buildPackage(SOLAR)
    expect(doc.slug).toBe('solar-generator-from-scrap')
    expect(doc.id).toBe(stableId('package', 'solar-generator-from-scrap'))
    expect(doc.createdAt).toBe(NOW.toISOString())
    expect(doc.rounds).toBe(1)
    expect(doc.history).toEqual([{ round: 1, pass: true, issues: [], fixes: [] }])
    expect(doc.gateReport.pass).toBe(true)
    expect(doc.chosenTitle).toBe(doc.titles[0]!.title)
    // Ranked publishable-first (over the gate and inside the mobile band), then by score.
    const rank = (t: { title: string; score: number }): number => (t.score >= 60 && t.title.length >= 30 && t.title.length <= 55 ? 0 : 1)
    expect(doc.titles.every((t, i) => {
      const prev = doc.titles[i - 1]
      return i === 0 || rank(prev!) < rank(t) || (rank(prev!) === rank(t) && t.score <= prev!.score)
    })).toBe(true)
    expect(doc.titles[0]!.formula).toBeDefined()
    expect(doc.titles[0]!.score).toBeGreaterThanOrEqual(60)
    expect(doc.thumbnails).toHaveLength(5)
    expect(new Set(doc.thumbnails.map((t) => t.angle))).toEqual(new Set(['result', 'stakes', 'curiosity', 'contrast', 'identity']))
    expect(doc.thumbnails.every((t) => t.qa.grade === 'ship' && t.spec.title === doc.chosenTitle)).toBe(true)
    expect(doc.thumbnails.every((t) => t.spec.colors?.join('/') === 'yellow/black')).toBe(true)
    expect(doc.abPick.a).toBe('The Result')
    expect(doc.abPick.b).toBe('The Identity')
    expect(doc.abPick.reason).toContain('different lever')
    expect(doc.hypothesis).toEqual({ levers: ['first-person test', 'result', 'identity'], angle: 'result', predictedCtrMultiple: 1 })
    expect(doc.ownTitles).toEqual(['', '', ''])
    expect(doc.promise).toBe(SOLAR.promise)
    expect(doc.designerBrief.length).toBeGreaterThan(10)
    expect(doc.designerBrief[0]).toMatch(/^The Result \(result\): focal/)
  })

  it('marks concepts whose text drops the promise as ineligible and still pairs two different levers', async () => {
    const doc = await buildPackage(SOLAR)
    const byName = Object.fromEntries(doc.thumbnails.map((t) => [t.name, t]))
    expect(byName['The Stakes']!.promisePass).toBe(false)
    expect(byName['The Stakes']!.eligible).toBe(false)
    expect(byName['The Curiosity Gap']!.eligible).toBe(false)
    expect(byName['The Result']!.eligible).toBe(true)
    expect(byName['The Identity']!.eligible).toBe(true)
    expect(doc.gateReport.thumbGate.reason).toContain('ship with different levers')
  })

  it('is deterministic', async () => {
    const a = await buildPackage(SOLAR)
    const b = await buildPackage(SOLAR)
    expect(a).toEqual(b)
  })

  it('carries the signature into every offline spec and records a face-policy drift', async () => {
    const doc = await buildPackage({ ...SOLAR, signature: { colors: ['white', 'red'], facePolicy: 'never', maxWords: 3, framing: 'subject lower third' } })
    expect(doc.thumbnails.every((t) => t.spec.colors?.join('/') === 'white/red')).toBe(true)
    const stakes = doc.thumbnails.find((t) => t.angle === 'stakes')!
    expect(stakes.qa.failures[0]).toMatch(/signature drift: a face is in frame/)
    expect(doc.designerBrief).toContain('Keep the channel signature: the white/red colour pair, never a face, at most 3 words of text, framing subject lower third.')
    expect(doc.gateReport.pass).toBe(true)
  })

  it('fails the promise gate when the promise is unrelated to the title, and does not loop without hooks', async () => {
    const doc = await buildPackage({ ...SOLAR, promise: 'I rebuild a vintage motorcycle engine in a weekend', rounds: 3 })
    expect(doc.gateReport.promiseGate.pass).toBe(false)
    expect(doc.gateReport.pass).toBe(false)
    expect(doc.rounds).toBe(1)
    expect(doc.history[0]!.issues.some((i) => i.startsWith('promise: title:'))).toBe(true)
    expect(doc.history[0]!.fixes).toEqual([])
  })

  it('fails the promise gate when no promise is written', async () => {
    const doc = await buildPackage({ ...SOLAR, promise: '   ' })
    expect(doc.gateReport.promiseGate).toEqual({ pass: false, reason: 'no promise written; write one sentence the video keeps' })
  })

  it('defaults createdAt to the clock only when now is not injected', async () => {
    const before = Date.now()
    const doc = await buildPackage({ idea: SOLAR.idea, promise: SOLAR.promise })
    expect(Date.parse(doc.createdAt)).toBeGreaterThanOrEqual(before)
  })
})

describe('buildPackage (generation hooks and the fix loop)', () => {
  const concepts = async (): Promise<ConceptInput[]> => GOOD_CONCEPTS
  const goodTitles: TitleInput[] = [{ title: 'I Built a Solar Generator From Scrap for $100', lever: 'first-person test' }, { title: 'Why Every Scrap Solar Generator Fails', lever: 'negativity' }]

  it('feeds the fixes of a failed round back into the hooks and records the rounds', async () => {
    const seen: FixContext<TitleInput>[] = []
    const titles = async (ctx: FixContext<TitleInput>): Promise<TitleInput[]> => {
      seen.push({ ...ctx, fixes: [...ctx.fixes] })
      return ctx.round === 1 ? [{ title: 'Vlog 3', lever: 'none' }] : goodTitles
    }
    const doc = await buildPackage({ ...SOLAR, generate: { titles, concepts } })
    expect(doc.rounds).toBe(2)
    expect(doc.gateReport.pass).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ round: 1, fixes: [], previous: undefined })
    expect(seen[1]!.round).toBe(2)
    expect(seen[1]!.fixes.some((f) => f.startsWith('Title: "Vlog 3" scores'))).toBe(true)
    expect(seen[1]!.previous).toEqual([{ title: 'Vlog 3', lever: 'none' }])
    expect(doc.history[0]!.pass).toBe(false)
    expect(doc.history[0]!.fixes).toEqual(seen[1]!.fixes)
    expect(doc.history[1]).toEqual({ round: 2, pass: true, issues: [], fixes: [] })
    expect(doc.chosenTitle).toBe('I Built a Solar Generator From Scrap for $100')
    expect(doc.titles[0]!.lever).toBe('first-person test')
    expect(doc.titles[0]!.formula).toBeUndefined()
  })

  it('stops after the configured rounds when the concepts never ship, with a provisional pair', async () => {
    let calls = 0
    const bad = async (ctx: FixContext<ConceptInput>): Promise<ConceptInput[]> => {
      calls += 1
      if (ctx.round > 1) {
        expect(ctx.fixes.some((f) => f.startsWith('Concept "Collage"'))).toBe(true)
        expect(ctx.fixes.some((f) => f.includes('Return at least 2 ship-grade concepts'))).toBe(true)
        expect(ctx.previous).toEqual([BAD_CONCEPT])
      }
      return [BAD_CONCEPT]
    }
    const doc = await buildPackage({ ...SOLAR, generate: { titles: async () => goodTitles, concepts: bad } })
    expect(calls).toBe(DEFAULT_ROUNDS)
    expect(doc.rounds).toBe(DEFAULT_ROUNDS)
    expect(doc.gateReport.pass).toBe(false)
    expect(doc.gateReport.thumbGate.pass).toBe(false)
    expect(doc.gateReport.thumbGate.reason).toContain('only 1 concept(s)')
    expect(doc.gateReport.overlapGate.pass).toBe(false)
    expect(doc.history.at(-1)!.fixes).toEqual([])
    expect(doc.abPick.a).toBe('Collage')
    expect(doc.abPick.b).toBe('')
    expect(doc.abPick.reason).toMatch(/^Provisional pair/)
    expect(doc.thumbnails[0]!.eligible).toBe(false)
  })

  it('honours a custom rounds cap', async () => {
    let calls = 0
    const doc = await buildPackage({ ...SOLAR, rounds: 2, generate: { titles: async () => { calls += 1; return [{ title: 'Vlog 3' }] }, concepts } })
    expect(calls).toBe(2)
    expect(doc.rounds).toBe(2)
    expect(doc.gateReport.titleGate.pass).toBe(false)
  })

  it('does not re-run a hook that cannot fix the failing side', async () => {
    let calls = 0
    const doc = await buildPackage({
      ...SOLAR,
      promise: 'I rebuild a vintage motorcycle engine in a weekend',
      rounds: 3,
      generate: { concepts: async () => { calls += 1; return GOOD_CONCEPTS.map((c) => ({ ...c, text: '' })) } },
    })
    expect(calls).toBe(1)
    expect(doc.rounds).toBe(1)
    expect(doc.gateReport.promiseGate.pass).toBe(false)
    expect(doc.gateReport.thumbGate.pass).toBe(true)
  })

  it('derives elements, names and angles for sparse hook concepts and refuses two concepts on one lever', async () => {
    const sparse: ConceptInput[] = [
      { focalSubject: 'the finished generator', supportingElement: 'a price tag', text: 'Under $100' },
      { focalSubject: 'the finished generator', text: 'Scrap Fire' },
    ]
    const doc = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => goodTitles, concepts: async () => sparse } })
    expect(doc.thumbnails[0]!.name).toBe('Concept 1')
    expect(doc.thumbnails[0]!.angle).toBe('concept-1')
    expect(doc.thumbnails[0]!.spec.elements).toEqual(['the finished generator', 'a price tag', 'text "Under $100"'])
    expect(doc.thumbnails[1]!.spec.elements).toEqual(['the finished generator', 'text "Scrap Fire"'])
    expect(doc.thumbnails.every((t) => t.qa.grade === 'ship' && t.eligible)).toBe(true)
    expect(doc.gateReport.thumbGate.pass).toBe(true)

    const sameLever = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => goodTitles, concepts: async () => GOOD_CONCEPTS.map((c) => ({ ...c, angle: 'result' })) } })
    expect(sameLever.gateReport.thumbGate.pass).toBe(false)
    expect(sameLever.gateReport.thumbGate.reason).toContain('both pull the result lever')
    expect(sameLever.abPick.reason).toContain('pulls the same lever as A')
  })

  it('excludes concepts whose text repeats the title and fails the overlap gate when nothing else exists', async () => {
    const repeat: ConceptInput[] = GOOD_CONCEPTS.map((c) => ({ ...c, text: 'Solar Generator Scrap' }))
    const doc = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => goodTitles, concepts: async () => repeat } })
    expect(doc.thumbnails.every((t) => t.overlap >= 0.67 && !t.eligible)).toBe(true)
    expect(doc.gateReport.overlapGate.pass).toBe(false)
    expect(doc.gateReport.pass).toBe(false)
    expect(doc.history[0]!.issues.some((i) => i.includes('says one thing twice'))).toBe(true)
  })

  it('reports an empty titles hook as a failed title gate instead of throwing', async () => {
    const doc = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => [], concepts } })
    expect(doc.chosenTitle).toBe('')
    expect(doc.gateReport.titleGate).toEqual({ pass: false, reason: 'no title generated' })
    expect(doc.gateReport.pass).toBe(false)
  })
})

describe('buildPackage (the title band publish check enforces)', () => {
  const concepts = async (): Promise<ConceptInput[]> => GOOD_CONCEPTS
  const IN_BAND = 'A Solar Generator Built From Scrap Today'
  const OVER = 'I Built a Solar Generator From Scrap for Under $100 in 30 Days'

  it('chooses the publishable title over one outside the band and ranks it first', async () => {
    const doc = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => [{ title: OVER }, { title: IN_BAND }], concepts } })
    expect(OVER.length).toBeGreaterThan(55)
    // Both rules point the same way now: the ranking is publishable-first, and scoreTitle also
    // deducts for a title past the mobile limit instead of silently giving it the neutral bonus.
    expect(doc.titles[0]!.title).toBe(IN_BAND)
    expect(doc.titles.map((t) => t.title)).toContain(OVER)
    expect(doc.titles.find((t) => t.title === OVER)!.notes.join(' ')).toContain(`over 55 chars (${OVER.length})`)
    expect(doc.chosenTitle).toBe(IN_BAND)
    expect(doc.gateReport.titleGate.pass).toBe(true)
  })

  it('fails the title gate, not passes it, when the only title is over titleMaxChars', async () => {
    const doc = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => [{ title: OVER }], concepts } })
    expect(doc.gateReport.titleGate.pass).toBe(false)
    expect(doc.gateReport.titleGate.reason).toContain(`title is ${OVER.length} characters`)
    expect(doc.gateReport.titleGate.reason).toContain('publish check needs 30 [house] to 55 [house]')
    expect(doc.gateReport.pass).toBe(false)
    expect(doc.history[0]!.issues.some((i) => i.includes('publish check needs'))).toBe(true)
    expect(doc.gateReport.thresholdsUsed).toEqual(expect.arrayContaining(['titleMinChars 30 [house]', 'titleMaxChars 55 [house]']))
  })

  it('moves the band with the profile override, so the gate and publish check stay one rule', async () => {
    applyOverrides({ titleMaxChars: 70 })
    try {
      const doc = await buildPackage({ ...SOLAR, rounds: 1, generate: { titles: async () => [{ title: OVER }], concepts } })
      expect(doc.gateReport.titleGate.pass).toBe(true)
    } finally {
      resetThresholds()
    }
  })
})

describe('buildPackage (pre-registered hypothesis)', () => {
  it('records the chosen title lever and both A/B angles, so rules compile can count the row', async () => {
    const doc = await buildPackage(SOLAR)
    expect(doc.hypothesis.levers).toEqual([doc.titles[0]!.formula, 'result', 'identity'])
    expect(doc.hypothesis.levers.length).toBeGreaterThan(0)
    expect(doc.hypothesis.angle).toBe('result')
    expect(doc.hypothesis.predictedCtrMultiple).toBe(1)
  })

  it('takes the model hook lever over the formula and de-duplicates case-insensitively', async () => {
    const doc = await buildPackage({
      ...SOLAR,
      rounds: 1,
      generate: {
        titles: async () => [{ title: 'I Built a Solar Generator From Scrap for $100', formula: 'first-person test', lever: 'Result' }],
        concepts: async () => GOOD_CONCEPTS,
      },
    })
    expect(doc.hypothesis.levers).toEqual(['Result', 'stakes'])
  })

  it('carries the predicted CTR multiple a person wrote at package time', async () => {
    const doc = await buildPackage({ ...SOLAR, predictedCtrMultiple: 1.4 })
    expect(doc.hypothesis.predictedCtrMultiple).toBe(1.4)
  })
})

describe('renderPackageMarkdown', () => {
  it('prints the promise, the gates, the titles, three blank own-title lines, the pair and the designer brief', async () => {
    const doc = await buildPackage(SOLAR)
    const md = renderPackageMarkdown(doc)
    expect(md).toContain(`# Package: ${SOLAR.idea}`)
    expect(md).toContain('## Promise')
    expect(md).toContain(SOLAR.promise)
    expect(md).toContain('- PASS title:')
    expect(md).toContain('- PASS promise:')
    expect(md).toContain(`Chosen: **${doc.chosenTitle}**`)
    expect(md).toContain('## Your own titles')
    expect(md.match(/^[123]\. _+$/gm)).toHaveLength(3)
    expect(md).toContain('A: The Result · B: The Identity')
    expect(md).toContain('## Designer brief')
    expect(md).toContain('- One focal subject. The eye must land somewhere in under a second.')
    expect(md).toContain('QA before export:')
    expect(md).toContain('- round 1: PASS')
    expect(md).toContain('Thresholds: titleGateScore 60 [house]')
  })

  it('shows failed gates, ineligible concepts and the fixes fed back', async () => {
    const doc = await buildPackage({ ...SOLAR, rounds: 2, generate: { titles: async () => [{ title: 'Vlog 3' }], concepts: async () => [BAD_CONCEPT] } })
    const md = renderPackageMarkdown(doc)
    expect(md).toContain('gates FAIL')
    expect(md).toContain('- FAIL title:')
    expect(md).toContain('· not eligible')
    expect(md).toContain('- QA failures:')
    expect(md).toMatch(/- round 1: FAIL \(\d+ issue\(s\)\); fixes fed back: \d+/)
    expect(md).toMatch(/- round 2: FAIL \(\d+ issue\(s\)\)$/m)
    expect(md).toContain('Provisional pair')
  })

  it('renders hand-written own titles when they are filled in', async () => {
    const doc = await buildPackage(SOLAR)
    const md = renderPackageMarkdown({ ...doc, ownTitles: ['My own one', '', ''] })
    expect(md).toContain('1. My own one')
    expect(md.match(/^[123]\. _+$/gm)).toHaveLength(2)
  })
})

describe('writePackage / readPackage', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'booster-package-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('writes package.json and package.md and reads the document back unchanged', async () => {
    const doc = await buildPackage(SOLAR)
    const dir = path.join(tmp(), 'packages', doc.slug)
    const paths = writePackage(dir, doc)
    expect(paths).toEqual({ json: path.join(dir, 'package.json'), md: path.join(dir, 'package.md') })
    expect(existsSync(paths.json)).toBe(true)
    expect(readFileSync(paths.md, 'utf8')).toBe(renderPackageMarkdown(doc))
    expect(JSON.parse(readFileSync(paths.json, 'utf8')).gateReport.pass).toBe(true)
    expect(readPackage(dir)).toEqual(doc)
  })

  it('returns undefined for a missing package and throws on bad JSON or a wrong shape', () => {
    const dir = tmp()
    expect(readPackage(dir)).toBeUndefined()
    writeFileSync(path.join(dir, 'package.json'), '{not json')
    expect(() => readPackage(dir)).toThrow(/not valid JSON/)
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ slug: 'x' }))
    expect(() => readPackage(dir)).toThrow(/does not match the package schema/)
  })

  it('fills defaults for optional fields when reading an older document', async () => {
    const doc = await buildPackage(SOLAR)
    const dir = tmp()
    const { history: _h, designerBrief: _d, ownTitles: _o, ...older } = doc as PackageDoc
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(older))
    const read = readPackage(dir)!
    expect(read.history).toEqual([])
    expect(read.designerBrief).toEqual([])
    expect(read.ownTitles).toEqual(['', '', ''])
  })
})

describe('renderFixPrompt', () => {
  it('ships a template with both placeholders', () => {
    const template = readFileSync(PACKAGE_FIX_PROMPT_PATH, 'utf8')
    expect(template).toContain('{{fixes}}')
    expect(template).toContain('{{previous}}')
    expect(template).toMatch(/^# Package fix-round prompt/)
  })

  it('fills the placeholders from the fixes and the previous round', () => {
    const out = renderFixPrompt(['Title: too short', 'Concept "X": cut text'], [{ title: 'Vlog 3' }])
    expect(out).toContain('- Title: too short\n- Concept "X": cut text')
    expect(out).toContain('"title": "Vlog 3"')
    expect(out).not.toContain('{{fixes}}')
    expect(out).not.toContain('{{previous}}')
  })

  it('accepts a custom template and a string previous, and writes (none) for no fixes', () => {
    expect(renderFixPrompt([], 'last round', 'F:{{fixes}} P:{{previous}} {{other}}')).toBe('F:- (none) P:last round {{other}}')
  })
})
