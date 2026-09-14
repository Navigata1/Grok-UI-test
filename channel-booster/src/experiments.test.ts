import { describe, expect, it } from 'vitest'
import { ExperimentDoc } from './schema.js'
import { decisiveMetric, judgeTest, renderJudgement, TEST_RULES, toExperimentDoc, winnerLetter, type TestVariant } from './experiments.js'

const now = new Date('2026-09-14T12:00:00Z')

const A = (extra: Partial<TestVariant> = {}): TestVariant => ({ name: 'A', impressions: 5_000, ctr: 6, watchTimeSharePct: 56, avdSec: 300, ...extra })
const B = (extra: Partial<TestVariant> = {}): TestVariant => ({ name: 'B', impressions: 5_000, ctr: 4.5, watchTimeSharePct: 44, avdSec: 260, ...extra })

describe('judgeTest: data floors', () => {
  it('refuses fewer than two variants or duplicate names', () => {
    expect(() => judgeTest([A()], { hoursRunning: 100 })).toThrow(/two variants/)
    expect(() => judgeTest([A(), A()], { hoursRunning: 100 })).toThrow(/distinct/)
  })

  it('is too early under the impression floor and routes to wait', () => {
    const j = judgeTest([A({ impressions: 900 }), B()], { hoursRunning: 100 })
    expect(j.outcome).toBe('too-early')
    expect(j.route).toBe('wait')
    expect(j.winner).toBeUndefined()
    expect(j.reason).toContain('A has 900 impressions')
    expect(j.reason).toContain('1000')
    expect(j.thresholdsUsed).toContain('minImpressions 1000 [house]')
  })

  it('is too early under the hour floor', () => {
    const j = judgeTest([A(), B()], { hoursRunning: 71.9 })
    expect(j.outcome).toBe('too-early')
    expect(j.reason).toContain('72 h')
    expect(judgeTest([A(), B()], { hoursRunning: 72 }).outcome).not.toBe('too-early')
  })

  it('uses 2,000 impressions and 7 days in cold start, and explicit floors win over both', () => {
    const cold = judgeTest([A({ impressions: 1_500 }), B({ impressions: 1_500 })], { hoursRunning: 100, coldStart: true })
    expect(cold.outcome).toBe('too-early')
    expect(cold.reason).toContain('2000')
    expect(cold.reason).toContain('cold start')
    const coldHours = judgeTest([A(), B()], { hoursRunning: 100, coldStart: true })
    expect(coldHours.outcome).toBe('too-early')
    expect(coldHours.reason).toContain('168 h')
    expect(coldHours.thresholdsUsed).toContain('coldStartMinHours 168 h [house]')
    const explicit = judgeTest([A({ impressions: 1_500 }), B({ impressions: 1_500 })], { hoursRunning: 100, coldStart: true, minImpressions: 500, minHours: 48 })
    expect(explicit.outcome).toBe('clear-winner')
  })
})

describe('judgeTest: verdicts', () => {
  it('crowns a clear winner by watch-time share and routes to ship', () => {
    const j = judgeTest([A(), B()], { hoursRunning: 96 })
    expect(j.outcome).toBe('clear-winner')
    expect(j.winner).toBe('A')
    expect(j.ctrLeader).toBe('A')
    expect(j.metric).toBe('watchTimeShare')
    expect(j.route).toBe('ship')
    expect(j.reason).toContain('56%')
    expect(j.hoursRunning).toBe(96)
  })

  it('decides by watch-time share even when CTR points the other way, and calls a 10% share loss an over-promise routed to the hook', () => {
    // B wins CTR but its share is 44 vs 56: 21% lower. R12.
    const j = judgeTest([A({ ctr: 4 }), B({ ctr: 7 })], { hoursRunning: 96 })
    expect(j.outcome).toBe('over-promise')
    expect(j.winner).toBe('A')
    expect(j.ctrLeader).toBe('B')
    expect(j.route).toBe('hook')
    expect(j.reason).toContain('B won CTR')
    expect(j.reason).toContain('watch-time share 44% vs 56%')
    expect(j.reason).toContain('fix the hook')
  })

  it('does not call an over-promise when the CTR leader loses share by under the margin', () => {
    // A leads CTR, B leads share 52 vs 48: 7.7% relative drop, under 10; 4 points apart, above the 3-point band.
    const j = judgeTest([A({ ctr: 6, watchTimeSharePct: 48, avdSec: 290 }), B({ ctr: 5, watchTimeSharePct: 52, avdSec: 300 })], { hoursRunning: 96 })
    expect(j.outcome).toBe('clear-winner')
    expect(j.winner).toBe('B')
    expect(j.ctrLeader).toBe('A')
  })

  it('catches an over-promise on AVD alone when the share loss is small', () => {
    // Shares 48 vs 52 (7.7% lower) but AVD 240 vs 300 (20% lower).
    const j = judgeTest([A({ ctr: 7, watchTimeSharePct: 48, avdSec: 240 }), B({ ctr: 5, watchTimeSharePct: 52, avdSec: 300 })], { hoursRunning: 96 })
    expect(j.outcome).toBe('over-promise')
    expect(j.reason).toContain('AVD 240 s vs 300 s')
    expect(j.reason).not.toContain('watch-time share 48%')
  })

  it('honours a custom over-promise margin', () => {
    const j = judgeTest([A({ ctr: 6, watchTimeSharePct: 48, avdSec: 290 }), B({ ctr: 5, watchTimeSharePct: 52, avdSec: 300 })], { hoursRunning: 96, overPromiseDropPct: 5 })
    expect(j.outcome).toBe('over-promise')
    expect(j.thresholdsUsed).toContain('overPromiseDropPct 5% [house]')
  })

  it('reports no difference inside 3 share points and routes to another thumbnail angle', () => {
    const j = judgeTest([A({ watchTimeSharePct: 51 }), B({ watchTimeSharePct: 49, ctr: 6 })], { hoursRunning: 96 })
    expect(j.outcome).toBe('no-difference')
    expect(j.winner).toBeUndefined()
    expect(j.route).toBe('thumbnail')
    expect(j.reason).toContain('too close')
    expect(judgeTest([A({ watchTimeSharePct: 51.5 }), B({ watchTimeSharePct: 48.5 })], { hoursRunning: 96 }).outcome).toBe('clear-winner')
  })

  it('falls back to AVD when any variant lacks a share, and to CTR when AVD is missing too', () => {
    const avd = judgeTest([A({ watchTimeSharePct: undefined, avdSec: 250 }), B({ avdSec: 320 })], { hoursRunning: 96 })
    expect(avd.metric).toBe('avd')
    expect(avd.outcome).toBe('over-promise') // A leads CTR, 250 s is 22% under 320 s
    expect(avd.winner).toBe('B')
    const ctr = judgeTest([A({ watchTimeSharePct: undefined, avdSec: undefined }), B({ ctr: 3 })], { hoursRunning: 96 })
    expect(ctr.metric).toBe('ctr')
    expect(ctr.outcome).toBe('clear-winner')
    expect(ctr.winner).toBe('A')
    expect(ctr.reason).toContain('CTR alone')
    const ctrClose = judgeTest([A({ watchTimeSharePct: undefined, avdSec: undefined, ctr: 5 }), B({ ctr: 4.9, avdSec: undefined })], { hoursRunning: 96 })
    expect(ctrClose.outcome).toBe('no-difference')
    expect(decisiveMetric([A(), B({ avdSec: undefined })])).toBe('watchTimeShare')
  })

  it('handles three variants: the CTR leader is compared with the share winner', () => {
    const C: TestVariant = { name: 'C', impressions: 4_000, ctr: 8, watchTimeSharePct: 20, avdSec: 200 }
    const j = judgeTest([A({ watchTimeSharePct: 45 }), B({ watchTimeSharePct: 35 }), C], { hoursRunning: 96 })
    expect(j.outcome).toBe('over-promise')
    expect(j.ctrLeader).toBe('C')
    expect(j.winner).toBe('A')
    const clean = judgeTest([A({ ctr: 9, watchTimeSharePct: 45 }), B({ watchTimeSharePct: 35 }), C], { hoursRunning: 96 })
    expect(clean.outcome).toBe('clear-winner')
    expect(clean.winner).toBe('A')
  })
})

describe('experiment documents', () => {
  it('builds a schema-valid experiment row with a deterministic id and derived start', () => {
    const variants = [A(), B()]
    const j = judgeTest(variants, { hoursRunning: 96 })
    const doc = toExperimentDoc('solar-generator', 1, variants, j, now)
    expect(ExperimentDoc.parse(doc)).toEqual(doc)
    expect(doc.id).toBe('solar-generator:1')
    expect(doc.kind).toBe('thumbnail')
    expect(doc.outcome).toBe('clear-winner')
    expect(doc.winner).toBe('A')
    expect(doc.startedAt).toBe('2026-09-10T12:00:00.000Z')
    expect(doc.updatedAt).toBe(now.toISOString())
    expect(doc.source).toBe('cli')
    const again = toExperimentDoc('solar-generator', 1, variants, j, now)
    expect(again).toEqual(doc)
  })

  it('leaves a too-early row open so it never counts, and honours explicit options', () => {
    const variants = [A({ impressions: 100 }), B({ impressions: 100 })]
    const j = judgeTest(variants, { hoursRunning: 10 })
    const doc = toExperimentDoc('slug', 2, variants, j, now, { kind: 'title', startedAt: '2026-09-13T00:00:00Z', source: 'agent:review' })
    expect(doc.outcome).toBeUndefined()
    expect(doc.winner).toBeUndefined()
    expect(doc.kind).toBe('title')
    expect(doc.startedAt).toBe('2026-09-13T00:00:00Z')
    expect(doc.source).toBe('agent:review')
    expect(ExperimentDoc.parse(doc)).toEqual(doc)
  })

  it('maps the winner to the ledger letter', () => {
    expect(winnerLetter(judgeTest([A(), B()], { hoursRunning: 96 }))).toBe('A')
    expect(winnerLetter(judgeTest([A({ watchTimeSharePct: 50 }), B({ watchTimeSharePct: 50 })], { hoursRunning: 96 }))).toBe('none')
    expect(winnerLetter(judgeTest([A({ impressions: 1 }), B()], { hoursRunning: 96 }))).toBeUndefined()
    expect(winnerLetter(judgeTest([A({ name: 'stakes' }), B({ name: 'result' })], { hoursRunning: 96 }))).toBeUndefined()
  })

  it('renders a judgement with the outcome, route, and thresholds', () => {
    const text = renderJudgement(judgeTest([A({ ctr: 4 }), B({ ctr: 7 })], { hoursRunning: 96 }))
    expect(text).toContain('OVER-PROMISE')
    expect(text).toContain('keep A')
    expect(text).toContain('route: hook')
    expect(text).toContain('watch-time share after 96 h')
    expect(text).toContain(`overPromiseDropPct ${TEST_RULES.overPromiseDropPct.value}% [house]`)
  })
})
