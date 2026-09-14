import { describe, expect, it } from 'vitest'
import { ProfileDoc } from './schema.js'
import { scoreTitle } from './titles.js'
import { assemblePublish, checkPublish, mmss, normaliseChapters, pickShortsCuts, PUBLISH_RULES, publishWindowFor, renderPublishCheck, renderPublishMarkdown, type PublishCheckInput, type PublishInput } from './publish.js'

const title = 'I Built a Solar Generator From Scrap for $40'
const promise = 'a solar generator built from scrap for under $40 that runs a fridge'

const input: PublishInput = {
  title,
  promise,
  chapters: [
    { atSec: 0, title: 'Open' },
    { atSec: 45, title: 'The scrap pile' },
    { atSec: 150, title: 'First test' },
    { atSec: 400, title: 'It runs the fridge' },
  ],
  payoffLadder: [
    { atSec: 150, moment: 'first light' },
    { atSec: 400, moment: 'the fridge runs on scrap' },
    { atSec: 250, moment: 'the inverter smokes' },
  ],
  thumbs: { a: 'stakes', b: 'result' },
  profile: ProfileDoc.parse({ publishDay: 'fri', baselines: { computedAt: '2026-09-01T00:00:00Z', bucket: '48', n: 6, tier: 'thin' } }),
  relatedVideo: 'I Powered My Shed With a Car Battery',
}

const goodCheck: PublishCheckInput = { titleScore: scoreTitle(title).score, thumbGrades: ['ship', 'ship'], overlapOk: true, reviewScheduled: true }

describe('assemblePublish', () => {
  it('puts the promise on line 1, chapters as mm:ss, and links after the fold', () => {
    const pack = assemblePublish(input)
    expect(pack.descriptionLine1).toBe(promise)
    const lines = pack.description.split('\n')
    expect(lines[0]).toBe(promise)
    expect(lines[1]).toBe('')
    expect(lines).toContain('00:00 Open')
    expect(lines).toContain('02:30 First test')
    expect(lines).toContain('06:40 It runs the fridge')
    expect(lines.indexOf('Links')).toBeGreaterThan(lines.indexOf('06:40 It runs the fridge'))
    expect(lines.at(-1)).toMatch(/^\[links after the fold/)
    expect(pack.chapters).toHaveLength(4)
  })

  it('asks a sequel question in the pinned comment, given or derived', () => {
    const derived = assemblePublish(input)
    expect(derived.pinnedComment).toContain('?')
    expect(derived.pinnedComment).toContain('A solar generator built from scrap')
    const given = assemblePublish({ ...input, sequelQuestion: 'Should the next one run a whole house.' })
    expect(given.pinnedComment).toBe('Should the next one run a whole house?')
    expect(assemblePublish({ ...input, sequelQuestion: 'Fridge or freezer next?' }).pinnedComment).toBe('Fridge or freezer next?')
  })

  it('cuts two Shorts from the strongest payoff moments, in playing order, 45 s each', () => {
    const pack = assemblePublish(input)
    expect(pack.shortsCuts).toHaveLength(2)
    expect(pack.shortsCuts.map((s) => s.atSec)).toEqual([250, 400])
    expect(pack.shortsCuts.every((s) => s.durationSec === 45)).toBe(true)
    expect(pack.shortsCuts[1].hook).toBe('The fridge runs on scrap (full video in the description)')
  })

  it('takes the publish window from the profile day and defaults to Thursday', () => {
    const pack = assemblePublish(input)
    expect(pack.publishWindow).toBe('Friday, when returning viewers are online (check Studio > Audience)')
    expect(pack.publishWindowSource).toBe('profile')
    expect(pack.baselineReady).toBe(true)
    const bare = assemblePublish({ ...input, profile: undefined })
    expect(bare.publishWindow).toBe('Thursday, when returning viewers are online (check Studio > Audience)')
    expect(bare.publishWindowSource).toBe('default')
    expect(bare.baselineReady).toBe(false)
    expect(publishWindowFor(ProfileDoc.parse({ publishDay: 'sun' })).publishWindow).toMatch(/^Sunday,/)
  })

  it('names A and B in the Test & Compare instructions and decides on watch-time share', () => {
    const pack = assemblePublish(input)
    expect(pack.abInstructions).toContain('Variant A = "stakes"')
    expect(pack.abInstructions).toContain('variant B = "result"')
    expect(pack.abInstructions).toContain('72 h [house]')
    expect(pack.abInstructions).toContain('1000 impressions')
    expect(pack.abInstructions).toContain('watch-time share, not the higher CTR')
    expect(pack.thumbs).toEqual({ a: 'stakes', b: 'result' })
  })

  it('carries the community post, end screen target, and a placeholder when none is chosen', () => {
    const pack = assemblePublish(input)
    expect(pack.communityPost).toContain(`New: ${title}`)
    expect(pack.communityPost).toContain(promise)
    expect(pack.communityPost).toContain(pack.pinnedComment)
    expect(pack.endScreenTarget).toBe('I Powered My Shed With a Car Battery')
    expect(assemblePublish({ ...input, relatedVideo: undefined }).endScreenTarget).toMatch(/^\[most related proven video/)
  })

  it('is deterministic and trims whitespace', () => {
    const a = assemblePublish({ ...input, title: `  ${title}  `, promise: `${promise}\n` })
    const b = assemblePublish(input)
    expect(a).toEqual(b)
  })
})

describe('chapters and Shorts helpers', () => {
  it('formats seconds as mm:ss and h:mm:ss', () => {
    expect(mmss(0)).toBe('00:00')
    expect(mmss(65)).toBe('01:05')
    expect(mmss(3_725)).toBe('1:02:05')
    expect(mmss(-4)).toBe('00:00')
  })

  it('sorts, de-duplicates, and opens chapters at 00:00', () => {
    const chapters = normaliseChapters([{ atSec: 120, title: 'Two' }, { atSec: 30, title: 'One' }, { atSec: 120, title: 'Dup' }, { atSec: 200, title: '   ' }])
    expect(chapters).toEqual([{ atSec: 0, title: 'Open' }, { atSec: 30, title: 'One' }, { atSec: 120, title: 'Two' }])
    expect(normaliseChapters(undefined)).toEqual([])
  })

  it('spaces chapters at least minChapterGapSec apart, so publish check accepts what publish pack writes', () => {
    // hook score segments a script per paragraph, so a short paragraph lands 8-9 s after the one before it.
    const perParagraph = [0, 10, 20, 30, 40, 50, 59, 70, 79, 88].map((atSec, i) => ({ atSec, title: `Beat ${i + 1}` }))
    const spaced = normaliseChapters(perParagraph)
    expect(spaced.map((c) => c.atSec)).toEqual([0, 10, 20, 30, 40, 50, 70, 88])
    expect(spaced.every((c, i) => i === 0 || c.atSec - spaced[i - 1].atSec >= PUBLISH_RULES.minChapterGapSec.value)).toBe(true)
    const check = checkPublish(assemblePublish({ ...input, chapters: perParagraph }), goodCheck)
    expect(check.items[3]).toEqual({ label: 'Chapters match the retention map beats.', ok: true })
    expect(check.pass).toBe(true)
  })

  it('pulls a first beat inside the gap back to 00:00 instead of inserting an open above it', () => {
    expect(normaliseChapters([{ atSec: 8, title: 'I tested every power station' }, { atSec: 40, title: 'The cheap one' }]))
      .toEqual([{ atSec: 0, title: 'I tested every power station' }, { atSec: 40, title: 'The cheap one' }])
  })

  it('ranks payoff moments by explicit strength, then promise words, then lateness', () => {
    const byStrength = pickShortsCuts(promise, [{ atSec: 400, moment: 'the fridge runs on scrap' }, { atSec: 90, moment: 'oops', strength: 1 }, { atSec: 200, moment: 'meh', strength: 0.9 }])
    expect(byStrength.map((s) => s.atSec)).toEqual([90, 200])
    const byLateness = pickShortsCuts(promise, [{ atSec: 10, moment: 'one' }, { atSec: 300, moment: 'two' }, { atSec: 200, moment: 'three' }])
    expect(byLateness.map((s) => s.atSec)).toEqual([200, 300])
  })

  it('falls back to chapters and then the open when the ladder is short, never duplicating a mark', () => {
    const fromChapters = pickShortsCuts(promise, [{ atSec: 400, moment: 'the fridge runs' }], [{ atSec: 0, title: 'Open' }, { atSec: 150, title: 'First test' }, { atSec: 400, title: 'Same mark' }])
    expect(fromChapters.map((s) => s.atSec)).toEqual([150, 400])
    const fromOpen = pickShortsCuts(promise, [{ atSec: 400, moment: 'the fridge runs' }], [])
    expect(fromOpen.map((s) => s.atSec)).toEqual([0, 400])
    expect(fromOpen[0].hook).toContain('A solar generator built from scrap')
    expect(pickShortsCuts(promise, undefined, [])).toHaveLength(1)
    expect(pickShortsCuts(promise, undefined, [])[0].durationSec).toBe(PUBLISH_RULES.shortsDurationSec.value)
  })
})

describe('checkPublish', () => {
  it('passes a complete pack and lists the nine checklist lines in order', () => {
    const check = checkPublish(assemblePublish(input), goodCheck)
    expect(check.pass).toBe(true)
    expect(check.items).toHaveLength(9)
    expect(check.items.every((i) => i.ok && i.detail === undefined)).toBe(true)
    expect(check.items[0].label).toMatch(/^Title final/)
    expect(check.items[1].label).toMatch(/^Thumbnails A and B/)
    expect(check.items[2].label).toMatch(/^Description first line/)
    expect(check.items[3].label).toMatch(/^Chapters/)
    expect(check.items[4].label).toMatch(/^End screen/)
    expect(check.items[5].label).toMatch(/^Pinned comment/)
    expect(check.items[6].label).toMatch(/^Community post/)
    expect(check.items[7].label).toMatch(/^Publish time/)
    expect(check.items[8].label).toMatch(/^The 48-hour review/)
  })

  it('fails the title line on length, promise drift, overlap, or score', () => {
    const short = checkPublish(assemblePublish({ ...input, title: 'Solar Generator' }), goodCheck)
    expect(short.pass).toBe(false)
    expect(short.items[0].ok).toBe(false)
    expect(short.items[0].detail).toContain('15 chars')
    const drift = checkPublish(assemblePublish({ ...input, title: 'What Nobody Tells You About Camping Vans' }), goodCheck)
    expect(drift.items[0].ok).toBe(false)
    expect(drift.items[0].detail).toMatch(/promise/)
    const overlap = checkPublish(assemblePublish(input), { ...goodCheck, overlapOk: false })
    expect(overlap.items[0].detail).toContain('repeats the title')
    const weak = checkPublish(assemblePublish(input), { ...goodCheck, titleScore: 10 })
    expect(weak.items[0].detail).toContain('title score 10')
  })

  it('fails the thumbnail line on a non-ship grade, a missing name, the same concept twice, or a bad file', () => {
    const pack = assemblePublish(input)
    const revise = checkPublish(pack, { ...goodCheck, thumbGrades: ['ship', 'revise'] })
    expect(revise.items[1].ok).toBe(false)
    expect(revise.items[1].detail).toContain('B graded revise')
    expect(checkPublish(assemblePublish({ ...input, thumbs: { a: 'stakes', b: '' } }), goodCheck).items[1].detail).toContain('named')
    expect(checkPublish(assemblePublish({ ...input, thumbs: { a: 'stakes', b: 'Stakes' } }), goodCheck).items[1].detail).toContain('same concept')
    expect(checkPublish(pack, { ...goodCheck, thumbFilesOk: false }).items[1].detail).toContain('thumbnail check')
    expect(checkPublish(pack, { ...goodCheck, thumbFilesOk: true }).items[1].ok).toBe(true)
  })

  it('fails the description line when a link sits in line 1 or the promise drifted', () => {
    const pack = assemblePublish(input)
    const linked = { ...pack, description: `${promise} https://example.com\n\nrest` }
    expect(checkPublish(linked, goodCheck).items[2].detail).toContain('link sits in line 1')
    const drifted = { ...pack, description: 'Something else entirely\n\nrest' }
    expect(checkPublish(drifted, goodCheck).items[2].ok).toBe(false)
  })

  it("fails the chapters line under YouTube's chapter rules", () => {
    const few = checkPublish(assemblePublish({ ...input, chapters: [{ atSec: 0, title: 'Open' }, { atSec: 60, title: 'Mid' }] }), goodCheck)
    expect(few.items[3].ok).toBe(false)
    expect(few.items[3].detail).toContain('2 chapters')
    // A hand-edited publish.json can still put two marks inside the gap; assemblePublish no longer can.
    const tight = { ...assemblePublish(input), chapters: [{ atSec: 0, title: 'Open' }, { atSec: 5, title: 'Fast' }, { atSec: 60, title: 'Mid' }] }
    expect(checkPublish(tight, goodCheck).items[3].detail).toContain('closer than 10 s at 00:05')
    const none = checkPublish(assemblePublish({ ...input, chapters: undefined }), goodCheck)
    expect(none.items[3].ok).toBe(false)
    const notZero = { ...assemblePublish(input), chapters: [{ atSec: 5, title: 'A' }, { atSec: 60, title: 'B' }, { atSec: 120, title: 'C' }] }
    expect(checkPublish(notZero, goodCheck).items[3].detail).toContain('00:00')
  })

  it('fails the end screen, pinned comment, and Shorts lines when they are placeholders or thin', () => {
    const noRelated = checkPublish(assemblePublish({ ...input, relatedVideo: undefined }), goodCheck)
    expect(noRelated.items[4].ok).toBe(false)
    expect(noRelated.items[4].detail).toContain('--related')
    const pack = assemblePublish(input)
    expect(checkPublish({ ...pack, pinnedComment: 'Thanks for watching.' }, goodCheck).items[5].ok).toBe(false)
    expect(checkPublish({ ...pack, shortsCuts: pack.shortsCuts.slice(0, 1) }, goodCheck).items[6].detail).toContain('1 Shorts cut')
    expect(checkPublish({ ...pack, shortsCuts: [pack.shortsCuts[0], pack.shortsCuts[0]] }, goodCheck).items[6].detail).toContain('same mark')
    expect(checkPublish({ ...pack, communityPost: ' ' }, goodCheck).items[6].detail).toContain('community post is empty')
  })

  it('needs the publish window confirmed and the review scheduled with baselines', () => {
    const bare = assemblePublish({ ...input, profile: undefined })
    const check = checkPublish(bare, { ...goodCheck, reviewScheduled: undefined })
    expect(check.items[7].ok).toBe(false)
    expect(check.items[7].detail).toContain('publishDay')
    expect(check.items[8].ok).toBe(false)
    expect(check.items[8].detail).toContain('48-hour review')
    expect(check.items[8].detail).toContain('no baselines')
    const confirmed = checkPublish(bare, { ...goodCheck, publishWindowConfirmed: true, reviewScheduled: true, baselineReady: true })
    expect(confirmed.items[7].ok).toBe(true)
    expect(confirmed.items[8].ok).toBe(true)
    expect(confirmed.pass).toBe(true)
    expect(checkPublish(assemblePublish(input), { ...goodCheck, publishWindowConfirmed: false }).items[7].ok).toBe(false)
  })
})

describe('rendering', () => {
  it('renders the pack as copy-paste Markdown blocks', () => {
    const md = renderPublishMarkdown(assemblePublish(input))
    expect(md).toContain(`# Publish: ${title}`)
    expect(md).toContain('## Description\n\n```\n' + promise)
    expect(md).toContain('## Pinned comment')
    expect(md).toContain('1. Cut at 04:10 for 45 s. Hook: The inverter smokes')
    expect(md).toContain('2. Cut at 06:40 for 45 s.')
    expect(md).toContain('Friday, when returning viewers are online')
    expect(md).not.toContain('(default;')
    expect(renderPublishMarkdown(assemblePublish({ ...input, profile: undefined }))).toContain('(default; set publishDay in channel.json)')
    expect(md).toContain('## Test & Compare')
    expect(md).toContain('## End screen\n\nI Powered My Shed With a Car Battery')
  })

  it('renders the checklist with ticks and details', () => {
    const pass = renderPublishCheck(checkPublish(assemblePublish(input), goodCheck))
    expect(pass).toContain('Publish checklist: PASS')
    expect(pass.split('\n').filter((l) => l.startsWith('- [x]'))).toHaveLength(9)
    const fail = renderPublishCheck(checkPublish(assemblePublish({ ...input, relatedVideo: undefined }), goodCheck))
    expect(fail).toContain('Publish checklist: NOT YET')
    expect(fail).toContain('- [ ] End screen')
    expect(fail).toContain('no related video chosen')
  })
})
