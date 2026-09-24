/**
 * Learned rules, compiled from evidence. Every pre-registered lever
 * (`hypothesis.levers` on a ledger row) that has reached its 7-day read is a
 * test; the test is a win when the video's 7-day views reach the channel's
 * own 7-day median or the 7-day decision was SEQUEL or EXPAND. Win rates are
 * Laplace-smoothed so n = 1 cannot write the playbook, and confidence halves
 * every `halfLifeDays` without a confirming win so rules cannot fossilise
 * around one trend. Pinned rules and rules a person accepted are never
 * rewritten by the compiler.
 *
 * The output lands in `playbook/00-learned-rules.md`, which the alphabetical
 * loader in src/ai reads first, and in the `rules` collection of the store.
 *
 * A compiled rule is a hypothesis under observation, never doctrine: the gates
 * below are not a significance test, and a small channel's sample cannot tell
 * a lever from luck. The status names stay `promoted` and `retired` in the
 * store; everything a person or a model reads says "winning so far" or
 * "losing so far" under observation instead. Only a person moves a rule into
 * the playbook, with `booster retro --accept-rule`.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { baselineFrom, readLedger } from './ledger.js'
import { isProtected, noEffectPromoteChance, ruleEvidence, ruleSentence, ruleText, smoothedWinRate } from './rules-core.js'
import { RuleDoc, stableId, type DecisionDoc, type LedgerRow } from './schema.js'
import type { Store } from './store.js'

export * from './rules-core.js'

/** File name of the compiled rules; sorted first by the playbook loader. */
export const LEARNED_RULES_FILE = '00-learned-rules.md'

/** Hard cap on the compiled file so it never crowds the doctrine out of the system prompt. */
export const LEARNED_RULES_MAX_CHARS = 8_000

/** House defaults from docs/02-strategist-playbook.md (rule R7, [house]). */
export const RULE_DEFAULTS = {
  /** Days without a confirming win after which confidence has halved. */
  halfLifeDays: 90,
  /** Tests a lever needs before it can be promoted or retired. */
  promoteTests: 3,
  /** Smoothed win rate at or above which a lever is promoted. */
  promoteWinRate: 0.6,
  /** Smoothed win rate at or below which a lever is retired. */
  retireWinRate: 0.35,
  /** A 7-day read wins when views reach this multiple of the 7-day median. */
  winMultiple: 1.0,
} as const

/** Decisions that count as a win on their own, whatever the views multiple says. */
export const WINNING_DECISIONS: ReadonlySet<string> = new Set(['SEQUEL', 'EXPAND'])

export interface CompileRulesOptions {
  /** Reference clock for decay and timestamps. Defaults to the wall clock; inject it in tests. */
  now?: Date
  halfLifeDays?: number
  promoteTests?: number
  promoteWinRate?: number
  retireWinRate?: number
  /** Who wrote the rows: 'cli' (default), 'desk', or 'agent:<name>'. */
  source?: string
}

/** One lever's evidence before it becomes a RuleDoc. */
export interface LeverEvidence {
  lever: string
  tests: number
  wins: number
  slugs: string[]
  /** 7-day read time of the latest win, if any. */
  lastConfirmedAt?: string
  /** 7-day read time of the latest test, win or not. */
  lastTestedAt: string
}

/** A status change between the previous compile and this one. */
export interface RuleChange {
  id: string
  lever: string
  from: RuleDoc['status'] | 'new'
  to: RuleDoc['status']
}

export interface CompiledRules {
  /** Every rule now in the store, promoted first, then by confidence. */
  rules: RuleDoc[]
  /** Rules whose status is promoted (pinned and accepted rules included). A compiled one is winning so far, under observation: not doctrine. */
  promoted: RuleDoc[]
  /** Rules whose status is retired: losing so far, under observation. */
  retired: RuleDoc[]
  /** Status changes since the previous compile, for the retro. */
  changes: RuleChange[]
  /** Rows counted: pre-registered levers with a 7-day read. */
  tested: number
}

/** Deterministic id for a lever: `rule:<hash of the normalised lever>`. */
export function ruleId(lever: string): string {
  return stableId('rule', lever)
}

/** Lower-cased, trimmed lever text: the tally key. */
export function leverKey(lever: string): string {
  return lever.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Exponential decay: 1 at zero days, 0.5 at `halfLifeDays`. Days at or below zero do not decay. */
export function decay(days: number, halfLifeDays: number): number {
  if (!(days > 0) || !(halfLifeDays > 0)) return 1
  return 2 ** (-days / halfLifeDays)
}

function round(n: number, places = 3): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** True when a 7-day decision string is one of the winning decisions (case-insensitive). */
export function isWinningDecision(decision: string | undefined): boolean {
  return decision !== undefined && WINNING_DECISIONS.has(decision.trim().toUpperCase())
}

/** Rows the compiler counts: a pre-registered lever list and a 7-day read. */
export function testedRows(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter((r) => (r.hypothesis?.levers.length ?? 0) > 0 && r.reads['168'] !== undefined)
}

/**
 * Did this row win its 7-day read? Views at or above `winMultiple` times the
 * leave-one-out 7-day median, or a SEQUEL / EXPAND decision on the row or in
 * the decisions collection. With no median yet (cold start) only the decision counts.
 */
export function rowWon(row: LedgerRow, allRows: LedgerRow[], decisions: DecisionDoc[], now: Date, winMultiple = RULE_DEFAULTS.winMultiple): boolean {
  const decided = decisions.filter((d) => d.slug === row.slug && (d.bucket === '168' || d.bucket === '672')).some((d) => isWinningDecision(d.decision))
  if (decided || isWinningDecision(row.decision)) return true
  const views = row.reads['168']?.views
  if (views === undefined) return false
  const median = baselineFrom(allRows, { bucket: '168', now, excludeSlug: row.slug }).views?.median
  if (median === undefined || median <= 0) return false
  return views >= winMultiple * median
}

/** Tally wins and tests per lever over the tested rows. Pure; no store. */
export function tallyEvidence(allRows: LedgerRow[], decisions: DecisionDoc[], now: Date, winMultiple = RULE_DEFAULTS.winMultiple): LeverEvidence[] {
  const byLever = new Map<string, LeverEvidence>()
  const rows = [...testedRows(allRows)].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  for (const row of rows) {
    const won = rowWon(row, allRows, decisions, now, winMultiple)
    const at = row.reads['168']!.at
    for (const key of new Set((row.hypothesis?.levers ?? []).map(leverKey).filter(Boolean))) {
      const e = byLever.get(key) ?? { lever: key, tests: 0, wins: 0, slugs: [], lastTestedAt: at }
      e.tests += 1
      e.slugs.push(row.slug)
      if (at > e.lastTestedAt) e.lastTestedAt = at
      if (won) {
        e.wins += 1
        if (!e.lastConfirmedAt || at > e.lastConfirmedAt) e.lastConfirmedAt = at
      }
      byLever.set(key, e)
    }
  }
  return [...byLever.values()].sort((a, b) => b.tests - a.tests || a.lever.localeCompare(b.lever))
}

/**
 * Score one lever: smoothed win rate, decayed confidence, and status.
 * Both gates need `promoteTests` tests. Retired: smoothed win rate at or
 * below `retireWinRate` (losing evidence does not fade). Promoted: smoothed
 * win rate at or above `promoteWinRate` while the decayed confidence is still
 * above `retireWinRate`; once the last confirming win is old enough that
 * confidence has sunk into the retire band, the rule drops back to candidate
 * until a new win confirms it. Everything else is a candidate.
 */
export function scoreLever(e: LeverEvidence, now: Date, options: Required<Omit<CompileRulesOptions, 'now' | 'source'>>): { rate: number; confidence: number; status: RuleDoc['status'] } {
  const rate = smoothedWinRate(e.wins, e.tests)
  const anchor = e.lastConfirmedAt ?? e.lastTestedAt
  const days = (now.getTime() - Date.parse(anchor)) / 86_400_000
  const confidence = Math.min(1, Math.max(0, rate * decay(days, options.halfLifeDays)))
  let status: RuleDoc['status'] = 'candidate'
  if (e.tests >= options.promoteTests && rate <= options.retireWinRate) status = 'retired'
  else if (e.tests >= options.promoteTests && rate >= options.promoteWinRate && confidence > options.retireWinRate) status = 'promoted'
  return { rate: round(rate), confidence: round(confidence), status }
}

/** Build RuleDocs from evidence without touching a store. Pure; the dashboard can call it. */
export function compileRuleDocs(allRows: LedgerRow[], decisions: DecisionDoc[], options: CompileRulesOptions = {}): RuleDoc[] {
  const now = options.now ?? new Date()
  const opts = {
    halfLifeDays: options.halfLifeDays ?? RULE_DEFAULTS.halfLifeDays,
    promoteTests: options.promoteTests ?? RULE_DEFAULTS.promoteTests,
    promoteWinRate: options.promoteWinRate ?? RULE_DEFAULTS.promoteWinRate,
    retireWinRate: options.retireWinRate ?? RULE_DEFAULTS.retireWinRate,
  }
  return tallyEvidence(allRows, decisions, now).map((e) => {
    const { confidence, status } = scoreLever(e, now, opts)
    return RuleDoc.parse({
      id: ruleId(e.lever),
      rule: ruleText(e.lever, status),
      lever: e.lever,
      tests: e.tests,
      wins: e.wins,
      confidence,
      status,
      slugs: e.slugs,
      lastConfirmedAt: e.lastConfirmedAt,
      pinned: false,
      updatedAt: now.toISOString(),
      source: options.source ?? 'cli',
    })
  })
}

function rank(rule: RuleDoc): number {
  return rule.status === 'pinned' ? 0 : rule.status === 'promoted' ? 1 : rule.status === 'candidate' ? 2 : 3
}

/** Sort: pinned, promoted, candidate, retired; then confidence, then tests, then lever. */
export function sortRules(rules: RuleDoc[]): RuleDoc[] {
  return [...rules].sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence || b.tests - a.tests || (a.lever ?? a.rule).localeCompare(b.lever ?? b.rule))
}

/**
 * Compile the `rules` collection from the ledger. Rules that are pinned or
 * carry `acceptedBy` are kept exactly as stored; every other rule is replaced
 * by the freshly compiled set, so a lever without evidence disappears.
 * Returns the rules, the promoted and retired subsets, and the status diff.
 */
export function compileRules(store: Store, options: CompileRulesOptions = {}): CompiledRules {
  const now = options.now ?? new Date()
  const allRows = readLedger(store)
  const decisions = store.read('decisions')
  const existing = store.read('rules')
  const previous = new Map(existing.map((r) => [r.id, r]))
  const compiled = compileRuleDocs(allRows, decisions, { ...options, now })
  const kept = existing.filter(isProtected)
  const keptIds = new Set(kept.map((r) => r.id))
  const fresh = compiled.filter((r) => !keptIds.has(r.id))
  const rules = sortRules([...kept, ...fresh])
  store.writeAll('rules', [...rules].sort((a, b) => a.id.localeCompare(b.id)))
  const changes: RuleChange[] = fresh
    .map((r) => ({ id: r.id, lever: r.lever ?? r.rule, from: previous.get(r.id)?.status ?? ('new' as const), to: r.status }))
    .filter((c) => c.from !== c.to)
    .sort((a, b) => a.lever.localeCompare(b.lever))
  return {
    rules,
    promoted: rules.filter((r) => r.status === 'promoted' || r.status === 'pinned'),
    retired: rules.filter((r) => r.status === 'retired'),
    changes,
    tested: testedRows(allRows).length,
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function ruleLine(r: RuleDoc, withSlugs: boolean): string {
  const slugs = withSlugs && r.slugs.length ? `; ${r.slugs.slice(0, 6).join(', ')}${r.slugs.length > 6 ? ', ...' : ''}` : ''
  if (isProtected(r)) {
    const tag = r.acceptedBy ? ` [accepted by ${r.acceptedBy}]` : ' [pinned]'
    return `- ${r.rule}${tag}${r.tests > 0 ? ` (${ruleEvidence(r)}${slugs})` : ''}`
  }
  return `- ${ruleSentence(r)} (${ruleEvidence(r)}${slugs})`
}

/**
 * The compiled playbook file. The header says it is compiled, that every
 * compiled rule is a hypothesis under observation from this channel's own
 * small sample (never doctrine, never an override of it), that only
 * `booster retro --accept-rule` moves a rule into the playbook, and what the
 * gates are and are not. Then the rules a person accepted, the levers winning
 * so far and the levers losing so far, each with tests, wins, smoothed win
 * rate and confidence. Always under `LEARNED_RULES_MAX_CHARS`; when the lists
 * would overflow, slug refs go first, then the lowest-confidence observations,
 * then accepted rules (a CLI-accepted rule is also in its own playbook file).
 */
export function renderLearnedRules(rules: RuleDoc[], options: { now?: Date; halfLifeDays?: number; promoteTests?: number; promoteWinRate?: number; retireWinRate?: number } = {}): string {
  const halfLife = options.halfLifeDays ?? RULE_DEFAULTS.halfLifeDays
  const minTests = options.promoteTests ?? RULE_DEFAULTS.promoteTests
  const promoteAt = options.promoteWinRate ?? RULE_DEFAULTS.promoteWinRate
  const retireAt = options.retireWinRate ?? RULE_DEFAULTS.retireWinRate
  const sorted = sortRules(rules)
  const accepted = sorted.filter(isProtected)
  const observed = sorted.filter((r) => !isProtected(r))
  const winning = observed.filter((r) => r.status === 'promoted')
  const losing = observed.filter((r) => r.status === 'retired')
  const candidates = observed.filter((r) => r.status === 'candidate')
  // The header says when the compile ran. A rule that compileRules() kept verbatim (pinned, or accepted by a person) keeps its old updatedAt, so the newest rule date is not the compile date; fall back to it only when no clock is given.
  const stamp = options.now?.toISOString() ?? rules.reduce<string | undefined>((m, r) => (m === undefined || r.updatedAt > m ? r.updatedAt : m), undefined)

  const header = [
    '# Learned rules (compiled): hypotheses under observation',
    '',
    `Compiled by \`booster rules compile\` from the packaging ledger${stamp ? ` on ${stamp.slice(0, 10)}` : ''}. Do not edit by hand.`,
    '',
    'Every compiled rule below is an observation under test from this channel\'s own small sample, not doctrine. None of them overrides docs/02-strategist-playbook.md or the other playbook files: where one disagrees with the doctrine, follow the doctrine and mention the observation only as a hypothesis worth testing, with its tests and wins. Only a person moves a rule into the playbook, with `booster retro --accept-rule "<rule>" --into playbook/<file>.md --yes`.',
    '',
    `Evidence gates [house]: a lever is marked winning so far at ${minTests} or more tests with a Laplace-smoothed win rate of ${pct(promoteAt)} or more, and losing so far at ${pct(retireAt)} or less; confidence halves every ${halfLife} days without a confirming win. A test is a win when the video's 7-day views reach the median of the channel's other 7-day reads, or its 7-day or 28-day decision was SEQUEL or EXPAND. These gates are not a significance test: a lever with no effect wins about half its reads, so at ${minTests} tests it still reaches winning so far ${pct(noEffectPromoteChance(minTests, promoteAt))} of the time.`,
    '',
  ]

  const more = (n: number, what: string): string => `- and ${n} more ${what} in data/rules.jsonl`
  const build = (withSlugs: boolean, acceptedN: number, winningN: number, losingN: number): string => {
    const lines = [...header]
    if (accepted.length > 0) {
      lines.push('## Accepted by a person', '')
      lines.push('These are playbook rules: a person accepted them.')
      for (const r of accepted.slice(0, acceptedN)) lines.push(ruleLine(r, withSlugs))
      if (acceptedN < accepted.length) lines.push(more(accepted.length - acceptedN, accepted.length - acceptedN === 1 ? 'accepted rule' : 'accepted rules'))
      lines.push('')
    }
    lines.push('## Under observation: winning so far')
    if (winning.length === 0) lines.push(`- none yet: ${plural(candidates.length, 'lever')} under test`)
    for (const r of winning.slice(0, winningN)) lines.push(ruleLine(r, withSlugs))
    if (winningN < winning.length) lines.push(more(winning.length - winningN, winning.length - winningN === 1 ? 'observation winning so far' : 'observations winning so far'))
    lines.push('', '## Under observation: losing so far')
    if (losing.length === 0) lines.push('- none')
    for (const r of losing.slice(0, losingN)) lines.push(ruleLine(r, withSlugs))
    if (losingN < losing.length) lines.push(more(losing.length - losingN, losing.length - losingN === 1 ? 'observation losing so far' : 'observations losing so far'))
    if (candidates.length > 0 && winning.length > 0) lines.push('', `Under test: ${plural(candidates.length, 'lever')} with fewer than ${minTests} tests or an undecided win rate.`)
    return `${lines.join('\n')}\n`
  }

  let withSlugs = true
  let acceptedN = accepted.length
  let winningN = winning.length
  let losingN = losing.length
  let content = build(withSlugs, acceptedN, winningN, losingN)
  if (content.length > LEARNED_RULES_MAX_CHARS) {
    withSlugs = false
    content = build(withSlugs, acceptedN, winningN, losingN)
  }
  while (content.length > LEARNED_RULES_MAX_CHARS && (acceptedN > 0 || winningN > 0 || losingN > 0)) {
    if (losingN > 0 && losingN >= winningN) losingN -= 1
    else if (winningN > 0) winningN -= 1
    else acceptedN -= 1
    content = build(withSlugs, acceptedN, winningN, losingN)
  }
  return content
}

/**
 * Write `00-learned-rules.md` into the playbook folder (atomic: temp file then
 * rename). Refuses content over the cap so the loader never truncates doctrine.
 * Returns the path written.
 */
export function writeLearnedRules(playbookDir: string, content: string): string {
  if (content.length > LEARNED_RULES_MAX_CHARS) throw new Error(`learned rules are ${content.length} characters; the cap is ${LEARNED_RULES_MAX_CHARS}. Render with renderLearnedRules().`)
  const dir = path.resolve(playbookDir)
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, LEARNED_RULES_FILE)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`)
  renameSync(tmp, target)
  return target
}
