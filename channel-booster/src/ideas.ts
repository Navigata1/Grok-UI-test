import { ageInDays } from './outliers.js'
import { thresholds } from './thresholds.js'
import { topicTokens } from './topics.js'
import type { IdeaScore, IdeaVerdict, OutlierRow } from './types.js'

/**
 * Axis weights. Demand and packaging carry half the score on purpose:
 * a video nobody is looking for, or one you cannot package, is not an idea yet.
 */
export const IDEA_WEIGHTS: Record<keyof IdeaScore, number> = {
  demand: 0.25,
  packaging: 0.25,
  fit: 0.15,
  angle: 0.15,
  payoff: 0.1,
  feasibility: 0.1,
}

const AXIS_FIX: Record<keyof IdeaScore, string> = {
  demand: 'Demand is unproven. Find 3 outliers (>=5x channel median) on this topic in adjacent channels, or 3 audience comments asking for it, before spending a day on it.',
  packaging: 'You cannot see the thumbnail yet. Write 10 titles and sketch 3 thumbnail concepts now; if none makes you want to click, change the angle, not the topic.',
  fit: 'Wrong viewer. Ask who watched your last 5 videos and whether this is the next thing they would click; if not, reframe it for them or park it for a second channel.',
  angle: 'It is a clone. Add a twist the outlier did not have: a constraint, a stake, a contrast, a first-person test, or a contrarian claim.',
  payoff: 'The promise is bigger than the delivery. Decide what the viewer gets in the first 60 seconds and what they only get at the end, then check the title still tells the truth.',
  feasibility: 'Too expensive for the expected return. Cut scope to the version you can ship in the normal cycle, or bank it as a tentpole with its own timeline.',
}

/**
 * Sentinel for "demand=auto": the demand axis is not typed by a person but
 * resolved from an outlier scan with suggestDemand(). scoreIdea() refuses an
 * unresolved -1 so the sentinel can never leak into a verdict.
 */
export const DEMAND_AUTO = -1

function clamp05(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(5, value))
}

/**
 * Score an idea on the six axes and return a verdict with concrete fixes.
 * Throws when demand is still the DEMAND_AUTO sentinel (-1): call
 * suggestDemand() and resolveDemand() first.
 */
export function scoreIdea(score: IdeaScore): IdeaVerdict {
  if (score.demand === DEMAND_AUTO) {
    throw new Error('demand is "auto" (-1) and has not been resolved: run suggestDemand(topic, ranked) over an outlier scan and pass its score (resolveDemand) before scoring')
  }
  const clean: IdeaScore = {
    demand: clamp05(score.demand),
    packaging: clamp05(score.packaging),
    fit: clamp05(score.fit),
    angle: clamp05(score.angle),
    payoff: clamp05(score.payoff),
    feasibility: clamp05(score.feasibility),
  }
  const axes = Object.keys(IDEA_WEIGHTS) as Array<keyof IdeaScore>
  const total = Math.round(axes.reduce((sum, axis) => sum + (clean[axis] / 5) * IDEA_WEIGHTS[axis], 0) * 100)

  let verdict: IdeaVerdict['verdict'] = total >= 75 ? 'green' : total >= 55 ? 'yellow' : 'red'
  // Hard gates: no amount of feasibility rescues an idea with no demand or no packaging.
  if (clean.demand <= 1 || clean.packaging <= 1) verdict = 'red'
  else if (axes.some((axis) => clean[axis] <= 1) && verdict === 'green') verdict = 'yellow'

  const fixes = axes
    .filter((axis) => clean[axis] <= 2)
    .sort((a, b) => clean[a] - clean[b] || IDEA_WEIGHTS[b] - IDEA_WEIGHTS[a])
    .map((axis) => AXIS_FIX[axis])

  return { score: clean, total, verdict, fixes }
}

/**
 * Parse "demand=4,packaging=3,..." or "4,3,5,2,4,3" into an IdeaScore.
 *
 * The demand axis also accepts "auto" (named `demand=auto` or positional
 * `auto,3,5,2,4,3`), which yields demand: -1 (DEMAND_AUTO). -1 means "resolve
 * with suggestDemand()": the caller must replace it before scoreIdea(), which
 * throws on the sentinel. "auto" on any other axis is an error.
 */
export function parseIdeaScore(input: string): IdeaScore {
  const axes = Object.keys(IDEA_WEIGHTS) as Array<keyof IdeaScore>
  const score: IdeaScore = { demand: 0, packaging: 0, fit: 0, angle: 0, payoff: 0, feasibility: 0 }
  const parts = input.split(/[,\s]+/).filter(Boolean)
  const parseAxis = (axis: keyof IdeaScore, raw: string): number => {
    const value = raw.trim().toLowerCase()
    if (value === 'auto') {
      if (axis !== 'demand') throw new Error(`Only demand accepts "auto"; type a 0-5 number for ${axis}`)
      return DEMAND_AUTO
    }
    return Number.parseFloat(value)
  }
  const named = parts.every((p) => p.includes('='))
  if (named) {
    for (const part of parts) {
      const [key, value] = part.split('=')
      const axis = axes.find((a) => a === key.trim().toLowerCase())
      if (!axis) throw new Error(`Unknown axis "${key}". Use: ${axes.join(', ')}`)
      score[axis] = parseAxis(axis, value ?? '')
    }
    return score
  }
  if (parts.length !== axes.length) {
    throw new Error(`Give ${axes.length} numbers in order (${axes.join(', ')}) or name them like demand=4`)
  }
  axes.forEach((axis, i) => {
    score[axis] = parseAxis(axis, parts[i])
  })
  return score
}

/** The fields suggestDemand() reads from a ranked row; OutlierRow, OutlierRowV2 and bank sources all qualify. */
export type DemandRow = Pick<OutlierRow, 'title' | 'multiplier'> & Partial<Pick<OutlierRow, 'channel' | 'published' | 'url'>> & {
  tier?: string
  velocityMultiplier?: number
}

export interface DemandEvidence {
  title: string
  /** The row's views-vs-median multiplier. */
  multiplier: number
  channel?: string
  /** Days since publish at `now`; undefined when the row has no date. */
  ageDays?: number
  /** The row's publish date as given, so a bank source can carry it as `date`. */
  published?: string
  /** Present for a fresh-tier row: its velocity multiplier, which is what was scored. */
  velocityMultiplier?: number
  url?: string
}

export interface DemandSuggestion {
  /** 0-5 demand axis. */
  score: number
  /** Matching rows inside the window, strongest first. */
  evidence: DemandEvidence[]
  /** One line saying which rule produced the score. */
  reason: string
  /** Matching rows that were older than the window and therefore ignored. */
  staleMatches: number
  /** Window and the multipliers the rule used, for printing. */
  windowDays: number
}

export interface SuggestDemandOptions {
  /** Only rows published within this many days count. Default thresholds.demandWindowDays (90). */
  windowDays?: number
  /** Reference time for age math. Inject in tests. */
  now?: Date
}

/** [house] A match at this multiple of its channel median is a demand signal on its own; belongs in thresholds.ts as demandMatchMultiplier. */
export const DEMAND_MATCH_MULTIPLIER = 5

/**
 * Derive the demand axis from an outlier scan, with the rows that prove it.
 *
 * A row matches the topic when its title shares at least two content tokens
 * with the topic (one, when the topic has a single content token); format
 * words ("tried", "days", "review") never count. Undated rows are treated as
 * inside the window. A fresh-tier row is scored on its velocity multiplier.
 *
 * The scale, with x = the row's multiple of its channel median [house]:
 *   0  no matching row at >= 1x inside the window
 *   1  one match at >= 1x, none at >= 5x (the topic exists, nothing over-performs)
 *   2  two or more matches at >= 1x, none at >= 5x (recurring topic, no winner)
 *   3  one match at >= 5x (the anchor the scorecard names)
 *   4  two matches at >= 10x, or three at >= 5x (the fix-text bar: "find 3 outliers >= 5x")
 *   5  three matches at >= 10x (the scorecard's "multiple 10x outliers in 90 days")
 * The 5x and 10x bars are DEMAND_MATCH_MULTIPLIER and thresholds.outlierMultiplier.
 */
export function suggestDemand(topic: string, ranked: ReadonlyArray<DemandRow>, options: SuggestDemandOptions = {}): DemandSuggestion {
  const windowDays = options.windowDays ?? thresholds.demandWindowDays.value
  const now = options.now ?? new Date()
  const outlierX = thresholds.outlierMultiplier.value
  const strongX = thresholds.demandMatchMultiplier.value
  const want = topicTokens(topic)
  const required = Math.min(2, want.length)
  if (required === 0) {
    return { score: 0, evidence: [], reason: `"${topic}" has no content words to match on`, staleMatches: 0, windowDays }
  }

  const evidence: DemandEvidence[] = []
  let staleMatches = 0
  for (const row of ranked) {
    const have = new Set(topicTokens(row.title))
    const shared = want.filter((t) => have.has(t)).length
    if (shared < required) continue
    const age = ageInDays(row.published, now)
    if (age !== undefined && age > windowDays) {
      staleMatches += 1
      continue
    }
    const item: DemandEvidence = { title: row.title, multiplier: row.multiplier }
    if (row.channel !== undefined) item.channel = row.channel
    if (age !== undefined) item.ageDays = age
    if (row.published !== undefined) item.published = row.published
    if (row.tier === 'fresh' && row.velocityMultiplier !== undefined) item.velocityMultiplier = row.velocityMultiplier
    if (row.url !== undefined) item.url = row.url
    evidence.push(item)
  }
  const scoredX = (e: DemandEvidence): number => Math.max(e.multiplier, e.velocityMultiplier ?? 0)
  evidence.sort((a, b) => scoredX(b) - scoredX(a) || a.title.localeCompare(b.title))

  const n10 = evidence.filter((e) => scoredX(e) >= outlierX).length
  const n5 = evidence.filter((e) => scoredX(e) >= strongX).length
  const n1 = evidence.filter((e) => scoredX(e) >= 1).length

  let score: number
  let reason: string
  if (n10 >= 3) {
    score = 5
    reason = `${n10} matches at >= ${outlierX}x inside ${windowDays} days`
  } else if (n10 >= 2 || n5 >= 3) {
    score = 4
    reason = n10 >= 2 ? `${n10} matches at >= ${outlierX}x inside ${windowDays} days` : `${n5} matches at >= ${strongX}x inside ${windowDays} days`
  } else if (n5 >= 1) {
    score = 3
    reason = `${n5} match${n5 === 1 ? '' : 'es'} at >= ${strongX}x inside ${windowDays} days`
  } else if (n1 >= 2) {
    score = 2
    reason = `${n1} matches at >= 1x but none at >= ${strongX}x inside ${windowDays} days`
  } else if (n1 === 1) {
    score = 1
    reason = `one match at >= 1x, none at >= ${strongX}x inside ${windowDays} days`
  } else {
    score = 0
    reason = evidence.length > 0
      ? `${evidence.length} match${evidence.length === 1 ? '' : 'es'} inside ${windowDays} days, all below channel median`
      : staleMatches > 0
        ? `no match inside ${windowDays} days (${staleMatches} older)`
        : `no match inside ${windowDays} days`
  }
  return { score, evidence, reason, staleMatches, windowDays }
}

/** Replace a DEMAND_AUTO (-1) demand with the suggested score; other scores pass through unchanged. */
export function resolveDemand(score: IdeaScore, suggestion: Pick<DemandSuggestion, 'score'>): IdeaScore {
  if (score.demand !== DEMAND_AUTO) return { ...score }
  return { ...score, demand: suggestion.score }
}

/** The questions a strategist answers to fill each axis. Used by the CLI and the skills. */
export const IDEA_AXIS_QUESTIONS: Record<keyof IdeaScore, string> = {
  demand: 'How many outliers, search results, or explicit audience requests prove people already want this? (0 none, 5 multiple 10x outliers in the last 90 days; or "auto" to read it from the outlier scan)',
  packaging: 'Can you already see a thumbnail and title that a stranger would click? (0 no image, 5 the thumbnail is obvious and the title writes itself)',
  fit: 'Would the exact viewer of your last three videos click this next? (0 different audience, 5 same viewer, same need)',
  angle: 'What does your version have that the winning videos do not? (0 straight copy, 5 a twist that makes the original look incomplete)',
  payoff: 'Can the video deliver the promise early and keep paying it off? (0 promise bigger than delivery, 5 payoff in 60s and escalating)',
  feasibility: 'Can you ship it at the quality bar inside a normal production cycle? (0 needs a crew and a month, 5 ship this week)',
}
