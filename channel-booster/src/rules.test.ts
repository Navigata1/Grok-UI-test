import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addRow, recordRead } from './ledger.js'
import {
  LEARNED_RULES_FILE,
  LEARNED_RULES_MAX_CHARS,
  compileRuleDocs,
  compileRules,
  decay,
  isProtected,
  leverKey,
  renderLearnedRules,
  rowWon,
  ruleId,
  scoreLever,
  smoothedWinRate,
  sortRules,
  tallyEvidence,
  testedRows,
  writeLearnedRules,
} from './rules.js'
import { RuleDoc, DecisionDoc, type LedgerRow } from './schema.js'
import { openStore, type Store } from './store.js'

let root: string
let store: Store
const now = new Date('2026-09-14T12:00:00Z')
const DAY = 86_400_000
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'booster-rules-')); store = openStore(root) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface SeedRow { slug: string; levers?: string[]; views?: number; weeksAgo: number; decision?: string; no168?: boolean }

/** Publish `weeksAgo` weeks before now; the 7-day read is stamped 7 days after publish so decay is deterministic. */
function seed(rows: SeedRow[]): void {
  for (const r of rows) {
    const published = new Date(now.getTime() - r.weeksAgo * 7 * DAY)
    addRow(store, { slug: r.slug, title: `Video ${r.slug}`, publishedAt: published.toISOString(), hypothesis: r.levers ? { levers: r.levers, predictedCtrMultiple: 1 } : undefined, now })
    if (r.no168) continue
    recordRead(store, {
      slug: r.slug,
      bucket: '168',
      read: { views: r.views ?? 200, at: new Date(published.getTime() + 7 * DAY).toISOString() },
      lever: 'one sentence of learning',
      decision: r.decision,
      now,
    })
  }
}

/**
 * Eleven rows with 7-day reads: leave-one-out medians make 2000 a win and 200 a loss.
 *   L1 number-in-title: a, b, c win, d loses (3 of 4)
 *   L2 stakes-thumb: c wins, e, f, g lose (1 of 4)
 *   L3 versus: h loses on views but its 7-day decision is SEQUEL
 *   L4 result-first: i loses on views but the decisions collection says EXPAND
 */
function seedChannel(): void {
  seed([
    { slug: 'a', levers: ['Number-in-title'], views: 2000, weeksAgo: 12 },
    { slug: 'b', levers: ['number-in-title'], views: 2000, weeksAgo: 11 },
    { slug: 'c', levers: ['number-in-title', 'stakes-thumb'], views: 2000, weeksAgo: 10 },
    { slug: 'd', levers: ['number-in-title '], views: 200, weeksAgo: 9 },
    { slug: 'e', levers: ['stakes-thumb'], views: 200, weeksAgo: 8 },
    { slug: 'f', levers: ['stakes-thumb'], views: 200, weeksAgo: 7 },
    { slug: 'g', levers: ['stakes-thumb'], views: 200, weeksAgo: 6 },
    { slug: 'h', levers: ['versus'], views: 200, weeksAgo: 5, decision: 'SEQUEL' },
    { slug: 'i', levers: ['result-first'], views: 200, weeksAgo: 4 },
    { slug: 'n1', views: 1000, weeksAgo: 3 },
    { slug: 'n2', views: 1000, weeksAgo: 2 },
    { slug: 'k', levers: ['unread-lever'], weeksAgo: 1, no168: true },
  ])
  store.upsert('decisions', DecisionDoc.parse({ id: 'i:168', slug: 'i', bucket: '168', decision: 'EXPAND', updatedAt: now.toISOString() }))
}

describe('rules: arithmetic', () => {
  it('smooths win rates with Laplace and decays by half per half-life', () => {
    expect(smoothedWinRate(0, 0)).toBe(0.5)
    expect(smoothedWinRate(3, 4)).toBeCloseTo(4 / 6)
    expect(smoothedWinRate(0, 1)).toBeCloseTo(1 / 3)
    expect(decay(0, 90)).toBe(1)
    expect(decay(90, 90)).toBeCloseTo(0.5)
    expect(decay(180, 90)).toBeCloseTo(0.25)
    expect(decay(-5, 90)).toBe(1)
    expect(decay(10, 0)).toBe(1)
  })

  it('derives deterministic ids from the normalised lever', () => {
    expect(leverKey('  Number-in-Title  ')).toBe('number-in-title')
    expect(ruleId('Number-in-title')).toBe(ruleId('number-in-title'))
    expect(ruleId('number-in-title')).toMatch(/^rule:[a-z0-9]+$/)
    expect(ruleId('a')).not.toBe(ruleId('b'))
  })

  it('scores a lever: promoted, retired, candidate, and stale', () => {
    const opts = { halfLifeDays: 90, promoteTests: 3, promoteWinRate: 0.6, retireWinRate: 0.35 }
    const fresh = now.toISOString()
    expect(scoreLever({ lever: 'x', tests: 4, wins: 3, slugs: [], lastConfirmedAt: fresh, lastTestedAt: fresh }, now, opts)).toMatchObject({ status: 'promoted', rate: 0.667, confidence: 0.667 })
    expect(scoreLever({ lever: 'x', tests: 4, wins: 0, slugs: [], lastTestedAt: fresh }, now, opts)).toMatchObject({ status: 'retired', rate: 0.167 })
    expect(scoreLever({ lever: 'x', tests: 2, wins: 2, slugs: [], lastConfirmedAt: fresh, lastTestedAt: fresh }, now, opts).status).toBe('candidate')
    expect(scoreLever({ lever: 'x', tests: 1, wins: 0, slugs: [], lastTestedAt: fresh }, now, opts).status).toBe('candidate')
    const old = new Date(now.getTime() - 200 * DAY).toISOString()
    const stale = scoreLever({ lever: 'x', tests: 4, wins: 3, slugs: [], lastConfirmedAt: old, lastTestedAt: old }, now, opts)
    expect(stale.status).toBe('candidate')
    expect(stale.confidence).toBeLessThan(0.2)
    const ageing = new Date(now.getTime() - 60 * DAY).toISOString()
    const stillPromoted = scoreLever({ lever: 'x', tests: 4, wins: 3, slugs: [], lastConfirmedAt: ageing, lastTestedAt: ageing }, now, opts)
    expect(stillPromoted.status).toBe('promoted')
    expect(stillPromoted.confidence).toBeCloseTo(0.42, 2)
    const losingOld = scoreLever({ lever: 'x', tests: 4, wins: 0, slugs: [], lastTestedAt: old }, now, opts)
    expect(losingOld.status).toBe('retired')
  })
})

describe('rules: evidence', () => {
  it('counts only rows with pre-registered levers and a 7-day read', () => {
    seedChannel()
    const rows = store.read('ledger')
    expect(testedRows(rows).map((r) => r.slug).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
  })

  it('judges a win on the leave-one-out median or a SEQUEL / EXPAND decision', () => {
    seedChannel()
    const rows = store.read('ledger')
    const decisions = store.read('decisions')
    const row = (slug: string) => rows.find((r) => r.slug === slug) as LedgerRow
    expect(rowWon(row('a'), rows, decisions, now)).toBe(true)
    expect(rowWon(row('d'), rows, decisions, now)).toBe(false)
    expect(rowWon(row('h'), rows, decisions, now)).toBe(true)
    expect(rowWon(row('i'), rows, decisions, now)).toBe(true)
    expect(rowWon(row('n1'), rows, decisions, now)).toBe(true)
  })

  it('with no median yet, only the decision can win', () => {
    seed([{ slug: 'solo', levers: ['x'], views: 5000, weeksAgo: 2 }])
    const rows = store.read('ledger')
    expect(rowWon(rows[0], rows, [], now)).toBe(false)
    seed([{ slug: 'solo2', levers: ['x'], views: 50, weeksAgo: 3, decision: 'sequel' }])
    const rows2 = store.read('ledger')
    expect(rowWon(rows2.find((r) => r.slug === 'solo2')!, rows2, [], now)).toBe(true)
  })

  it('tallies tests, wins, slugs and the last confirmation per normalised lever', () => {
    seedChannel()
    const evidence = tallyEvidence(store.read('ledger'), store.read('decisions'), now)
    const byLever = Object.fromEntries(evidence.map((e) => [e.lever, e]))
    expect(byLever['number-in-title']).toMatchObject({ tests: 4, wins: 3, slugs: ['a', 'b', 'c', 'd'] })
    expect(byLever['number-in-title'].lastConfirmedAt).toBe(new Date(now.getTime() - 10 * 7 * DAY + 7 * DAY).toISOString())
    expect(byLever['number-in-title'].lastTestedAt).toBe(new Date(now.getTime() - 9 * 7 * DAY + 7 * DAY).toISOString())
    expect(byLever['stakes-thumb']).toMatchObject({ tests: 4, wins: 1, slugs: ['c', 'e', 'f', 'g'] })
    expect(byLever['versus']).toMatchObject({ tests: 1, wins: 1 })
    expect(byLever['result-first']).toMatchObject({ tests: 1, wins: 1 })
    expect(byLever['unread-lever']).toBeUndefined()
    expect(evidence[0].lever).toBe('number-in-title')
  })
})

describe('rules: compile', () => {
  it('writes rule docs with status, confidence and deterministic ids, and reports the diff', () => {
    seedChannel()
    const result = compileRules(store, { now })
    expect(result.tested).toBe(9)
    const by = Object.fromEntries(result.rules.map((r) => [r.lever, r]))
    expect(by['number-in-title']).toMatchObject({ id: ruleId('number-in-title'), status: 'promoted', tests: 4, wins: 3, pinned: false })
    expect(by['number-in-title'].rule).toContain('Prefer "number-in-title"')
    // The last confirming win (c) is 63 days old: 0.667 * 2^(-63/90).
    expect(by['number-in-title'].confidence).toBeCloseTo(0.41, 2)
    expect(by['stakes-thumb']).toMatchObject({ status: 'retired', tests: 4, wins: 1 })
    expect(by['stakes-thumb'].rule).toContain('Avoid "stakes-thumb"')
    expect(by['versus'].status).toBe('candidate')
    expect(by['result-first'].status).toBe('candidate')
    expect(result.promoted.map((r) => r.lever)).toEqual(['number-in-title'])
    expect(result.retired.map((r) => r.lever)).toEqual(['stakes-thumb'])
    expect(result.rules[0].status).toBe('promoted')
    expect(result.changes).toEqual([
      { id: ruleId('number-in-title'), lever: 'number-in-title', from: 'new', to: 'promoted' },
      { id: ruleId('result-first'), lever: 'result-first', from: 'new', to: 'candidate' },
      { id: ruleId('stakes-thumb'), lever: 'stakes-thumb', from: 'new', to: 'retired' },
      { id: ruleId('versus'), lever: 'versus', from: 'new', to: 'candidate' },
    ])
    expect(store.read('rules')).toHaveLength(4)
    for (const r of store.read('rules')) expect(() => RuleDoc.parse(r)).not.toThrow()

    const again = compileRules(store, { now })
    expect(again.changes).toEqual([])
    expect(again.rules).toEqual(result.rules)
  })

  it('demotes a promoted lever to candidate once confidence has decayed, but never un-retires', () => {
    seedChannel()
    compileRules(store, { now })
    const later = new Date(now.getTime() + 200 * DAY)
    const result = compileRules(store, { now: later })
    const by = Object.fromEntries(result.rules.map((r) => [r.lever, r]))
    expect(by['number-in-title'].status).toBe('candidate')
    expect(by['number-in-title'].confidence).toBeLessThan(0.3)
    expect(by['stakes-thumb'].status).toBe('retired')
    expect(result.changes).toEqual([{ id: ruleId('number-in-title'), lever: 'number-in-title', from: 'promoted', to: 'candidate' }])
    const longLife = compileRules(store, { now: later, halfLifeDays: 100_000 })
    expect(longLife.rules.find((r) => r.lever === 'number-in-title')?.status).toBe('promoted')
  })

  it('honours the gate options', () => {
    seedChannel()
    const strict = compileRules(store, { now, promoteTests: 5 })
    expect(strict.promoted).toEqual([])
    expect(strict.retired).toEqual([])
    const loose = compileRules(store, { now, promoteTests: 1, promoteWinRate: 0.6 })
    expect(loose.promoted.map((r) => r.lever).sort()).toEqual(['number-in-title', 'result-first', 'versus'])
  })

  it('keeps pinned and human-accepted rules untouched and drops stale compiled ones', () => {
    seedChannel()
    const pinned = RuleDoc.parse({ id: ruleId('number-in-title'), rule: 'Always put the number in the title', lever: 'number-in-title', status: 'pinned', pinned: true, confidence: 1, updatedAt: '2026-01-01T00:00:00Z' })
    const accepted = RuleDoc.parse({ id: 'rule:human', rule: 'Face on every thumbnail', status: 'promoted', acceptedBy: 'jony', confidence: 0.9, updatedAt: '2026-01-01T00:00:00Z' })
    const stale = RuleDoc.parse({ id: 'rule:stale', rule: 'Old compiled rule', lever: 'gone', status: 'promoted', confidence: 0.9, updatedAt: '2026-01-01T00:00:00Z' })
    store.upsert('rules', pinned)
    store.upsert('rules', accepted)
    store.upsert('rules', stale)
    expect(isProtected(pinned)).toBe(true)
    expect(isProtected(accepted)).toBe(true)
    expect(isProtected(stale)).toBe(false)

    const result = compileRules(store, { now })
    const stored = store.read('rules')
    expect(stored.find((r) => r.id === pinned.id)).toEqual(pinned)
    expect(stored.find((r) => r.id === accepted.id)).toEqual(accepted)
    expect(stored.find((r) => r.id === stale.id)).toBeUndefined()
    expect(result.rules[0].id).toBe(pinned.id)
    expect(result.promoted.map((r) => r.id)).toContain(pinned.id)
    expect(result.promoted.map((r) => r.id)).toContain(accepted.id)
    expect(result.changes.map((c) => c.lever)).not.toContain('number-in-title')
    expect(result.changes.find((c) => c.lever === 'stakes-thumb')).toMatchObject({ from: 'new', to: 'retired' })
  })

  it('compiles an empty ledger to an empty rule set', () => {
    const result = compileRules(store, { now })
    expect(result).toMatchObject({ rules: [], promoted: [], retired: [], changes: [], tested: 0 })
    expect(store.read('rules')).toEqual([])
  })

  it('stamps rows with the injected clock and source', () => {
    seedChannel()
    const docs = compileRuleDocs(store.read('ledger'), store.read('decisions'), { now, source: 'agent:nightly' })
    expect(docs.every((d) => d.updatedAt === now.toISOString() && d.source === 'agent:nightly')).toBe(true)
  })
})

describe('rules: render and write', () => {
  it('renders a compiled header, promoted rules with counts, and the retired list', () => {
    seedChannel()
    const { rules } = compileRules(store, { now })
    const md = renderLearnedRules(rules)
    expect(md.startsWith('# Learned rules (compiled)')).toBe(true)
    expect(md).toContain('Do not edit by hand')
    expect(md).toContain('on 2026-09-14')
    expect(md).toContain('promoted at 3 or more tests')
    expect(md).toContain('win rate of 60% or more')
    expect(md).toContain('halves every 90 days')
    expect(md).toContain('## Promoted')
    expect(md).toContain('- Prefer "number-in-title" on this channel (n=4, win rate 67%, confidence 41%; a, b, c, d)')
    expect(md).toContain('## Retired')
    expect(md).toContain('- Avoid "stakes-thumb" on this channel (n=4, win rate 33%, confidence')
    expect(md).toContain('Under test: 2 levers')
    expect(md).not.toContain('versus')
    expect(md.length).toBeLessThan(LEARNED_RULES_MAX_CHARS)
    expect(md.endsWith('\n')).toBe(true)
  })

  it('renders an empty rule set honestly', () => {
    const md = renderLearnedRules([])
    expect(md).toContain('- none yet: 0 levers under test')
    expect(md).toContain('## Retired\n- none')
    expect(md).not.toContain(' on undefined')
  })

  it('marks pinned and accepted rules', () => {
    const pinned = RuleDoc.parse({ id: 'rule:p', rule: 'Always X', status: 'pinned', pinned: true, confidence: 1, updatedAt: '2026-02-01T00:00:00Z' })
    const accepted = RuleDoc.parse({ id: 'rule:h', rule: 'Face on every thumbnail', status: 'promoted', acceptedBy: 'jony', confidence: 0.9, updatedAt: '2026-02-02T00:00:00Z' })
    const md = renderLearnedRules([accepted, pinned])
    expect(md).toContain('- Always X [pinned] (n=0, win rate 50%, confidence 100%)')
    expect(md).toContain('- Face on every thumbnail [accepted by jony]')
    expect(md.indexOf('Always X')).toBeLessThan(md.indexOf('Face on every'))
    expect(md).toContain('on 2026-02-02')
  })

  it('stamps the header with the compile clock, not the newest rule date', () => {
    // Rules a compile keeps verbatim (pinned, or accepted by a person) carry an older updatedAt than the run that wrote the file.
    const pinned = RuleDoc.parse({ id: 'rule:p', rule: 'Always X', status: 'pinned', pinned: true, confidence: 1, updatedAt: '2026-02-01T00:00:00Z' })
    const accepted = RuleDoc.parse({ id: 'rule:h', rule: 'Face on every thumbnail', status: 'promoted', acceptedBy: 'jony', confidence: 0.9, updatedAt: '2026-02-02T00:00:00Z' })
    const md = renderLearnedRules([accepted, pinned], { now: new Date('2026-09-21T21:00:00Z') })
    expect(md).toContain('from the packaging ledger on 2026-09-21.')
    expect(md).not.toContain('on 2026-02-02')
    // Each rule still reports its own evidence.
    expect(md).toContain('- Face on every thumbnail [accepted by jony]')
  })

  it('stays under the cap with hundreds of rules, dropping slugs first, then the weakest lines', () => {
    const rules: RuleDoc[] = []
    for (let i = 0; i < 300; i += 1) {
      rules.push(RuleDoc.parse({
        id: `rule:${i}`,
        rule: `Prefer "a fairly long lever description number ${i} that takes up space" on this channel`,
        lever: `lever ${i}`,
        tests: 5,
        wins: 4,
        confidence: 1 - i / 300,
        status: i % 3 === 0 ? 'retired' : 'promoted',
        slugs: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        updatedAt: now.toISOString(),
      }))
    }
    const md = renderLearnedRules(rules)
    expect(md.length).toBeLessThanOrEqual(LEARNED_RULES_MAX_CHARS)
    expect(md).not.toContain('; one, two')
    expect(md).toMatch(/- and \d+ more promoted rules in data\/rules\.jsonl/)
    expect(md).toMatch(/- and \d+ more retired rules in data\/rules\.jsonl/)
    expect(md).toContain('lever description number 1 that')
    const sorted = sortRules(rules)
    expect(sorted[0].status).toBe('promoted')
    expect(sorted[sorted.length - 1].status).toBe('retired')
  })

  it('writes 00-learned-rules.md atomically and refuses oversize content', () => {
    const dir = path.join(root, 'playbook')
    const target = writeLearnedRules(dir, renderLearnedRules([]))
    expect(target).toBe(path.join(dir, LEARNED_RULES_FILE))
    expect(existsSync(target)).toBe(true)
    expect(existsSync(`${target}.tmp`)).toBe(false)
    expect(readFileSync(target, 'utf8')).toContain('# Learned rules (compiled)')
    expect(writeLearnedRules(dir, 'no newline')).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe('no newline\n')
    expect(() => writeLearnedRules(dir, 'x'.repeat(LEARNED_RULES_MAX_CHARS + 1))).toThrow(/cap is 8000/)
    expect(readFileSync(target, 'utf8')).toBe('no newline\n')
  })
})
