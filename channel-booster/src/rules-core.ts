/**
 * Pure learned-rule presentation: the smoothed win rate, the rule sentences
 * and the labels a person or a model reads. No store and no filesystem, so
 * the brief and the browser bundle can use it. rules.ts re-exports
 * everything here and adds the compiler and the playbook writer.
 *
 * A compiled rule is a hypothesis under observation, never doctrine. The
 * store keeps the status names `promoted` and `retired`; what is shown says
 * "winning so far" or "losing so far" under observation instead. Only a
 * rule a person accepted (`booster retro --accept-rule`) or pinned is
 * playbook.
 */
import type { RuleDoc } from './schema.js'

/** Laplace-smoothed win rate: (wins + 1) / (tests + 2). */
export function smoothedWinRate(wins: number, tests: number): number {
  return (wins + 1) / (tests + 2)
}

/**
 * The rule sentence for a lever at a status. Every compiled sentence is a
 * hypothesis, never an instruction: a lever that is winning so far "may
 * help", one that is losing so far "may not help".
 */
export function ruleText(lever: string, status: RuleDoc['status']): string {
  if (status === 'retired') return `Hypothesis under observation: "${lever}" may not help on this channel`
  if (status === 'candidate') return `"${lever}" is under test on this channel`
  return `Hypothesis under observation: "${lever}" may help on this channel`
}

/** What a person reads for each status. `promoted` and `retired` are store values, not verdicts. */
export const STATUS_LABELS: Readonly<Record<RuleDoc['status'] | 'new', string>> = {
  new: 'new',
  candidate: 'under test',
  promoted: 'winning so far',
  retired: 'losing so far',
  pinned: 'pinned',
}

/** The label for a status, for status diffs such as `new -> winning so far`. */
export function statusLabel(status: RuleDoc['status'] | 'new'): string {
  return STATUS_LABELS[status]
}

/** A rule the compiler must leave alone: pinned, or accepted by a person. */
export function isProtected(rule: RuleDoc): boolean {
  return rule.pinned || rule.status === 'pinned' || Boolean(rule.acceptedBy)
}

/**
 * Where a rule stands, in the words a person reads: a rule a person accepted
 * or pinned is playbook; every compiled rule is under observation or under test.
 */
export function ruleStanding(rule: RuleDoc): string {
  if (rule.acceptedBy) return `accepted by ${rule.acceptedBy}`
  if (rule.pinned || rule.status === 'pinned') return 'pinned by a person'
  if (rule.status === 'candidate') return statusLabel('candidate')
  return `under observation, ${statusLabel(rule.status)}`
}

/**
 * The sentence to show for a rule. A person's rule is shown as written. A
 * compiled rule is rebuilt from its lever and status, so a row an older
 * compile wrote with instruction wording still reads as a hypothesis.
 */
export function ruleSentence(rule: RuleDoc): string {
  if (isProtected(rule) || !rule.lever) return rule.rule
  return ruleText(rule.lever, rule.status)
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The evidence behind a rule: tests, wins, smoothed win rate and decayed confidence. */
export function ruleEvidence(rule: RuleDoc): string {
  return `${plural(rule.tests, 'test')}, ${plural(rule.wins, 'win')}, smoothed win rate ${pct(smoothedWinRate(rule.wins, rule.tests))}, confidence ${pct(rule.confidence)}`
}

/**
 * One line for a person (rules compile, rules show, the brief): the standing
 * first, then the lever or the person's rule, then the evidence. A person's
 * rule shows evidence only when it has some.
 */
export function describeRule(rule: RuleDoc): string {
  if (isProtected(rule)) return `${ruleStanding(rule)}: ${rule.rule}${rule.tests > 0 ? ` (${ruleEvidence(rule)})` : ''}`
  return `${ruleStanding(rule)}: "${rule.lever ?? rule.rule}" (${ruleEvidence(rule)})`
}

/**
 * The chance that a lever with no effect clears the promote gate at exactly
 * `tests` tests, when each test is a fair coin (a win is a read at or above a
 * median, so a lever with no effect wins about half its reads). Binomial
 * arithmetic on the [house] gate, not a measured rate; decay is ignored.
 */
export function noEffectPromoteChance(tests: number, promoteWinRate: number): number {
  const n = Math.max(0, Math.floor(tests))
  let coefficient = 1
  let total = 0
  for (let k = 0; k <= n; k += 1) {
    if (k > 0) coefficient = (coefficient * (n - k + 1)) / k
    if (smoothedWinRate(k, n) >= promoteWinRate) total += coefficient
  }
  return total / 2 ** n
}
