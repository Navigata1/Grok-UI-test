/**
 * Commands: postmortem, decide, repackage (prepare).
 *
 * `postmortem` diagnoses typed Studio numbers (architecture 2.14): the read
 * bucket, the mode, the profile's computed baselines for that bucket (typed
 * --baseline-* flags still win) and the traffic and loyalty reads. `decide` diagnoses a
 * ledger row at one bucket with leave-one-out baselines from the ledger and
 * turns the verdict into a numbered decision (2.15); --record upserts it by
 * id `<slug>:<bucket>`. `repackage prepare` turns a recorded REPACKAGE or
 * RE-TEST-TITLE decision plus packages/<slug>/package.json into the swap plan
 * at packages/<slug>/repackage.json. Nothing here applies anything: the swap
 * in Studio and the ledger's repackagedAt stamp are a person's job (human-only
 * gate 4).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Bucket } from '../../src/buckets.js'
import { decide, describeDecision } from '../../src/decide.js'
import { ageHours, baselineFrom, readLedger } from '../../src/ledger.js'
import { diagnose, type DiagnosisMode, type DiagnosisV2, type PostMortemInputV2 } from '../../src/postmortem.js'
import { baselineInputFrom, baselinesForBucket, describeBaselineInput, diagnoseBaseline } from '../../src/profile.js'
import { describeRepackage, prepareRepackage, type PackagedThumbnail, type PackagedTitle, type RepackagePackage } from '../../src/repackage.js'
import type { LedgerRead, ProfileDoc } from '../../src/schema.js'
import { bool, getProfile, getStore, need, nowFrom, num, out, str, warn, type CommandModule, type Flags } from '../shared.js'

const USAGE_POSTMORTEM = 'booster postmortem --ctr 4.2 [--impressions N] [--avp 38] [--avd-sec ..] [--duration-sec ..] [--retention30 ..] [--hours 48] [--bucket 24|48|168|672] [--mode established|cold-start] [--returning pct] [--sub-share pct] [--browse-suggested pct] [--prev-impressions N] [--baseline-ctr ..] [--baseline-avp ..] [--baseline-views ..]'
const USAGE_DECIDE = 'booster decide --slug <slug> --bucket 48|168|672 [--now ISO] [--record]'
const USAGE_APPROVE = 'booster decide approve <slug> --bucket 48|168|672 --by <name> --yes [--now ISO]'
const USAGE_APPLY = 'booster decide apply <slug> --bucket 48|168|672 --by <name> --yes [--root dir] [--now ISO]'
const USAGE_PREPARE = 'booster repackage prepare <slug> [--bucket 48] [--out packages/<slug>/repackage.json] [--root dir]'

const ALL_BUCKETS: readonly Bucket[] = ['24', '48', '168', '672']
const DECIDE_BUCKETS: readonly Bucket[] = ['48', '168', '672']
const MODES: readonly DiagnosisMode[] = ['established', 'cold-start']

/** `--bucket` as a Bucket, restricted to `allowed`; undefined when not given. */
function bucketFrom(flags: Flags, allowed: readonly Bucket[], usage: string): Bucket | undefined {
  const v = str(flags, 'bucket')
  if (v === undefined) return undefined
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--bucket must be one of ${allowed.join('|')}, got "${v}". Usage: ${usage}`)
  return v as Bucket
}

function modeFrom(flags: Flags): DiagnosisMode | undefined {
  const v = str(flags, 'mode')
  if (v === undefined) return undefined
  if (!(MODES as readonly string[]).includes(v)) throw new Error(`--mode must be established or cold-start, got "${v}". Usage: ${USAGE_POSTMORTEM}`)
  return v as DiagnosisMode
}

/** `--root dir` (default cwd): packages/<slug>/ is resolved against it. */
function rootFrom(flags: Flags): string {
  return path.resolve(str(flags, 'root') ?? process.cwd())
}

/**
 * The baseline a typed diagnosis compares against: typed --baseline-* flags
 * win (filled from the profile's flat baseline where a flag is missing);
 * otherwise the profile's computed baselines for the read's bucket with their
 * tier, and diagnose() borrows priors itself when the tier is `prior`. A 7-day
 * read is judged against the 7-day medians, never against the 48-hour ones.
 */
function baselineArgs(flags: Flags, profile: ProfileDoc, bucket: Bucket | undefined): Pick<PostMortemInputV2, 'baseline' | 'baselines'> {
  const typed = { ctr: num(flags, 'baseline-ctr'), avpPct: num(flags, 'baseline-avp'), views: num(flags, 'baseline-views') }
  const anyTyped = typed.ctr !== undefined || typed.avpPct !== undefined || typed.views !== undefined
  if (!anyTyped) return { baselines: baselinesForBucket(profile, bucket) }
  const fromProfile = diagnoseBaseline(profile, bucket)
  return { baseline: { ctr: typed.ctr ?? fromProfile?.ctr, avpPct: typed.avpPct ?? fromProfile?.avpPct, views: typed.views ?? fromProfile?.views } }
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

/** The verdict as the CLI prints it: bottleneck, headline, mode and baseline lines, evidence, actions, thresholds. */
function renderDiagnosis(d: DiagnosisV2, profileLine?: string): string {
  const lines = [`Bottleneck: ${d.bottleneck.toUpperCase()}${d.repackage ? ' · REPACKAGE NOW' : ''}`, d.headline]
  lines.push(`Mode: ${d.mode}${d.bucket ? ` (${d.bucket} h read)` : ''}`)
  lines.push(`Baseline used: ${d.baselineUsed.source}${d.baselineUsed.tier ? ` (${d.baselineUsed.tier} tier, n=${d.baselineUsed.n ?? 0}${d.baselineUsed.bucket ? `, ${d.baselineUsed.bucket} h reads` : ''})` : ''}: CTR ${d.baselineUsed.ctr}% / AVP ${d.baselineUsed.avpPct}% / 30 s ${d.baselineUsed.retention30sPct}%${d.baselineUsed.views !== undefined ? ` / views ${fmtInt(d.baselineUsed.views)}` : ''}${d.baselineUsed.impressions !== undefined ? ` / expected impressions ${fmtInt(d.baselineUsed.impressions)}` : ''}${d.baselineUsed.borrowed.length ? ` (borrowed from priors: ${d.baselineUsed.borrowed.join(', ')})` : ''}`)
  if (d.ctrInterval) lines.push(`CTR 95% interval: ${d.ctrInterval.low.toFixed(2)}% to ${d.ctrInterval.high.toFixed(2)}% over ${fmtInt(d.ctrInterval.impressions)} impressions`)
  if (d.impressionsNeeded !== undefined) lines.push(`Impressions needed: ${fmtInt(d.impressionsNeeded)} total${d.ctrInterval ? ` (${fmtInt(Math.max(0, d.impressionsNeeded - d.ctrInterval.impressions))} more)` : ''} before the CTR band is certain`)
  if (d.growthPct !== undefined) lines.push(`Impression growth since the previous read: ${d.growthPct >= 0 ? '+' : ''}${d.growthPct.toFixed(0)}%`)
  if (d.algorithmic !== undefined) lines.push(`Algorithmic: ${d.algorithmic ? 'yes, browse + suggested is serving it' : 'not yet'}`)
  if (profileLine) lines.push(`Profile ${profileLine}`)
  lines.push('', ...d.evidence.map((e) => `  · ${e}`), '', 'Do this:', ...d.actions.map((a) => `  - ${a}`))
  if (d.thresholdsUsed.length) lines.push('', `Thresholds: ${d.thresholdsUsed.join(' · ')}`)
  return lines.join('\n')
}

async function runPostmortem(flags: Flags): Promise<number> {
  const profile = getProfile(flags)
  const prevImpressions = num(flags, 'prev-impressions')
  const bucket = bucketFrom(flags, ALL_BUCKETS, USAGE_POSTMORTEM)
  const d = diagnose({
    impressions: num(flags, 'impressions'),
    ctr: num(flags, 'ctr'),
    views: num(flags, 'views'),
    avdSec: num(flags, 'avd-sec'),
    durationSec: num(flags, 'duration-sec'),
    avpPct: num(flags, 'avp'),
    retention30sPct: num(flags, 'retention30'),
    hoursSincePublish: num(flags, 'hours'),
    bucket,
    mode: modeFrom(flags),
    ...baselineArgs(flags, profile, bucket),
    returningViewerPct: num(flags, 'returning'),
    subscriberSharePct: num(flags, 'sub-share'),
    browseSuggestedPct: num(flags, 'browse-suggested'),
    previousRead: prevImpressions !== undefined ? { impressions: prevImpressions } : undefined,
  })
  out(d, flags, () => renderDiagnosis(d, describeBaselineInput(baselineInputFrom(profile, bucket))))
  return 0
}

async function runDecide(flags: Flags): Promise<number> {
  const slug = need(flags, 'slug', USAGE_DECIDE)
  const bucket = bucketFrom(flags, DECIDE_BUCKETS, USAGE_DECIDE)
  if (!bucket) throw new Error(`--bucket is required (48, 168 or 672; the 24-hour read is distribution only). Usage: ${USAGE_DECIDE}`)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const row = store.get('ledger', slug)
  if (!row) throw new Error(`no ledger row for "${slug}". Publish it first (booster publish confirm) or add it (booster ledger add).`)
  const rows = readLedger(store)
  // Leave-one-out: the video under judgment never sits in its own baseline.
  const baselines = baselineFrom(rows, { bucket: bucket === '48' ? '48' : '168', excludeSlug: slug, now })
  const read: Partial<LedgerRead> = row.reads[bucket] ?? {}
  const diagnosis = diagnose({
    impressions: read.impressions,
    ctr: read.ctr,
    views: read.views,
    avdSec: read.avdSec,
    avpPct: read.avpPct,
    retention30sPct: read.retention30sPct,
    bucket,
    baselines,
    hoursSincePublish: ageHours(row, now),
    previousRead: bucket === '48' ? row.reads['24'] : undefined,
    returningViewerPct: read.returningPct,
    subscriberSharePct: read.subscriberSharePct,
    browseSuggestedPct: read.browseSuggestedPct,
  })
  const doc = decide({ diagnosis, row, bucket, baselines, now })
  const record = bool(flags, 'record')
  if (record) store.upsert('decisions', doc)
  out({ ...doc, recorded: record, diagnosis, baselines }, flags, () => [
    `${row.title} (${slug}), ${bucket} h read${row.reads[bucket] ? ` at ${row.reads[bucket]!.at}` : ' missing'}`,
    `Bottleneck: ${diagnosis.bottleneck.toUpperCase()} · mode ${diagnosis.mode} · ${diagnosis.evidence[0]}`,
    diagnosis.headline,
    '',
    describeDecision(doc),
    '',
    record ? `Recorded decisions/${doc.id} (${store.path('decisions')}); re-running changes nothing.` : `Not recorded: add --record to store decisions/${doc.id}.`,
    ...(doc.decision === 'REPACKAGE' || doc.decision === 'RE-TEST-TITLE' ? [`Next: booster repackage prepare ${slug} --bucket ${bucket} writes the swap plan; a person applies it in Studio.`] : []),
  ].join('\n'))
  return 0
}

/** The recorded decision for a slug at a bucket, or the command that records one. */
function recordedDecision(store: ReturnType<typeof getStore>, slug: string, bucket: Bucket) {
  const doc = store.get('decisions', `${slug}:${bucket}`)
  if (!doc) throw new Error(`no recorded decision for "${slug}" at ${bucket} h: run booster decide --slug ${slug} --bucket ${bucket} --record (or booster review run) first`)
  return doc
}

/**
 * A person approves a recorded decision (human-only gate 4). Prints what it
 * is about to stamp and needs --yes as well as --by; the decision itself is
 * never changed here, only who stood behind it and when.
 */
async function runDecideApprove(slug: string | undefined, flags: Flags): Promise<number> {
  if (!slug) throw new Error(`usage: ${USAGE_APPROVE}`)
  const bucket = bucketFrom(flags, DECIDE_BUCKETS, USAGE_APPROVE)
  if (!bucket) throw new Error(`--bucket is required. Usage: ${USAGE_APPROVE}`)
  const by = need(flags, 'by', USAGE_APPROVE)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const doc = recordedDecision(store, slug, bucket)
  if (doc.appliedAt) throw new Error(`decisions/${doc.id} was applied at ${doc.appliedAt}; nothing to approve`)
  const plan = { action: 'approve', id: doc.id, decision: doc.decision, previouslyApprovedBy: doc.approvedBy ?? null, by, applied: false, needs: '--yes' }
  if (!bool(flags, 'yes')) {
    out(plan, flags, () => [`About to approve decisions/${doc.id} (${doc.decision}${doc.flipCondition ? `; flips when ${doc.flipCondition}` : ''}) as ${by}.`, 'Approving a decision is a human-only gate: the person takes responsibility for the swap or the sequel it starts.'].join('\n'))
    throw new Error(`nothing written. A person re-runs with --yes to approve ${doc.id}.`)
  }
  const updated = store.upsert('decisions', { ...doc, approvedBy: by, approvedAt: now.toISOString(), updatedAt: now.toISOString(), source: 'cli' })
  out({ ...plan, applied: true, decision: updated }, flags, () => [
    `Approved decisions/${doc.id}: ${doc.decision} by ${by} at ${updated.approvedAt}.`,
    ...(doc.decision === 'REPACKAGE' || doc.decision === 'RE-TEST-TITLE' ? [`Next: booster repackage prepare ${slug} --bucket ${bucket} (if not yet), swap in Studio, then booster decide apply ${slug} --bucket ${bucket} --by ${by} --yes.`] : []),
  ].join('\n'))
  return 0
}

/** packages/<slug>/repackage.json as `repackage prepare` writes it; only the fields the apply stamp touches. */
interface RepackageFile {
  decisionId?: string
  applied?: boolean
  appliedAt?: string
  [key: string]: unknown
}

/**
 * A person records that a decision was carried out (human-only gate 4): the
 * swap made in Studio, the sequel briefed, the idea parked. Stamps appliedAt
 * (and approval by the same person when it was missing), marks the ledger
 * row repackagedAt for REPACKAGE and RE-TEST-TITLE so later reads stay out
 * of the baselines, and flips packages/<slug>/repackage.json to applied.
 */
async function runDecideApply(slug: string | undefined, flags: Flags): Promise<number> {
  if (!slug) throw new Error(`usage: ${USAGE_APPLY}`)
  const bucket = bucketFrom(flags, DECIDE_BUCKETS, USAGE_APPLY)
  if (!bucket) throw new Error(`--bucket is required. Usage: ${USAGE_APPLY}`)
  const by = need(flags, 'by', USAGE_APPLY)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const doc = recordedDecision(store, slug, bucket)
  if (doc.appliedAt) throw new Error(`decisions/${doc.id} was already applied at ${doc.appliedAt}`)
  if (doc.decision === 'WAIT') throw new Error(`decisions/${doc.id} is WAIT: there is nothing to apply until the next read`)
  if (doc.decision === 'HOLD') throw new Error(`decisions/${doc.id} is HOLD: there is nothing to apply; the flip condition${doc.flipCondition ? ` (${doc.flipCondition})` : ''} is re-evaluated on the next read (booster review due)`)
  const swaps = doc.decision === 'REPACKAGE' || doc.decision === 'RE-TEST-TITLE'
  const row = store.get('ledger', slug)
  const planFile = path.join(rootFrom(flags), 'packages', slug, 'repackage.json')
  const plan = { action: 'apply', id: doc.id, decision: doc.decision, by, approvedBy: doc.approvedBy ?? by, stampsRepackagedAt: swaps && Boolean(row), repackageFile: swaps && existsSync(planFile) ? planFile : null, applied: false, needs: '--yes' }
  if (!bool(flags, 'yes')) {
    out(plan, flags, () => [
      `About to record decisions/${doc.id} (${doc.decision}) as applied by ${by}${doc.approvedBy ? '' : ' (and approved, since no approval was recorded)'}.`,
      ...(swaps ? [row ? `The ledger row ${slug} gets repackagedAt = ${now.toISOString()}: its later reads leave the baselines.` : `No ledger row for ${slug}; nothing stamped there.`] : []),
      ...(plan.repackageFile ? [`${plan.repackageFile} is marked applied.`] : []),
      'Applying a decision is a human-only gate: the swap, the sequel or the park happened in the real world first.',
    ].join('\n'))
    throw new Error(`nothing written. A person re-runs with --yes to record ${doc.id} as applied.`)
  }
  const stamp = now.toISOString()
  const updated = store.upsert('decisions', { ...doc, approvedBy: doc.approvedBy ?? by, approvedAt: doc.approvedAt ?? stamp, appliedAt: stamp, updatedAt: stamp, source: 'cli' })
  if (swaps && row) store.upsert('ledger', { ...row, repackagedAt: stamp, updatedAt: stamp, source: 'cli' })
  let planApplied = false
  let planSkipped: string | undefined
  if (plan.repackageFile) {
    try {
      const raw = JSON.parse(readFileSync(plan.repackageFile, 'utf8')) as RepackageFile
      if (raw.decisionId === undefined || raw.decisionId === doc.id) {
        writeFileSync(plan.repackageFile, `${JSON.stringify({ ...raw, applied: true, appliedAt: stamp, appliedBy: by }, null, 2)}\n`)
        planApplied = true
      } else {
        planSkipped = `belongs to decisions/${raw.decisionId}, not ${doc.id}; left untouched (re-run booster repackage prepare ${slug} --bucket ${bucket})`
      }
    } catch {
      planSkipped = 'is not valid JSON; left untouched'
    }
    if (planSkipped) warn(`${plan.repackageFile} ${planSkipped}`)
  }
  out({ ...plan, repackageFile: planApplied ? plan.repackageFile : null, repackageFileSkipped: planSkipped ?? null, applied: true, decision: updated }, flags, () => [
    `Applied decisions/${doc.id}: ${doc.decision} by ${by} at ${stamp}.`,
    ...(swaps && row ? [`Ledger row ${slug}: repackagedAt = ${stamp}.`] : []),
    ...(planApplied ? [`${plan.repackageFile}: applied.`] : plan.repackageFile ? [`${plan.repackageFile}: NOT marked applied (${planSkipped}).`] : []),
    doc.decision === 'SEQUEL' || doc.decision === 'EXPAND' ? `Next: booster bank sequels banks the follow-up; the 168 h lever on ${slug} feeds booster rules compile.` : doc.decision === 'PARK' ? `Next: the topic is parked; booster review due lists what is still open.` : `Next read shows whether the swap worked: booster review due.`,
  ].join('\n'))
  return 0
}

/** The fields of packages/<slug>/package.json the repackage needs, as the package builder writes them (every field may be missing). */
interface PackageFile {
  chosenTitle?: string
  titles?: Array<{ title?: string; score?: number }>
  thumbnails?: Array<{ name?: string; angle?: string; qa?: { grade?: string; score?: number } }>
  abPick?: { a?: string; b?: string }
}

/** Normalise the package file into the RepackagePackage shape; a concept without a QA grade is never shippable. */
function toRepackagePackage(raw: PackageFile, file: string): RepackagePackage {
  const titles: PackagedTitle[] = (Array.isArray(raw.titles) ? raw.titles : [])
    .filter((t): t is { title: string; score?: number } => typeof t?.title === 'string' && t.title.length > 0)
    .map((t) => ({ title: t.title, score: typeof t.score === 'number' ? t.score : 0 }))
  const thumbnails: PackagedThumbnail[] = (Array.isArray(raw.thumbnails) ? raw.thumbnails : [])
    .filter((t): t is { name: string; angle?: string; qa?: { grade?: string; score?: number } } => typeof t?.name === 'string' && t.name.length > 0)
    .map((t) => {
      const grade = t.qa?.grade
      return {
        name: t.name,
        angle: t.angle ?? 'unknown',
        qa: { grade: grade === 'ship' || grade === 'revise' || grade === 'rethink' ? grade : 'revise', ...(typeof t.qa?.score === 'number' ? { score: t.qa.score } : {}) },
      }
    })
  if (titles.length === 0 && thumbnails.length === 0) throw new Error(`${file} has no titles or thumbnails to repackage from; build the package first (booster package)`)
  const abPick = raw.abPick && (raw.abPick.a || raw.abPick.b) ? { a: raw.abPick.a ?? '', b: raw.abPick.b ?? '' } : undefined
  return { titles, thumbnails, ...(raw.chosenTitle ? { chosenTitle: raw.chosenTitle } : {}), ...(abPick ? { abPick } : {}) }
}

async function runRepackagePrepare(slug: string | undefined, flags: Flags): Promise<number> {
  if (!slug) throw new Error(`a slug is required. Usage: ${USAGE_PREPARE}`)
  const bucket = bucketFrom(flags, DECIDE_BUCKETS, USAGE_PREPARE) ?? '48'
  const now = nowFrom(flags)
  const store = getStore(flags)
  const decision = store.get('decisions', `${slug}:${bucket}`)
  if (!decision) throw new Error(`no recorded decision for "${slug}" at ${bucket} h: run booster decide --slug ${slug} --bucket ${bucket} --record first`)
  const dir = path.join(rootFrom(flags), 'packages', slug)
  const pkgFile = path.join(dir, 'package.json')
  if (!existsSync(pkgFile)) throw new Error(`${pkgFile} not found: build the package first (booster package "${slug}") or pass --root`)
  let raw: PackageFile
  try {
    raw = JSON.parse(readFileSync(pkgFile, 'utf8')) as PackageFile
  } catch {
    throw new Error(`${pkgFile} is not valid JSON`)
  }
  const pkg = toRepackagePackage(raw, pkgFile)
  const plan = prepareRepackage(pkg, decision)
  const outFile = path.resolve(str(flags, 'out') ?? path.join(dir, 'repackage.json'))
  const doc = { slug, decisionId: decision.id, decision: decision.decision, bucket, preparedAt: now.toISOString(), applied: false, ...plan }
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`)
  out({ ...doc, out: outFile }, flags, () => [
    `Decision ${decision.id}: ${decision.decision}`,
    describeRepackage(plan),
    '',
    `Plan written to ${outFile}. Nothing applied: a person swaps in Studio, then records repackagedAt on the ledger row (human-only gate 4).`,
  ].join('\n'))
  return 0
}

export const reviewModule: CommandModule = {
  verbs: ['postmortem', 'decide', 'repackage'],
  help: [
    'postmortem --ctr 4.2 [--impressions N] [--avp 38] [--avd-sec ..] [--duration-sec ..] [--retention30 ..] [--hours 48] [--bucket 24|48|168|672] [--mode established|cold-start] [--returning pct] [--sub-share pct] [--browse-suggested pct] [--prev-impressions N] [--baseline-ctr ..] [--baseline-avp ..] [--baseline-views ..]   diagnose typed Studio numbers; profile baselines unless --baseline-* is typed',
    'decide --slug <slug> --bucket 48|168|672 [--now ISO] [--record]         diagnose a ledger read with leave-one-out baselines and decide; --record stores decisions/<slug>:<bucket>',
    'decide approve <slug> --bucket 48|168|672 --by <name> --yes            a person stands behind a recorded decision (human-only gate 4)',
    'decide apply <slug> --bucket 48|168|672 --by <name> --yes [--root dir]  record that it was carried out (REPACKAGE, RE-TEST-TITLE, SEQUEL, EXPAND, PARK; WAIT and HOLD have nothing to apply); stamps repackagedAt on the ledger row for a swap (human-only gate 4)',
    'repackage prepare <slug> [--bucket 48] [--out packages/<slug>/repackage.json] [--root dir]   the swap plan from the recorded decision and package.json; prepares only, never applies',
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'postmortem') return runPostmortem(flags)
    if (cmd === 'decide') {
      if (sub === 'approve') return runDecideApprove(rest[0] ?? str(flags, 'slug'), flags)
      if (sub === 'apply') return runDecideApply(rest[0] ?? str(flags, 'slug'), flags)
      if (sub !== undefined) throw new Error(`unknown decide command "${sub}". Usage: ${USAGE_DECIDE} | ${USAGE_APPROVE} | ${USAGE_APPLY}`)
      return runDecide(flags)
    }
    if (cmd === 'repackage') {
      if (sub === 'prepare') return runRepackagePrepare(rest[0] ?? str(flags, 'slug'), flags)
      throw new Error(`unknown repackage command "${sub ?? ''}". Usage: ${USAGE_PREPARE}`)
    }
    throw new Error(`unknown command "${cmd}". Run booster help.`)
  },
}
