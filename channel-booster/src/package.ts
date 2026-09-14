/**
 * Package builder with a deterministic QA loop (architecture 2.5).
 *
 * A package is a promise, a title, and two thumbnail concepts that a
 * stranger would click next to the best competing videos. This module owns
 * the four gates every package must clear before the story stage may start:
 *
 *   titleGate    scoreTitle(chosenTitle) >= thresholds.titleGateScore, and the
 *                title inside thresholds.titleMinChars..titleMaxChars, the same
 *                band `publish check` applies to the title it receives from here
 *   overlapGate  titleThumbnailOverlap(chosenTitle, text) < thresholds.titleThumbOverlapMax
 *                for both concepts of the A/B pair (the title tells, the thumbnail shows)
 *   thumbGate    qaThumbnail() grade "ship" on the A and B concepts, and their `angle`
 *                values differ (two levers in Test & Compare, not one lever twice)
 *   promiseGate  checkPromise() passes on the chosen title and on the A/B thumbnail text
 *
 * `reviewPackage()` runs the gates on one pair (the `booster package review`
 * fast path; it now calls qaThumbnail so colour, emotion and background rules
 * are judged when a spec is given). `buildPackage()` generates titles and
 * concepts, QA's every concept, picks A and B, and, when generation hooks are
 * given, feeds every failed gate's fixes back into the hooks for up to
 * `rounds` rounds (`prompts/package-fix.md`). Offline it uses generateTitles()
 * and buildThumbnailBrief(), which are deterministic, so the loop runs once.
 *
 * The sheet (`package.md`) leaves three blank lines for the human's own
 * titles: an agent prepares, a person picks (AGENTS.md, human gate 2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { checkPromise, type PromiseReport } from './promise.js'
import { stableId, type Signature } from './schema.js'
import { describeSignature } from './signature.js'
import { tagged, thresholds } from './thresholds.js'
import { THUMBNAIL_QA_CHECKLIST, THUMBNAIL_RULES, THUMBNAIL_TEST_PLAN, buildThumbnailBrief, qaThumbnail } from './thumbnails.js'
import { generateTitles, scoreTitle, titleThumbnailOverlap } from './titles.js'
import type { ThumbnailConcept, ThumbnailQa, ThumbnailSpec, TitleCandidate } from './types.js'
import { slugify } from './workflow.js'

/** Concepts a package needs at grade "ship" with distinct angles before it may leave packaging (architecture 2.5; house). */
export const MIN_SHIP_CONCEPTS = 2
/** Fix rounds the generation loop runs before it gives up and emits the package with its failed gates recorded (architecture 2.5; house). */
export const DEFAULT_ROUNDS = 3
/** Blank "your own title" lines on the sheet (architecture 2.5: the human writes three titles by hand). */
export const OWN_TITLE_LINES = 3
/** Colour pair the offline concepts use when the channel has no signature yet: the first pair in the high-contrast table (house). */
export const DEFAULT_COLOR_PAIR: readonly string[] = ['yellow', 'black']
/** Background the offline concepts specify; a clean ground never trips the busy-background rule (house). */
export const DEFAULT_BACKGROUND = 'clean gradient'

/** Emotion the offline concepts give a face, per lever, so a person in frame is never expressionless (house). */
const ANGLE_EMOTION: Record<ThumbnailConcept['angle'], string> = {
  result: 'proud',
  stakes: 'worried',
  curiosity: 'curious',
  contrast: 'none',
  identity: 'confident',
}

export type PackageVerdict = 'pass' | 'revise' | 'fail'

/** One gate: whether it passed and the one-line reason, with its threshold tag where one applies. */
export interface Gate {
  pass: boolean
  reason: string
}

/** The four gates plus the overall verdict the workflow runner reads (`gateReport.pass`). */
export interface GateReport {
  titleGate: Gate
  overlapGate: Gate
  thumbGate: Gate
  promiseGate: Gate
  /** Every gate passed. */
  pass: boolean
  /** Threshold values with evidence tags, for printing next to the verdict. */
  thresholdsUsed: string[]
}

export interface ReviewInput {
  title: string
  /** Text on the thumbnail; empty or absent means the image carries it. */
  thumbnailText?: string
  /** Every visual element, when no full spec is given (fast path). */
  elements?: string[]
  /** Full concept spec; when given, qaThumbnail() judges colour, emotion and background too. */
  spec?: ThumbnailSpec
  /** The promise sentence; when given, checkPromise() runs on the title and thumbnail text. */
  promise?: string
  signature?: Signature
}

export interface PackageReview {
  verdict: PackageVerdict
  title: string
  thumbnailText: string
  titleScore: number
  titleNotes: string[]
  /** Share of thumbnail words repeated from the title, 0-1. */
  overlap: number
  qa?: ThumbnailQa
  promiseCheck?: PromiseReport
  /** One line per problem; zero means pass, one means revise, two or more means fail (playbook/packaging-review.md). */
  issues: string[]
  gateReport: GateReport
}

/** A title as the package stores it: heuristic score plus the formula (offline) or lever (model) that produced it. */
export interface PackageTitle {
  title: string
  score: number
  formula?: string
  lever?: string
  notes: string[]
}

/** What a titles hook returns: a title and, optionally, the formula or lever behind it. Scores are recomputed here. */
export interface TitleInput {
  title: string
  formula?: string
  lever?: string
  score?: number
  notes?: string[]
}

/**
 * What a concepts hook returns: a ThumbnailSpec-like object. `elements` may be
 * omitted (derived from the subject, the supporting element and the text);
 * `angle` names the lever so two concepts of the same lever are never paired.
 */
export interface ConceptInput {
  name?: string
  angle?: string
  focalSubject: string
  emotion?: string
  elements?: string[]
  supportingElement?: string
  text?: string
  background?: string
  colors?: string[]
  composition?: string
  /** What to shoot or build (the model's designer_brief, or the brief's whyItWorks offline). */
  designerBrief?: string
}

/** A concept after QA, as the package stores it. */
export interface PackageThumbnail {
  name: string
  angle: string
  spec: ThumbnailSpec
  qa: ThumbnailQa
  /** Share of this concept's text repeated from the chosen title. */
  overlap: number
  /** Thumbnail-text surface of the promise check; absent without a promise. */
  promisePass?: boolean
  /** Ship grade, overlap under the limit, and the promise kept on the text. */
  eligible: boolean
  composition?: string
  designerBrief?: string
}

/** What a hook receives on every round: the round number, the fixes from the last round (empty on round 1) and the last output. */
export interface FixContext<T> {
  round: number
  fixes: string[]
  previous?: T[]
  /** The round's chosen title (concepts hook only), so concepts are designed against the title the gates score. */
  title?: string
}

export interface GenerateHooks {
  titles?: (ctx: FixContext<TitleInput>) => Promise<TitleInput[]>
  concepts?: (ctx: FixContext<ConceptInput>) => Promise<ConceptInput[]>
}

export interface BuildPackageInput {
  idea: string
  promise: string
  subject?: string
  stake?: string
  result?: string
  number?: string
  audience?: string
  signature?: Signature
  generate?: GenerateHooks
  /** Fix rounds when hooks are given; offline generation is deterministic and runs once. */
  rounds?: number
  /** The CTR multiple this package predicts, pre-registered with the levers. Defaults to 1 (no lift claimed). */
  predictedCtrMultiple?: number
  now?: Date
}

/** One round of the loop, for the sheet and the tests. */
export interface RoundRecord {
  round: number
  pass: boolean
  issues: string[]
  /** Fixes fed into the next round; empty when the round passed or was the last. */
  fixes: string[]
}

export interface PackageDoc {
  /** stableId('package', slug). */
  id: string
  slug: string
  idea: string
  promise: string
  titles: PackageTitle[]
  chosenTitle: string
  thumbnails: PackageThumbnail[]
  abPick: { a: string; b: string; reason: string }
  designerBrief: string[]
  hypothesis: { levers: string[]; angle?: string; predictedCtrMultiple: number }
  gateReport: GateReport
  rounds: number
  history: RoundRecord[]
  /** Three empty strings; the human writes titles here before the review. */
  ownTitles: string[]
  createdAt: string
}

const GateSchema = z.object({ pass: z.boolean(), reason: z.string() })
const QaSchema = z.object({ score: z.number(), grade: z.enum(['ship', 'revise', 'rethink']), passes: z.array(z.string()), failures: z.array(z.string()), fixes: z.array(z.string()) })
const SpecSchema = z.object({
  focalSubject: z.string(),
  emotion: z.string().optional(),
  elements: z.array(z.string()),
  text: z.string().optional(),
  background: z.string().optional(),
  colors: z.array(z.string()).optional(),
  title: z.string().optional(),
})

/** Zod shape of package.json, so readPackage() refuses a hand-edited file that no longer fits. */
export const PackageDocSchema = z.object({
  id: z.string(),
  slug: z.string().min(1),
  idea: z.string().min(1),
  promise: z.string(),
  titles: z.array(z.object({ title: z.string(), score: z.number(), formula: z.string().optional(), lever: z.string().optional(), notes: z.array(z.string()).default([]) })),
  chosenTitle: z.string(),
  thumbnails: z.array(z.object({
    name: z.string(),
    angle: z.string(),
    spec: SpecSchema,
    qa: QaSchema,
    overlap: z.number(),
    promisePass: z.boolean().optional(),
    eligible: z.boolean(),
    composition: z.string().optional(),
    designerBrief: z.string().optional(),
  })),
  abPick: z.object({ a: z.string(), b: z.string(), reason: z.string() }),
  designerBrief: z.array(z.string()).default([]),
  hypothesis: z.object({ levers: z.array(z.string()).default([]), angle: z.string().optional(), predictedCtrMultiple: z.number().default(1) }),
  gateReport: z.object({ titleGate: GateSchema, overlapGate: GateSchema, thumbGate: GateSchema, promiseGate: GateSchema, pass: z.boolean(), thresholdsUsed: z.array(z.string()).default([]) }),
  rounds: z.number().int().min(0),
  history: z.array(z.object({ round: z.number().int(), pass: z.boolean(), issues: z.array(z.string()), fixes: z.array(z.string()) })).default([]),
  ownTitles: z.array(z.string()).default(['', '', '']),
  createdAt: z.string().min(10),
})

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function wordCount(text: string | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

/** The threshold lines every gate report prints. */
function thresholdLines(): string[] {
  return [
    `titleGateScore ${tagged('titleGateScore')}`,
    `titleMinChars ${tagged('titleMinChars')}`,
    `titleMaxChars ${tagged('titleMaxChars')}`,
    `titleThumbOverlapMax ${tagged('titleThumbOverlapMax')}`,
    `thumbShipScore ${tagged('thumbShipScore')}`,
  ]
}

/** A title the publish checklist would accept: at or above the score gate and inside the mobile length band. */
function titlePublishable(title: string, score: number): boolean {
  return score >= thresholds.titleGateScore.value && title.length >= thresholds.titleMinChars.value && title.length <= thresholds.titleMaxChars.value
}

/**
 * Title gate for one title: the heuristic score and the mobile length band.
 * `publish check` (src/publish.ts) rejects a title outside titleMinChars..
 * titleMaxChars, and it reads the title this gate stamped, so passing one band
 * here and failing it there would stop the pipeline with nothing to fix.
 */
function titleGateFor(title: string, score: number): Gate {
  const gate = thresholds.titleGateScore.value
  const len = title.length
  if (score < gate) return { pass: false, reason: `title scores ${score}/100, below ${tagged('titleGateScore')}: rewrite before testing the thumbnail ("${title}")` }
  if (len < thresholds.titleMinChars.value || len > thresholds.titleMaxChars.value) {
    return { pass: false, reason: `title is ${len} characters; publish check needs ${tagged('titleMinChars')} to ${tagged('titleMaxChars')}: rewrite it before the story stage ("${title}")` }
  }
  return { pass: true, reason: `title scores ${score}/100, at or above ${tagged('titleGateScore')}, and is ${len} characters, inside ${thresholds.titleMinChars.value}-${thresholds.titleMaxChars.value}` }
}

/** Overlap gate for one title/text pair. */
function overlapGateFor(overlap: number, text: string): Gate {
  const max = thresholds.titleThumbOverlapMax.value
  if (overlap < max) return { pass: true, reason: text.trim() ? `thumbnail text repeats ${pct(overlap)} of the title, under ${pct(max)} [${thresholds.titleThumbOverlapMax.evidence}]` : 'no thumbnail text: nothing to repeat' }
  return { pass: false, reason: `thumbnail text repeats ${pct(overlap)} of the title (limit ${pct(max)} [${thresholds.titleThumbOverlapMax.evidence}]): the pair says one thing twice instead of two things once` }
}

/** Verdict from the issue count, as playbook/packaging-review.md rules: none pass, one revise, two or more fail. */
export function verdictFor(issues: string[]): PackageVerdict {
  return issues.length === 0 ? 'pass' : issues.length === 1 ? 'revise' : 'fail'
}

/**
 * Review one title/thumbnail pair against the four gates. Replaces the
 * inlined logic of `booster package review`: with a `spec` the concept goes
 * through qaThumbnail() (so colour, emotion, background and signature rules
 * apply); without one, only the word budget and element count are judged and
 * the thumb gate says so. With a `promise`, checkPromise() runs on the title
 * and the thumbnail text.
 */
export function reviewPackage(input: ReviewInput): PackageReview {
  const title = input.title
  const text = (input.spec?.text ?? input.thumbnailText ?? '').trim()
  const scored = scoreTitle(title)
  const overlap = titleThumbnailOverlap(title, text)
  const issues: string[] = []

  const titleGate = titleGateFor(title, scored.score)
  if (!titleGate.pass) issues.push(titleGate.reason)

  const overlapGate = overlapGateFor(overlap, text)
  if (!overlapGate.pass) issues.push(overlapGate.reason)

  let qa: ThumbnailQa | undefined
  let thumbGate: Gate
  if (input.spec) {
    qa = qaThumbnail({ ...input.spec, text, title: input.spec.title ?? title }, input.signature)
    if (qa.grade === 'ship') {
      thumbGate = { pass: true, reason: `thumbnail QA ${qa.score}/100 SHIP${qa.failures.length ? ` (noted: ${qa.failures.join('; ')})` : ''}` }
    } else {
      thumbGate = { pass: false, reason: `thumbnail QA ${qa.score}/100 ${qa.grade.toUpperCase()}: ${qa.failures.join('; ')}` }
      issues.push(...qa.failures.map((f) => `thumbnail: ${f}`))
    }
  } else {
    const problems: string[] = []
    const words = wordCount(text)
    const maxWords = thresholds.thumbMaxWords.value
    const maxElements = thresholds.thumbMaxElements.value
    const elements = (input.elements ?? []).filter((e) => e.trim())
    if (words > maxWords) problems.push(`thumbnail text is ${words} words, longer than ${tagged('thumbMaxWords')}`)
    if (elements.length > maxElements) problems.push(`thumbnail has ${elements.length} elements; cut to ${tagged('thumbMaxElements')}`)
    issues.push(...problems)
    thumbGate = problems.length === 0
      ? { pass: true, reason: `text ${words} word(s), ${elements.length} element(s); no spec given, so colour, emotion and background were not judged (run booster thumbnail qa)` }
      : { pass: false, reason: problems.join('; ') }
  }

  let promiseCheck: PromiseReport | undefined
  let promiseGate: Gate
  if (input.promise !== undefined) {
    promiseCheck = checkPromise(input.promise, { title, thumbnailText: text })
    promiseGate = promiseCheck.pass
      ? { pass: true, reason: 'the promise survives on the title and the thumbnail text' }
      : { pass: false, reason: promiseCheck.drift.join('; ') }
    issues.push(...promiseCheck.drift.map((d) => `promise: ${d}`))
  } else {
    promiseGate = { pass: true, reason: 'no promise given; not checked (write one at package time)' }
  }

  const gateReport: GateReport = {
    titleGate,
    overlapGate,
    thumbGate,
    promiseGate,
    pass: titleGate.pass && overlapGate.pass && thumbGate.pass && promiseGate.pass,
    thresholdsUsed: [...thresholdLines(), `thumbMaxWords ${tagged('thumbMaxWords')}`, `thumbMaxElements ${tagged('thumbMaxElements')}`, ...(promiseCheck?.thresholdsUsed.filter((t) => t.startsWith('promise')) ?? [])],
  }
  return { verdict: verdictFor(issues), title, thumbnailText: text, titleScore: scored.score, titleNotes: scored.notes, overlap, qa, promiseCheck, issues, gateReport }
}

/** A brief concept as a QA spec: elements derived from subject, support and text; a per-lever emotion; the signature colours or the default pair. */
export function conceptToSpec(concept: ThumbnailConcept, title: string, signature?: Signature): ThumbnailSpec {
  const text = concept.text.trim()
  const elements = [concept.focalSubject, concept.supportingElement, text ? `text "${text}"` : ''].map((e) => e.trim()).filter(Boolean)
  return {
    focalSubject: concept.focalSubject,
    emotion: ANGLE_EMOTION[concept.angle],
    elements,
    text,
    background: DEFAULT_BACKGROUND,
    colors: [...(signature?.colors?.length ? signature.colors : DEFAULT_COLOR_PAIR)],
    title,
  }
}

/** Offline concepts: the five-lever brief converted to specs, with the brief's "why it works" as the designer note. */
function offlineConcepts(input: BuildPackageInput, title: string): ConceptInput[] {
  const brief = buildThumbnailBrief(input.idea, title, { subject: input.subject, stake: input.stake, result: input.result })
  return brief.concepts.map((c) => {
    const spec = conceptToSpec(c, title, input.signature)
    return { name: c.name, angle: c.angle, focalSubject: spec.focalSubject, emotion: spec.emotion, elements: spec.elements, text: spec.text, background: spec.background, colors: spec.colors, composition: c.composition, designerBrief: c.whyItWorks }
  })
}

function offlineTitles(input: BuildPackageInput): TitleInput[] {
  return generateTitles({ topic: input.idea, number: input.number, subject: input.subject, audience: input.audience }).map((t: TitleCandidate) => ({ title: t.title, formula: t.formula }))
}

/**
 * Rescore and rank titles; the hook's own score is ignored so the gate is one
 * function. A title publish check would reject on length sorts behind every
 * publishable one however well it scores: the first title here becomes
 * `chosenTitle`, and that is the title the publish stage receives.
 */
function rankTitles(inputs: TitleInput[]): PackageTitle[] {
  const seen = new Set<string>()
  const out: PackageTitle[] = []
  for (const t of inputs) {
    const title = t.title.trim()
    if (!title || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    const { score, notes } = scoreTitle(title)
    out.push({ title, score, formula: t.formula, lever: t.lever, notes })
  }
  return out.sort((a, b) => Number(titlePublishable(b.title, b.score)) - Number(titlePublishable(a.title, a.score)) || b.score - a.score)
}

/** A hook concept as a full spec: elements derived when missing. */
function toSpec(c: ConceptInput, title: string): ThumbnailSpec {
  const text = (c.text ?? '').trim()
  const elements = c.elements && c.elements.length > 0
    ? c.elements.map((e) => e.trim()).filter(Boolean)
    : [c.focalSubject, c.supportingElement ?? '', text ? `text "${text}"` : ''].map((e) => e.trim()).filter(Boolean)
  return { focalSubject: c.focalSubject, emotion: c.emotion, elements, text, background: c.background, colors: c.colors, title }
}

/** QA every concept against the chosen title, the signature and the promise. */
function qaConcepts(concepts: ConceptInput[], title: string, promise: string, signature?: Signature): PackageThumbnail[] {
  const max = thresholds.titleThumbOverlapMax.value
  return concepts.map((c, i) => {
    const spec = toSpec(c, title)
    const qa = qaThumbnail(spec, signature)
    const overlap = titleThumbnailOverlap(title, spec.text)
    const promisePass = promise.trim() ? checkPromise(promise, { title, thumbnailText: spec.text }).surfaces.thumbnailText?.pass ?? true : undefined
    return {
      name: c.name?.trim() || `Concept ${i + 1}`,
      angle: c.angle?.trim() || `concept-${i + 1}`,
      spec,
      qa,
      overlap,
      promisePass,
      eligible: qa.grade === 'ship' && overlap < max && promisePass !== false,
      composition: c.composition,
      designerBrief: c.designerBrief,
    }
  })
}

/** Strongest eligible concept as A, the strongest eligible with a different angle as B; falls back to ship grade, then to score, and says so. */
function pickAb(thumbs: PackageThumbnail[]): { a?: PackageThumbnail; b?: PackageThumbnail; reason: string } {
  if (thumbs.length === 0) return { reason: 'no concepts to pick from' }
  const byScore = (xs: PackageThumbnail[]) => [...xs].sort((x, y) => y.qa.score - x.qa.score)
  const eligible = byScore(thumbs.filter((t) => t.eligible))
  const shipped = byScore(thumbs.filter((t) => t.qa.grade === 'ship'))
  const all = byScore(thumbs)
  const a = eligible[0] ?? shipped[0] ?? all[0]
  const different = (pool: PackageThumbnail[]) => pool.find((t) => t !== a && t.angle !== a.angle)
  const bEligible = different(eligible)
  if (a.eligible && bEligible) {
    return { a, b: bEligible, reason: `A "${a.name}" is the strongest concept (QA ${a.qa.score}); B "${bEligible.name}" pulls a different lever (${bEligible.angle} vs ${a.angle}) at QA ${bEligible.qa.score}, so Test & Compare tests two ideas, not one twice.` }
  }
  const b = bEligible ?? different(shipped) ?? different(all) ?? all.find((t) => t !== a)
  const why: string[] = []
  if (!a.eligible) why.push(`A "${a.name}" is not eligible (${describeIneligible(a)})`)
  if (!b) why.push('no second concept exists')
  else if (!b.eligible) why.push(`B "${b.name}" is not eligible (${describeIneligible(b)})`)
  else if (b.angle === a.angle) why.push(`B "${b.name}" pulls the same lever as A (${a.angle})`)
  return { a, b, reason: `Provisional pair: ${why.join('; ')}. Fix the concepts before the review.` }
}

function describeIneligible(t: PackageThumbnail): string {
  const parts: string[] = []
  if (t.qa.grade !== 'ship') parts.push(`QA ${t.qa.score} ${t.qa.grade}`)
  if (t.overlap >= thresholds.titleThumbOverlapMax.value) parts.push(`text repeats ${pct(t.overlap)} of the title`)
  if (t.promisePass === false) parts.push('text drops the promise')
  return parts.join(', ') || 'unknown'
}

interface Evaluation {
  titles: PackageTitle[]
  chosen: PackageTitle
  thumbs: PackageThumbnail[]
  a?: PackageThumbnail
  b?: PackageThumbnail
  abReason: string
  gateReport: GateReport
  issues: string[]
  fixes: string[]
  titleSide: boolean
  thumbSide: boolean
}

/** Run every gate on one round's titles and concepts and write the fixes the next round must apply. */
function evaluate(titles: PackageTitle[], concepts: ConceptInput[], promise: string, signature?: Signature): Evaluation {
  const chosen = titles[0] ?? { title: '', score: 0, notes: ['no title generated'] }
  const thumbs = qaConcepts(concepts, chosen.title, promise, signature)
  const pick = pickAb(thumbs)
  const pair = [pick.a, pick.b].filter((t): t is PackageThumbnail => t !== undefined)
  const issues: string[] = []
  const fixes: string[] = []
  let titleSide = false
  let thumbSide = false

  const titleGate = titles.length === 0 ? { pass: false, reason: 'no title generated' } : titleGateFor(chosen.title, chosen.score)
  if (!titleGate.pass) {
    issues.push(titleGate.reason)
    titleSide = true
    fixes.push(`Title: "${chosen.title}" scores ${chosen.score}/100 (gate ${thresholds.titleGateScore.value}). Notes: ${chosen.notes.join('; ') || 'none'}. Write titles of ${thresholds.titleMinChars.value}-${thresholds.titleMaxChars.value} characters with the promise inside the first 40, a number or a named thing, one hook word up front, no shouting.`)
  }

  const worstOverlap = pair.reduce((m, t) => Math.max(m, t.overlap), 0)
  const overlapGate = pair.length === 0 ? { pass: false, reason: 'no concept to compare' } : overlapGateFor(worstOverlap, pair.map((t) => t.spec.text ?? '').join(' '))
  if (!overlapGate.pass) {
    issues.push(overlapGate.reason)
    thumbSide = true
    for (const t of pair.filter((x) => x.overlap >= thresholds.titleThumbOverlapMax.value)) {
      fixes.push(`Concept "${t.name}": the text "${t.spec.text}" repeats ${pct(t.overlap)} of the title "${chosen.title}". Show what the title tells: the stake, the number, the reaction or the object, in three words or fewer.`)
    }
  }

  const shipPair = pair.filter((t) => t.qa.grade === 'ship')
  const distinct = new Set(pair.map((t) => t.angle)).size
  let thumbGate: Gate
  if (pair.length >= MIN_SHIP_CONCEPTS && shipPair.length === pair.length && distinct === pair.length) {
    thumbGate = { pass: true, reason: `${pair.map((t) => `"${t.name}" (${t.angle}) QA ${t.qa.score}`).join(' and ')} ship with different levers` }
  } else {
    const why: string[] = []
    if (pair.length < MIN_SHIP_CONCEPTS) why.push(`only ${pair.length} concept(s)`)
    for (const t of pair.filter((x) => x.qa.grade !== 'ship')) why.push(`"${t.name}" QA ${t.qa.score} ${t.qa.grade}`)
    if (pair.length >= MIN_SHIP_CONCEPTS && distinct < pair.length) why.push(`both pull the ${pair[0]!.angle} lever`)
    thumbGate = { pass: false, reason: `need ${MIN_SHIP_CONCEPTS} ship-grade concepts with different angles: ${why.join('; ')}` }
    issues.push(thumbGate.reason)
    thumbSide = true
    for (const t of thumbs.filter((x) => x.qa.grade !== 'ship')) fixes.push(`Concept "${t.name}" (${t.angle}, QA ${t.qa.score}): ${t.qa.fixes.join(' ')}`)
    const shipAngles = new Set(thumbs.filter((t) => t.eligible).map((t) => t.angle))
    if (shipAngles.size < MIN_SHIP_CONCEPTS) fixes.push(`Return at least ${MIN_SHIP_CONCEPTS} ship-grade concepts pulling different levers (result, stakes, curiosity, contrast, identity); ${shipAngles.size} lever(s) ship today${shipAngles.size ? ` (${[...shipAngles].join(', ')})` : ''}.`)
  }

  let promiseGate: Gate
  if (!promise.trim()) {
    promiseGate = { pass: false, reason: 'no promise written; write one sentence the video keeps' }
    issues.push(promiseGate.reason)
    titleSide = true
  } else {
    const titleCheck = checkPromise(promise, { title: chosen.title })
    const drift = [...titleCheck.drift]
    for (const t of pair) {
      const c = checkPromise(promise, { title: chosen.title, thumbnailText: t.spec.text ?? '' }).surfaces.thumbnailText
      if (c && !c.pass) drift.push(`thumbnailText ("${t.name}"): ${c.reason}`)
    }
    promiseGate = drift.length === 0
      ? { pass: true, reason: 'the promise survives on the title and both thumbnail texts' }
      : { pass: false, reason: drift.join('; ') }
    if (drift.length) {
      issues.push(...drift.map((d) => `promise: ${d}`))
      if (!titleCheck.pass) {
        titleSide = true
        fixes.push(`Promise "${promise}": ${titleCheck.drift.join('; ')}. Every title must carry the promise words (${titleCheck.promiseTokens.join(', ')}) inside the first 40 characters.`)
      }
      for (const t of pair) {
        const c = checkPromise(promise, { title: chosen.title, thumbnailText: t.spec.text ?? '' }).surfaces.thumbnailText
        if (c && !c.pass) {
          thumbSide = true
          fixes.push(`Concept "${t.name}": ${c.reason}. Use one promise word (${titleCheck.promiseTokens.join(', ')}) or no text at all.`)
        }
      }
    }
  }

  const gateReport: GateReport = {
    titleGate,
    overlapGate,
    thumbGate,
    promiseGate,
    pass: titleGate.pass && overlapGate.pass && thumbGate.pass && promiseGate.pass,
    thresholdsUsed: thresholdLines(),
  }
  return { titles, chosen, thumbs, a: pick.a, b: pick.b, abReason: pick.reason, gateReport, issues, fixes, titleSide, thumbSide }
}

/** The designer brief: the ten rules, the pair's shoot notes, the signature sentence, the QA checklist and the test plan. */
function designerBrief(ev: Evaluation, signature?: Signature): string[] {
  const lines: string[] = []
  for (const t of [ev.a, ev.b].filter((x): x is PackageThumbnail => x !== undefined)) {
    lines.push(`${t.name} (${t.angle}): focal ${t.spec.focalSubject}${t.spec.emotion && !/^(none|neutral|flat|no)/i.test(t.spec.emotion) ? `, expression ${t.spec.emotion}` : ''}; elements ${t.spec.elements.join(', ')}; text ${t.spec.text ? `"${t.spec.text}"` : 'none'}; colours ${(t.spec.colors ?? []).join('/') || 'channel pair'}; background ${t.spec.background ?? 'clean'}.${t.composition ? ` Composition: ${t.composition}` : ''}${t.designerBrief ? ` Note: ${t.designerBrief}` : ''}`)
  }
  if (signature) lines.push(describeSignature(signature))
  return [...lines, ...THUMBNAIL_RULES]
}

/**
 * Build a complete package for an idea and refuse to call it passed until
 * every gate clears. Offline (no hooks) generation is generateTitles() and
 * buildThumbnailBrief(); with hooks, every failed gate's fixes go back into
 * the hooks (titles hook for title and promise-on-title failures, concepts
 * hook for thumbnail, overlap and promise-on-text failures) for up to
 * `rounds` rounds. The document is returned whether or not the gates pass:
 * `gateReport.pass` is the truth, and the workflow runner reads it.
 */
export async function buildPackage(input: BuildPackageInput): Promise<PackageDoc> {
  const now = input.now ?? new Date()
  const hooks = input.generate ?? {}
  const hasHook = Boolean(hooks.titles || hooks.concepts)
  const maxRounds = Math.max(1, Math.floor(hasHook ? input.rounds ?? DEFAULT_ROUNDS : 1))
  const history: RoundRecord[] = []
  let fixes: string[] = []
  let prevTitles: TitleInput[] | undefined
  let prevConcepts: ConceptInput[] | undefined
  let ev: Evaluation | undefined

  for (let round = 1; round <= maxRounds; round += 1) {
    const rawTitles = hooks.titles ? await hooks.titles({ round, fixes, previous: prevTitles }) : offlineTitles(input)
    const titles = rankTitles(rawTitles)
    const chosenTitle = titles[0]?.title ?? ''
    const rawConcepts = hooks.concepts ? await hooks.concepts({ round, fixes, previous: prevConcepts, title: chosenTitle }) : offlineConcepts(input, chosenTitle)
    ev = evaluate(titles, rawConcepts, input.promise, input.signature)
    prevTitles = rawTitles
    prevConcepts = rawConcepts
    const canFix = round < maxRounds && ((ev.titleSide && Boolean(hooks.titles)) || (ev.thumbSide && Boolean(hooks.concepts)))
    fixes = ev.gateReport.pass || !canFix ? [] : ev.fixes
    history.push({ round, pass: ev.gateReport.pass, issues: ev.issues, fixes })
    if (ev.gateReport.pass || !canFix) break
  }

  const final = ev!
  const slug = slugify(input.idea)
  const ownTitles = Array.from({ length: OWN_TITLE_LINES }, () => '')
  return {
    id: stableId('package', slug),
    slug,
    idea: input.idea,
    promise: input.promise,
    titles: final.titles,
    chosenTitle: final.chosen.title,
    thumbnails: final.thumbs,
    abPick: { a: final.a?.name ?? '', b: final.b?.name ?? '', reason: final.abReason },
    designerBrief: designerBrief(final, input.signature),
    hypothesis: { levers: preRegisteredLevers(final), angle: final.a?.angle, predictedCtrMultiple: input.predictedCtrMultiple ?? 1 },
    gateReport: final.gateReport,
    rounds: history.length,
    history,
    ownTitles,
    createdAt: now.toISOString(),
  }
}

/**
 * The levers this package pre-registers: the chosen title's lever (its formula
 * offline) and the two A/B angles, de-duplicated case-insensitively. `booster
 * rules compile` counts only ledger rows whose `hypothesis.levers` is non-empty,
 * so an empty list here keeps every published package out of the flywheel —
 * and the pair was picked precisely because it pulls two named levers.
 */
function preRegisteredLevers(ev: Evaluation): string[] {
  const seen = new Map<string, string>()
  for (const raw of [ev.chosen.lever ?? ev.chosen.formula, ev.a?.angle, ev.b?.angle]) {
    const lever = raw?.trim()
    // First spelling wins: the title's own lever names the thing, the angle repeats it.
    if (lever && !seen.has(lever.toLowerCase())) seen.set(lever.toLowerCase(), lever)
  }
  return [...seen.values()]
}

function gateLine(name: string, g: Gate): string {
  return `- ${g.pass ? 'PASS' : 'FAIL'} ${name}: ${g.reason}`
}

/** The sheet: promise, gates, titles, three blank lines for the human's own titles, the concepts with QA, the A/B pick, the designer brief. */
export function renderPackageMarkdown(doc: PackageDoc): string {
  const lines: string[] = [
    `# Package: ${doc.idea}`,
    '',
    `Slug \`${doc.slug}\` · built ${doc.createdAt} · ${doc.rounds} round(s) · gates ${doc.gateReport.pass ? 'PASS' : 'FAIL'}`,
    '',
    '## Promise',
    '',
    doc.promise || '(none written; write one sentence the video keeps)',
    '',
    '## Gates',
    '',
    gateLine('title', doc.gateReport.titleGate),
    gateLine('overlap', doc.gateReport.overlapGate),
    gateLine('thumbnail', doc.gateReport.thumbGate),
    gateLine('promise', doc.gateReport.promiseGate),
    '',
    `Thresholds: ${doc.gateReport.thresholdsUsed.join(' · ')}`,
    '',
    '## Titles',
    '',
    `Chosen: **${doc.chosenTitle || '(none)'}**`,
    '',
    '| Score | Formula / lever | Title |',
    '| --- | --- | --- |',
    ...doc.titles.map((t) => `| ${t.score} | ${t.formula ?? t.lever ?? ''} | ${t.title} |`),
    '',
    '## Your own titles',
    '',
    'Write three by hand that beat the chosen one, then pick the final title. Thirty to fifty-five characters, promise inside the first forty.',
    '',
    ...doc.ownTitles.map((t, i) => `${i + 1}. ${t || '________________________________________________'}`),
    '',
    '## Thumbnail concepts',
    '',
    ...doc.thumbnails.flatMap((t, i) => [
      `### ${i + 1}. ${t.name} (${t.angle}) · QA ${t.qa.score}/100 ${t.qa.grade.toUpperCase()}${t.eligible ? '' : ' · not eligible'}`,
      '',
      `- focal: ${t.spec.focalSubject}${t.spec.emotion ? ` (${t.spec.emotion})` : ''}`,
      `- elements: ${t.spec.elements.join(', ') || '(none)'}`,
      `- text: ${t.spec.text ? `"${t.spec.text}"` : '(none)'} · overlap with title ${pct(t.overlap)}${t.promisePass === undefined ? '' : t.promisePass ? ' · promise kept' : ' · promise dropped'}`,
      `- colours: ${(t.spec.colors ?? []).join('/') || '(unset)'} · background: ${t.spec.background ?? '(unset)'}`,
      ...(t.composition ? [`- composition: ${t.composition}`] : []),
      ...(t.designerBrief ? [`- note: ${t.designerBrief}`] : []),
      ...(t.qa.failures.length ? [`- QA failures: ${t.qa.failures.join('; ')}`] : []),
      ...(t.qa.fixes.length ? [`- fixes: ${t.qa.fixes.join(' ')}`] : []),
      '',
    ]),
    '## A/B pick for Test & Compare',
    '',
    `A: ${doc.abPick.a || '(none)'} · B: ${doc.abPick.b || '(none)'}`,
    '',
    doc.abPick.reason,
    '',
    'Final pair (human picks): A ________  B ________',
    '',
    '## Designer brief',
    '',
    ...doc.designerBrief.map((l) => `- ${l}`),
    '',
    'QA before export:',
    ...THUMBNAIL_QA_CHECKLIST.map((l) => `- ${l}`),
    '',
    'Test plan:',
    ...THUMBNAIL_TEST_PLAN.map((l) => `- ${l}`),
    '',
    '## Hypothesis',
    '',
    `Levers: ${doc.hypothesis.levers.length ? doc.hypothesis.levers.join(', ') : '(write the lever you expect to win)'} · angle: ${doc.hypothesis.angle ?? '(none)'} · predicted CTR multiple: ${doc.hypothesis.predictedCtrMultiple}`,
    '',
    '## Rounds',
    '',
    ...doc.history.map((r) => `- round ${r.round}: ${r.pass ? 'PASS' : `FAIL (${r.issues.length} issue(s))`}${r.fixes.length ? `; fixes fed back: ${r.fixes.length}` : ''}`),
    '',
  ]
  return lines.join('\n')
}

/** Write package.json and package.md under `dir` (created if missing). Returns both paths. */
export function writePackage(dir: string, doc: PackageDoc): { json: string; md: string } {
  mkdirSync(dir, { recursive: true })
  const json = path.join(dir, 'package.json')
  const md = path.join(dir, 'package.md')
  writeFileSync(json, `${JSON.stringify(doc, null, 2)}\n`)
  writeFileSync(md, renderPackageMarkdown(doc))
  return { json, md }
}

/** Read and validate `dir`/package.json; undefined when the file is absent, an error when it does not fit the schema. */
export function readPackage(dir: string): PackageDoc | undefined {
  const file = path.join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  const parsed = PackageDocSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`${file} does not match the package schema: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`)
  return parsed.data
}

/** Path of the fix-round prompt template shipped with the module. */
export const PACKAGE_FIX_PROMPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'package-fix.md')

/**
 * Fill the fix-round prompt: `{{fixes}}` becomes one line per fix,
 * `{{previous}}` the last round's output as JSON. Any other placeholder is
 * left in place. Reads prompts/package-fix.md unless a template is given.
 */
export function renderFixPrompt(fixes: string[], previous: unknown, template: string = readFileSync(PACKAGE_FIX_PROMPT_PATH, 'utf8')): string {
  const fixText = fixes.length ? fixes.map((f) => `- ${f}`).join('\n') : '- (none)'
  const prevText = typeof previous === 'string' ? previous : JSON.stringify(previous ?? null, null, 2)
  return template.replace(/\{\{fixes\}\}/g, fixText).replace(/\{\{previous\}\}/g, prevText)
}
