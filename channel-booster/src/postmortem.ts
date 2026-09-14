import type { Diagnosis, PostMortemInput } from './types.js'

/** Defaults when the channel has no baseline yet. */
export const DEFAULT_BASELINE = { ctr: 4, avpPct: 40 }

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
  const baselineCtr = input.baseline?.ctr ?? DEFAULT_BASELINE.ctr
  const baselineAvp = input.baseline?.avpPct ?? DEFAULT_BASELINE.avpPct

  const avp = input.avpPct ?? (input.avdSec !== undefined && input.durationSec ? (input.avdSec / input.durationSec) * 100 : undefined)
  const hasCtr = input.ctr !== undefined
  const hasRetention = avp !== undefined || input.retention30sPct !== undefined

  if (!hasCtr && !hasRetention) {
    return { bottleneck: 'insufficient-data', headline: 'Not enough data to diagnose yet.', evidence, actions: ACTIONS['insufficient-data'], repackage: false }
  }
  if (input.impressions !== undefined && input.impressions < 1000 && (input.hoursSincePublish ?? 48) < 24) {
    return { bottleneck: 'insufficient-data', headline: 'Fewer than 1,000 impressions in the first day: too early to call.', evidence: [`impressions ${input.impressions}`], actions: ACTIONS['insufficient-data'], repackage: false }
  }

  const ctrRel = hasCtr ? input.ctr! / baselineCtr : undefined
  const avpRel = avp !== undefined ? avp / baselineAvp : undefined

  if (hasCtr) evidence.push(`CTR ${input.ctr}% vs baseline ${baselineCtr}% (${ctrRel!.toFixed(2)}x)`)
  if (avp !== undefined) evidence.push(`average percentage viewed ${avp.toFixed(0)}% vs baseline ${baselineAvp}% (${avpRel!.toFixed(2)}x)`)
  if (input.retention30sPct !== undefined) evidence.push(`30-second retention ${input.retention30sPct}%`)
  if (input.impressions !== undefined) evidence.push(`impressions ${input.impressions}`)

  const impressionsLow = input.impressions !== undefined && input.baseline?.views !== undefined && input.impressions < input.baseline.views * 2
  const ctrHealthy = ctrRel !== undefined && ctrRel >= 0.9 && input.ctr! >= 3
  const ctrLow = ctrRel !== undefined && (ctrRel < 0.75 || input.ctr! < 2.5)
  const hookBroken = (input.retention30sPct !== undefined && input.retention30sPct < 60) || (avpRel !== undefined && avpRel < 0.6 && input.retention30sPct === undefined && avp! < 30)
  const retentionSoft = avpRel !== undefined && avpRel < 0.85

  const hours = input.hoursSincePublish ?? 48
  let bottleneck: Diagnosis['bottleneck']
  let headline: string
  if (impressionsLow && !ctrLow) {
    bottleneck = 'idea'
    headline = 'Impressions never took off while CTR held: the system found no audience for this idea.'
  } else if (ctrLow) {
    bottleneck = 'packaging'
    headline = 'People saw it and did not click: packaging is the bottleneck.'
  } else if (hookBroken) {
    bottleneck = 'hook'
    headline = 'People clicked and left in the first 30 seconds: the open does not deliver the promise.'
  } else if (retentionSoft) {
    bottleneck = 'retention'
    headline = 'The open holds but the middle loses them: retention structure is the bottleneck.'
  } else if (ctrHealthy || avpRel !== undefined) {
    bottleneck = 'none'
    headline = 'Packaging and retention are both at or above baseline. Double down.'
  } else {
    bottleneck = 'insufficient-data'
    headline = 'Metrics are borderline; collect another day of data.'
  }

  const repackage = bottleneck === 'packaging' && hours <= 72 && !impressionsLow
  return { bottleneck, headline, evidence, actions: ACTIONS[bottleneck], repackage }
}
