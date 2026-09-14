/**
 * Scheduled review agent (architecture 2.16). Runs unattended every few
 * hours and does four things in order, stopping at every human-only gate:
 *
 *   1. `ingestInbox()` reads every Studio export (`inbox/*.csv`), matches each
 *      row to a ledger row by video id or slugified title, picks the read
 *      bucket from the export time (`csv.bucketFor`), and records the read.
 *      A 7-day read on a row with no lever is never recorded (the lever is a
 *      person's sentence); it is reported instead.
 *   2. `reviewQueue()` lists every (slug, bucket) whose hour mark has passed:
 *      ready (read present, not yet decided on that read), awaiting data (no
 *      read), or done.
 *   3. `runReviews()` diagnoses every ready read with the profile baselines
 *      (`postmortem.diagnose`), decides (`decide.decide`), prepares the swap
 *      when the decision calls for one (`repackage.prepareRepackage` over
 *      `packages/<slug>/package.json`), writes the decision to the store and
 *      `<outDir>/<date>.json`, and returns the reviews with a Markdown digest.
 *   4. The digest ends with "Awaiting a human": approvals, swaps, levers and
 *      reads only a person can supply. Nothing here approves, applies or
 *      invents a number.
 *
 * Every time-dependent function takes `now`; nothing reads the clock.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bucketFor, ledgerReadFromRow, readStudioRows } from './csv.js'
import { BUCKET_HOURS, BUCKETS, type Bucket } from './buckets.js'
import { decide } from './decide.js'
import { ageHours, baselineFrom, dueReads, readLedger, recordRead } from './ledger.js'
import { diagnose, type DiagnosisMode, type DiagnosisV2, type PostMortemInputV2 } from './postmortem.js'
import { baselineInputFrom } from './profile.js'
import { prepareRepackage, type PackagedThumbnail, type PackagedTitle, type RepackagePackage, type RepackagePlan } from './repackage.js'
import { DecisionDoc, LedgerRow, type Baselines, type LedgerRead, type ProfileDoc } from './schema.js'
import type { Store } from './store.js'
import { slugify } from './workflow.js'
import type { VideoRow } from './types.js'

/** A due read (ledger.dueReads) with its ledger row attached. */
export interface DueReview {
  slug: string
  bucket: Bucket
  /** Hours past the bucket's hour mark. */
  overdueHours: number
  row: LedgerRow
}

/**
 * The reads whose hour mark has passed and that have no read yet, newest
 * overdue first, each with its ledger row so the caller can print the title
 * and the video id without a second lookup.
 */
export function dueReviews(store: Store, now: Date): DueReview[] {
  const rows = readLedger(store)
  const byId = new Map(rows.map((r) => [r.slug, r]))
  return dueReads(rows, now).map((d) => ({ ...d, row: byId.get(d.slug) as LedgerRow }))
}

/** Where a (slug, bucket) stands: ready to review, waiting for numbers, or already decided on this read. */
export type QueueStatus = 'ready' | 'awaiting-data' | 'reviewed' | 'applied'

/** One entry of the review queue. */
export interface QueueEntry {
  slug: string
  bucket: Bucket
  status: QueueStatus
  row: LedgerRow
  /** The read at this bucket, when present. */
  read?: LedgerRead
  /** The stored decision for `<slug>:<bucket>`, when present. */
  decision?: DecisionDoc
  overdueHours: number
}

/**
 * Every (slug, bucket) whose hour mark has passed, in ledger order (newest
 * publish first) then bucket order. `ready` means a read exists and no
 * decision has been recorded on it (no decision, or the read is newer than
 * the decision); `awaiting-data` means the read is missing; `reviewed` means
 * the decision on file already covers this read; `applied` means a person
 * applied that decision (`appliedAt`), which closes the bucket for good.
 */
export function reviewQueue(store: Store, now: Date): QueueEntry[] {
  const rows = readLedger(store)
  const decisions = new Map(store.read('decisions').map((d) => [d.id, d]))
  const out: QueueEntry[] = []
  for (const row of rows) {
    const age = ageHours(row, now)
    for (const bucket of BUCKETS) {
      if (age < BUCKET_HOURS[bucket]) continue
      const read = row.reads[bucket]
      const decision = decisions.get(`${row.slug}:${bucket}`)
      const overdueHours = Math.round(age - BUCKET_HOURS[bucket])
      let status: QueueStatus
      if (decision?.appliedAt) status = 'applied'
      else if (!read) status = 'awaiting-data'
      else if (!decision || Date.parse(read.at) > Date.parse(decision.updatedAt)) status = 'ready'
      else status = 'reviewed'
      out.push({ slug: row.slug, bucket, status, row, read, decision, overdueHours })
    }
  }
  return out
}

/** A read the ingest recorded (or merged into an existing read). */
export interface IngestedRead {
  file: string
  slug: string
  bucket: Bucket
  /** `recorded` for a new read, `merged` when fields were added to an existing read, `unchanged` when nothing new arrived. */
  outcome: 'recorded' | 'merged' | 'unchanged'
  read: LedgerRead
  matchedBy: 'videoId' | 'title'
}

/** A 7-day read the ingest refused because the row has no lever yet. */
export interface NeedsLever {
  file: string
  slug: string
  bucket: '168'
  read: LedgerRead
}

/** A row the ingest could not use, with the reason. */
export interface IngestSkip {
  file: string
  title: string
  videoId?: string
  slug?: string
  reason: string
}

/** What `ingestInbox()` did. */
export interface IngestReport {
  /** Directory read (may not exist: then every list is empty). */
  inboxDir: string
  /** CSV files read, in name order. */
  files: string[]
  recorded: IngestedRead[]
  /** 7-day reads waiting for a person's lever sentence; nothing was written for them. */
  needsLever: NeedsLever[]
  /** Rows matched to the ledger but not recorded (no bucket within tolerance, unparsable publish time). */
  skipped: IngestSkip[]
  /** Rows no ledger row matched (older uploads are expected here). */
  unmatched: IngestSkip[]
  /** Columns no alias recognised, per file. */
  unknownColumns: Record<string, string[]>
}

export interface IngestOptions {
  /** The reference clock; also the export time of any file whose name carries no timestamp. */
  now: Date
  /** Unused today beyond validation; reserved so profile-driven ingest rules (thresholds) travel with the call. */
  profile?: ProfileDoc
  /** Who is writing: defaults to `agent:review`. */
  source?: string
}

/** The read fields a Studio export can carry; anything else on a read was typed by a person and is kept on merge. */
const CSV_FIELDS: Array<keyof LedgerRead> = ['impressions', 'ctr', 'views', 'avdSec', 'avpPct']

/**
 * The export time of an inbox file from its name: `2026-09-14.csv`,
 * `studio-2026-09-14T18.csv`, `2026-09-14T18-30.csv` or `20260914-1830.csv`
 * all parse; a name without a date means "exported now" and returns `fallback`.
 * Times are read as UTC.
 */
export function exportTimeFrom(fileName: string, fallback: Date): Date {
  const iso = fileName.match(/(\d{4})-(\d{2})-(\d{2})(?:[T_ -](\d{2})(?:[-:h]?(\d{2}))?)?/)
  const compact = iso ? undefined : fileName.match(/(?<![\d])(\d{4})(\d{2})(\d{2})(?:[T_-](\d{2})(\d{2})?)?(?![\d])/)
  const m = iso ?? compact
  if (!m) return fallback
  const [, y, mo, d, h, mi] = m
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0))
  if (Number.isNaN(t)) return fallback
  const date = new Date(t)
  // Reject impossible dates (2026-13-40) that Date.UTC would silently roll over.
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return fallback
  return date
}

/** Match a Studio row to a ledger row: by video id first, then by slugified title (either side). */
export function matchLedgerRow(video: VideoRow, rows: LedgerRow[]): { row: LedgerRow; matchedBy: 'videoId' | 'title' } | undefined {
  if (video.videoId) {
    const byId = rows.find((r) => r.videoId !== undefined && r.videoId === video.videoId)
    if (byId) return { row: byId, matchedBy: 'videoId' }
  }
  const slug = slugify(video.title)
  const byTitle = rows.find((r) => r.slug === slug || slugify(r.title) === slug)
  return byTitle ? { row: byTitle, matchedBy: 'title' } : undefined
}

function sameNumbers(a: LedgerRead, b: LedgerRead): boolean {
  return CSV_FIELDS.every((k) => a[k] === b[k])
}

/**
 * Read every `*.csv` in `inboxDir` as a Studio Content export and record the
 * reads it carries. The bucket comes from the export time (the file name's
 * date, else `now`) against the row's publish time; a read more than the
 * bucket tolerance from every mark is skipped and named. An existing read at
 * that bucket is merged: export fields overwrite, person-typed fields (30 s
 * retention, returning share) stay. A 7-day read on a row without a lever is
 * not written; it comes back in `needsLever`. Files are left where they are.
 */
export function ingestInbox(store: Store, inboxDir: string, options: IngestOptions): IngestReport {
  const source = options.source ?? 'agent:review'
  const report: IngestReport = { inboxDir, files: [], recorded: [], needsLever: [], skipped: [], unmatched: [], unknownColumns: {} }
  if (!existsSync(inboxDir)) return report
  const files = readdirSync(inboxDir).filter((f) => f.toLowerCase().endsWith('.csv')).sort()
  for (const file of files) {
    report.files.push(file)
    const imported = readStudioRows(readFileSync(path.join(inboxDir, file), 'utf8'))
    if (imported.unknownColumns.length) report.unknownColumns[file] = imported.unknownColumns
    const at = exportTimeFrom(file, options.now)
    // A Studio export lists every upload on the channel; read the ledger once per file and refresh only after a write.
    let rows = readLedger(store)
    for (const video of imported.rows) {
      const match = matchLedgerRow(video, rows)
      if (!match) {
        report.unmatched.push({ file, title: video.title, ...(video.videoId ? { videoId: video.videoId } : {}), reason: 'no ledger row with this video id or title' })
        continue
      }
      const { row, matchedBy } = match
      const bucket = bucketFor(row.publishedAt, at)
      if (!bucket) {
        const hours = (at.getTime() - Date.parse(row.publishedAt)) / 3_600_000
        report.skipped.push({ file, title: video.title, slug: row.slug, reason: Number.isNaN(hours) ? 'publish time on the ledger row cannot be parsed' : `export taken ${Math.round(hours)} h after publish sits outside the tolerance of every read bucket (24/48/168/672 h)` })
        continue
      }
      const fresh = ledgerReadFromRow(video, { at })
      const existing = row.reads[bucket]
      const read: LedgerRead = existing ? { ...existing, ...fresh, at: existing.at } : fresh
      if (bucket === '168' && !row.lever) {
        report.needsLever.push({ file, slug: row.slug, bucket, read })
        continue
      }
      if (existing && sameNumbers(existing, read)) {
        report.recorded.push({ file, slug: row.slug, bucket, outcome: 'unchanged', read: existing, matchedBy })
        continue
      }
      const { at: readAt, ...numbers } = read
      recordRead(store, { slug: row.slug, bucket, read: { ...numbers, at: readAt }, source, now: options.now })
      rows = readLedger(store)
      report.recorded.push({ file, slug: row.slug, bucket, outcome: existing ? 'merged' : 'recorded', read, matchedBy })
    }
  }
  return report
}

/** One reviewed read: the verdict, the decision, the prepared swap, and what a person must do next. */
export interface Review {
  slug: string
  bucket: Bucket
  title: string
  /** When the read was taken; absent when the review ran on a missing read (a forced slug) and decided WAIT. */
  readAt?: string
  diagnosis: DiagnosisV2
  decision: DecisionDoc
  /** The swap prepared for REPACKAGE / RE-TEST-TITLE when `packages/<slug>/package.json` was found. */
  repackage?: RepackagePlan
  /** The package file the plan was built from. */
  packageFile?: string
  /** True when the decision doc was newly created or its decision changed. */
  changed: boolean
  /** Lines only a person can act on, each ending in a command. */
  awaiting: string[]
}

export interface RunReviewsOptions {
  now: Date
  profile: ProfileDoc
  /** Studio exports are ingested from here first; omit to skip ingest. */
  inboxDir?: string
  /** `<outDir>/<YYYY-MM-DD>.json` is written (merged into the day's file) when given. */
  outDir?: string
  /** Root of `packages/<slug>/`; defaults to `packages` under the current working directory. */
  packagesDir?: string
  /** Review this slug only, whether or not the queue says it is ready (the workflow stage). */
  slug?: string
  /** With `slug`: this bucket only. */
  bucket?: Bucket
  /** Who is writing: defaults to `agent:review`. */
  source?: string
}

export interface RunReviewsResult {
  date: string
  reviews: Review[]
  ingest?: IngestReport
  /** Reads whose hour mark has passed with no numbers yet. */
  awaitingData: DueReview[]
  /** Path of the JSON written, when `outDir` was given. */
  outFile?: string
  digest: string
}

/** The page written to `<outDir>/<date>.json`. */
export interface ReviewDayFile {
  date: string
  generatedAt: string
  reviews: Review[]
  awaitingData: Array<Pick<DueReview, 'slug' | 'bucket' | 'overdueHours'>>
  ingest?: Omit<IngestReport, 'inboxDir'>
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Read `packages/<slug>/package.json` into the shape `prepareRepackage()`
 * needs. Tolerant of the builder's variations: titles as strings or
 * `{title, score}`; thumbnails under `thumbnails` or `concepts`, with `qa.grade`
 * or a flat `grade`; the live title under `chosenTitle`, `title` or `finalTitle`;
 * the pair under `abPick` or `pair`. Returns undefined when the file is
 * missing or is not JSON.
 */
export function loadRepackagePackage(file: string): RepackagePackage | undefined {
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const titles: PackagedTitle[] = (Array.isArray(raw.titles) ? raw.titles : [])
    .map((t: unknown): PackagedTitle | undefined => {
      if (typeof t === 'string') return { title: t, score: 0 }
      if (isRecord(t) && typeof t.title === 'string') return { title: t.title, score: typeof t.score === 'number' ? t.score : 0 }
      return undefined
    })
    .filter((t): t is PackagedTitle => t !== undefined)
  const rawThumbs = Array.isArray(raw.thumbnails) ? raw.thumbnails : Array.isArray(raw.concepts) ? raw.concepts : []
  const thumbnails: PackagedThumbnail[] = rawThumbs
    .map((c: unknown): PackagedThumbnail | undefined => {
      if (!isRecord(c) || typeof c.name !== 'string') return undefined
      const qa = isRecord(c.qa) ? c.qa : {}
      const grade = typeof qa.grade === 'string' ? qa.grade : typeof c.grade === 'string' ? c.grade : 'revise'
      const score = typeof qa.score === 'number' ? qa.score : typeof c.score === 'number' ? c.score : undefined
      return { name: c.name, angle: typeof c.angle === 'string' ? c.angle : 'unknown', qa: { grade: grade === 'ship' || grade === 'rethink' ? grade : 'revise', ...(score !== undefined ? { score } : {}) } }
    })
    .filter((c): c is PackagedThumbnail => c !== undefined)
  const chosen = [raw.chosenTitle, raw.finalTitle, raw.title].find((v) => typeof v === 'string') as string | undefined
  const pair = isRecord(raw.abPick) ? raw.abPick : isRecord(raw.pair) ? raw.pair : undefined
  const abPick = pair && typeof pair.a === 'string' && typeof pair.b === 'string' ? { a: pair.a, b: pair.b } : undefined
  return { titles, thumbnails, ...(chosen ? { chosenTitle: chosen } : {}), ...(abPick ? { abPick } : {}) }
}

/** The diagnosis inputs a ledger read carries: its numbers, with `returningPct` renamed to the diagnosis field and `at` dropped. */
function readNumbers(read: LedgerRead): Partial<PostMortemInputV2> {
  const out: Partial<PostMortemInputV2> = {}
  if (read.impressions !== undefined) out.impressions = read.impressions
  if (read.ctr !== undefined) out.ctr = read.ctr
  if (read.views !== undefined) out.views = read.views
  if (read.avdSec !== undefined) out.avdSec = read.avdSec
  if (read.avpPct !== undefined) out.avpPct = read.avpPct
  if (read.retention30sPct !== undefined) out.retention30sPct = read.retention30sPct
  if (read.returningPct !== undefined) out.returningViewerPct = read.returningPct
  if (read.subscriberSharePct !== undefined) out.subscriberSharePct = read.subscriberSharePct
  if (read.browseSuggestedPct !== undefined) out.browseSuggestedPct = read.browseSuggestedPct
  return out
}

/** The baselines and mode a review at `bucket` compares against. */
function baselinesFor(profile: ProfileDoc, rows: LedgerRow[], slug: string, bucket: Bucket, now: Date): { baselines?: Baselines; mode: DiagnosisMode; flat?: PostMortemInputV2['baseline'] } {
  const input = baselineInputFrom(profile)
  const flat = input.source === 'computed' ? { ctr: input.ctr, avpPct: input.avpPct, ...(input.views !== undefined ? { views: input.views } : {}) } : undefined
  if (bucket === '24' || bucket === '48') {
    const baselines = profile.baselines
    const mode: DiagnosisMode = baselines && baselines.tier !== 'prior' ? 'established' : input.source === 'computed' ? 'established' : 'cold-start'
    return { baselines, mode, flat }
  }
  // 7 and 28 day reads judge on the multiple: leave-one-out 168 h medians from the ledger itself.
  const baselines = baselineFrom(rows, { bucket: '168', now, excludeSlug: slug })
  const mode: DiagnosisMode = baselines.tier !== 'prior' || input.source === 'computed' ? 'established' : 'cold-start'
  return { baselines, mode, flat }
}

/** The one-line human tasks a decision opens, each with its command. */
function awaitingFor(review: Pick<Review, 'slug' | 'bucket' | 'decision' | 'repackage' | 'packageFile'>): string[] {
  const { slug, bucket, decision } = review
  const id = `${slug}:${bucket}`
  switch (decision.decision) {
    case 'REPACKAGE':
      return [
        review.repackage
          ? `${id}: approve the swap${review.repackage.thumbnail ? ` to "${review.repackage.thumbnail.name}"` : ''}, apply it in Studio, then stamp it: booster decide approve ${slug} --bucket ${bucket} --by <name>`
          : `${id}: REPACKAGE decided but no package.json was found; build the swap plan: booster repackage prepare ${slug}`,
      ]
    case 'RE-TEST-TITLE':
      return [`${id}: start Test & Compare on the title${review.repackage?.title ? ` (vs "${review.repackage.title.title}")` : ''} and approve: booster decide approve ${slug} --bucket ${bucket} --by <name>`]
    case 'SEQUEL':
      return [`${id}: brief the sequel this week (the bank already holds the candidate): booster bank list --status banked`]
    case 'EXPAND':
      return [`${id}: bank two adjacent angles on this topic: booster bank add "<idea>" --score "demand=5,..."`]
    case 'PARK':
      return [`${id}: park the topic with the weakest axis named: booster bank park <idea-id> --reason "no audience at ${bucket} h"`]
    default:
      return []
  }
}

/** Format one review as its digest section. */
function reviewSection(r: Review): string[] {
  const lines = [`## ${r.slug} · ${r.bucket} h`, '', `**${r.title}**${r.readAt ? ` · read ${r.readAt.slice(0, 16).replace('T', ' ')} UTC` : ' · no read yet'}`, '']
  lines.push(`Verdict: **${r.diagnosis.bottleneck}** (${r.diagnosis.mode}) — ${r.diagnosis.headline}`, '', 'Evidence:')
  for (const e of r.diagnosis.evidence) lines.push(`- ${e}`)
  lines.push('', `Decision: **${r.decision.decision}**${r.changed ? '' : ' (unchanged)'}`)
  if (r.decision.flipCondition) lines.push(`Flip: ${r.decision.flipCondition}`)
  if (r.repackage) {
    lines.push('', `Repackage prepared from ${r.packageFile ?? 'the package'}:`)
    if (r.repackage.thumbnail) lines.push(`- thumbnail: ${r.repackage.thumbnail.name} (${r.repackage.thumbnail.angle}, QA ${r.repackage.thumbnail.qa.grade})`)
    if (r.repackage.title) lines.push(`- title: "${r.repackage.title.title}" (score ${r.repackage.title.score})`)
    r.repackage.instructions.forEach((i, n) => lines.push(`${n + 1}. ${i}`))
  }
  lines.push('')
  return lines
}

/** The next read to come due after `now`, for the "nothing due" line. */
function nextRead(rows: LedgerRow[], now: Date): { slug: string; bucket: Bucket; inHours: number } | undefined {
  let best: { slug: string; bucket: Bucket; inHours: number } | undefined
  for (const row of rows) {
    const age = ageHours(row, now)
    for (const bucket of BUCKETS) {
      if (row.reads[bucket] !== undefined || age >= BUCKET_HOURS[bucket]) continue
      const inHours = BUCKET_HOURS[bucket] - age
      if (!best || inHours < best.inHours) best = { slug: row.slug, bucket, inHours }
    }
  }
  return best
}

/** The digest: one section per review, then everything a person must do. */
export function renderDigest(result: Pick<RunReviewsResult, 'date' | 'reviews' | 'ingest' | 'awaitingData'>, extra: { rows?: LedgerRow[]; now?: Date } = {}): string {
  const lines = [`# Review digest · ${result.date}`, '']
  if (result.ingest) {
    const i = result.ingest
    const counts = [`${i.files.length} file${i.files.length === 1 ? '' : 's'}`, `${i.recorded.filter((r) => r.outcome !== 'unchanged').length} read${i.recorded.filter((r) => r.outcome !== 'unchanged').length === 1 ? '' : 's'} recorded`]
    if (i.needsLever.length) counts.push(`${i.needsLever.length} waiting for a lever`)
    if (i.skipped.length) counts.push(`${i.skipped.length} skipped`)
    if (i.unmatched.length) counts.push(`${i.unmatched.length} unmatched`)
    lines.push(`Inbox: ${counts.join(', ')}.`, '')
  }
  if (result.reviews.length === 0) {
    const next = extra.rows && extra.now ? nextRead(extra.rows, extra.now) : undefined
    lines.push(next ? `Nothing to review. Next read: ${next.slug} at ${next.bucket} h in ${Math.ceil(next.inHours)} h.` : 'Nothing to review.', '')
  }
  for (const r of result.reviews) lines.push(...reviewSection(r))
  const awaiting = [
    ...result.reviews.flatMap((r) => r.awaiting),
    ...(result.ingest?.needsLever ?? []).map((n) => `${n.slug}:168: write the lever learned, then the read records itself on the next run: booster set ${n.slug} --bucket 168 --lever "<one sentence of learning>"`),
    ...result.awaitingData.map((d) => `${d.slug}:${d.bucket}: no numbers yet (${d.overdueHours} h overdue); drop the Studio export in inbox/ or type them: booster set ${d.slug} --bucket ${d.bucket} --impressions N --ctr X --avp Y${d.bucket === '48' ? ' --ret30 Z --returning W' : d.bucket === '168' ? ' --views V --returning W --lever "<sentence>"' : ''}`),
  ]
  lines.push('## Awaiting a human', '')
  if (awaiting.length === 0) lines.push('- nothing')
  for (const a of awaiting) lines.push(`- ${a}`)
  return lines.join('\n')
}

/**
 * Ingest the inbox, then review every ready read (or the forced slug/bucket):
 * diagnose with the profile baselines and the bucket's mode, decide, prepare
 * the swap when the decision asks for one, write the decision (keeping any
 * approval when the decision did not change; a bucket a person already
 * applied is never re-decided), stamp the row's bottleneck and decision, and
 * write the day's JSON. Returns the reviews and the Markdown digest.
 */
export function runReviews(store: Store, options: RunReviewsOptions): RunReviewsResult {
  const { now, profile } = options
  const source = options.source ?? 'agent:review'
  const date = now.toISOString().slice(0, 10)
  const ingest = options.inboxDir ? ingestInbox(store, options.inboxDir, { now, profile, source }) : undefined
  const queue = reviewQueue(store, now)
  const forced = options.slug !== undefined
  const targets = queue.filter((q) => {
    if (forced) return q.slug === options.slug && (options.bucket === undefined || q.bucket === options.bucket) && q.status !== 'applied'
    return q.status === 'ready'
  })
  if (forced && targets.length === 0 && options.bucket !== undefined) {
    const row = store.get('ledger', options.slug as string)
    if (!row) throw new Error(`no ledger row for "${options.slug}"`)
    if (ageHours(row, now) < BUCKET_HOURS[options.bucket]) throw new Error(`${options.slug} is ${Math.round(ageHours(row, now))} h old; the ${options.bucket}-hour read is not due yet`)
  }
  const rows = readLedger(store)
  const packagesDir = options.packagesDir ?? path.resolve('packages')
  const reviews: Review[] = []
  for (const q of targets) {
    const { row, bucket, read } = q
    const { baselines, mode, flat } = baselinesFor(profile, rows, row.slug, bucket, now)
    const input: PostMortemInputV2 = {
      ...(read ? readNumbers(read) : {}),
      bucket,
      mode,
      baselines,
      baseline: flat,
      hoursSincePublish: ageHours(row, now),
      previousRead: bucket === '48' ? row.reads['24'] : undefined,
    }
    const diagnosis = diagnose(input)
    const fresh = decide({ diagnosis, row, bucket, baselines, now, source })
    const existing = store.get('decisions', fresh.id)
    const unchanged = existing !== undefined && existing.decision === fresh.decision
    const decision = DecisionDoc.parse(unchanged ? { ...fresh, approvedBy: existing.approvedBy, approvedAt: existing.approvedAt } : fresh)
    store.upsert('decisions', decision)
    let repackage: RepackagePlan | undefined
    let packageFile: string | undefined
    if (decision.decision === 'REPACKAGE' || decision.decision === 'RE-TEST-TITLE') {
      const file = path.join(packagesDir, row.slug, 'package.json')
      const pkg = loadRepackagePackage(file)
      if (pkg) {
        repackage = prepareRepackage(pkg, decision)
        packageFile = file
      }
    }
    if (decision.decision !== 'WAIT') {
      const current = store.get('ledger', row.slug) as LedgerRow
      store.upsert('ledger', LedgerRow.parse({ ...current, bottleneck: diagnosis.bottleneck, decision: decision.decision, updatedAt: now.toISOString(), source }))
    }
    const review: Review = { slug: row.slug, bucket, title: row.title, readAt: read?.at, diagnosis, decision, repackage, packageFile, changed: !unchanged, awaiting: [] }
    review.awaiting = awaitingFor(review)
    reviews.push(review)
  }
  const awaitingData = dueReviews(store, now)
  const result: RunReviewsResult = { date, reviews, ingest, awaitingData, digest: '' }
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true })
    const file = path.join(options.outDir, `${date}.json`)
    let previous: Review[] = []
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReviewDayFile>
        previous = Array.isArray(raw.reviews) ? raw.reviews : []
      } catch {
        previous = []
      }
    }
    const ids = new Set(reviews.map((r) => `${r.slug}:${r.bucket}`))
    const merged = [...previous.filter((r) => !ids.has(`${r.slug}:${r.bucket}`)), ...reviews]
    const page: ReviewDayFile = {
      date,
      generatedAt: now.toISOString(),
      reviews: merged,
      awaitingData: awaitingData.map((d) => ({ slug: d.slug, bucket: d.bucket, overdueHours: d.overdueHours })),
    }
    if (ingest) page.ingest = { files: ingest.files, recorded: ingest.recorded, needsLever: ingest.needsLever, skipped: ingest.skipped, unmatched: ingest.unmatched, unknownColumns: ingest.unknownColumns }
    writeFileSync(file, `${JSON.stringify(page, null, 2)}\n`)
    result.outFile = file
  }
  result.digest = renderDigest(result, { rows: readLedger(store), now })
  return result
}
