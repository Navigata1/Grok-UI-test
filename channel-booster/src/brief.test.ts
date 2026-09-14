import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addIdea, setStatus } from './bank.js'
import { INBOX_STALE_DAYS, LOYALTY_DRIFT_REL, buildBrief, renderBriefMarkdown, type Brief } from './brief.js'
import { addRow, recordRead } from './ledger.js'
import { defaultProfile } from './profile.js'
import { DecisionDoc, ExperimentDoc, RuleDoc, type Baselines, type ProfileDoc } from './schema.js'
import { openStore, type Store } from './store.js'
import { resetThresholds } from './thresholds.js'

let root: string
let store: Store
const now = new Date('2026-09-14T12:00:00Z')
const DAY = 86_400_000
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY)
const iso = (d: number) => daysAgo(d).toISOString()

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'booster-brief-'))
  store = openStore(root)
  resetThresholds()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function baselines(overrides: Partial<Baselines> = {}): Baselines {
  return { computedAt: iso(1), bucket: '48', n: 10, tier: 'solid', ctr: { median: 5, mad: 0.5, n: 10 }, avpPct: { median: 40, mad: 3, n: 10 }, shift: false, ...overrides }
}

function profileWith(extra: Partial<ProfileDoc> = {}): ProfileDoc {
  return { ...defaultProfile(), ...extra }
}

const scores = { demand: 4, packaging: 4, fit: 4, angle: 4, payoff: 4, feasibility: 4 }

/** Old finished rows with returning share `returning`, aged `firstAge` days and more (a week apart). */
function seedHistory(n: number, returning = 40, firstAge = 14): void {
  for (let i = 0; i < n; i += 1) {
    const publishedAt = iso(firstAge + i * 7)
    addRow(store, { slug: `old-${i}`, title: `Old ${i}`, publishedAt, now })
    recordRead(store, { slug: `old-${i}`, bucket: '48', read: { impressions: 20_000, ctr: 5, avpPct: 40 }, now: new Date(Date.parse(publishedAt) + 2 * DAY) })
    recordRead(store, { slug: `old-${i}`, bucket: '168', read: { views: 5_000, returningPct: returning }, lever: 'stakes won', now: new Date(Date.parse(publishedAt) + 7 * DAY) })
  }
}

function everyItem(brief: Brief) {
  return [...brief.readsDue, ...brief.decisionsAwaiting, ...brief.experimentsToClose, ...brief.rulesChanged, ...brief.alerts, ...brief.ideaMovers, ...brief.nextThree]
}

describe('buildBrief', () => {
  it('is empty and well-formed on an empty store', () => {
    const brief = buildBrief(store, { now, profile: profileWith() })
    expect(brief).toEqual({ window: 'week', from: iso(7), to: now.toISOString(), readsDue: [], decisionsAwaiting: [], experimentsToClose: [], rulesChanged: [], alerts: [], ideaMovers: [], nextThree: [] })
    expect(buildBrief(store, { now, profile: profileWith(), window: 'today' }).from).toBe(iso(1))
  })

  it('lists reads due with the typing command', () => {
    addRow(store, { slug: 'solar', title: 'Solar', publishedAt: iso(2.5), now })
    const brief = buildBrief(store, { now, profile: profileWith() })
    expect(brief.readsDue.map((r) => [r.slug, r.bucket, r.overdueHours])).toEqual([['solar', '24', 36], ['solar', '48', 12]])
    expect(brief.readsDue[1].text).toBe('solar at 48 h, 12 h overdue')
    expect(brief.readsDue[1].command).toBe('drop the Studio export in inbox/ then booster review run, or booster set solar --bucket 48 --impressions N --ctr X --avp Y --ret30 Z --returning W')
  })

  it('lists decisions that need approval or application, and skips HOLD, WAIT and applied ones', () => {
    const base = { numbers: {}, updatedAt: iso(1), source: 'cli' }
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'a:48', slug: 'a', bucket: '48', decision: 'REPACKAGE', flipCondition: 'Flips to HOLD if the window closes.' }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'b:48', slug: 'b', bucket: '48', decision: 'RE-TEST-TITLE', approvedBy: 'jony', approvedAt: iso(0.5) }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'c:168', slug: 'c', bucket: '168', decision: 'SEQUEL' }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'd:168', slug: 'd', bucket: '168', decision: 'EXPAND' }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'e:168', slug: 'e', bucket: '168', decision: 'PARK' }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'f:48', slug: 'f', bucket: '48', decision: 'HOLD' }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'g:24', slug: 'g', bucket: '24', decision: 'WAIT' }))
    store.upsert('decisions', DecisionDoc.parse({ ...base, id: 'h:48', slug: 'h', bucket: '48', decision: 'REPACKAGE', approvedAt: iso(1), appliedAt: iso(0.5) }))
    const sequel = addIdea(store, { idea: 'Sequel: the c video', scores, sequelOf: 'c', now })
    const brief = buildBrief(store, { now, profile: profileWith() })
    expect(brief.decisionsAwaiting.map((d) => [d.id, d.decision, d.stage])).toEqual([['a:48', 'REPACKAGE', 'approve'], ['b:48', 'RE-TEST-TITLE', 'apply'], ['c:168', 'SEQUEL', 'approve'], ['d:168', 'EXPAND', 'approve'], ['e:168', 'PARK', 'approve']])
    const byId = Object.fromEntries(brief.decisionsAwaiting.map((d) => [d.id, d]))
    expect(byId['a:48'].command).toBe('booster repackage prepare a then booster decide approve a --bucket 48 --by <name>')
    expect(byId['a:48'].flipCondition).toBe('Flips to HOLD if the window closes.')
    expect(byId['b:48'].text).toContain('approved by jony')
    expect(byId['b:48'].command).toBe('start Test & Compare in Studio, then booster decide apply b --bucket 48')
    expect(byId['c:168'].command).toBe(`booster bank approve ${sequel.id}`)
    expect(byId['d:168'].command).toMatch(/^booster bank add/)
    expect(byId['e:168'].command).toMatch(/^booster bank park <idea-id> --reason "no audience at 168 h"/)
  })

  it('lists open experiments, ready once past the hour floor (the cold-start floor without a baseline)', () => {
    const variants = [{ name: 'A', impressions: 3_000, ctr: 5 }, { name: 'B', impressions: 3_000, ctr: 6 }]
    store.upsert('experiments', ExperimentDoc.parse({ id: 'a:1', slug: 'a', variants, startedAt: new Date(now.getTime() - 100 * 3_600_000).toISOString(), updatedAt: iso(1), source: 'cli' }))
    store.upsert('experiments', ExperimentDoc.parse({ id: 'b:1', slug: 'b', kind: 'title', variants, startedAt: new Date(now.getTime() - 10 * 3_600_000).toISOString(), updatedAt: iso(0), source: 'cli' }))
    store.upsert('experiments', ExperimentDoc.parse({ id: 'c:1', slug: 'c', variants, startedAt: iso(20), outcome: 'clear-winner', winner: 'A', updatedAt: iso(10), source: 'cli' }))
    const established = buildBrief(store, { now, profile: profileWith({ baselines: baselines() }) })
    expect(established.experimentsToClose.map((e) => [e.id, e.hoursRunning, e.ready])).toEqual([['a:1', 100, true], ['b:1', 10, false]])
    expect(established.experimentsToClose[0].text).toBe('a:1 (thumbnail, A vs B) running 100 h: past the 72 h floor, judge it')
    expect(established.experimentsToClose[0].command).toBe('type the Test & Compare panel, then booster test judge a --hours 100')
    expect(established.experimentsToClose[1].command).toBe('booster brief --today in 62 h')
    const cold = buildBrief(store, { now, profile: profileWith() })
    expect(cold.experimentsToClose.map((e) => e.ready)).toEqual([false, false])
    expect(cold.experimentsToClose[0].text).toContain('under the 168 h floor (cold start)')
  })

  it('lists rules that moved inside the window with their evidence counts', () => {
    const base = { slugs: [], source: 'cli' }
    store.upsert('rules', RuleDoc.parse({ ...base, id: 'rule:1', rule: 'numbers beat adjectives', tests: 4, wins: 3, confidence: 0.7, status: 'promoted', updatedAt: iso(2) }))
    store.upsert('rules', RuleDoc.parse({ ...base, id: 'rule:2', rule: 'faces on every thumbnail', tests: 3, wins: 1, confidence: 0.3, status: 'retired', updatedAt: iso(6) }))
    store.upsert('rules', RuleDoc.parse({ ...base, id: 'rule:3', rule: 'stakes over results', tests: 1, wins: 1, confidence: 0.5, status: 'candidate', updatedAt: iso(0.5) }))
    store.upsert('rules', RuleDoc.parse({ ...base, id: 'rule:4', rule: 'old news', tests: 5, wins: 4, confidence: 0.8, status: 'promoted', updatedAt: iso(20) }))
    const week = buildBrief(store, { now, profile: profileWith() })
    expect(week.rulesChanged.map((r) => r.id)).toEqual(['rule:1', 'rule:3', 'rule:2'])
    expect(week.rulesChanged[0].text).toBe('"numbers beat adjectives" is promoted (4 tests, 3 wins, confidence 0.70)')
    expect(week.rulesChanged[0].command).toBe('booster rules compile (refreshes playbook/00-learned-rules.md)')
    expect(week.rulesChanged[1].text).toBe('"stakes over results" is candidate (1 test, 1 win, confidence 0.50)')
    expect(week.rulesChanged[1].command).toMatch(/^booster retro --accept-rule "stakes over results"/)
    expect(week.rulesChanged[2].command).toMatch(/^booster rules compile \(drops it/)
    const today = buildBrief(store, { now, profile: profileWith(), window: 'today' })
    expect(today.rulesChanged.map((r) => r.id)).toEqual(['rule:3'])
  })

  it('raises the baseline-shift, loyalty-drift, WIP and cadence alerts', () => {
    seedHistory(5)
    for (const [slug, days, returning] of [['recent-1', 9, 28], ['recent-0', 8, 25]] as const) {
      addRow(store, { slug, title: slug, publishedAt: iso(days), now })
      recordRead(store, { slug, bucket: '168', read: { views: 4_000, returningPct: returning }, lever: 'unclear', now: daysAgo(days - 7) })
    }
    addRow(store, { slug: 'this-week-1', title: 'One', publishedAt: iso(1), now })
    addRow(store, { slug: 'this-week-2', title: 'Two', publishedAt: iso(3), now })
    for (let i = 0; i < 4; i += 1) {
      const idea = addIdea(store, { idea: `Packaging idea ${i}`, scores, now: daysAgo(20) })
      setStatus(store, idea.id, 'green', { now: daysAgo(19) })
      setStatus(store, idea.id, 'packaging', { now: daysAgo(18) })
    }
    const previous = baselines({ computedAt: iso(30), ctr: { median: 3, mad: 0.4, n: 10 } })
    const profile = profileWith({ baselines: baselines({ shift: true }), previousBaselines: previous, maxPerWeek: 1 })
    const brief = buildBrief(store, { now, profile })
    expect(brief.alerts.map((a) => a.kind)).toEqual(['baseline-shift', 'loyalty-drift', 'wip-over-cap', 'cadence-over-cap'])
    expect(brief.alerts[0].text).toBe('Baseline shifted by more than one MAD since the previous refresh (ctr); every verdict now compares against the new medians')
    expect(brief.alerts[0].command).toMatch(/^booster profile show/)
    expect(brief.alerts[1].text).toBe(`Loyalty drift: returning share on the last two videos is 25% (recent-0) and 28% (recent-1), both under ${LOYALTY_DRIFT_REL}x the 40% baseline [house]`)
    expect(brief.alerts[1].command).toMatch(/^booster retro --since 14d/)
    expect(brief.alerts[2].text).toBe('4 ideas in packaging, cap 3 [house]: finish one before starting another')
    expect(brief.alerts[3].text).toBe('2 uploads in the last 7 days against a cap of 1 (maxPerWeek 1); fewer, better uploads')

    const calm = buildBrief(store, { now, profile: profileWith({ baselines: baselines(), maxPerWeek: 2 }) })
    expect(calm.alerts.map((a) => a.kind)).toEqual(['loyalty-drift', 'wip-over-cap'])
  })

  it('does not call loyalty drift on one bad read, a thin baseline, or a healthy pair', () => {
    seedHistory(5)
    addRow(store, { slug: 'recent-1', title: 'r1', publishedAt: iso(9), now })
    recordRead(store, { slug: 'recent-1', bucket: '168', read: { views: 4_000, returningPct: 42 }, lever: 'x', now: daysAgo(2) })
    addRow(store, { slug: 'recent-0', title: 'r0', publishedAt: iso(8), now })
    recordRead(store, { slug: 'recent-0', bucket: '168', read: { views: 4_000, returningPct: 20 }, lever: 'x', now: daysAgo(1) })
    expect(buildBrief(store, { now, profile: profileWith() }).alerts).toEqual([])
    const thin = openStore(path.join(root, 'thin'))
    for (const [slug, days] of [['a', 9], ['b', 8]] as const) {
      addRow(thin, { slug, title: slug, publishedAt: iso(days), now })
      recordRead(thin, { slug, bucket: '168', read: { views: 100, returningPct: 5 }, lever: 'x', now })
    }
    expect(buildBrief(thin, { now, profile: profileWith() }).alerts).toEqual([])
  })

  it('raises the stale-inbox alert only with reads due, no export in the inbox, and no numbers for 14 days', () => {
    seedHistory(3, 40, 30)
    addRow(store, { slug: 'waiting', title: 'Waiting', publishedAt: iso(3), now })
    const profile = profileWith()
    expect(buildBrief(store, { now, profile }).alerts).toEqual([])
    expect(buildBrief(store, { now, profile, inboxFiles: ['Table data.csv'] }).alerts).toEqual([])
    const stale = buildBrief(store, { now, profile, inboxFiles: ['README.md'] })
    expect(stale.alerts.map((a) => a.kind)).toEqual(['inbox-stale'])
    expect(stale.alerts[0].text).toMatch(new RegExp(`^No Studio export in inbox/ and no numbers recorded for ${INBOX_STALE_DAYS} days \\[house\\] while \\d+ reads are due; the loop has stalled$`))
    expect(stale.alerts[0].command).toMatch(/Export CSV into inbox\/, then booster review run$/)
    recordRead(store, { slug: 'waiting', bucket: '24', read: { impressions: 900 }, now: daysAgo(2) })
    expect(buildBrief(store, { now, profile, inboxFiles: [] }).alerts).toEqual([])
    const empty = openStore(path.join(root, 'empty'))
    addRow(empty, { slug: 'lonely', title: 'Lonely', publishedAt: iso(20), now })
    expect(buildBrief(empty, { now, profile, inboxFiles: [] }).alerts.map((a) => a.kind)).toEqual(['inbox-stale'])
  })

  it('lists idea movers inside the window and the next three ideas with their commands', () => {
    const green = addIdea(store, { idea: 'Cold showers for 30 days', scores: { ...scores, demand: 5, packaging: 5 }, now: daysAgo(3) })
    setStatus(store, green.id, 'green', { now: daysAgo(2) })
    const fresh = addIdea(store, { idea: 'A brand new idea', scores, now: daysAgo(1) })
    const parked = addIdea(store, { idea: 'Parked one', scores, now: daysAgo(10) })
    setStatus(store, parked.id, 'parked', { reason: 'angle is a clone', now: daysAgo(4) })
    const rescored = addIdea(store, { idea: 'Old banked idea', scores: { ...scores, demand: 2 }, now: daysAgo(30) })
    addIdea(store, { idea: 'Old banked idea', scores: { ...scores, demand: 3 }, now: daysAgo(2) })
    const stale = addIdea(store, { idea: 'Stale green', scores: { ...scores, demand: 5 }, now: daysAgo(30) })
    setStatus(store, stale.id, 'green', { now: daysAgo(20) })
    const weak = addIdea(store, { idea: 'Weak one', scores: { demand: 3, packaging: 3, fit: 3, angle: 3, payoff: 3, feasibility: 3 }, now: daysAgo(15) })
    const brief = buildBrief(store, { now, profile: profileWith() })
    expect(brief.ideaMovers.map((m) => [m.id, m.status])).toEqual([[fresh.id, 'banked'], [green.id, 'green'], [parked.id, 'parked']])
    expect(brief.ideaMovers[0].text).toBe('"A brand new idea" new in the bank · 80/100 green')
    expect(brief.ideaMovers[0].command).toBe(`booster bank approve ${fresh.id} (or booster bank park ${fresh.id} --reason "<weakest axis>")`)
    expect(brief.ideaMovers[1].text).toBe('"Cold showers for 30 days" moved to green · 90/100 green')
    expect(brief.ideaMovers[1].command).toBe(`booster package build ${green.id}`)
    expect(brief.ideaMovers[2].text).toBe('"Parked one" moved to parked (angle is a clone) · 80/100 green')
    expect(brief.ideaMovers.some((m) => m.id === rescored.id)).toBe(false)

    expect(brief.nextThree.map((n) => [n.rank, n.id])).toEqual([[1, green.id], [2, stale.id], [3, fresh.id]])
    expect(brief.nextThree[0].text).toBe('Cold showers for 30 days · 90/100 green, green; weakest axis fit')
    expect(brief.nextThree[0].command).toBe(`booster package build ${green.id}`)
    expect(brief.nextThree[2].command).toBe(`booster bank approve ${fresh.id}`)
    const onlyWeak = buildBrief(openStore(path.join(root, 'weak')), { now, profile: profileWith() })
    expect(onlyWeak.nextThree).toEqual([])
    setStatus(store, green.id, 'packaging', { now })
    setStatus(store, stale.id, 'parked', { now })
    setStatus(store, fresh.id, 'retired', { now })
    setStatus(store, rescored.id, 'retired', { now })
    const next = buildBrief(store, { now, profile: profileWith() }).nextThree
    expect(next.map((n) => n.id)).toEqual([weak.id])
    expect(next[0].verdict).toBe('yellow')
    expect(next[0].command).toMatch(/; then booster bank approve /)
  })

  it('gives every item a text and a command', () => {
    seedHistory(3)
    addRow(store, { slug: 'due', title: 'Due', publishedAt: iso(2), now })
    store.upsert('decisions', DecisionDoc.parse({ id: 'x:48', slug: 'x', bucket: '48', decision: 'REPACKAGE', numbers: {}, updatedAt: iso(1), source: 'cli' }))
    store.upsert('experiments', ExperimentDoc.parse({ id: 'x:1', slug: 'x', variants: [{ name: 'A' }, { name: 'B' }], startedAt: iso(4), updatedAt: iso(1), source: 'cli' }))
    store.upsert('rules', RuleDoc.parse({ id: 'rule:1', rule: 'r', updatedAt: iso(1), source: 'cli' }))
    addIdea(store, { idea: 'Fresh', scores, now })
    const brief = buildBrief(store, { now, profile: profileWith({ maxPerWeek: 0.5 }), inboxFiles: [] })
    const items = everyItem(brief)
    expect(items.length).toBeGreaterThanOrEqual(7)
    for (const item of items) {
      expect(item.text.length).toBeGreaterThan(0)
      expect(item.command.length).toBeGreaterThan(0)
      expect(item.text).not.toContain('\n')
    }
  })
})

describe('renderBriefMarkdown', () => {
  it('renders one section per list with the command on every line and a named empty state', () => {
    const empty = renderBriefMarkdown(buildBrief(store, { now, profile: profileWith() }))
    expect(empty).toMatch(/^# Weekly brief · 2026-09-14\n\nWindow: 2026-09-07 12:00 to 2026-09-14 12:00 UTC\.\n\n## Reads due\n\n- nothing due\n/)
    expect(empty).toContain('## Next three\n\n- the bank is empty: booster bank add "<idea>" --score "..."')
    expect(empty.endsWith('\n')).toBe(true)
    expect(empty.endsWith('\n\n')).toBe(false)
    addRow(store, { slug: 'solar', title: 'Solar', publishedAt: iso(2), now })
    const idea = addIdea(store, { idea: 'Cold showers for 30 days', scores: { ...scores, demand: 5 }, now })
    const md = renderBriefMarkdown(buildBrief(store, { now, profile: profileWith(), window: 'today' }))
    expect(md).toMatch(/^# Daily brief · 2026-09-14/)
    expect(md).toContain('## Reads due (2)\n\n- solar at 24 h, 24 h overdue — do: `drop the Studio export in inbox/ then booster review run, or booster set solar --bucket 24 --impressions N --ctr X --avp Y`')
    expect(md).toContain(`## Idea movers (1)\n\n- "Cold showers for 30 days" new in the bank · 85/100 green — do: \`booster bank approve ${idea.id}`)
    expect(md).toContain('## Next three (1)')
    const sections = md.split('\n').filter((l) => l.startsWith('## '))
    expect(sections).toEqual(['## Reads due (2)', '## Decisions awaiting a person', '## Experiments to close', '## Rules changed', '## Alerts', '## Idea movers (1)', '## Next three (1)'])
  })
})
