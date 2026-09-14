/**
 * Every numeric gate in one place, each with its evidence tag.
 *
 *   sourced    - a number the strategist or the platform stated (see docs/02-strategist-playbook.md)
 *   unverified - a widely repeated platform figure the research could not confirm at source
 *   house      - a default this system chose; tune it from your own ledger
 *
 * Engines read from `thresholds` (mutable copy) so a channel profile can override
 * values with `applyOverrides()`; the evidence tag travels with every verdict.
 */
export type Evidence = 'sourced' | 'unverified' | 'house'

export interface Threshold {
  value: number
  evidence: Evidence
  note: string
}

export const DEFAULT_THRESHOLDS = {
  // Outliers and demand
  outlierMultiplier: { value: 10, evidence: 'house', note: '1of10-style outlier: views vs channel median; the concept is sourced, the multiple is a house default' },
  ownWinnerMultiplier: { value: 5, evidence: 'house', note: 'your own video at this multiple of your median is a proven format; brief the sequel' },
  demandWindowDays: { value: 90, evidence: 'house', note: 'outliers older than this count less as demand' },
  // Titles
  titleMinChars: { value: 30, evidence: 'house', note: 'below this the title makes no promise' },
  titleMaxChars: { value: 55, evidence: 'house', note: 'above this the promise truncates on a phone' },
  titleGateScore: { value: 60, evidence: 'house', note: 'heuristic score a title must reach before the thumbnail is tested' },
  titleThumbOverlapMax: { value: 0.67, evidence: 'house', note: 'share of thumbnail words repeated from the title above which the pair says one thing twice' },
  // Thumbnails
  thumbShipScore: { value: 80, evidence: 'house', note: 'QA score at which a concept ships' },
  thumbReviseScore: { value: 60, evidence: 'house', note: 'QA score below which a concept is rethought' },
  thumbMaxElements: { value: 3, evidence: 'house', note: 'one subject, one support, optional text; the "clean" doctrine is sourced, the count is house' },
  thumbMaxWords: { value: 3, evidence: 'house', note: 'text reads at 120px wide only this short' },
  // Funnel diagnosis
  minImpressionsForVerdict: { value: 1000, evidence: 'house', note: 'below this, do not diagnose; a subscriber burst can be the whole sample' },
  minHoursForVerdict: { value: 24, evidence: 'house', note: 'the first day is distribution, not judgment' },
  impressionsHealthyVsMedianViews: { value: 2, evidence: 'house', note: 'impressions at least this multiple of median views means the system found an audience' },
  ctrHealthyRel: { value: 0.9, evidence: 'house', note: 'CTR at or above this share of your baseline is healthy; "compare against your own history" is the sourced guidance' },
  ctrLowRel: { value: 0.75, evidence: 'house', note: 'CTR below this share of baseline is a packaging bottleneck; between low and healthy is packaging-soft' },
  ctrHealthyAbs: { value: 3, evidence: 'unverified', note: 'YouTube Help: half of channels sit between 2% and 10% CTR; 3% is a floor for "healthy" here' },
  ctrLowAbs: { value: 2.5, evidence: 'unverified', note: 'below this absolute CTR is treated as low regardless of baseline' },
  retention30Healthy: { value: 60, evidence: 'unverified', note: 'share of viewers still watching at 30 seconds; widely cited YouTube intro guidance, not confirmed at source' },
  avpSoftRel: { value: 0.85, evidence: 'house', note: 'average percentage viewed below this share of baseline is a retention bottleneck' },
  repackageWindowHours: { value: 72, evidence: 'house', note: 'after this a thumbnail swap rarely changes distribution' },
  // Cold start priors (used when the channel has no baseline yet)
  priorCtr: { value: 4, evidence: 'unverified', note: 'midpoint of the 2-10% band' },
  priorAvp: { value: 40, evidence: 'house', note: 'mid-length video average percentage viewed prior' },
  priorRetention30: { value: 60, evidence: 'unverified', note: 'same figure as retention30Healthy' },
  coldStartMinImpressions: { value: 2000, evidence: 'house', note: 'no packaging verdict on a first upload before this many impressions' },
  coldStartMinHours: { value: 72, evidence: 'house', note: 'no packaging verdict on a first upload before this many hours' },
  // Story
  hookGateScore: { value: 70, evidence: 'house', note: 'hook score a script must reach before the shoot' },
  rehookMaxGapSec: { value: 90, evidence: 'house', note: 'longest stretch without a new question, reveal, or escalation' },
  // Cadence
  wipPackaging: { value: 3, evidence: 'house', note: 'ideas in packaging at once before the bank warns' },
  wipProduction: { value: 2, evidence: 'house', note: 'videos in production at once before the bank warns' },
  soloReviewGapHours: { value: 12, evidence: 'house', note: 'time between building a package and picking the pair when there is no second reviewer' },
} as const satisfies Record<string, Threshold>

export type ThresholdKey = keyof typeof DEFAULT_THRESHOLDS

/** The live table. Engines read from here; profiles override with applyOverrides(). */
export const thresholds: Record<ThresholdKey, Threshold> = Object.fromEntries(
  Object.entries(DEFAULT_THRESHOLDS).map(([k, v]) => [k, { ...v }]),
) as Record<ThresholdKey, Threshold>

/** Override values (for example from channel.json). Unknown keys throw; the evidence tag becomes "house". */
export function applyOverrides(overrides: Partial<Record<ThresholdKey, number>>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in thresholds)) throw new Error(`unknown threshold "${key}"`)
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`threshold "${key}" must be a number`)
    thresholds[key as ThresholdKey] = { ...thresholds[key as ThresholdKey], value, evidence: 'house', note: `${thresholds[key as ThresholdKey].note} (overridden)` }
  }
}

/** Restore defaults (tests). */
export function resetThresholds(): void {
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as ThresholdKey[]) thresholds[key] = { ...DEFAULT_THRESHOLDS[key] }
}

/** Value plus tag, for printing next to a verdict: "60% [unverified]". */
export function tagged(key: ThresholdKey, suffix = ''): string {
  const t = thresholds[key]
  return `${t.value}${suffix} [${t.evidence}]`
}
