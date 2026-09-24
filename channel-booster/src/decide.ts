/**
 * Decision engine (architecture 2.15): turns a diagnosis plus the ledger row
 * into a numbered decision, the numbers that made it, and the condition that
 * would flip it.
 *
 *   REPACKAGE      packaging is the bottleneck with a certain CTR read, the video is still
 *                  being served, inside the 72 h window, no swap in the last 7 days, and the
 *                  expected gain (remaining impressions x CTR gap x retention factor) clears
 *                  max(500 views, 5% of median views). Thumbnail first, then title.
 *   RE-TEST-TITLE  the packaging-soft band inside the window: a title test, not a swap.
 *   SEQUEL         7-day multiple >= 3x with returning share >= 0.9x baseline and AVP >= 0.9x.
 *   EXPAND         7-day multiple 1.5x to 3x with healthy retention.
 *   PARK           7-day multiple < 0.7x with an idea bottleneck.
 *                  All three need a 7-day median views resting on at least five 7-day reads
 *                  (the prior/thin boundary of tierFor()); a 48-hour median or a typed number
 *                  never stands in for it. Short of that the call is HOLD, with the multiple shown.
 *   HOLD           nothing to change now; the flip condition says what would change it.
 *   WAIT           the read is missing or the diagnosis is insufficient-data.
 *
 * The engine only prescribes the first broken stage (R11); hook and retention
 * verdicts are HOLD with the fix routed to the next edit. It never applies
 * anything: `prepareRepackage()` in src/repackage.ts builds the swap plan and a
 * person applies it. All gates live in src/thresholds.ts with evidence tags.
 */
import { BUCKET_HOURS, BUCKETS, type Bucket } from './buckets.js'
import { tierFor } from './ledger-core.js'
import type { Baselines, DecisionDoc, LedgerRow } from './schema.js'
import type { DiagnosisV2 } from './postmortem.js'
import { tagged, thresholds } from './thresholds.js'

export interface DecideInput {
  /** The verdict from `diagnose()` for this row at this bucket. */
  diagnosis: DiagnosisV2
  row: LedgerRow
  bucket: Bucket
  /** Computed channel baselines; used for expected impressions, median views and returning share. */
  baselines?: Baselines
  /** Reference time; injected so decisions are reproducible. */
  now: Date
  /** Who is writing the document; defaults to `cli`. */
  source?: string
}

type Numbers = Record<string, number | string | boolean>

/** Fewest 7-day reads behind the median views before SEQUEL, EXPAND or PARK: the first n that tierFor() lifts out of `prior`. */
const MIN_WEEK_READS = (() => {
  let n = 0
  while (tierFor(n) === 'prior') n += 1
  return n
})()

function round(v: number, places = 2): number {
  const f = 10 ** places
  return Math.round(v * f) / f
}

function fmt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

/** Hours between `publishedAt` and `now`. */
function hoursSince(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 3_600_000
}

/** The bucket read before `bucket`, for the "still rising" read. */
function previousBucket(bucket: Bucket): Bucket | undefined {
  const i = BUCKETS.indexOf(bucket)
  return i > 0 ? BUCKETS[i - 1] : undefined
}

/**
 * Decide what to do with a published video at one read bucket. Pure and
 * deterministic: the same diagnosis, row and `now` always give the same document
 * (id `<slug>:<bucket>`), so recording it twice changes nothing.
 */
export function decide(input: DecideInput): DecisionDoc {
  const { diagnosis, row, bucket, baselines, now } = input
  const read = row.reads[bucket]
  const hours = hoursSince(row.publishedAt, now)
  const base = diagnosis.baselineUsed
  // 7 and 28-day reads judge on the 7-day median views alone; at 48 h any median views the caller has.
  const onMultiple = bucket === '168' || bucket === '672'
  const weekViews = baselines?.bucket === '168' ? baselines.views : undefined
  const baselineViews = onMultiple ? weekViews?.median : baselines?.views?.median ?? base.views
  const numbers: Numbers = {
    bucket,
    hoursSincePublish: round(hours, 1),
    bottleneck: diagnosis.bottleneck,
    mode: diagnosis.mode ?? 'established',
    baselineSource: base.source,
  }
  if (base.tier) numbers.baselineTier = base.tier
  const finish = (decision: DecisionDoc['decision'], flipCondition: string): DecisionDoc => ({
    id: `${row.slug}:${bucket}`,
    slug: row.slug,
    bucket,
    decision,
    numbers: { ...numbers },
    flipCondition,
    updatedAt: now.toISOString(),
    source: input.source ?? 'cli',
  })

  if (!read) return finish('WAIT', `Record the ${bucket}-hour read for ${row.slug}; there is nothing to decide on yet.`)
  if (read.impressions !== undefined) numbers.impressions = read.impressions
  if (read.ctr !== undefined) numbers.ctr = read.ctr
  if (read.views !== undefined) numbers.views = read.views
  numbers.baselineCtr = base.ctr
  numbers.baselineAvp = base.avpPct
  if (baselineViews !== undefined) numbers.baselineViews = baselineViews

  if (diagnosis.bottleneck === 'insufficient-data') {
    const need = diagnosis.impressionsNeeded !== undefined && read.impressions !== undefined
      ? `Flips once the video has about ${fmt(diagnosis.impressionsNeeded)} impressions (${fmt(diagnosis.impressionsNeeded - read.impressions)} more) and the CTR band is certain.`
      : bucket === '24'
        ? 'Flips at the 48-hour read, the first read that can call packaging.'
        : `Flips when the next read clears the data gates (${tagged('minImpressionsForVerdict')} impressions and ${tagged('minHoursForVerdict', 'h')}; cold start ${tagged('coldStartMinImpressions')} or ${tagged('coldStartMinHours', 'h')}).`
    if (diagnosis.impressionsNeeded !== undefined) numbers.impressionsNeeded = diagnosis.impressionsNeeded
    return finish('WAIT', need)
  }
  if (bucket === '24') return finish('WAIT', 'The 24-hour read is distribution only; the 48-hour read decides. Flips to PARK at 7 days if impressions stay under the idea floor.')

  const window = thresholds.repackageWindowHours.value
  const swapDays = thresholds.oneSwapPerDays.value
  const daysSinceSwap = row.repackagedAt ? (now.getTime() - Date.parse(row.repackagedAt)) / 86_400_000 : undefined
  const swapAllowed = daysSinceSwap === undefined || daysSinceSwap >= swapDays
  if (daysSinceSwap !== undefined) numbers.daysSinceSwap = round(daysSinceSwap, 1)
  numbers.repackageWindowHours = window
  numbers.oneSwapPerDays = swapDays
  const nextSwapAt = daysSinceSwap !== undefined ? new Date(Date.parse(row.repackagedAt!) + swapDays * 86_400_000).toISOString().slice(0, 10) : undefined

  if (bucket === '48') {
    switch (diagnosis.bottleneck) {
      case 'packaging':
        return decidePackaging()
      case 'packaging-soft': {
        if (hours > window) return finish('HOLD', `CTR is soft (${read.ctr}% vs ${base.ctr}%) but the ${window}-hour window has closed; write the lever and carry the learning into the next package. Nothing flips this.`)
        if (!swapAllowed) return finish('HOLD', `CTR is soft but the last swap was ${round(daysSinceSwap!, 1)} days ago; one swap per ${swapDays} days. Flips to RE-TEST-TITLE on ${nextSwapAt} if CTR is still under ${round(base.ctr * thresholds.ctrHealthyRel.value)}%.`)
        numbers.ctrHealthyMark = round(Math.max(base.ctr * thresholds.ctrHealthyRel.value, thresholds.ctrHealthyAbs.value))
        return finish('RE-TEST-TITLE', `Flips to HOLD if the title test lifts CTR to ${numbers.ctrHealthyMark}% or the ${window}-hour window closes; to REPACKAGE if a re-read inside the window falls under ${round(Math.max(base.ctr * thresholds.ctrLowRel.value, thresholds.ctrLowAbs.value))}%.`)
      }
      case 'idea':
        return finish('HOLD', `Impressions never came; a swap cannot fix distribution. Flips to PARK at the 7-day read if views are under ${tagged('parkMultiple', 'x')} median${baselineViews !== undefined ? ` (${fmt(baselineViews * thresholds.parkMultiple.value)} views)` : ''}, to EXPAND if a related outlier appears.`)
      case 'hook':
        return finish('HOLD', 'The open loses viewers; packaging is not the lever. Fix the first 30 seconds in the next edit. Flips to EXPAND at the 7-day read if the multiple still reaches 1.5x with retention repaired.')
      case 'retention':
        return finish('HOLD', 'The middle sags; packaging is not the lever. Re-cut the retention dips in the next edit. Flips to EXPAND at the 7-day read if the multiple still reaches 1.5x.')
      case 'none':
        return finish('HOLD', `Every stage is healthy; let it run. Flips to SEQUEL at the 7-day read if views reach ${tagged('sequelMultiple', 'x')} median${baselineViews !== undefined ? ` (${fmt(baselineViews * thresholds.sequelMultiple.value)})` : ''} with returning share at ${tagged('sequelReturningRel', 'x')} baseline, to EXPAND at ${tagged('expandMultipleLow', 'x')}.`)
      default:
        return finish('HOLD', 'No rule applies; review by hand.')
    }
  }

  // 168 and 672: judge on the multiple. Swaps are closed; only learning decisions remain.
  const views = read.views
  const multiple = views !== undefined && baselineViews !== undefined && baselineViews > 0 ? views / baselineViews : undefined
  if (multiple !== undefined) numbers.multiple = round(multiple)
  const baselineReturning = baselines?.returningPct?.median ?? base.returningPct
  const returningRel = read.returningPct !== undefined && baselineReturning !== undefined && baselineReturning > 0 ? read.returningPct / baselineReturning : undefined
  if (read.returningPct !== undefined) numbers.returningPct = read.returningPct
  if (baselineReturning !== undefined) numbers.baselineReturningPct = baselineReturning
  if (returningRel !== undefined) numbers.returningRel = round(returningRel)
  const avpRel = read.avpPct !== undefined ? read.avpPct / base.avpPct : undefined
  if (avpRel !== undefined) numbers.avpRel = round(avpRel)
  const healthyRetention = diagnosis.bottleneck !== 'hook' && diagnosis.bottleneck !== 'retention'
  const sequelX = thresholds.sequelMultiple.value
  const expandX = thresholds.expandMultipleLow.value
  const parkX = thresholds.parkMultiple.value
  numbers.sequelMultiple = sequelX
  numbers.expandMultipleLow = expandX
  numbers.parkMultiple = parkX

  // The views baseline the multiple rests on: how many genuine 7-day reads, and their tier.
  const weekReads = weekViews?.n ?? 0
  numbers.baselineViewsN = weekReads
  numbers.baselineViewsTier = tierFor(weekReads)
  const moreReads = MIN_WEEK_READS - weekReads
  const readsToGo = moreReads > 0 ? `${moreReads} more video${moreReads === 1 ? ' has' : 's have'} a 7-day read with views` : 'the 7-day median views is above zero'

  if (multiple === undefined) {
    return finish('HOLD', views === undefined
      ? `Record views on the ${bucket}-hour read; the multiple cannot be computed without them.`
      : `No 7-day median views yet (${weekReads} of ${MIN_WEEK_READS} reads): the multiple cannot be computed, and a 48-hour or typed median never stands in for it. Flips to SEQUEL/EXPAND/PARK once ${readsToGo}.`)
  }
  if (weekReads < MIN_WEEK_READS) {
    const carry = diagnosis.bottleneck === 'packaging' || diagnosis.bottleneck === 'packaging-soft'
      ? ' CTR was the bottleneck and the swap window has closed: write the lever; the next package inherits it.'
      : diagnosis.bottleneck === 'hook' || diagnosis.bottleneck === 'retention'
        ? ` The ${diagnosis.bottleneck} is broken: fix it in the next edit.`
        : ''
    return finish('HOLD', `${multiple.toFixed(2)}x median views, but the 7-day median rests on ${weekReads} of ${MIN_WEEK_READS} reads; SEQUEL/EXPAND/PARK wait for ${MIN_WEEK_READS}.${carry} Flips once ${readsToGo}.`)
  }
  if (multiple >= sequelX) {
    const returningOk = read.returningPct !== undefined && (returningRel === undefined || returningRel >= thresholds.sequelReturningRel.value)
    const avpOk = avpRel === undefined || avpRel >= thresholds.sequelAvpRel.value
    numbers.sequelReturningRel = thresholds.sequelReturningRel.value
    numbers.sequelAvpRel = thresholds.sequelAvpRel.value
    if (returningOk && avpOk && healthyRetention) return finish('SEQUEL', `Flips to EXPAND if returning share on the sequel drops under ${tagged('sequelReturningRel', 'x')} baseline${baselineReturning !== undefined ? ` (${round(baselineReturning * thresholds.sequelReturningRel.value, 1)}%)` : ''}.`)
    const blocker = read.returningPct === undefined
      ? 'record the returning-viewer share on this read'
      : !returningOk
        ? `returning share ${read.returningPct}% is under ${tagged('sequelReturningRel', 'x')} baseline (${round(baselineReturning! * thresholds.sequelReturningRel.value, 1)}%): the views came from strangers, not the audience`
        : !avpOk
          ? `AVP is ${round(avpRel!)}x baseline, under ${tagged('sequelAvpRel', 'x')}: the promise was not kept`
          : `the ${diagnosis.bottleneck} bottleneck must be fixed first`
    return finish('EXPAND', `${multiple.toFixed(1)}x median views. Flips to SEQUEL when ${blocker}.`)
  }
  if (multiple >= expandX) {
    if (healthyRetention) return finish('EXPAND', `${multiple.toFixed(1)}x median views with retention holding. Flips to SEQUEL at ${tagged('sequelMultiple', 'x')} with returning share at ${tagged('sequelReturningRel', 'x')} baseline.`)
    return finish('HOLD', `${multiple.toFixed(1)}x median views but the ${diagnosis.bottleneck} is broken; expanding a leaky format wastes the demand. Flips to EXPAND once the next edit fixes the ${diagnosis.bottleneck}.`)
  }
  if (multiple < parkX && diagnosis.bottleneck === 'idea') {
    return finish('PARK', `${multiple.toFixed(2)}x median views with no audience found. Flips to HOLD (re-bank) if a related outlier at ${tagged('demandMatchMultiplier', 'x')} appears in the next scan.`)
  }
  if (diagnosis.bottleneck === 'packaging' || diagnosis.bottleneck === 'packaging-soft') {
    return finish('HOLD', `${multiple.toFixed(2)}x median views; CTR ${read.ctr}% vs ${base.ctr}% was the bottleneck and the ${window}-hour swap window has closed. Write the lever; the next package inherits it. Flips to PARK if a second video on the topic reads idea.`)
  }
  if (multiple < parkX) {
    return finish('HOLD', `${multiple.toFixed(2)}x median views with a ${diagnosis.bottleneck} bottleneck: the topic had demand, the video did not deliver it. Fix the ${diagnosis.bottleneck} in the next edit. Flips to PARK if the retry reads idea.`)
  }
  return finish('HOLD', `${multiple.toFixed(2)}x median views: a normal video. Flips to EXPAND at ${tagged('expandMultipleLow', 'x')} (${fmt(baselineViews! * expandX)} views) or PARK under ${tagged('parkMultiple', 'x')} with an idea bottleneck.`)

  /** The REPACKAGE gate, condition by condition; the first failing one names the flip. */
  function decidePackaging(): DecisionDoc {
    const impressions = read!.impressions
    const ctr = read!.ctr
    numbers.ctrLowMark = round(Math.max(base.ctr * thresholds.ctrLowRel.value, thresholds.ctrLowAbs.value))
    if (hours > window) {
      return finish('HOLD', `Packaging was the bottleneck but ${round(hours, 0)} h is past the ${tagged('repackageWindowHours', 'h')} window; a swap now rarely changes distribution. Write the lever. Nothing flips this.`)
    }
    if (!swapAllowed) {
      return finish('HOLD', `Packaging is the bottleneck but the last swap was ${round(daysSinceSwap!, 1)} days ago (one per ${tagged('oneSwapPerDays', 'd')}). Flips to REPACKAGE on ${nextSwapAt} if CTR is still under ${numbers.ctrLowMark}% and inside the window.`)
    }
    if (impressions === undefined || ctr === undefined) {
      return finish('HOLD', 'Packaging is the bottleneck but the read has no impressions or CTR; record both to size the gain.')
    }
    // Still being served: >= share of expected impressions at this read, or still rising vs the previous read.
    const expected = baselines && baselines.bucket === bucket && baselines.impressions ? baselines.impressions.median : base.impressions
    const share = thresholds.repackageImpressionsShareOfExpected.value
    numbers.repackageImpressionsShareOfExpected = share
    const prev = previousBucket(bucket)
    const prevImpr = prev ? row.reads[prev]?.impressions : undefined
    const growthPct = prevImpr !== undefined && prevImpr > 0 ? (impressions / prevImpr - 1) * 100 : diagnosis.growthPct
    const rising = growthPct !== undefined && growthPct > thresholds.coldStartGrowthPct.value
    if (expected !== undefined) {
      numbers.expectedImpressions = expected
      numbers.impressionsShareOfExpected = round(impressions / expected)
    }
    if (growthPct !== undefined) numbers.impressionGrowthPct = round(growthPct, 0)
    const served = expected !== undefined ? impressions >= expected * share : undefined
    numbers.stillServed = served === undefined ? (rising ? true : 'unknown') : served || rising
    if (served === false && !rising) {
      return finish('HOLD', `Impressions ${fmt(impressions)} are under ${share}x the expected ${fmt(expected!)} and not rising; the system has stopped serving it, so a swap changes little. Flips to REPACKAGE if impressions reach ${fmt(expected! * share)} by the next read inside the window.`)
    }
    // Expected gain: remaining impressions x CTR gap x retention factor.
    const horizon = BUCKET_HOURS['168']
    const expected168 = baselines && baselines.bucket === '168' && baselines.impressions ? baselines.impressions.median : undefined
    const remaining = expected168 !== undefined ? Math.max(0, expected168 - impressions) : hours < horizon ? impressions * ((horizon - hours) / hours) : 0
    numbers.remainingImpressions = Math.round(remaining)
    numbers.remainingImpressionsMethod = expected168 !== undefined ? 'median-168h-minus-current' : 'current-rate-to-168h'
    const gapPoints = Math.max(0, base.ctr - ctr)
    const retentionFactor = read!.avpPct !== undefined ? Math.min(1, Math.max(0, read!.avpPct / base.avpPct)) : 1
    const gain = remaining * (gapPoints / 100) * retentionFactor
    const floor = Math.max(thresholds.repackageMinExpectedGainViews.value, baselineViews !== undefined ? (baselineViews * thresholds.repackageMinExpectedGainPctOfBaseline.value) / 100 : 0)
    numbers.ctrGapPoints = round(gapPoints)
    numbers.retentionFactor = round(retentionFactor)
    numbers.expectedGainViews = Math.round(gain)
    numbers.gainFloorViews = Math.round(floor)
    numbers.repackageMinExpectedGainViews = thresholds.repackageMinExpectedGainViews.value
    numbers.repackageMinExpectedGainPctOfBaseline = thresholds.repackageMinExpectedGainPctOfBaseline.value
    if (gain < floor) {
      const perView = (gapPoints / 100) * retentionFactor
      const needed = perView > 0 ? Math.ceil(floor / perView) : undefined
      return finish('HOLD', `A swap is expected to earn about ${fmt(gain)} views (${fmt(remaining)} remaining impressions x ${round(gapPoints)}-point CTR gap x ${round(retentionFactor)} retention), under the floor of ${fmt(floor)} (max of ${tagged('repackageMinExpectedGainViews')} views and ${tagged('repackageMinExpectedGainPctOfBaseline', '%')} of median views). Flips to REPACKAGE if ${needed !== undefined ? `remaining impressions reach ${fmt(needed)}` : 'the CTR gap opens'} inside the window.`)
    }
    return finish('REPACKAGE', `Expected gain ${fmt(gain)} views clears the ${fmt(floor)} floor. Flips to HOLD if impressions stop rising or the window (${tagged('repackageWindowHours', 'h')}) closes before the swap; thumbnail first, title only if the re-read is still under ${numbers.ctrLowMark}%.`)
  }
}

/** The decision as the lines the CLI prints: decision, the numbers that made it, and the flip condition. */
export function describeDecision(doc: DecisionDoc): string {
  const lines = [`Decision: ${doc.decision} (${doc.slug} at ${doc.bucket} h)`]
  const entries = Object.entries(doc.numbers)
  if (entries.length) lines.push(`Numbers: ${entries.map(([k, v]) => `${k}=${typeof v === 'number' ? v.toLocaleString('en-US') : v}`).join(', ')}`)
  if (doc.flipCondition) lines.push(`Flip: ${doc.flipCondition}`)
  return lines.join('\n')
}
