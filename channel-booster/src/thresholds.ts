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
  wilsonZ: { value: 1.96, evidence: 'house', note: 'z for the 95% Wilson interval on CTR; a verdict is insufficient-data while the interval straddles a CTR threshold' },
  impressionsLowVsExpectedRel: { value: 0.5, evidence: 'house', note: 'impressions below this share of your own median impressions at the same read means the system found no audience' },
  notAlgorithmicBrowseSuggestedPct: { value: 40, evidence: 'house', note: 'browse plus suggested under this share of impressions: the video is not yet algorithmic; the traffic-source taxonomy is unverified' },
  // Cold start priors (used when the channel has no baseline yet)
  priorCtr: { value: 4, evidence: 'unverified', note: 'midpoint of the 2-10% band' },
  priorAvp: { value: 40, evidence: 'house', note: 'mid-length video average percentage viewed prior' },
  priorRetention30: { value: 60, evidence: 'unverified', note: 'same figure as retention30Healthy' },
  coldStartMinImpressions: { value: 2000, evidence: 'house', note: 'no packaging verdict on a first upload before this many impressions' },
  coldStartMinHours: { value: 72, evidence: 'house', note: 'no packaging verdict on a first upload before this many hours' },
  coldStartGrowthPct: { value: 30, evidence: 'house', note: '24-to-48 hour impression growth above this is healthy on a cold start; there is no median to compare against' },
  // Decisions (src/decide.ts)
  repackageMinExpectedGainViews: { value: 500, evidence: 'house', note: 'a repackage must be expected to earn at least this many extra views' },
  repackageMinExpectedGainPctOfBaseline: { value: 5, evidence: 'house', note: 'or this percent of your median views, whichever is larger' },
  repackageImpressionsShareOfExpected: { value: 0.8, evidence: 'house', note: 'impressions at least this share of the expected read (or still rising) means the system is still serving the video' },
  oneSwapPerDays: { value: 7, evidence: 'house', note: 'no second packaging swap inside this many days of the last one' },
  sequelMultiple: { value: 3, evidence: 'house', note: '7-day views at this multiple of your median is a sequel trigger' },
  sequelReturningRel: { value: 0.9, evidence: 'house', note: 'returning-viewer share must hold at this share of baseline for a sequel; returning loyalty as the growth engine is sourced' },
  sequelAvpRel: { value: 0.9, evidence: 'house', note: 'average percentage viewed at this share of baseline confirms the sequel promise is kept' },
  expandMultipleLow: { value: 1.5, evidence: 'house', note: '7-day multiple from here up to the sequel multiple, with healthy retention, means expand the topic' },
  parkMultiple: { value: 0.7, evidence: 'house', note: '7-day multiple below this with an idea bottleneck parks the topic' },
  // Story
  hookGateScore: { value: 70, evidence: 'house', note: 'hook score a script must reach before the shoot' },
  rehookMaxGapSec: { value: 90, evidence: 'house', note: 'longest stretch without a new question, reveal, or escalation' },
  // Cadence
  wipPackaging: { value: 3, evidence: 'house', note: 'ideas in packaging at once before the bank warns' },
  wipProduction: { value: 2, evidence: 'house', note: 'videos in production at once before the bank warns' },
  soloReviewGapHours: { value: 12, evidence: 'house', note: 'time between building a package and picking the pair when there is no second reviewer' },
  // Constants other engines still hold locally, added here so their owners can point at one table
  bucketTolerance: { value: 0.2, evidence: 'house', note: 'a Studio read within this share of a bucket hour mark counts as that bucket (src/csv.ts)' },
  freshMaxAgeDays: { value: 21, evidence: 'house', note: 'a competitor video this young with high velocity is a fresh outlier (src/outliers.ts)' },
  freshVelocityMultiplier: { value: 3, evidence: 'house', note: 'views per day at this multiple of the channel median velocity is fresh (src/outliers.ts)' },
  formatLiftMinCount: { value: 3, evidence: 'house', note: 'a format cue needs this many videos before its lift is reported (src/outliers.ts)' },
  demandDecayDays: { value: 180, evidence: 'house', note: 'an idea with no new evidence for this many days loses one point of demand per rescore' },
  sequelHumanAxisScore: { value: 3, evidence: 'house', note: 'starting score of the five human axes on an auto-created sequel candidate' },
  demandMatchMultiplier: { value: 5, evidence: 'house', note: 'an outlier at this multiple of its channel median is a demand signal on its own (src/ideas.ts)' },
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
