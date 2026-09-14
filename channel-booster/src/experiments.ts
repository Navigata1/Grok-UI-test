/**
 * Test & Compare protocol (architecture 2.10, rule R12).
 *
 * YouTube's Test & Compare serves two or three thumbnails and reports each
 * variant's share of watch time. The house rule this module enforces: the
 * winner is decided by watch-time share, not CTR, because a CTR winner that
 * loses watch time promised something the video did not keep. That result is
 * routed to the hook (the open, the promise), never to another thumbnail
 * round. Experiment rows never count while the read is inconclusive.
 *
 * Decision order in `judgeTest()`:
 *   1. too-early     any variant under the impression floor, or the test under
 *                    the hour floor (2,000 impressions / 7 days in cold start).
 *   2. over-promise  the CTR leader is not the winner on the decisive metric and
 *                    its AVD or watch-time share is >= overPromiseDropPct (10 %)
 *                    lower, relative, than the best other variant.
 *   3. no-difference the top two are within 3 points of watch-time share (or
 *                    3 % relative on AVD / CTR when share is missing).
 *   4. clear-winner  otherwise; winner by watch-time share when every variant
 *                    has it, else AVD, else CTR (CTR-only verdicts say so).
 *
 * The platform mechanics (three variants, share of watch time, Winner /
 * Preferred / None) are [unverified]; every number here is a house default.
 */
import type { Evidence } from './thresholds.js'
import type { ExperimentDoc } from './schema.js'

/**
 * Numeric gates of the Test & Compare judge. House defaults, owned here until
 * the thresholds owner moves them into thresholds.ts (see integration notes).
 */
export const TEST_RULES = {
  minImpressions: { value: 1000, evidence: 'house', note: 'impressions each variant needs before the test can be judged' },
  minHours: { value: 72, evidence: 'house', note: 'hours a test runs before it can be judged; browse traffic arrives over days' },
  coldStartMinImpressions: { value: 2000, evidence: 'house', note: 'impression floor per variant on a channel with no baseline' },
  coldStartMinHours: { value: 168, evidence: 'house', note: 'hour floor (7 days) on a channel with no baseline' },
  overPromiseDropPct: { value: 10, evidence: 'house', note: 'the CTR leader with AVD or watch-time share this much lower (relative) than the other variant over-promised' },
  noDifferenceSharePts: { value: 3, evidence: 'house', note: 'watch-time shares closer than this many points taught nothing' },
  noDifferenceRelPct: { value: 3, evidence: 'house', note: 'AVD or CTR closer than this relative percent taught nothing (used only when share is missing)' },
} as const satisfies Record<string, { value: number; evidence: Evidence; note: string }>

/** One Test & Compare variant as Studio reports it. Names are what the creator called the thumbnails (A, B, "stakes"...). */
export interface TestVariant {
  name: string
  impressions: number
  /** Click-through rate, percent. */
  ctr: number
  /** Share of the test's watch time this variant earned, percent. Studio's Test & Compare panel shows it; the winner is decided here. */
  watchTimeSharePct?: number
  /** Average view duration, seconds. Used when the share is not typed. */
  avdSec?: number
}

export interface JudgeOptions {
  /** Hours the test has been running at the time of the read. */
  hoursRunning: number
  /** Impression floor per variant. Defaults to TEST_RULES (2,000 in cold start). */
  minImpressions?: number
  /** Hour floor for the test. Defaults to TEST_RULES (168 in cold start). */
  minHours?: number
  /** Relative percent the CTR leader may lose on AVD / share before it is an over-promise. Default 10. */
  overPromiseDropPct?: number
  /** Channel with no baseline yet: stricter floors. */
  coldStart?: boolean
}

export type TestOutcome = 'too-early' | 'clear-winner' | 'over-promise' | 'no-difference'
export type TestRoute = 'ship' | 'hook' | 'thumbnail' | 'wait'
export type DecisiveMetric = 'watchTimeShare' | 'avd' | 'ctr'

export interface Judgement {
  outcome: TestOutcome
  /** The variant to keep: the watch-time winner (also on over-promise, where it is the honest variant). */
  winner?: string
  /** The variant with the highest CTR, for the record. */
  ctrLeader?: string
  /** Which metric decided the verdict. */
  metric: DecisiveMetric
  reason: string
  /** Where the next unit of work goes: ship the winner, fix the hook, another thumbnail angle, or wait. */
  route: TestRoute
  hoursRunning: number
  /** Threshold values with evidence tags, for printing next to the verdict. */
  thresholdsUsed: string[]
}

function pct(x: number): string {
  return `${Math.round(x * 10) / 10}%`
}

function tag(key: keyof typeof TEST_RULES, value: number, suffix = ''): string {
  return `${key} ${value}${suffix} [${TEST_RULES[key].evidence}]`
}

/** Relative drop of `a` below `b`, percent; 0 when b is 0 or a >= b. */
function relDropPct(a: number, b: number): number {
  if (b <= 0 || a >= b) return 0
  return ((b - a) / b) * 100
}

function metricValue(v: TestVariant, metric: DecisiveMetric): number {
  if (metric === 'watchTimeShare') return v.watchTimeSharePct ?? 0
  if (metric === 'avd') return v.avdSec ?? 0
  return v.ctr
}

function metricLabel(metric: DecisiveMetric): string {
  return metric === 'watchTimeShare' ? 'watch-time share' : metric === 'avd' ? 'average view duration' : 'CTR'
}

/** The metric the verdict rests on: watch-time share when every variant has it, else AVD, else CTR. */
export function decisiveMetric(variants: TestVariant[]): DecisiveMetric {
  if (variants.every((v) => typeof v.watchTimeSharePct === 'number')) return 'watchTimeShare'
  if (variants.every((v) => typeof v.avdSec === 'number')) return 'avd'
  return 'ctr'
}

/**
 * Judge a Test & Compare read. Throws on fewer than two variants (that is not
 * a test). Never reads the clock: `hoursRunning` is an input.
 */
export function judgeTest(variants: TestVariant[], options: JudgeOptions): Judgement {
  if (variants.length < 2) throw new Error('a Test & Compare needs at least two variants')
  const names = new Set(variants.map((v) => v.name))
  if (names.size !== variants.length) throw new Error('variant names must be distinct')
  const coldStart = options.coldStart ?? false
  const minImpressions = options.minImpressions ?? (coldStart ? TEST_RULES.coldStartMinImpressions.value : TEST_RULES.minImpressions.value)
  const minHours = options.minHours ?? (coldStart ? TEST_RULES.coldStartMinHours.value : TEST_RULES.minHours.value)
  const overPromiseDropPct = options.overPromiseDropPct ?? TEST_RULES.overPromiseDropPct.value
  const hoursRunning = options.hoursRunning
  const metric = decisiveMetric(variants)
  const thresholdsUsed = [
    tag(coldStart ? 'coldStartMinImpressions' : 'minImpressions', minImpressions),
    tag(coldStart ? 'coldStartMinHours' : 'minHours', minHours, ' h'),
    tag('overPromiseDropPct', overPromiseDropPct, '%'),
    metric === 'watchTimeShare' ? tag('noDifferenceSharePts', TEST_RULES.noDifferenceSharePts.value, ' pts') : tag('noDifferenceRelPct', TEST_RULES.noDifferenceRelPct.value, '%'),
  ]
  const base = { metric, hoursRunning, thresholdsUsed }
  const mode = coldStart ? ' (cold start)' : ''

  // 1. too-early
  const thin = variants.filter((v) => v.impressions < minImpressions)
  if (thin.length > 0) {
    return {
      ...base,
      outcome: 'too-early',
      route: 'wait',
      reason: `${thin.map((v) => `${v.name} has ${v.impressions} impressions`).join(', ')}; each variant needs ${minImpressions}${mode}. Do not count this row yet.`,
    }
  }
  if (hoursRunning < minHours) {
    return {
      ...base,
      outcome: 'too-early',
      route: 'wait',
      reason: `${Math.round(hoursRunning)} h running; the test needs ${minHours} h${mode} before a read. Do not count this row yet.`,
    }
  }

  const byMetric = [...variants].sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
  const byCtr = [...variants].sort((a, b) => b.ctr - a.ctr)
  const top = byMetric[0]
  const second = byMetric[1]
  const ctrLeader = byCtr[0]
  const fmt = (v: TestVariant) => (metric === 'avd' ? `${Math.round(metricValue(v, metric))} s` : pct(metricValue(v, metric)))

  // 2. over-promise: the CTR leader lost on AVD or share by the drop margin
  if (ctrLeader.name !== top.name && metric !== 'ctr') {
    const drops: string[] = []
    const shareDrop = typeof ctrLeader.watchTimeSharePct === 'number' && typeof top.watchTimeSharePct === 'number' ? relDropPct(ctrLeader.watchTimeSharePct, top.watchTimeSharePct) : 0
    const avdDrop = typeof ctrLeader.avdSec === 'number' && typeof top.avdSec === 'number' ? relDropPct(ctrLeader.avdSec, top.avdSec) : 0
    if (shareDrop >= overPromiseDropPct) drops.push(`watch-time share ${pct(ctrLeader.watchTimeSharePct!)} vs ${pct(top.watchTimeSharePct!)} (${pct(shareDrop)} lower)`)
    if (avdDrop >= overPromiseDropPct) drops.push(`AVD ${Math.round(ctrLeader.avdSec!)} s vs ${Math.round(top.avdSec!)} s (${pct(avdDrop)} lower)`)
    if (drops.length > 0) {
      return {
        ...base,
        outcome: 'over-promise',
        winner: top.name,
        ctrLeader: ctrLeader.name,
        route: 'hook',
        reason: `${ctrLeader.name} won CTR (${pct(ctrLeader.ctr)} vs ${pct(top.ctr)}) but lost ${drops.join(' and ')}: it promised something the open did not keep. Keep ${top.name}; fix the hook and the promise, not the thumbnail.`,
      }
    }
  }

  // 3. no-difference
  const a = metricValue(top, metric)
  const b = metricValue(second, metric)
  const close = metric === 'watchTimeShare' ? Math.abs(a - b) < TEST_RULES.noDifferenceSharePts.value : relDropPct(b, a) < TEST_RULES.noDifferenceRelPct.value
  if (close) {
    return {
      ...base,
      outcome: 'no-difference',
      ctrLeader: ctrLeader.name,
      route: 'thumbnail',
      reason: `${top.name} ${fmt(top)} and ${second.name} ${fmt(second)} on ${metricLabel(metric)} are too close to teach anything. Next test: a more distant thumbnail angle.`,
    }
  }

  // 4. clear-winner
  const caveat = metric === 'ctr' ? ' No watch-time share or AVD was typed, so this rests on CTR alone; type the Test & Compare panel numbers to confirm.' : ''
  return {
    ...base,
    outcome: 'clear-winner',
    winner: top.name,
    ctrLeader: ctrLeader.name,
    route: 'ship',
    reason: `${top.name} leads on ${metricLabel(metric)} (${fmt(top)} vs ${fmt(second)}).${caveat} Ship ${top.name}; log the lever.`,
  }
}

export interface ExperimentDocOptions {
  kind?: ExperimentDoc['kind']
  /** When the test started. Defaults to `now` minus the judgement's hoursRunning. */
  startedAt?: string
  source?: string
}

/**
 * The stored experiment row for a judged read. Id is `<slug>:<n>` so a
 * re-import changes nothing. Outcome and winner are only stored when the read
 * is conclusive: a too-early row stays open (no outcome) so it never counts.
 */
export function toExperimentDoc(slug: string, n: number, variants: TestVariant[], judgement: Judgement, now: Date, options: ExperimentDocOptions = {}): ExperimentDoc {
  const startedAt = options.startedAt ?? new Date(now.getTime() - judgement.hoursRunning * 3_600_000).toISOString()
  const conclusive = judgement.outcome !== 'too-early'
  return {
    id: `${slug}:${n}`,
    slug,
    kind: options.kind ?? 'thumbnail',
    variants: variants.map((v) => ({ name: v.name, impressions: v.impressions, ctr: v.ctr, watchTimeSharePct: v.watchTimeSharePct, avdSec: v.avdSec })),
    startedAt,
    outcome: conclusive ? judgement.outcome : undefined,
    winner: conclusive ? judgement.winner : undefined,
    updatedAt: now.toISOString(),
    source: options.source ?? 'cli',
  }
}

/**
 * The ledger's `winner` letter for a judgement: "A" / "B" when the winning
 * variant is named that way, "none" for no-difference, undefined otherwise
 * (too early, or variants named differently; the CLI then leaves the row alone).
 */
export function winnerLetter(judgement: Judgement): 'A' | 'B' | 'none' | undefined {
  if (judgement.outcome === 'no-difference') return 'none'
  if (judgement.outcome === 'too-early') return undefined
  const w = judgement.winner?.trim().toUpperCase()
  return w === 'A' || w === 'B' ? w : undefined
}

/** A judgement as the lines the CLI prints. */
export function renderJudgement(judgement: Judgement): string {
  const head = `Test & Compare: ${judgement.outcome.toUpperCase()}${judgement.winner ? ` · keep ${judgement.winner}` : ''} · route: ${judgement.route}`
  return [head, judgement.reason, `Decided on: ${metricLabel(judgement.metric)} after ${Math.round(judgement.hoursRunning)} h`, `Thresholds: ${judgement.thresholdsUsed.join('; ')}`].join('\n')
}
