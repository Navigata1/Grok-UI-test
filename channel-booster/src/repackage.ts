/**
 * Repackage preparation (architecture 2.15): from a decision and the package
 * that shipped, pick the swap a person would apply: the most angle-distant
 * thumbnail concept that QA graded `ship` and has not been used, and the
 * next-best title. Thumbnail first, then title; one swap per 7 days.
 *
 * This module prepares and never applies. The CLI writes the plan to
 * `packages/<slug>/repackage.json` and opens a human task; the swap in Studio
 * and the `repackagedAt` stamp on the ledger row are a person's job.
 */
import type { DecisionDoc } from './schema.js'
import { tagged, thresholds } from './thresholds.js'
import type { ThumbnailConcept } from './types.js'

export type ThumbnailAngle = ThumbnailConcept['angle']

/** A thumbnail concept as the package records it: name, angle and the QA grade it earned. */
export interface PackagedThumbnail {
  name: string
  angle: ThumbnailAngle | string
  qa: { grade: 'ship' | 'revise' | 'rethink'; score?: number }
}

/** A scored title from the package. */
export interface PackagedTitle {
  title: string
  score: number
}

/** The subset of `packages/<slug>/package.json` the repackage needs. */
export interface RepackagePackage {
  titles: PackagedTitle[]
  thumbnails: PackagedThumbnail[]
  /** The title that shipped. When absent, the top-scored title is assumed to be live. */
  chosenTitle?: string
  /** The Test & Compare pair that shipped, by concept name. */
  abPick?: { a: string; b: string }
}

/** The prepared swap: nothing here has been applied. */
export interface RepackagePlan {
  /** The concept to ship next, when the decision calls for a thumbnail swap and one is available. */
  thumbnail?: PackagedThumbnail
  /** The title to test or swap to, when the decision calls for it and one is available. */
  title?: PackagedTitle
  /** What a person does, in order. */
  instructions: string[]
}

/**
 * Where each angle sits relative to the others [house]: result and stakes both
 * promise an outcome, contrast and curiosity both withhold one, identity stands
 * apart. Distance is the gap on this line, so a `curiosity` swap after a
 * `result` pair is the most different; an unknown angle counts as one step from everything.
 */
const ANGLE_LINE: ThumbnailAngle[] = ['result', 'stakes', 'contrast', 'curiosity', 'identity']

/** How different two thumbnail angles are, 0 (same) to 4 (opposite ends of the line). */
export function angleDistance(a: string, b: string): number {
  const ia = ANGLE_LINE.indexOf(a as ThumbnailAngle)
  const ib = ANGLE_LINE.indexOf(b as ThumbnailAngle)
  if (a === b) return 0
  if (ia < 0 || ib < 0) return 1
  return Math.abs(ia - ib)
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The unused ship-graded concept farthest (by its nearest used angle) from what
 * already ran; ties keep package order. Undefined when nothing qualifies.
 */
export function pickThumbnail(pkg: RepackagePackage): PackagedThumbnail | undefined {
  const usedNames = new Set([pkg.abPick?.a, pkg.abPick?.b].filter((n): n is string => typeof n === 'string' && n.length > 0))
  const usedAngles = pkg.thumbnails.filter((t) => usedNames.has(t.name)).map((t) => t.angle)
  const candidates = pkg.thumbnails.filter((t) => t.qa.grade === 'ship' && !usedNames.has(t.name))
  let best: PackagedThumbnail | undefined
  let bestDistance = -1
  for (const c of candidates) {
    const distance = usedAngles.length ? Math.min(...usedAngles.map((u) => angleDistance(c.angle, u))) : 1
    if (distance > bestDistance) {
      best = c
      bestDistance = distance
    }
  }
  return best
}

/** The highest-scored title that is not the live one. Without `chosenTitle`, the top-scored title is assumed live. */
export function pickTitle(pkg: RepackagePackage): PackagedTitle | undefined {
  const sorted = [...pkg.titles].sort((a, b) => b.score - a.score)
  if (sorted.length === 0) return undefined
  const live = pkg.chosenTitle ?? sorted[0].title
  return sorted.find((t) => !sameTitle(t.title, live))
}

/**
 * Prepare the swap a decision calls for. REPACKAGE gets a thumbnail (first)
 * and a title (only if the re-read is still low); RE-TEST-TITLE gets a title
 * for Test & Compare; every other decision gets no swap and says why. Pure:
 * nothing is written or applied.
 */
export function prepareRepackage(pkg: RepackagePackage, decision: Pick<DecisionDoc, 'decision' | 'slug' | 'bucket' | 'numbers' | 'flipCondition'>): RepackagePlan {
  const instructions: string[] = []
  const swapDays = tagged('oneSwapPerDays', 'd')
  const lowMark = decision.numbers?.ctrLowMark
  const gain = decision.numbers?.expectedGainViews

  if (decision.decision === 'REPACKAGE') {
    const thumbnail = pickThumbnail(pkg)
    const title = pickTitle(pkg)
    const used = [pkg.abPick?.a, pkg.abPick?.b].filter(Boolean).join(' / ')
    if (thumbnail) {
      instructions.push(`Thumbnail first: replace ${used || 'the live thumbnail'} with "${thumbnail.name}" (${thumbnail.angle} angle, QA ship) in Studio. Do not change the title in the same swap; one lever per swap.`)
    } else {
      instructions.push('No unused ship-graded concept is left in the package. Brief one more concept with a different angle (booster thumbnail brief), QA it to ship, and prepare again; do not swap to a revise-graded concept.')
    }
    instructions.push(`Record the swap on the ledger row (repackagedAt) the moment it is live; the ${swapDays} rule and the baselines depend on it.`)
    if (title) {
      instructions.push(`Re-read 48 hours after the swap. Only if CTR is still under ${lowMark !== undefined ? `${lowMark}%` : 'the low mark'}, run Test & Compare on the title: current vs "${title.title}" (score ${title.score}). Never inside ${swapDays} of the thumbnail swap.`)
    } else {
      instructions.push('No alternative title is left in the package; if the re-read is still low, run the title lab again before touching the title.')
    }
    if (gain !== undefined) instructions.push(`Expected gain on record: about ${Number(gain).toLocaleString('en-US')} views (${decision.flipCondition ?? 'see the decision'}).`)
    instructions.push(`This plan prepares only; a person applies the swap in Studio and approves decision ${decision.slug}:${decision.bucket} (approvedBy, appliedAt).`)
    return { thumbnail, title, instructions }
  }

  if (decision.decision === 'RE-TEST-TITLE') {
    const title = pickTitle(pkg)
    if (title) {
      instructions.push(`Keep the thumbnail. Run Test & Compare on the title: current${pkg.chosenTitle ? ` "${pkg.chosenTitle}"` : ''} vs "${title.title}" (score ${title.score}).`)
      instructions.push('Judge on watch-time share, not CTR (judgeTest); a CTR winner that loses watch time over-promises.')
    } else {
      instructions.push('No alternative title is left in the package; run the title lab again (booster titles) and QA the best before testing.')
    }
    instructions.push(`This plan prepares only; a person starts the test in Studio and approves decision ${decision.slug}:${decision.bucket} (approvedBy, appliedAt).`)
    return { title, instructions }
  }

  instructions.push(`Decision ${decision.decision} for ${decision.slug} at ${decision.bucket} h calls for no packaging change; nothing prepared.`)
  if (decision.flipCondition) instructions.push(decision.flipCondition)
  return { instructions }
}

/** The plan as the lines the CLI prints. */
export function describeRepackage(plan: RepackagePlan): string {
  const lines: string[] = []
  lines.push(`Thumbnail: ${plan.thumbnail ? `${plan.thumbnail.name} (${plan.thumbnail.angle})` : 'none'}`)
  lines.push(`Title: ${plan.title ? `${plan.title.title} (score ${plan.title.score})` : 'none'}`)
  lines.push(`One swap per ${thresholds.oneSwapPerDays.value} days [${thresholds.oneSwapPerDays.evidence}]; thumbnail before title.`)
  lines.push('')
  plan.instructions.forEach((i, n) => lines.push(`${n + 1}. ${i}`))
  return lines.join('\n')
}
