/**
 * Promise contract (architecture 2.6).
 *
 * One `promise` sentence is written at package time. Wherever the promise must
 * survive (title, first seconds of the script, description line 1, thumbnail
 * text) this module checks deterministically that it did. Drift blocks the
 * stage: a title that promises one thing and an open that delivers another is
 * a CTR win that becomes a hook failure (rules R9, R12).
 *
 * Tokeniser is `tokens()` from titles.ts, so every surface is compared with the
 * same notion of "content word" the title/thumbnail overlap check uses.
 *
 * Exact rules (all evidence-tagged house defaults, see PROMISE_RULES):
 *
 *   overlap (every surface): share of the promise's unique content tokens that
 *     appear in the surface, 0-1. A promise with no content tokens gives 0 and
 *     fails every present surface.
 *   title: passes when the first `headChars` (40) characters share >= 1 content
 *     token with the promise AND the whole title carries >= `minCoverage`
 *     (0.5) of the promise tokens. The head is cut at exactly 40 characters;
 *     a word cut in half only counts if the visible part is itself a promise
 *     token, which is what a phone viewer sees.
 *   scriptHead: the text is trimmed to its first `headWords` (25) whitespace
 *     words (so a whole script may be passed) and passes at >= `minCoverage`.
 *   descriptionLine1: only the text before the first newline is read; passes at
 *     >= `minCoverage`.
 *   thumbnailText: passes when empty (the image carries it), otherwise when it
 *     does NOT repeat the title (titleThumbnailOverlap < thresholds
 *     .titleThumbOverlapMax; 0 when no title is given) AND shares >= 1 content
 *     token with the promise.
 *   overall: every present surface passes. With no surfaces present the report
 *     passes vacuously (nothing drifted) unless the promise itself is empty.
 */
import { tagged, thresholds } from './thresholds.js'
import { titleThumbnailOverlap, tokens } from './titles.js'

/**
 * Numeric gates of the promise contract. House defaults, owned here until the
 * thresholds owner moves them into thresholds.ts (see integration notes).
 */
export const PROMISE_RULES = {
  headChars: { value: 40, evidence: 'house', note: 'title characters a phone shows before truncating; the promise must start inside them' },
  headWords: { value: 25, evidence: 'house', note: 'spoken words (about ten seconds at 150 wpm) inside which the script must state the promise' },
  minCoverage: { value: 0.5, evidence: 'house', note: 'share of the promise content tokens a surface must carry to count as restating it' },
} as const

export type PromiseSurfaceName = 'title' | 'scriptHead' | 'descriptionLine1' | 'thumbnailText'

/** The surfaces a promise must survive on. Every field is optional; only present ones are checked. */
export interface PromiseSurfaces {
  title?: string
  /** The script, or its opening; only the first 25 words are read. */
  scriptHead?: string
  /** The description, or its first line; only the text before the first newline is read. */
  descriptionLine1?: string
  /** Text on the thumbnail; empty passes. */
  thumbnailText?: string
}

/** Result for one surface. */
export interface SurfaceCheck {
  surface: PromiseSurfaceName
  /** Share of promise content tokens present in the surface, 0-1. */
  overlap: number
  /** Promise tokens the surface carries. */
  shared: string[]
  /** Promise tokens the surface lacks. */
  missing: string[]
  pass: boolean
  reason: string
  /** Title only: promise tokens found inside the first 40 characters. */
  headShared?: string[]
  /** Thumbnail only: share of thumbnail words repeated from the title (titleThumbnailOverlap). */
  titleOverlap?: number
}

export interface PromiseReport {
  promise: string
  /** Unique content tokens of the promise, in order of first appearance. */
  promiseTokens: string[]
  surfaces: Partial<Record<PromiseSurfaceName, SurfaceCheck>>
  /** Surfaces that were present and therefore checked. */
  checked: PromiseSurfaceName[]
  /** Every present surface passed. */
  pass: boolean
  /** One line per failing surface: what drifted and how to fix it. Empty when pass is true. */
  drift: string[]
  /** Threshold values with evidence tags, for printing next to the verdict. */
  thresholdsUsed: string[]
}

/** Unique content tokens of a promise (or any text), in order of first appearance. */
export function promiseTokens(text: string): string[] {
  return [...new Set(tokens(text))]
}

/**
 * Share of `promiseToks` present in `text`, with the shared and missing tokens.
 * 0 when the promise has no tokens.
 */
export function coverage(promiseToks: string[], text: string): { overlap: number; shared: string[]; missing: string[] } {
  if (promiseToks.length === 0) return { overlap: 0, shared: [], missing: [] }
  const present = new Set(tokens(text))
  const shared = promiseToks.filter((t) => present.has(t))
  const missing = promiseToks.filter((t) => !present.has(t))
  return { overlap: shared.length / promiseToks.length, shared, missing }
}

/** The first `n` whitespace-separated words of a text, joined by single spaces. */
export function firstWords(text: string, n: number): string {
  return text.split(/\s+/).filter(Boolean).slice(0, Math.max(0, n)).join(' ')
}

/** Text before the first newline, trimmed. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? ''
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/**
 * Check that the promise survives on every surface given. See the module
 * comment for the exact rule per surface. Surfaces left undefined are not
 * checked; `pass` is true only when every present surface passes.
 */
export function checkPromise(promise: string, surfaces: PromiseSurfaces): PromiseReport {
  const promiseToks = promiseTokens(promise)
  const minCoverage = PROMISE_RULES.minCoverage.value
  const headChars = PROMISE_RULES.headChars.value
  const headWords = PROMISE_RULES.headWords.value
  const out: Partial<Record<PromiseSurfaceName, SurfaceCheck>> = {}
  const checked: PromiseSurfaceName[] = []
  const drift: string[] = []
  const thresholdsUsed = [
    `promise headChars ${headChars} [${PROMISE_RULES.headChars.evidence}]`,
    `promise headWords ${headWords} [${PROMISE_RULES.headWords.evidence}]`,
    `promise minCoverage ${minCoverage} [${PROMISE_RULES.minCoverage.evidence}]`,
  ]
  const emptyPromise = promiseToks.length === 0

  const record = (check: SurfaceCheck): void => {
    out[check.surface] = check
    checked.push(check.surface)
    if (!check.pass) drift.push(`${check.surface}: ${check.reason}`)
  }

  if (surfaces.title !== undefined) {
    const title = surfaces.title
    const whole = coverage(promiseToks, title)
    const headToks = new Set(tokens(title.slice(0, headChars)))
    const headShared = promiseToks.filter((t) => headToks.has(t))
    let pass = false
    let reason: string
    if (emptyPromise) reason = 'the promise has no content words; write a promise with a subject and a result'
    else if (headShared.length === 0) reason = `no promise word inside the first ${headChars} characters; front-load the promise (missing: ${whole.missing.join(', ') || 'none'})`
    else if (whole.overlap < minCoverage) reason = `the title carries ${pct(whole.overlap)} of the promise words, below ${pct(minCoverage)} (missing: ${whole.missing.join(', ')})`
    else {
      pass = true
      reason = `promise starts inside ${headChars} characters (${headShared.join(', ')}) and the title carries ${pct(whole.overlap)} of it`
    }
    record({ surface: 'title', overlap: whole.overlap, shared: whole.shared, missing: whole.missing, pass, reason, headShared })
  }

  if (surfaces.scriptHead !== undefined) {
    const head = firstWords(surfaces.scriptHead, headWords)
    const c = coverage(promiseToks, head)
    let pass = false
    let reason: string
    if (emptyPromise) reason = 'the promise has no content words'
    else if (c.overlap < minCoverage) reason = `the first ${headWords} words carry ${pct(c.overlap)} of the promise, below ${pct(minCoverage)}; state the promise before anything else (missing: ${c.missing.join(', ')})`
    else {
      pass = true
      reason = `the first ${headWords} words carry ${pct(c.overlap)} of the promise (${c.shared.join(', ')})`
    }
    record({ surface: 'scriptHead', overlap: c.overlap, shared: c.shared, missing: c.missing, pass, reason })
  }

  if (surfaces.descriptionLine1 !== undefined) {
    const line = firstLine(surfaces.descriptionLine1)
    const c = coverage(promiseToks, line)
    let pass = false
    let reason: string
    if (emptyPromise) reason = 'the promise has no content words'
    else if (c.overlap < minCoverage) reason = `description line 1 carries ${pct(c.overlap)} of the promise, below ${pct(minCoverage)}; restate the promise in the first line (missing: ${c.missing.join(', ')})`
    else {
      pass = true
      reason = `description line 1 carries ${pct(c.overlap)} of the promise (${c.shared.join(', ')})`
    }
    record({ surface: 'descriptionLine1', overlap: c.overlap, shared: c.shared, missing: c.missing, pass, reason })
  }

  if (surfaces.thumbnailText !== undefined) {
    const text = surfaces.thumbnailText.trim()
    const c = coverage(promiseToks, text)
    const maxRepeat = thresholds.titleThumbOverlapMax.value
    const titleOverlap = surfaces.title !== undefined ? titleThumbnailOverlap(surfaces.title, text) : 0
    thresholdsUsed.push(`titleThumbOverlapMax ${tagged('titleThumbOverlapMax')}`)
    let pass = false
    let reason: string
    if (text.length === 0) {
      pass = true
      reason = 'no thumbnail text: the image carries the promise'
    } else if (emptyPromise) reason = 'the promise has no content words'
    else if (titleOverlap >= maxRepeat) reason = `thumbnail text repeats ${pct(titleOverlap)} of its words from the title (limit ${pct(maxRepeat)}); show what the title tells instead of repeating it`
    else if (c.shared.length === 0) reason = `thumbnail text shares no word with the promise; add the stake, number, or object the promise names (${promiseToks.join(', ')})`
    else {
      pass = true
      reason = `thumbnail text shares "${c.shared.join(', ')}" with the promise and repeats only ${pct(titleOverlap)} of the title`
    }
    record({ surface: 'thumbnailText', overlap: c.overlap, shared: c.shared, missing: c.missing, pass, reason, titleOverlap })
  }

  if (emptyPromise && checked.length === 0) drift.push('promise: no content words; nothing can be checked against it')
  const pass = drift.length === 0
  return { promise, promiseTokens: promiseToks, surfaces: out, checked, pass, drift, thresholdsUsed }
}
