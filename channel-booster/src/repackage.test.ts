import { describe, expect, it } from 'vitest'
import { angleDistance, describeRepackage, pickThumbnail, pickTitle, prepareRepackage, type RepackagePackage } from './repackage.js'
import type { DecisionDoc } from './schema.js'

const pkg: RepackagePackage = {
  titles: [
    { title: 'I Built a Solar Generator From Scrap', score: 82 },
    { title: 'Scrap to Solar: 300W for Just $40', score: 78 },
    { title: 'Can Junk Power a House?', score: 71 },
  ],
  thumbnails: [
    { name: 'result-panel', angle: 'result', qa: { grade: 'ship', score: 90 } },
    { name: 'stakes-bill', angle: 'stakes', qa: { grade: 'ship', score: 85 } },
    { name: 'curiosity-box', angle: 'curiosity', qa: { grade: 'ship', score: 82 } },
    { name: 'identity-me', angle: 'identity', qa: { grade: 'revise', score: 70 } },
    { name: 'contrast-split', angle: 'contrast', qa: { grade: 'ship', score: 81 } },
  ],
  chosenTitle: 'I Built a Solar Generator From Scrap',
  abPick: { a: 'result-panel', b: 'stakes-bill' },
}

function decision(kind: DecisionDoc['decision'], numbers: DecisionDoc['numbers'] = {}, flipCondition = 'Flips to HOLD if the window closes.'): Pick<DecisionDoc, 'decision' | 'slug' | 'bucket' | 'numbers' | 'flipCondition'> {
  return { decision: kind, slug: 'solar', bucket: '48', numbers, flipCondition }
}

describe('angleDistance', () => {
  it('measures the gap on the angle line and treats unknown angles as one step', () => {
    expect(angleDistance('result', 'result')).toBe(0)
    expect(angleDistance('result', 'stakes')).toBe(1)
    expect(angleDistance('result', 'identity')).toBe(4)
    expect(angleDistance('stakes', 'curiosity')).toBe(2)
    expect(angleDistance('result', 'meme')).toBe(1)
    expect(angleDistance('meme', 'meme')).toBe(0)
  })
})

describe('pickThumbnail', () => {
  it('picks the ship-graded concept farthest from the angles that already ran', () => {
    // Used: result (0) and stakes (1). curiosity (3) is 2 from stakes; contrast (2) is 1; identity is revise-graded.
    expect(pickThumbnail(pkg)?.name).toBe('curiosity-box')
  })
  it('skips used and non-ship concepts and keeps package order on ties', () => {
    const tie: RepackagePackage = { ...pkg, thumbnails: [
      { name: 'a', angle: 'contrast', qa: { grade: 'ship' } },
      { name: 'b', angle: 'contrast', qa: { grade: 'ship' } },
      { name: 'used', angle: 'result', qa: { grade: 'ship' } },
    ], abPick: { a: 'used', b: 'used' } }
    expect(pickThumbnail(tie)?.name).toBe('a')
    expect(pickThumbnail({ ...pkg, thumbnails: pkg.thumbnails.map((t) => ({ ...t, qa: { grade: 'revise' as const } })) })).toBeUndefined()
    expect(pickThumbnail({ ...pkg, thumbnails: [] })).toBeUndefined()
  })
  it('falls back to the first ship-graded concept when no pair is recorded', () => {
    expect(pickThumbnail({ ...pkg, abPick: undefined })?.name).toBe('result-panel')
  })
  it('prefers an unknown-angle concept only when nothing is farther', () => {
    const odd: RepackagePackage = { ...pkg, thumbnails: [...pkg.thumbnails, { name: 'meme', angle: 'meme', qa: { grade: 'ship' } }] }
    expect(pickThumbnail(odd)?.name).toBe('curiosity-box')
    const onlyOdd: RepackagePackage = { ...pkg, thumbnails: [pkg.thumbnails[0], pkg.thumbnails[1], { name: 'meme', angle: 'meme', qa: { grade: 'ship' } }] }
    expect(pickThumbnail(onlyOdd)?.name).toBe('meme')
  })
})

describe('pickTitle', () => {
  it('returns the next-best title after the live one, comparing case-insensitively', () => {
    expect(pickTitle(pkg)?.title).toBe('Scrap to Solar: 300W for Just $40')
    expect(pickTitle({ ...pkg, chosenTitle: '  scrap to solar: 300w for $40 ' })?.title).toBe('I Built a Solar Generator From Scrap')
    expect(pickTitle({ ...pkg, chosenTitle: undefined })?.title).toBe('Scrap to Solar: 300W for Just $40')
    expect(pickTitle({ ...pkg, titles: [pkg.titles[0]] })).toBeUndefined()
    // A replacement the publish checklist would reject on length is not a replacement.
    const tooShort = { ...pkg, titles: [pkg.titles[0], { title: 'Junk to 300W', score: 99 }] }
    expect(pickTitle(tooShort)).toBeUndefined()
    const tooLong = { ...pkg, titles: [pkg.titles[0], { title: 'I Built a Solar Generator From Scrap Metal for Under $40 and Ran a Fridge', score: 99 }] }
    expect(pickTitle(tooLong)).toBeUndefined()
    expect(pickTitle({ ...pkg, titles: [] })).toBeUndefined()
  })
  it('sorts by score rather than trusting package order', () => {
    const shuffled = { ...pkg, titles: [pkg.titles[2], pkg.titles[0], pkg.titles[1]] }
    expect(pickTitle(shuffled)?.title).toBe('Scrap to Solar: 300W for Just $40')
  })
})

describe('prepareRepackage', () => {
  it('prepares thumbnail first and title second for REPACKAGE, and never applies anything', () => {
    const before = JSON.stringify(pkg)
    const plan = prepareRepackage(pkg, decision('REPACKAGE', { ctrLowMark: 3.75, expectedGainViews: 1650 }, 'Expected gain 1,650 views clears the 500 floor.'))
    expect(JSON.stringify(pkg)).toBe(before)
    expect(plan.thumbnail?.name).toBe('curiosity-box')
    expect(plan.title?.title).toBe('Scrap to Solar: 300W for Just $40')
    expect(plan.instructions[0]).toBe('Thumbnail first: replace result-panel / stakes-bill with "curiosity-box" (curiosity angle, QA ship) in Studio. Do not change the title in the same swap; one lever per swap.')
    expect(plan.instructions[1]).toMatch(/Record the swap on the ledger row \(repackagedAt\)/)
    expect(plan.instructions[2]).toBe('Re-read 48 hours after the swap. Only if CTR is still under 3.75%, run Test & Compare on the title: current vs "Scrap to Solar: 300W for Just $40" (score 78). Never inside 7d [house] of the thumbnail swap.')
    expect(plan.instructions[3]).toBe('Expected gain on record: about 1,650 views (Expected gain 1,650 views clears the 500 floor.).')
    expect(plan.instructions[4]).toMatch(/This plan prepares only; a person applies the swap in Studio and approves decision solar:48/)
    expect(plan.instructions.join('\n')).not.toMatch(/has been applied|swapped automatically/)
  })

  it('says what to do when no concept or title is left', () => {
    const bare: RepackagePackage = { titles: [pkg.titles[0]], thumbnails: [pkg.thumbnails[0]], chosenTitle: pkg.titles[0].title, abPick: { a: 'result-panel', b: 'result-panel' } }
    const plan = prepareRepackage(bare, decision('REPACKAGE'))
    expect(plan.thumbnail).toBeUndefined()
    expect(plan.title).toBeUndefined()
    expect(plan.instructions[0]).toMatch(/No unused ship-graded concept is left/)
    expect(plan.instructions[2]).toMatch(/No alternative title is left/)
    expect(plan.instructions.some((i) => /Expected gain on record/.test(i))).toBe(false)
  })

  it('prepares only a title for RE-TEST-TITLE', () => {
    const plan = prepareRepackage(pkg, decision('RE-TEST-TITLE', { ctrHealthyMark: 4.5 }))
    expect(plan.thumbnail).toBeUndefined()
    expect(plan.title?.title).toBe('Scrap to Solar: 300W for Just $40')
    expect(plan.instructions[0]).toBe('Keep the thumbnail. Run Test & Compare on the title: current "I Built a Solar Generator From Scrap" vs "Scrap to Solar: 300W for Just $40" (score 78).')
    expect(plan.instructions[1]).toMatch(/watch-time share, not CTR/)
    expect(prepareRepackage({ ...pkg, titles: [] }, decision('RE-TEST-TITLE')).instructions[0]).toMatch(/No alternative title is left/)
  })

  it('prepares nothing for every other decision and repeats the flip condition', () => {
    for (const kind of ['HOLD', 'WAIT', 'SEQUEL', 'EXPAND', 'PARK'] as const) {
      const plan = prepareRepackage(pkg, decision(kind, {}, `flip for ${kind}`))
      expect(plan.thumbnail).toBeUndefined()
      expect(plan.title).toBeUndefined()
      expect(plan.instructions).toEqual([`Decision ${kind} for solar at 48 h calls for no packaging change; nothing prepared.`, `flip for ${kind}`])
    }
  })

  it('prints the plan', () => {
    const text = describeRepackage(prepareRepackage(pkg, decision('REPACKAGE')))
    expect(text.split('\n').slice(0, 3)).toEqual([
      'Thumbnail: curiosity-box (curiosity)',
      'Title: Scrap to Solar: 300W for Just $40 (score 78)',
      'One swap per 7 days [house]; thumbnail before title.',
    ])
    expect(text).toMatch(/\n1\. Thumbnail first/)
    expect(describeRepackage(prepareRepackage(pkg, decision('HOLD')))).toMatch(/^Thumbnail: none\nTitle: none/)
  })
})
