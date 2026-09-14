import { tagged, thresholds } from './thresholds.js'
import type { Diagnosis, PostMortemInput } from './types.js'

/** Defaults when the channel has no baseline yet (cold-start priors from thresholds.ts). */
export const DEFAULT_BASELINE = { get ctr() { return thresholds.priorCtr.value }, get avpPct() { return thresholds.priorAvp.value } }

const ACTIONS: Record<Diagnosis['bottleneck'], string[]> = {
  'insufficient-data': [
    'Wait until the video has at least 1,000 impressions and 24 hours of data before diagnosing.',
    'Record impressions, CTR, average view duration, and 30-second retention in the ledger when you do.',
  ],
  idea: [
    'YouTube could not find an audience: the topic has no proven demand or the packaging does not match any viewer intent it recognises.',
    'Check the outlier list for this topic. If there are no winners in adjacent channels, bank the learning and move on; do not repackage.',
    'If a related outlier exists, remake the packaging to mirror its promise and test once.',
  ],
  'packaging-soft': [
    'CTR is below baseline but not broken. Re-test the title (Test & Compare) before touching the thumbnail; a swap on a borderline read burns the test budget.',
    'Check whether a subscriber notification burst inflated the early CTR baseline you are comparing against.',
    'Log it; if the 7-day read is still soft, treat it as packaging.',
  ],
  packaging: [
    'Viewers saw it and did not click. Swap the thumbnail first, then the title, using Test & Compare.',
    'Pick the losing concept from the brief and ship the most different alternative, not a tweak.',
    'Re-check title length, front-loaded promise, and whether the thumbnail text repeats the title.',
  ],
  hook: [
    'Viewers clicked and left early: the first 30 seconds did not deliver the promise the packaging made.',
    'Re-cut the open: show the payoff or the stake inside the first 10 seconds and remove the intro.',
    'Confirm the title and thumbnail promise is stated on screen in the first line.',
  ],
  retention: [
    'The open works but the middle sags. Map the retention graph and cut or re-hook every dip longer than 20 seconds.',
    'Add a progress structure (steps, countdown, escalation) so viewers know why to stay.',
    'Move the strongest moment earlier and tease it in the open.',
  ],
  none: [
    'Every stage is healthy. Make the sequel while the audience is warm and link it in the end screen and pinned comment.',
    'Log the packaging as a proven format in the ledger and remix it for the next idea.',
    'Cut two Shorts from the best moments and point them at this video.',
  ],
}

/**
 * Decide where a video is losing viewers. The funnel is:
 * impressions (idea and channel signals) -> CTR (packaging) -> first 30s (hook) -> the rest (retention).
 * The first broken stage is the bottleneck; fixing later stages first wastes the cycle.
 */
export function diagnose(input: PostMortemInput): Diagnosis {
  const evidence: string[] = []
  const thresholdsUsed: string[] = []
  const baselineSource: Diagnosis['baselineSource'] = input.baseline?.ctr !== undefined || input.baseline?.avpPct !== undefined ? 'provided' : 'default'
  const baselineCtr = input.baseline?.ctr ?? DEFAULT_BASELINE.ctr
  const baselineAvp = input.baseline?.avpPct ?? DEFAULT_BASELINE.avpPct
  if (baselineSource === 'default') evidence.push(`baseline is borrowed: CTR ${tagged('priorCtr', '%')}, AVP ${tagged('priorAvp', '%')} (no channel history given)`)

  const avp = input.avpPct ?? (input.avdSec !== undefined && input.durationSec ? (input.avdSec / input.durationSec) * 100 : undefined)
  const hasCtr = input.ctr !== undefined
  const hasRetention = avp !== undefined || input.retention30sPct !== undefined
  const hours = input.hoursSincePublish ?? 48
  const minImpr = thresholds.minImpressionsForVerdict.value
  const minHours = thresholds.minHoursForVerdict.value
  const done = (bottleneck: Diagnosis['bottleneck'], headline: string, repackage = false): Diagnosis => ({ bottleneck, headline, evidence, actions: ACTIONS[bottleneck], repackage, baselineSource, thresholdsUsed })

  if (!hasCtr && !hasRetention) return done('insufficient-data', 'Not enough data to diagnose yet.')
  if (input.impressions !== undefined && input.impressions < minImpr && hours < minHours) {
    evidence.push(`impressions ${input.impressions} at ${hours}h`)
    thresholdsUsed.push(`minImpressionsForVerdict ${tagged('minImpressionsForVerdict')}`, `minHoursForVerdict ${tagged('minHoursForVerdict', 'h')}`)
    return done('insufficient-data', `Fewer than ${minImpr} impressions in the first ${minHours} hours: too early to call.`)
  }

  const ctrRel = hasCtr ? input.ctr! / baselineCtr : undefined
  const avpRel = avp !== undefined ? avp / baselineAvp : undefined
  if (hasCtr) evidence.push(`CTR ${input.ctr}% vs baseline ${baselineCtr}% (${ctrRel!.toFixed(2)}x)`)
  if (avp !== undefined) evidence.push(`average percentage viewed ${avp.toFixed(0)}% vs baseline ${baselineAvp}% (${avpRel!.toFixed(2)}x)`)
  if (input.retention30sPct !== undefined) evidence.push(`30-second retention ${input.retention30sPct}%`)
  if (input.impressions !== undefined) evidence.push(`impressions ${input.impressions}`)

  // Idea stage: the system never found an audience. Two reads: vs your own median views when known,
  // otherwise an absolute floor once a full day has passed.
  const impressionsLowVsMedian = input.impressions !== undefined && input.baseline?.views !== undefined && input.impressions < input.baseline.views * thresholds.impressionsHealthyVsMedianViews.value
  const impressionsLowAbs = input.impressions !== undefined && input.baseline?.views === undefined && input.impressions < minImpr && hours >= minHours
  const impressionsLow = impressionsLowVsMedian || impressionsLowAbs
  if (impressionsLowVsMedian) thresholdsUsed.push(`impressionsHealthyVsMedianViews ${tagged('impressionsHealthyVsMedianViews', 'x')}`)
  if (impressionsLowAbs) thresholdsUsed.push(`minImpressionsForVerdict ${tagged('minImpressionsForVerdict')}`)

  const ctrLow = ctrRel !== undefined && (ctrRel < thresholds.ctrLowRel.value || input.ctr! < thresholds.ctrLowAbs.value)
  const ctrHealthy = ctrRel !== undefined && ctrRel >= thresholds.ctrHealthyRel.value && input.ctr! >= thresholds.ctrHealthyAbs.value
  const ctrSoft = ctrRel !== undefined && !ctrLow && !ctrHealthy
  if (hasCtr) thresholdsUsed.push(`ctrLowRel ${tagged('ctrLowRel', 'x')}`, `ctrHealthyRel ${tagged('ctrHealthyRel', 'x')}`, `ctrHealthyAbs ${tagged('ctrHealthyAbs', '%')}`)
  const hookBroken = (input.retention30sPct !== undefined && input.retention30sPct < thresholds.retention30Healthy.value)
    || (avpRel !== undefined && input.retention30sPct === undefined && avpRel < 0.6 && avp! < 30)
  if (input.retention30sPct !== undefined) thresholdsUsed.push(`retention30Healthy ${tagged('retention30Healthy', '%')}`)
  const retentionSoft = avpRel !== undefined && avpRel < thresholds.avpSoftRel.value
  if (avpRel !== undefined) thresholdsUsed.push(`avpSoftRel ${tagged('avpSoftRel', 'x')}`)

  if (impressionsLow && !ctrLow) return done('idea', 'Impressions never took off while CTR held: the system found no audience for this idea.')
  if (ctrLow) {
    const repackage = hours <= thresholds.repackageWindowHours.value && !impressionsLow
    thresholdsUsed.push(`repackageWindowHours ${tagged('repackageWindowHours', 'h')}`)
    return done('packaging', 'People saw it and did not click: packaging is the bottleneck.', repackage)
  }
  if (hookBroken) return done('hook', 'People clicked and left in the first 30 seconds: the open does not deliver the promise.')
  if (retentionSoft) return done('retention', 'The open holds but the middle loses them: retention structure is the bottleneck.')
  if (ctrSoft) return done('packaging-soft', 'CTR is under baseline but not broken: re-test the title before swapping the thumbnail.')
  if (input.impressions !== undefined && input.impressions < minImpr) {
    evidence.push(`impressions ${input.impressions} are under ${minImpr}: no "healthy" verdict on this sample`)
    return done('insufficient-data', 'Nothing is broken yet, but the sample is too small to call it healthy.')
  }
  if (ctrHealthy || avpRel !== undefined) return done('none', 'Packaging and retention are both at or above baseline. Double down.')
  return done('insufficient-data', 'Metrics are borderline; collect another day of data.')
}
