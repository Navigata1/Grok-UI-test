/**
 * Funnel diagnosis: where a published video is losing viewers.
 *
 * The funnel is impressions (idea and channel signals) -> CTR (packaging) ->
 * first 30 s (hook) -> the rest (retention). The first broken stage is the
 * bottleneck; fixing a later stage first wastes the cycle (R11).
 *
 * v2 adds the read bucket (24/48/168/672 h), computed baselines with their
 * tier, cold-start mode with absolute priors and a 24-to-48 h growth read, a
 * Wilson interval on CTR so a borderline read says "insufficient-data" and how
 * many more impressions would settle it (at 48 h, while a swap is still
 * possible; the 7 and 28-day reads call the band on the point estimate and keep
 * the interval as evidence), and the traffic and loyalty reads
 * (returning share, subscriber share, browse + suggested). Every verdict's
 * first evidence line names the baseline it compared against and its source.
 */
import { BUCKET_HOURS, type Bucket } from './buckets.js'
import type { Baselines, LedgerRead } from './schema.js'
import { tagged, thresholds } from './thresholds.js'
import type { Diagnosis, PostMortemInput } from './types.js'

/** Defaults when the channel has no baseline yet (cold-start priors from thresholds.ts). */
export const DEFAULT_BASELINE = {
  get ctr() { return thresholds.priorCtr.value },
  get avpPct() { return thresholds.priorAvp.value },
  get retention30sPct() { return thresholds.priorRetention30.value },
}

/** `established` compares against the channel's own history; `cold-start` uses priors and stricter data gates (R10). */
export type DiagnosisMode = 'established' | 'cold-start'

/** The v2 input: everything `PostMortemInput` takes plus the bucket, the mode, computed baselines and the traffic/loyalty reads. */
export interface PostMortemInputV2 extends PostMortemInput {
  /** Which read this is. 24 h reads are distribution only; 168/672 h reads never recommend a swap. */
  bucket?: Bucket
  /** Defaults to cold-start when the baseline tier is `prior` or there is no baseline at all. */
  mode?: DiagnosisMode
  /** Computed channel baselines (src/ledger.ts). Preferred over the flat `baseline` object. */
  baselines?: Baselines
  /** Share of views from returning viewers, percent. */
  returningViewerPct?: number
  /** Share of views from subscribers, percent. A high share inflates early CTR. */
  subscriberSharePct?: number
  /** Share of impressions from Browse plus Suggested, percent. Under the gate the video is "not yet algorithmic". */
  browseSuggestedPct?: number
  /** The previous read (normally the 24 h read at a 48 h diagnosis) for the impression-growth read. */
  previousRead?: Partial<Pick<LedgerRead, 'at' | 'impressions' | 'views' | 'ctr'>>
}

/** The numbers a verdict compared against, and where each came from. */
export interface BaselineUsed {
  ctr: number
  avpPct: number
  retention30sPct: number
  views?: number
  /** Expected impressions at this read, from the channel's own median at the same bucket. */
  impressions?: number
  returningPct?: number
  /** `computed` from the ledger, `provided` as flat numbers by the caller, `default` = the cold-start priors. */
  source: 'computed' | 'provided' | 'default'
  /** Tier of the computed baselines; absent for flat or default baselines. */
  tier?: Baselines['tier']
  n?: number
  bucket?: Baselines['bucket']
  /** Fields that fell back to a prior because the baseline did not carry them. */
  borrowed: string[]
}

/** A 95% (by default) Wilson score interval on CTR, in percent. */
export interface CtrInterval {
  low: number
  high: number
  z: number
  impressions: number
}

/** The v2 verdict: the v1 shape plus mode, bucket, the baseline used and the confidence reads. */
export interface DiagnosisV2 extends Diagnosis {
  mode: DiagnosisMode
  bucket?: Bucket
  baselineUsed: BaselineUsed
  ctrInterval?: CtrInterval
  /** More impressions needed before the CTR verdict is certain, when the interval straddles a threshold. */
  impressionsNeeded?: number
  /** Impression growth from the previous read, percent, when `previousRead` was given. */
  growthPct?: number
  /** False when browse + suggested is under the gate ("not yet algorithmic"); absent when the share is unknown. */
  algorithmic?: boolean
  /** Verdicts this bucket may return. */
  allowedVerdicts: Diagnosis['bottleneck'][]
}

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

/** Verdicts each bucket may return. 24 h is distribution only; later buckets allow everything (but never a swap after 48 h). */
export const ALLOWED_VERDICTS: Record<Bucket, Diagnosis['bottleneck'][]> = {
  '24': ['insufficient-data', 'idea'],
  '48': ['insufficient-data', 'idea', 'packaging', 'packaging-soft', 'hook', 'retention', 'none'],
  '168': ['insufficient-data', 'idea', 'packaging', 'packaging-soft', 'hook', 'retention', 'none'],
  '672': ['insufficient-data', 'idea', 'packaging', 'packaging-soft', 'hook', 'retention', 'none'],
}

const ALL_VERDICTS = ALLOWED_VERDICTS['48']

/**
 * Wilson score interval on a click-through rate, in percent, given the number
 * of impressions it was measured over. `z` defaults to thresholds.wilsonZ (95%).
 */
export function wilsonCtrInterval(ctrPct: number, impressions: number, z: number = thresholds.wilsonZ.value): CtrInterval {
  const n = Math.max(1, impressions)
  const p = Math.min(1, Math.max(0, ctrPct / 100))
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half) * 100, high: Math.min(1, centre + half) * 100, z, impressions }
}

/** Which of the given CTR thresholds (percent) the interval straddles. */
function straddled(interval: CtrInterval, marks: Array<{ name: string; value: number }>): Array<{ name: string; value: number }> {
  return marks.filter((m) => interval.low < m.value && interval.high >= m.value)
}

/**
 * Smallest impression count at which a CTR of `ctrPct` would no longer straddle
 * any of `marks`, or undefined when the CTR sits on a mark (no sample settles that).
 */
export function impressionsToSettle(ctrPct: number, marks: number[], from = 1, z: number = thresholds.wilsonZ.value): number | undefined {
  const named = marks.map((value) => ({ name: '', value }))
  if (marks.some((m) => Math.abs(m - ctrPct) < 1e-9)) return undefined
  const clear = (n: number) => straddled(wilsonCtrInterval(ctrPct, n, z), named).length === 0
  let lo = Math.max(1, Math.floor(from))
  if (clear(lo)) return lo
  let hi = lo * 2
  const cap = 50_000_000
  while (!clear(hi)) {
    if (hi >= cap) return undefined
    hi = Math.min(cap, hi * 2)
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (clear(mid)) hi = mid
    else lo = mid
  }
  return hi
}

function pct(v: number, decimals = 1): string {
  return `${Number.isInteger(v) ? v : Number(v.toFixed(decimals))}%`
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

/** Resolve the baseline: computed medians when the tier allows, flat caller numbers next, priors last; record what was borrowed. */
function resolveBaseline(input: PostMortemInputV2): BaselineUsed {
  const b = input.baselines
  const computedUsable = b !== undefined && (b.tier !== 'prior' || input.mode === 'established')
  const flat = input.baseline
  const borrowed: string[] = []
  const bucketMatches = b !== undefined && (input.bucket === undefined || input.bucket === b.bucket)
  const pick = (computed: number | undefined, provided: number | undefined, prior: number, key: string): number => {
    if (computedUsable && computed !== undefined) return computed
    if (provided !== undefined) return provided
    borrowed.push(key)
    return prior
  }
  const ctr = pick(b?.ctr?.median, flat?.ctr, DEFAULT_BASELINE.ctr, 'ctr')
  const avpPct = pick(b?.avpPct?.median, flat?.avpPct, DEFAULT_BASELINE.avpPct, 'avpPct')
  const retention30sPct = pick(b?.retention30sPct?.median, undefined, DEFAULT_BASELINE.retention30sPct, 'retention30sPct')
  const views = computedUsable && b?.views ? b.views.median : flat?.views
  const impressions = computedUsable && bucketMatches && b?.impressions ? b.impressions.median : undefined
  const returningPct = computedUsable && b?.returningPct ? b.returningPct.median : undefined
  const anyComputed = computedUsable && (b?.ctr !== undefined || b?.avpPct !== undefined)
  const anyProvided = flat?.ctr !== undefined || flat?.avpPct !== undefined
  const source: BaselineUsed['source'] = anyComputed ? 'computed' : anyProvided ? 'provided' : 'default'
  return {
    ctr, avpPct, retention30sPct, views, impressions, returningPct, source,
    tier: b?.tier, n: b?.n, bucket: b?.bucket, borrowed,
  }
}

/** One line naming the baseline a verdict used and where it came from; always the first evidence line. */
export function describeBaselineUsed(b: BaselineUsed): string {
  const borrowedNote = b.borrowed.length
    ? `; borrowed from priors: ${b.borrowed.map((k) => (k === 'ctr' ? `CTR ${tagged('priorCtr', '%')}` : k === 'avpPct' ? `AVP ${tagged('priorAvp', '%')}` : `30 s ${tagged('priorRetention30', '%')}`)).join(', ')}`
    : ''
  if (b.source === 'default') {
    return `baseline is borrowed: CTR ${tagged('priorCtr', '%')}, AVP ${tagged('priorAvp', '%')}, 30 s ${tagged('priorRetention30', '%')} (no channel history given${b.tier ? `; ledger tier ${b.tier}, n=${b.n ?? 0}` : ''})`
  }
  const where = b.source === 'computed'
    ? `computed from your ledger (${b.tier ?? 'unknown'} tier, n=${b.n ?? 0}, ${b.bucket ?? '?'} h reads)`
    : 'provided by the caller (tier unknown)'
  const parts = [`CTR judged vs baseline ${pct(b.ctr)}`, `AVP vs ${pct(b.avpPct)}`]
  if (!b.borrowed.includes('retention30sPct')) parts.push(`30 s vs ${pct(b.retention30sPct)}`)
  if (b.views !== undefined) parts.push(`views vs ${fmtInt(b.views)}`)
  if (b.impressions !== undefined) parts.push(`expected impressions ${fmtInt(b.impressions)}`)
  if (b.returningPct !== undefined) parts.push(`returning vs ${pct(b.returningPct)}`)
  return `baseline used: ${where}: ${parts.join(', ')}${borrowedNote}`
}

/**
 * Decide where a video is losing viewers. Accepts the v1 flat input or the v2
 * input with bucket, mode, computed baselines and traffic reads; returns the
 * v2 verdict (a superset of v1).
 */
export function diagnose(input: PostMortemInputV2): DiagnosisV2 {
  const evidence: string[] = []
  const thresholdsUsed: string[] = []
  const bucket = input.bucket
  const autoMode: DiagnosisMode = input.baselines
    ? (input.baselines.tier === 'prior' ? 'cold-start' : 'established')
    : (input.baseline?.ctr !== undefined || input.baseline?.avpPct !== undefined ? 'established' : 'cold-start')
  const mode = input.mode ?? autoMode
  const baselineUsed = resolveBaseline(input)
  const baselineSource: Diagnosis['baselineSource'] = baselineUsed.source === 'default' ? 'default' : 'provided'
  evidence.push(describeBaselineUsed(baselineUsed))
  if (mode === 'cold-start') evidence.push(`cold-start mode: this upload is judged on its own (R10); priors and stricter data gates apply`)

  const allowedVerdicts = bucket ? ALLOWED_VERDICTS[bucket] : ALL_VERDICTS
  const hours = input.hoursSincePublish ?? (bucket ? BUCKET_HOURS[bucket] : 48)
  const impressions = input.impressions
  const avp = input.avpPct ?? (input.avdSec !== undefined && input.durationSec ? (input.avdSec / input.durationSec) * 100 : undefined)
  const hasCtr = input.ctr !== undefined
  const hasRetention = avp !== undefined || input.retention30sPct !== undefined
  const minImpr = thresholds.minImpressionsForVerdict.value
  const minHours = thresholds.minHoursForVerdict.value
  const baselineCtr = baselineUsed.ctr
  const baselineAvp = baselineUsed.avpPct

  let ctrInterval: CtrInterval | undefined
  let impressionsNeeded: number | undefined
  let growthPct: number | undefined
  let algorithmic: boolean | undefined

  const done = (bottleneck: Diagnosis['bottleneck'], headline: string, repackage = false, extraActions: string[] = []): DiagnosisV2 => {
    const noSwapBucket = bucket === '168' || bucket === '672' || bucket === '24'
    return {
      bottleneck,
      headline,
      evidence,
      actions: extraActions.length ? [...extraActions, ACTIONS['insufficient-data'][1]] : ACTIONS[bottleneck],
      repackage: repackage && !noSwapBucket,
      baselineSource,
      thresholdsUsed,
      mode,
      bucket,
      baselineUsed,
      ctrInterval,
      impressionsNeeded,
      growthPct,
      algorithmic,
      allowedVerdicts,
    }
  }

  // Traffic and loyalty reads: evidence on every verdict, whatever the bottleneck.
  if (input.browseSuggestedPct !== undefined) {
    const gate = thresholds.notAlgorithmicBrowseSuggestedPct.value
    algorithmic = input.browseSuggestedPct >= gate
    thresholdsUsed.push(`notAlgorithmicBrowseSuggestedPct ${tagged('notAlgorithmicBrowseSuggestedPct', '%')}`)
    evidence.push(algorithmic
      ? `browse + suggested ${pct(input.browseSuggestedPct)} of impressions: the system is recommending it (gate ${tagged('notAlgorithmicBrowseSuggestedPct', '%')})`
      : `not yet algorithmic: browse + suggested ${pct(input.browseSuggestedPct)} of impressions, under ${tagged('notAlgorithmicBrowseSuggestedPct', '%')}; early CTR is mostly subscribers and external traffic`)
  }
  if (input.subscriberSharePct !== undefined) evidence.push(`subscribers ${pct(input.subscriberSharePct)} of views (a high share inflates early CTR; compare CTR by traffic source before swapping)`)
  if (input.returningViewerPct !== undefined) {
    const rel = baselineUsed.returningPct ? ` (${(input.returningViewerPct / baselineUsed.returningPct).toFixed(2)}x baseline ${pct(baselineUsed.returningPct)})` : ''
    evidence.push(`returning viewers ${pct(input.returningViewerPct)} of views${rel}`)
  }
  if (input.previousRead?.impressions !== undefined && impressions !== undefined && input.previousRead.impressions > 0 && bucket !== '168' && bucket !== '672' && bucket !== '24') {
    growthPct = (impressions / input.previousRead.impressions - 1) * 100
    const healthy = growthPct > thresholds.coldStartGrowthPct.value
    thresholdsUsed.push(`coldStartGrowthPct ${tagged('coldStartGrowthPct', '%')}`)
    evidence.push(`24-to-48 h impression growth ${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(0)}% (${fmtInt(input.previousRead.impressions)} -> ${fmtInt(impressions)}); healthy above ${tagged('coldStartGrowthPct', '%')}${healthy ? '' : ': distribution has stalled'}`)
  }

  if (!hasCtr && !hasRetention && !(bucket === '24' && impressions !== undefined)) return done('insufficient-data', 'Not enough data to diagnose yet.')
  if (impressions !== undefined && impressions < minImpr && hours < minHours) {
    evidence.push(`impressions ${fmtInt(impressions)} at ${hours}h`)
    thresholdsUsed.push(`minImpressionsForVerdict ${tagged('minImpressionsForVerdict')}`, `minHoursForVerdict ${tagged('minHoursForVerdict', 'h')}`)
    return done('insufficient-data', `Fewer than ${fmtInt(minImpr)} impressions in the first ${minHours} hours: too early to call.`)
  }

  const ctrRel = hasCtr ? input.ctr! / baselineCtr : undefined
  const avpRel = avp !== undefined ? avp / baselineAvp : undefined
  if (hasCtr) evidence.push(`CTR ${input.ctr}% vs baseline ${pct(baselineCtr)} (${ctrRel!.toFixed(2)}x)`)
  if (avp !== undefined) evidence.push(`average percentage viewed ${avp.toFixed(0)}% vs baseline ${pct(baselineAvp)} (${avpRel!.toFixed(2)}x)`)
  if (input.retention30sPct !== undefined) evidence.push(`30-second retention ${input.retention30sPct}%`)
  if (impressions !== undefined) evidence.push(`impressions ${fmtInt(impressions)}${baselineUsed.impressions !== undefined ? ` vs expected ${fmtInt(baselineUsed.impressions)} at this read (${(impressions / baselineUsed.impressions).toFixed(2)}x)` : ''}`)

  // Idea stage: the system never found an audience. Reads in order of preference: the channel's own
  // expected impressions at this bucket, then 2x median views, then (cold start) the growth read, then an absolute floor.
  const expected = baselineUsed.impressions
  const impressionsLowVsExpected = impressions !== undefined && expected !== undefined && impressions < expected * thresholds.impressionsLowVsExpectedRel.value
  const impressionsLowVsMedian = impressions !== undefined && expected === undefined && baselineUsed.views !== undefined && impressions < baselineUsed.views * thresholds.impressionsHealthyVsMedianViews.value
  const impressionsLowAbs = impressions !== undefined && expected === undefined && baselineUsed.views === undefined && impressions < minImpr && hours >= minHours
  const growthStalled = mode === 'cold-start' && growthPct !== undefined && growthPct <= thresholds.coldStartGrowthPct.value && hours >= minHours
  const impressionsLow = impressionsLowVsExpected || impressionsLowVsMedian || impressionsLowAbs || growthStalled
  if (impressionsLowVsExpected) thresholdsUsed.push(`impressionsLowVsExpectedRel ${tagged('impressionsLowVsExpectedRel', 'x')}`)
  if (impressionsLowVsMedian) thresholdsUsed.push(`impressionsHealthyVsMedianViews ${tagged('impressionsHealthyVsMedianViews', 'x')}`)
  if (impressionsLowAbs) thresholdsUsed.push(`minImpressionsForVerdict ${tagged('minImpressionsForVerdict')}`)

  // CTR band with its confidence interval.
  const lowMark = Math.max(baselineCtr * thresholds.ctrLowRel.value, thresholds.ctrLowAbs.value)
  const healthyMark = Math.max(baselineCtr * thresholds.ctrHealthyRel.value, thresholds.ctrHealthyAbs.value)
  const ctrLow = ctrRel !== undefined && input.ctr! < lowMark
  const ctrHealthy = ctrRel !== undefined && input.ctr! >= healthyMark
  const ctrSoft = ctrRel !== undefined && !ctrLow && !ctrHealthy
  if (hasCtr) thresholdsUsed.push(`ctrLowRel ${tagged('ctrLowRel', 'x')}`, `ctrHealthyRel ${tagged('ctrHealthyRel', 'x')}`, `ctrHealthyAbs ${tagged('ctrHealthyAbs', '%')}`, `ctrLowAbs ${tagged('ctrLowAbs', '%')}`)
  // The certainty gate exists to stop a premature swap. At 7 and 28 days the swap window is closed, so
  // waiting for more impressions settles nothing: the band is called on the point estimate and the
  // interval stays in the evidence.
  const certaintyGate = bucket !== '168' && bucket !== '672'
  let straddle: Array<{ name: string; value: number }> = []
  if (hasCtr && impressions !== undefined && impressions > 0) {
    ctrInterval = wilsonCtrInterval(input.ctr!, impressions)
    thresholdsUsed.push(`wilsonZ ${tagged('wilsonZ')}`)
    const marks = ctrLow ? [{ name: 'low', value: lowMark }] : ctrHealthy ? [{ name: 'healthy', value: healthyMark }] : [{ name: 'low', value: lowMark }, { name: 'healthy', value: healthyMark }]
    straddle = straddled(ctrInterval, marks)
    evidence.push(`CTR 95% interval ${pct(ctrInterval.low, 2)} to ${pct(ctrInterval.high, 2)} over ${fmtInt(impressions)} impressions (thresholds: low ${pct(lowMark, 2)}, healthy ${pct(healthyMark, 2)})`)
    const straddles = `the interval straddles the ${straddle.map((m) => `${m.name} threshold ${pct(m.value, 2)}`).join(' and the ')}`
    if (straddle.length && !certaintyGate) {
      evidence.push(`${straddles}; the swap window is closed at the ${bucket}-hour read, so the band is called on the point estimate, not a certain one`)
    } else if (straddle.length) {
      impressionsNeeded = impressionsToSettle(input.ctr!, straddle.map((m) => m.value), impressions)
      const more = impressionsNeeded === undefined ? 'no sample size settles a CTR sitting exactly on the threshold' : `about ${fmtInt(impressionsNeeded - impressions)} more impressions needed (${fmtInt(impressionsNeeded)} total)`
      evidence.push(`${straddles}: ${more}`)
    }
  }
  const ctrLowCertain = ctrLow && (ctrInterval === undefined || straddle.length === 0)

  const hookBroken = (input.retention30sPct !== undefined && input.retention30sPct < thresholds.retention30Healthy.value)
    || (avpRel !== undefined && input.retention30sPct === undefined && avpRel < 0.6 && avp! < 30)
  if (input.retention30sPct !== undefined) thresholdsUsed.push(`retention30Healthy ${tagged('retention30Healthy', '%')}`)
  const retentionSoft = avpRel !== undefined && avpRel < thresholds.avpSoftRel.value
  if (avpRel !== undefined) thresholdsUsed.push(`avpSoftRel ${tagged('avpSoftRel', 'x')}`)

  // The 24-hour read is a distribution read: idea or nothing.
  if (bucket === '24') {
    if (impressionsLow && !ctrLowCertain) {
      evidence.push('24-hour read: the first day is distribution, not judgment; confirm the idea verdict at the 48-hour read before parking the topic')
      return done('idea', 'Impressions never took off in the first day: the system has not found an audience for this idea yet.')
    }
    const note = ctrLow ? ` CTR reads low (${input.ctr}%) but a 24-hour read cannot call packaging.` : ''
    evidence.push('24-hour read: the first day is distribution, not judgment; packaging verdicts start at the 48-hour read')
    return done('insufficient-data', `24-hour read recorded (${impressions !== undefined ? `${fmtInt(impressions)} impressions` : 'no impressions given'}).${note} Diagnose at 48 hours.`)
  }

  const coldGateMet = mode !== 'cold-start' || (impressions !== undefined && impressions >= thresholds.coldStartMinImpressions.value) || hours >= thresholds.coldStartMinHours.value
  // The gate holds good news as well as bad: a healthy-looking first sample is not yet a reason to double down.
  const coldGate = (band: 'low' | 'soft' | 'healthy'): DiagnosisV2 => {
    const needImpr = Math.max(0, thresholds.coldStartMinImpressions.value - (impressions ?? 0))
    const needHours = Math.max(0, thresholds.coldStartMinHours.value - hours)
    thresholdsUsed.push(`coldStartMinImpressions ${tagged('coldStartMinImpressions')}`, `coldStartMinHours ${tagged('coldStartMinHours', 'h')}`)
    const what = band === 'healthy' ? 'no healthy verdict' : 'no packaging verdict'
    const sentence = `Cold start: ${what} before ${fmtInt(thresholds.coldStartMinImpressions.value)} impressions or ${thresholds.coldStartMinHours.value} hours (${impressions !== undefined ? fmtInt(impressions) : 'unknown'} impressions at ${hours}h: ${fmtInt(needImpr)} more impressions or ${needHours.toFixed(0)} more hours).`
    evidence.push(sentence)
    const headline = band === 'healthy'
      ? 'The numbers look healthy so far, but a cold-start upload gets no verdict before the gate: too early to call it healthy.'
      : `CTR ${input.ctr}% reads ${band} but the cold-start gate is not met: too early to call packaging.`
    return done('insufficient-data', headline, false, [sentence])
  }
  const wilsonGate = (band: string): DiagnosisV2 => {
    const sentence = impressionsNeeded === undefined
      ? `CTR ${input.ctr}% sits on the threshold itself; treat the next read as the verdict.`
      : `Collect about ${fmtInt(impressionsNeeded - impressions!)} more impressions (${fmtInt(impressionsNeeded)} total) before calling CTR ${band}.`
    return done('insufficient-data', `CTR ${input.ctr}% reads ${band} but its 95% interval straddles the threshold: not certain yet.`, false, [sentence])
  }

  if (impressionsLow && !ctrLowCertain) {
    if (growthStalled && !impressionsLowVsExpected && !impressionsLowVsMedian && !impressionsLowAbs) return done('idea', 'Impressions stalled between the 24 and 48-hour reads while CTR held: the system stopped serving this idea.')
    return done('idea', 'Impressions never took off while CTR held: the system found no audience for this idea.')
  }
  if (ctrLow) {
    if (!coldGateMet) return coldGate('low')
    if (straddle.length && certaintyGate) return wilsonGate('low')
    const repackage = hours <= thresholds.repackageWindowHours.value && !impressionsLow
    thresholdsUsed.push(`repackageWindowHours ${tagged('repackageWindowHours', 'h')}`)
    return done('packaging', 'People saw it and did not click: packaging is the bottleneck.', repackage)
  }
  if (hookBroken) return done('hook', 'People clicked and left in the first 30 seconds: the open does not deliver the promise.')
  if (retentionSoft) return done('retention', 'The open holds but the middle loses them: retention structure is the bottleneck.')
  if (ctrSoft) {
    if (!coldGateMet) return coldGate('soft')
    if (straddle.length && certaintyGate) return wilsonGate('soft')
    return done('packaging-soft', 'CTR is under baseline but not broken: re-test the title before swapping the thumbnail.')
  }
  if (impressions !== undefined && impressions < minImpr) {
    evidence.push(`impressions ${fmtInt(impressions)} are under ${fmtInt(minImpr)}: no "healthy" verdict on this sample`)
    return done('insufficient-data', 'Nothing is broken yet, but the sample is too small to call it healthy.')
  }
  if (!coldGateMet && (ctrHealthy || avpRel !== undefined)) return coldGate('healthy')
  if (ctrHealthy && straddle.length && certaintyGate) return wilsonGate('healthy')
  if (ctrHealthy || avpRel !== undefined) return done('none', 'Packaging and retention are both at or above baseline. Double down.')
  return done('insufficient-data', 'Metrics are borderline; collect another day of data.')
}
