import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEMAND_DECAY_DAYS, LIFECYCLE, SEQUEL_HUMAN_AXIS_SCORE, addIdea, attachVerdict, canTransition, ideaId, ideaTopicKey, importIdeas,
  listIdeas, rescore, sequelCandidates, setStatus, weakestAxis, wipWarnings,
} from './bank.js'
import { addRow, readLedger, recordRead } from './ledger.js'
import { stableId } from './schema.js'
import { openStore, type Store } from './store.js'
import { resetThresholds, thresholds } from './thresholds.js'
import { topicKey } from './topics.js'
import type { IdeaScore } from './types.js'

let root: string
let store: Store
const now = new Date('2026-09-14T12:00:00Z')
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'booster-')); store = openStore(root); resetThresholds() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** ISO date `days` days before `now`. */
function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

/** `days` days before `now`, as a Date (for `now:` inputs). */
function dateAgo(days: number): Date {
  return new Date(now.getTime() - days * 86_400_000)
}

/** `days` days after `now`, as a Date. */
function daysLater(days: number): Date {
  return new Date(now.getTime() + days * 86_400_000)
}

const mid: IdeaScore = { demand: 3, packaging: 3, fit: 3, angle: 3, payoff: 3, feasibility: 3 }
const strong: IdeaScore = { demand: 5, packaging: 5, fit: 4, angle: 4, payoff: 4, feasibility: 4 }

describe('addIdea', () => {
  it('banks an idea with a deterministic id, the miner topic key, and the weakest axis', () => {
    const doc = addIdea(store, { idea: '  Cold showers ', scores: { ...mid, packaging: 2, angle: 2 }, now })
    expect(doc.id).toBe(stableId('idea', 'cold showers'))
    expect(doc.id).toBe(ideaId('Cold showers'))
    expect(doc.idea).toBe('Cold showers')
    expect(doc.topicKey).toBe('cold+showers')
    expect(doc.topicKey).toBe(topicKey('I Took Cold Showers for 30 Days'))
    expect(doc.status).toBe('banked')
    expect(doc.weakestAxis).toBe('packaging') // ties go to the heavier axis
    expect(doc.sources).toEqual([])
    expect(doc.createdAt).toBe(now.toISOString())
    expect(doc.updatedAt).toBe(now.toISOString())
    expect(doc.source).toBe('cli')
    expect(store.read('ideas')).toHaveLength(1)
  })

  it('adding the same text twice updates the row: scores replaced, sources appended without duplicates, status and createdAt kept', () => {
    addIdea(store, { idea: 'Cold showers', scores: mid, sources: [{ title: 'Cold Showers Ruined My Skin', multiplier: 8, channel: 'A' }], now })
    setStatus(store, ideaId('Cold showers'), 'green', { now })
    const later = daysLater(1)
    const doc = addIdea(store, {
      idea: 'cold showers',
      scores: strong,
      sources: [{ title: 'cold showers ruined my skin', multiplier: 8, channel: 'a' }, { title: 'I Took Cold Showers for 30 Days', multiplier: 12, channel: 'B' }],
      series: 'Habit tests',
      promise: 'You will know in 30 days whether it is worth it',
      source: 'agent:test',
      now: later,
    })
    expect(store.read('ideas')).toHaveLength(1)
    expect(doc.idea).toBe('Cold showers')
    expect(doc.status).toBe('green')
    expect(doc.scores).toEqual(strong)
    expect(doc.sources.map((s) => s.title)).toEqual(['Cold Showers Ruined My Skin', 'I Took Cold Showers for 30 Days'])
    expect(doc.series).toBe('Habit tests')
    expect(doc.promise).toMatch(/30 days/)
    expect(doc.createdAt).toBe(now.toISOString())
    expect(doc.updatedAt).toBe(later.toISOString())
    expect(doc.source).toBe('agent:test')
  })

  it('refuses empty text, out-of-range scores, and the unresolved demand=auto sentinel', () => {
    expect(() => addIdea(store, { idea: '   ', scores: mid, now })).toThrow(/needs text/)
    expect(() => addIdea(store, { idea: 'x', scores: { ...mid, fit: 6 }, now })).toThrow(/0-5/)
    expect(() => addIdea(store, { idea: 'x', scores: { ...mid, demand: -1 }, now })).toThrow(/suggestDemand/)
    expect(store.read('ideas')).toEqual([])
  })

  it('strips the Sequel label from the topic key', () => {
    expect(ideaTopicKey('Sequel: I Took Cold Showers for 30 Days')).toBe('cold+showers')
    expect(ideaTopicKey('I Tried Van Life for 30 Days')).toBe('life+van')
  })
})

describe('weakestAxis and attachVerdict', () => {
  it('names the lowest axis, heavier axis first on ties, and attaches the verdict', () => {
    expect(weakestAxis({ ...mid, feasibility: 1 })).toBe('feasibility')
    expect(weakestAxis({ ...mid, fit: 2, payoff: 2 })).toBe('fit')
    expect(weakestAxis(mid)).toBe('demand')
    const row = attachVerdict(addIdea(store, { idea: 'Cold showers', scores: strong, now }))
    expect(row.verdict.verdict).toBe('green')
    expect(row.total).toBe(row.verdict.total)
    expect(row.total).toBeGreaterThanOrEqual(85)
    expect(row.weakestAxis).toBe('fit')
  })
})

describe('listIdeas', () => {
  beforeEach(() => {
    addIdea(store, { idea: 'Cold showers', scores: strong, now })
    addIdea(store, { idea: 'Sourdough starter', scores: mid, now: daysLater(1) })
    addIdea(store, { idea: 'Van life', scores: { ...mid, demand: 5 }, now: daysLater(2) })
    addIdea(store, { idea: 'Old and gone', scores: mid, now })
    setStatus(store, ideaId('Old and gone'), 'retired', { now, reason: 'a clone' })
  })

  it('sorts by total by default and hides retired ideas unless asked for', () => {
    const rows = listIdeas(store)
    expect(rows.map((r) => r.idea)).toEqual(['Cold showers', 'Van life', 'Sourdough starter'])
    expect(rows[0].verdict.verdict).toBe('green')
    expect(rows[0].weakestAxis).toBe('fit')
    expect(rows[2].weakestAxis).toBe('demand')
    expect(listIdeas(store, { status: 'retired' }).map((r) => r.idea)).toEqual(['Old and gone'])
    expect(listIdeas(store, { status: ['banked', 'retired'] })).toHaveLength(4)
    expect(listIdeas(store, { status: 'green' })).toEqual([])
  })

  it('supports the other sort keys', () => {
    expect(listIdeas(store, { sortBy: 'demand' }).map((r) => r.idea)).toEqual(['Cold showers', 'Van life', 'Sourdough starter'])
    expect(listIdeas(store, { sortBy: 'updatedAt' }).map((r) => r.idea)).toEqual(['Van life', 'Sourdough starter', 'Cold showers'])
    expect(listIdeas(store, { sortBy: 'createdAt' }).map((r) => r.idea)).toEqual(['Van life', 'Sourdough starter', 'Cold showers'])
    expect(listIdeas(store, { sortBy: 'idea' }).map((r) => r.idea)).toEqual(['Cold showers', 'Sourdough starter', 'Van life'])
  })

  it('pins sequel candidates to the front of the queue unless sequelFirst is off', () => {
    addIdea(store, { idea: 'Sequel: Cheap Camper Build', scores: { ...mid, demand: 5 }, sequelOf: 'cheap-camper', now })
    expect(listIdeas(store)[0].idea).toBe('Sequel: Cheap Camper Build')
    expect(listIdeas(store, { sequelFirst: false })[0].idea).toBe('Cold showers')
    // A sequel already in packaging is no longer "at the front of the queue".
    setStatus(store, ideaId('Sequel: Cheap Camper Build'), 'green', { now })
    setStatus(store, ideaId('Sequel: Cheap Camper Build'), 'packaging', { now })
    expect(listIdeas(store)[0].idea).toBe('Cold showers')
  })
})

describe('setStatus and the lifecycle', () => {
  it('walks the happy path and refuses skips, backwards moves, and the same status twice', () => {
    const id = addIdea(store, { idea: 'Cold showers', scores: strong, now }).id
    expect(() => setStatus(store, id, 'packaging', { now })).toThrow(/from banked to packaging.*allowed: green, parked, retired/)
    expect(() => setStatus(store, id, 'banked', { now })).toThrow(/already banked/)
    for (const [status, at] of [['green', 1], ['packaging', 2], ['production', 3], ['published', 4]] as const) {
      const doc = setStatus(store, id, status, { now: daysLater(at) })
      expect(doc.status).toBe(status)
      expect(doc.updatedAt).toBe(daysLater(at).toISOString())
    }
    expect(() => setStatus(store, id, 'banked', { now })).toThrow(/from published to banked/)
    expect(() => setStatus(store, id, 'parked', { now })).toThrow(/from published to parked/)
    expect(setStatus(store, id, 'retired', { now, reason: 'done' }).status).toBe('retired')
    expect(() => setStatus(store, id, 'banked', { now })).toThrow(/retired is final/)
    expect(() => setStatus(store, 'idea:nope', 'green', { now })).toThrow(/no idea with id/)
  })

  it('parks only from banked or green, keeps the reason, and clears it on reopen', () => {
    const id = addIdea(store, { idea: 'Cold showers', scores: mid, now }).id
    const parked = setStatus(store, id, 'parked', { now, reason: 'no packaging yet', source: 'desk' })
    expect(parked.parkedReason).toBe('no packaging yet')
    expect(parked.source).toBe('desk')
    const reopened = setStatus(store, id, 'banked', { now })
    expect(reopened.parkedReason).toBeUndefined()
    setStatus(store, id, 'green', { now })
    expect(setStatus(store, id, 'parked', { now }).status).toBe('parked')
    setStatus(store, id, 'banked', { now })
    setStatus(store, id, 'green', { now })
    setStatus(store, id, 'packaging', { now })
    expect(() => setStatus(store, id, 'parked', { now })).toThrow(/from packaging to parked/)
    const retired = setStatus(store, id, 'retired', { now, reason: 'a clone of the outlier' })
    expect(retired.parkedReason).toBe('a clone of the outlier')
  })

  it('exposes the transition table', () => {
    expect(canTransition('banked', 'green')).toBe(true)
    expect(canTransition('green', 'production')).toBe(false)
    expect(canTransition('retired', 'banked')).toBe(false)
    expect(LIFECYCLE.retired).toEqual([])
    expect(Object.keys(LIFECYCLE).sort()).toEqual(['banked', 'green', 'packaging', 'parked', 'production', 'published', 'retired'])
  })
})

describe('rescore', () => {
  const scan = [
    { title: 'I Tried Van Life for 30 Days', multiplier: 12, channel: 'A', published: daysAgo(20) },
    { title: 'Van Life: The Truth', multiplier: 11, channel: 'B', published: daysAgo(40), url: 'https://example.test/truth' },
    { title: 'Why I Almost Quit Van Life', multiplier: 10, channel: 'C', published: daysAgo(80) },
    { title: 'Van Life Costs, Honestly', multiplier: 15, channel: 'A', published: daysAgo(200) },
    { title: 'Solar Setup Explained', multiplier: 0.8, channel: 'B', published: daysAgo(10) },
  ]

  it('appends matching in-window sources by topic key, raises demand to what they prove, and reports', () => {
    addIdea(store, { idea: 'Van life', scores: { ...mid, demand: 1 }, now: dateAgo(3) })
    addIdea(store, { idea: 'Sourdough starter', scores: mid, now: dateAgo(3) })
    const report = rescore(store, scan, { now })
    expect(report.scanned).toBe(5)
    expect(report.inWindow).toBe(4)
    expect(report.windowDays).toBe(90)
    expect(report.matched).toHaveLength(1)
    expect(report.matched[0]).toMatchObject({ idea: 'Van life', topicKey: 'life+van', demand: { before: 1, after: 5 } })
    expect(report.matched[0].added.map((s) => s.title)).toEqual(['I Tried Van Life for 30 Days', 'Van Life: The Truth', 'Why I Almost Quit Van Life'])
    expect(report.matched[0].added[1]).toEqual({ title: 'Van Life: The Truth', multiplier: 11, channel: 'B', date: daysAgo(40), url: 'https://example.test/truth' })
    expect(report.matched[0].reason).toMatch(/3 matches at >= 10x/)
    expect(report.reopened).toEqual([])
    expect(report.decayed).toEqual([])
    expect(report.unchanged).toBe(1)
    const van = store.get('ideas', ideaId('Van life'))!
    expect(van.scores.demand).toBe(5)
    expect(van.weakestAxis).toBe('packaging')
    expect(van.sources).toHaveLength(3)
    expect(van.updatedAt).toBe(now.toISOString())
    expect(store.get('ideas', ideaId('Sourdough starter'))!.updatedAt).toBe(daysAgo(3))
  })

  it('is idempotent and never lowers a typed demand', () => {
    addIdea(store, { idea: 'Van life', scores: { ...mid, demand: 5 }, now: dateAgo(3) })
    const first = rescore(store, scan.slice(0, 1), { now })
    expect(first.matched[0].demand).toEqual({ before: 5, after: 5 })
    const second = rescore(store, scan.slice(0, 1), { now })
    expect(second.matched).toEqual([])
    expect(second.unchanged).toBe(1)
    expect(store.get('ideas', ideaId('Van life'))!.sources).toHaveLength(1)
  })

  it('reopens a parked idea on a fresh >= 5x match, with a note, but not on a weak one', () => {
    const id = addIdea(store, { idea: 'Van life', scores: mid, now: dateAgo(3) }).id
    setStatus(store, id, 'parked', { now: dateAgo(2), reason: 'crowded' })
    const weak = rescore(store, [{ title: 'My Van Life', multiplier: 2, channel: 'D', published: daysAgo(1) }], { now })
    expect(weak.matched).toHaveLength(1)
    expect(weak.reopened).toEqual([])
    expect(store.get('ideas', id)!.status).toBe('parked')
    const fresh = rescore(store, scan, { now })
    expect(fresh.reopened).toHaveLength(1)
    expect(fresh.reopened[0]).toMatchObject({ id, idea: 'Van life' })
    expect(fresh.reopened[0].note).toMatch(/"I Tried Van Life for 30 Days" \(A\) at 12\.0x is a fresh >= 5x match on life\+van/)
    const doc = store.get('ideas', id)!
    expect(doc.status).toBe('banked')
    expect(doc.parkedReason).toBeUndefined()
    expect(doc.scores.demand).toBe(5)
  })

  it('ignores stale rows and the demandMatchMultiplier override', () => {
    const id = addIdea(store, { idea: 'Van life', scores: mid, now: dateAgo(3) }).id
    setStatus(store, id, 'parked', { now: dateAgo(2) })
    const stale = rescore(store, [scan[3]], { now })
    expect(stale.inWindow).toBe(0)
    expect(stale.matched).toEqual([])
    expect(store.get('ideas', id)!.status).toBe('parked')
    thresholds.demandMatchMultiplier.value = 20
    const r = rescore(store, scan, { now })
    expect(r.matched).toHaveLength(1)
    expect(r.reopened).toEqual([])
    expect(store.get('ideas', id)!.status).toBe('parked')
  })

  it('decays demand by one after 180 days without evidence, floors at 0, and resets the clock', () => {
    addIdea(store, { idea: 'Sourdough starter', scores: { ...mid, demand: 2 }, now: dateAgo(DEMAND_DECAY_DAYS + 1) })
    addIdea(store, { idea: 'Cold showers', scores: { ...mid, demand: 3 }, now: dateAgo(DEMAND_DECAY_DAYS - 10) })
    const first = rescore(store, [], { now })
    expect(first.decayed).toEqual([{ id: ideaId('Sourdough starter'), idea: 'Sourdough starter', from: 2, to: 1 }])
    expect(first.unchanged).toBe(1)
    const sour = store.get('ideas', ideaId('Sourdough starter'))!
    expect(sour.scores.demand).toBe(1)
    expect(sour.updatedAt).toBe(now.toISOString())
    // Next Monday: nothing decays again, the clock restarted at `now`.
    expect(rescore(store, [], { now: daysLater(7) }).decayed).toEqual([])
    // Half a year later both decay; a third pass floors the first at 0 and stops.
    const later = daysLater(DEMAND_DECAY_DAYS)
    expect(rescore(store, [], { now: later }).decayed.map((d) => [d.idea, d.to])).toEqual([[ 'Cold showers', 2 ], [ 'Sourdough starter', 0 ]])
    const final = rescore(store, [], { now: new Date(later.getTime() + DEMAND_DECAY_DAYS * 86_400_000) })
    expect(final.decayed).toEqual([{ id: ideaId('Cold showers'), idea: 'Cold showers', from: 2, to: 1 }])
    expect(store.get('ideas', ideaId('Sourdough starter'))!.scores.demand).toBe(0)
  })

  it('counts a recent source date as evidence, and leaves published, retired, packaging and production ideas alone', () => {
    addIdea(store, { idea: 'Van life', scores: mid, sources: [{ title: 'Van Life: The Truth', multiplier: 11, channel: 'B', date: daysAgo(10) }], now: dateAgo(400) })
    const untouched = ['packaging', 'production', 'published', 'retired'] as const
    for (const status of untouched) {
      const id = addIdea(store, { idea: `Idea ${status}`, scores: mid, now: dateAgo(400) }).id
      const path: Record<typeof status, readonly string[]> = { packaging: ['green', 'packaging'], production: ['green', 'packaging', 'production'], published: ['green', 'packaging', 'production', 'published'], retired: ['retired'] }
      for (const s of path[status]) setStatus(store, id, s as typeof status | 'green', { now: dateAgo(400) })
    }
    const report = rescore(store, [{ title: 'Idea published', multiplier: 30, channel: 'Z', published: daysAgo(1) }], { now, decayDays: 30 })
    expect(report.decayed).toEqual([])
    expect(report.matched).toEqual([])
    for (const status of untouched) {
      const doc = store.get('ideas', ideaId(`Idea ${status}`))!
      expect(doc.scores.demand).toBe(3)
      expect(doc.sources).toEqual([])
    }
    expect(store.get('ideas', ideaId('Van life'))!.scores.demand).toBe(3)
    expect(report.decayDays).toBe(30)
  })

  it('accepts a custom window and tags the writer', () => {
    addIdea(store, { idea: 'Van life', scores: mid, now: dateAgo(3) })
    const r = rescore(store, scan, { now, windowDays: 30, source: 'agent:radar' })
    expect(r.inWindow).toBe(2)
    expect(r.matched[0].added.map((s) => s.title)).toEqual(['I Tried Van Life for 30 Days'])
    expect(r.matched[0].demand.after).toBe(3)
    expect(store.get('ideas', ideaId('Van life'))!.source).toBe('agent:radar')
  })
})

describe('sequelCandidates', () => {
  function seedLedger(): void {
    for (let i = 0; i < 6; i += 1) {
      const publishedAt = daysAgo((i + 2) * 7)
      addRow(store, { slug: `v${i}`, title: i === 3 ? 'I Built a Cheap Camper' : `Video ${i}`, publishedAt, now })
      recordRead(store, { slug: `v${i}`, bucket: '168', read: { views: i === 3 ? 60_000 : 5_000 + i * 100 }, lever: 'l', now })
    }
  }

  it('banks a demand-5 sequel for every own winner once, at the front of the queue', () => {
    seedLedger()
    const created = sequelCandidates(store, readLedger(store), { now })
    expect(created).toHaveLength(1)
    const s = created[0]
    expect(s.idea).toBe('Sequel: I Built a Cheap Camper')
    expect(s.id).toBe(stableId('idea', 'Sequel: I Built a Cheap Camper'))
    expect(s.sequelOf).toBe('v3')
    expect(s.status).toBe('banked')
    expect(s.topicKey).toBe(topicKey('I Built a Cheap Camper'))
    expect(s.scores).toEqual({ demand: 5, packaging: SEQUEL_HUMAN_AXIS_SCORE, fit: SEQUEL_HUMAN_AXIS_SCORE, angle: SEQUEL_HUMAN_AXIS_SCORE, payoff: SEQUEL_HUMAN_AXIS_SCORE, feasibility: SEQUEL_HUMAN_AXIS_SCORE })
    expect(s.sources).toHaveLength(1)
    expect(s.sources[0]).toMatchObject({ title: 'I Built a Cheap Camper', channel: 'own', date: daysAgo(35) })
    expect(s.sources[0].multiplier).toBeGreaterThan(5)
    expect(attachVerdict(s).verdict.verdict).toBe('yellow') // a person still scores the five human axes
    addIdea(store, { idea: 'Cold showers', scores: strong, now })
    expect(listIdeas(store)[0].idea).toBe('Sequel: I Built a Cheap Camper')
    expect(sequelCandidates(store, readLedger(store), { now })).toEqual([])
    expect(store.read('ideas')).toHaveLength(2)
  })

  it('treats a sequel already in the ledger, or a retired sequel idea, as covered', () => {
    seedLedger()
    addRow(store, { slug: 'v3-sequel', title: 'I Built an Even Cheaper Camper', publishedAt: daysAgo(3), sequelOf: 'v3', now })
    expect(sequelCandidates(store, readLedger(store), { now })).toEqual([])
    store.remove('ledger', 'v3-sequel')
    const [s] = sequelCandidates(store, readLedger(store), { now })
    setStatus(store, s.id, 'retired', { now, reason: 'shot it already' })
    expect(sequelCandidates(store, readLedger(store), { now })).toEqual([])
  })

  it('returns nothing without a ledger, without winners, and honours a custom multiplier', () => {
    expect(sequelCandidates(store, [], { now })).toEqual([])
    seedLedger()
    expect(sequelCandidates(store, readLedger(store), { now, multiplier: 100 })).toEqual([])
    expect(sequelCandidates(store, readLedger(store), { now, multiplier: 1.03 }).map((s) => s.sequelOf)).toEqual(['v3', 'v5'])
  })
})

describe('wipWarnings', () => {
  function advance(idea: string, to: 'packaging' | 'production'): void {
    const id = addIdea(store, { idea, scores: mid, now }).id
    setStatus(store, id, 'green', { now })
    setStatus(store, id, 'packaging', { now })
    if (to === 'production') setStatus(store, id, 'production', { now })
  }

  it('warns only above the caps and carries the evidence tag', () => {
    expect(wipWarnings(store)).toEqual([])
    advance('P1', 'packaging'); advance('P2', 'packaging'); advance('P3', 'packaging')
    advance('Q1', 'production'); advance('Q2', 'production')
    expect(wipWarnings(store)).toEqual([])
    advance('P4', 'packaging')
    advance('Q3', 'production')
    const warnings = wipWarnings(store)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toEqual({ stage: 'packaging', count: 4, cap: 3, evidence: 'house', message: '4 ideas in packaging, cap 3 [house]: finish one before starting another' })
    expect(warnings[1]).toMatchObject({ stage: 'production', count: 3, cap: 2, evidence: 'house' })
  })

  it('reads overridden caps', () => {
    thresholds.wipPackaging.value = 0
    advance('P1', 'packaging')
    expect(wipWarnings(store)).toEqual([{ stage: 'packaging', count: 1, cap: 0, evidence: 'house', message: '1 ideas in packaging, cap 0 [house]: finish one before starting another' }])
  })
})

describe('importIdeas', () => {
  const engineOutput = {
    channel_read: 'Makers who want cheap builds.',
    ideas: [
      { idea: 'Cheap camper build', working_title: 'I Built a Camper for $500', thumbnail_concept: 'van, price tag', demand_evidence: 'Three camper builds at 10x on channel A', angle: 'budget cap', scores: strong, verdict: { total: 90, verdict: 'green', fixes: [] } },
      { idea: 'Van life', working_title: 'Van Life, Honestly', thumbnail_concept: 'face, van', demand_evidence: 'Van life outliers on A and B', angle: 'first-person', scores: mid },
      { idea: 'Broken', working_title: 'x', thumbnail_concept: 'x', demand_evidence: 'x', angle: 'x', scores: { ...mid, demand: 9 } },
    ],
  }

  it('imports the ai idea-engine shape, keeps the evidence as a source, and reports the fields the schema lacks', () => {
    const report = importIdeas(store, engineOutput, { now })
    expect(report.imported).toHaveLength(2)
    expect(report.imported[0]).toEqual({ id: ideaId('Cheap camper build'), idea: 'Cheap camper build', status: 'banked', outcome: 'added', workingTitle: 'I Built a Camper for $500', thumbnailConcept: 'van, price tag', angle: 'budget cap' })
    expect(report.skipped).toEqual([{ index: 2, reason: expect.stringMatching(/0-5/) }])
    const doc = store.get('ideas', ideaId('Cheap camper build'))!
    expect(doc.scores).toEqual(strong)
    expect(doc.sources).toEqual([{ title: 'Three camper builds at 10x on channel A', channel: 'idea-engine' }])
    expect(doc.source).toBe('agent:idea-engine')
    expect(doc.topicKey).toBe(topicKey('Cheap camper build'))
    expect(store.read('ideas')).toHaveLength(2)
  })

  it('accepts a JSON string, tags the source, and updates existing rows without touching their status', () => {
    const id = addIdea(store, { idea: 'Van life', scores: { ...mid, demand: 1 }, now: dateAgo(3) }).id
    setStatus(store, id, 'green', { now: dateAgo(2) })
    const report = importIdeas(store, JSON.stringify(engineOutput), { now, source: 'agent:grok' })
    const van = report.imported.find((i) => i.id === id)!
    expect(van.outcome).toBe('updated')
    expect(van.status).toBe('green')
    const doc = store.get('ideas', id)!
    expect(doc.status).toBe('green')
    expect(doc.scores).toEqual(mid)
    expect(doc.createdAt).toBe(daysAgo(3))
    expect(doc.updatedAt).toBe(now.toISOString())
    expect(doc.source).toBe('agent:grok')
    expect(importIdeas(store, engineOutput, { now }).imported.every((i) => i.outcome === 'updated')).toBe(true)
  })

  it('imports a plain array of IdeaDoc rows, filling ids and timestamps, and {ideas: IdeaDoc[]}', () => {
    const full = { id: 'idea:custom', idea: 'Cold showers', topicKey: 'stale+key', sources: [{ title: 'Cold Showers Ruined My Skin', multiplier: 8 }], scores: mid, status: 'parked', parkedReason: 'later', createdAt: daysAgo(30), updatedAt: daysAgo(30), source: 'desk' }
    const bare = { idea: 'Sourdough starter', scores: strong }
    const report = importIdeas(store, [full, bare, 'junk', { idea: '', scores: mid }, { idea: 'Bad', scores: mid, status: 'nonsense' }], { now })
    expect(report.imported.map((i) => [i.id, i.status, i.outcome])).toEqual([['idea:custom', 'parked', 'added'], [ideaId('Sourdough starter'), 'banked', 'added']])
    expect(report.skipped.map((s) => s.index)).toEqual([2, 3, 4])
    expect(report.skipped[0].reason).toBe('not an object')
    expect(report.skipped[1].reason).toMatch(/missing idea text/)
    const cold = store.get('ideas', 'idea:custom')!
    expect(cold.topicKey).toBe('cold+showers') // recomputed, never trusted from the file
    expect(cold.parkedReason).toBe('later')
    expect(cold.createdAt).toBe(daysAgo(30))
    expect(cold.updatedAt).toBe(now.toISOString())
    expect(cold.source).toBe('desk')
    const sour = store.get('ideas', ideaId('Sourdough starter'))!
    expect(sour.createdAt).toBe(now.toISOString())
    expect(sour.weakestAxis).toBe('fit')
    // Re-importing the parked row after it moved on keeps the live status and merges sources.
    setStatus(store, 'idea:custom', 'banked', { now })
    const again = importIdeas(store, { ideas: [{ ...full, sources: [{ title: 'cold showers ruined my skin', multiplier: 8 }, { title: 'New one', multiplier: 6, channel: 'C' }] }] }, { now })
    expect(again.imported[0].outcome).toBe('updated')
    expect(store.get('ideas', 'idea:custom')!.status).toBe('banked')
    expect(store.get('ideas', 'idea:custom')!.sources.map((s) => s.title)).toEqual(['Cold Showers Ruined My Skin', 'New one'])
  })

  it('rejects shapes that are neither an array nor {ideas: [...]}', () => {
    expect(() => importIdeas(store, { channel_read: 'x' }, { now })).toThrow(/expected \{ideas/)
    expect(() => importIdeas(store, 42, { now })).toThrow(/expected \{ideas/)
    expect(importIdeas(store, [], { now })).toEqual({ imported: [], skipped: [] })
    expect(importIdeas(store, { ideas: [] }, { now })).toEqual({ imported: [], skipped: [] })
  })
})
