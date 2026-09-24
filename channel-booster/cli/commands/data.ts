/**
 * Commands: profile, ingest, set, ledger, fetch, thresholds.
 *
 * The data side of the booster: the channel profile (channel.json), the
 * packaging ledger (data/ledger.jsonl through the store), Studio exports
 * dropped in inbox/, the optional Data API fetch, and the threshold table.
 * Every location comes from the shared helpers (cli/shared.ts), so a channel
 * workspace holds all of it and the old --path, --data and --root still win.
 * Gate 6 of AGENTS.md is human-only: `set --lever`, `ingest --lever` and a
 * `profile refresh` that would move an existing baseline print what they are
 * about to write and need --yes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fetchChannelVideos, resolveChannelRef, toCsv, CSV_HEADER } from '../../src/adapters/youtube-data.js'
import { BUCKETS, BUCKET_HOURS, type Bucket } from '../../src/buckets.js'
import { bucketFor, ledgerReadFromRow, readStudioRows } from '../../src/csv.js'
import { addRow, ageHours, baselineFrom, dueReads, leverTally, ownOutliers, readLedger, recordRead, renderLedgerMarkdown } from '../../src/ledger.js'
import { initProfile, loadProfile, movedMetrics, profileExists, refreshBaselines, renderProfileText, saveProfile } from '../../src/profile.js'
import type { Baselines, LedgerRead, LedgerRow, ProfileDoc, Stat } from '../../src/schema.js'
import { DEFAULT_THRESHOLDS, thresholds, type ThresholdKey } from '../../src/thresholds.js'
import { resolveCsvArg } from '../example-clock.js'
import { cliName } from '../../src/build-info.js'
import { activeWorkspace, bool, getStore, inboxDir, need, nowFrom, num, out, packagesRoot, profilePath, str, writeOut, type CommandModule, type Flags } from '../shared.js'

const USAGE_PROFILE = `${cliName()} profile init|show|refresh [--path channel.json]`
const USAGE_INGEST = `${cliName()} ingest <studio-content.csv> [--at ISO] [--bucket 24|48|168|672] [--lever ".." --yes] [--dry-run]`
const USAGE_SET = `${cliName()} set <slug> --bucket 24|48|168|672 [--ret30 n] [--returning n] [--sub-share n] [--browse-suggested n] [--impressions n] [--ctr n] [--avp n] [--avd-sec n] [--views n] [--lever ".." --yes]`
const USAGE_LEDGER = `${cliName()} ledger add|show|baseline|levers|winners|due|export`
const USAGE_LEDGER_ADD = `${cliName()} ledger add --slug <slug> --title ".." --published-at ISO [--video-id id] [--thumb-a name] [--thumb-b name] [--sequel-of slug]`
const USAGE_FETCH = `${cliName()} fetch channel <@handle|UC-id> [--max 50] [--out inbox/<name>.csv] [--inbox dir]`

const FACE_POLICIES = ['always', 'never', 'either'] as const
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const STORES = ['local', 'db'] as const
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/** `--bucket` as a Bucket, or undefined when absent; any other value is refused. */
function bucketFlag(flags: Flags): Bucket | undefined {
  const v = str(flags, 'bucket')
  if (v === undefined) return undefined
  if (!(BUCKETS as readonly string[]).includes(v)) throw new Error(`--bucket must be one of ${BUCKETS.join('|')}, got "${v}"`)
  return v as Bucket
}

function oneOf<T extends string>(flags: Flags, key: string, allowed: readonly T[]): T | undefined {
  const v = str(flags, key)
  if (v === undefined) return undefined
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${key} must be one of ${allowed.join('|')}, got "${v}"`)
  return v as T
}

function isoFlag(flags: Flags, key: string): string | undefined {
  const v = str(flags, key)
  if (v === undefined) return undefined
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`--${key} must be an ISO date, got "${v}"`)
  return d.toISOString()
}

/**
 * Human-only gate: print what is about to be written, then stop unless --yes
 * was given. Never simulate the confirmation.
 */
function requireYes(flags: Flags, plan: Record<string, unknown>, lines: string[], what: string): void {
  if (bool(flags, 'yes')) return
  out({ needsConfirmation: true, ...plan }, flags, () => [...lines, '', `${what} is a human-only gate (AGENTS.md): re-run with --yes to confirm.`].join('\n'))
  throw new Error(`${what} needs --yes (a person decides; an agent only prepares)`)
}

function n1(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** One read as "impressions 721000, CTR 5.9%, views 38000, AVD 342 s, AVP 36.8%, 30 s 62%, returning 38%". */
function describeRead(read: Partial<LedgerRead>): string {
  const parts: string[] = []
  if (read.impressions !== undefined) parts.push(`impressions ${n1(read.impressions)}`)
  if (read.ctr !== undefined) parts.push(`CTR ${n1(read.ctr)}%`)
  if (read.views !== undefined) parts.push(`views ${n1(read.views)}`)
  if (read.avdSec !== undefined) parts.push(`AVD ${n1(read.avdSec)} s`)
  if (read.avpPct !== undefined) parts.push(`AVP ${n1(read.avpPct)}%`)
  if (read.retention30sPct !== undefined) parts.push(`30 s ${n1(read.retention30sPct)}%`)
  if (read.returningPct !== undefined) parts.push(`returning ${n1(read.returningPct)}%`)
  if (read.subscriberSharePct !== undefined) parts.push(`subscribers ${n1(read.subscriberSharePct)}%`)
  if (read.browseSuggestedPct !== undefined) parts.push(`browse+suggested ${n1(read.browseSuggestedPct)}%`)
  return parts.length > 0 ? parts.join(', ') : '(no numbers)'
}

function statLine(label: string, stat: Stat | undefined, suffix: string): string {
  return stat ? `  ${label}: median ${n1(stat.median)}${suffix}, MAD ${n1(stat.mad)}, n=${stat.n}` : `  ${label}: not in the ledger`
}

/** One baseline set on one line, for the gate that asks before a refresh moves it. */
function describeBaselines(b: Baselines): string {
  return `${b.tier}, n=${b.n}, CTR ${b.ctr ? `${n1(b.ctr.median)}%` : '—'}, AVP ${b.avpPct ? `${n1(b.avpPct.median)}%` : '—'}, views ${b.views ? n1(b.views.median) : '—'}`
}

function renderBaselines(b: Baselines, extra: string[] = []): string {
  return [
    `Baseline at ${b.bucket} h: tier ${b.tier}, n=${b.n}${extra.length ? ` (${extra.join(', ')})` : ''}, computed ${b.computedAt}${b.shift ? ', SHIFTED since previous' : ''}`,
    statLine('CTR', b.ctr, '%'),
    statLine('AVP', b.avpPct, '%'),
    statLine('30 s retention', b.retention30sPct, '%'),
    statLine('returning share', b.returningPct, '%'),
    statLine('views', b.views, ''),
    statLine('impressions', b.impressions, ''),
  ].join('\n')
}

function renderRow(r: LedgerRow): string {
  const marks = BUCKETS.map((b) => `${b}h ${r.reads[b] ? '✓' : '—'}`).join(' ')
  const extras = [r.videoId ? `id ${r.videoId}` : '', r.thumbA || r.thumbB ? `${r.thumbA ?? '—'}/${r.thumbB ?? '—'}` : '', r.winner ? `winner ${r.winner}` : '', r.lever ? `lever: ${r.lever}` : ''].filter(Boolean)
  return `${r.publishedAt.slice(0, 10)}  ${r.slug.padEnd(24)} ${r.title}\n    reads: ${marks}${extras.length ? `  ·  ${extras.join('  ·  ')}` : ''}`
}

/** File name for a fetched channel: the handle without "@" or the UC id, restricted to safe characters. */
function channelFileName(ref: string): string {
  const resolved = resolveChannelRef(ref)
  const raw = 'id' in resolved ? resolved.id : resolved.forHandle.replace(/^@/, '')
  return raw.replace(/[^A-Za-z0-9_-]/g, '_')
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// ---------------------------------------------------------------- profile

async function runProfile(sub: string | undefined, flags: Flags): Promise<number> {
  const file = profilePath(flags)
  const now = nowFrom(flags)
  if (sub === 'init') {
    if (profileExists(file) && !bool(flags, 'force')) throw new Error(`${file} exists; pass --force to overwrite`)
    const profile = initProfile({
      positioning: str(flags, 'positioning'),
      persona: str(flags, 'persona'),
      colors: str(flags, 'colors'),
      facePolicy: oneOf(flags, 'face', FACE_POLICIES),
      maxWords: num(flags, 'max-words'),
      framing: str(flags, 'framing'),
      typeface: str(flags, 'typeface'),
      signatureNotes: str(flags, 'notes'),
      competitors: str(flags, 'competitors'),
      maxPerWeek: num(flags, 'max-per-week'),
      publishDay: oneOf(flags, 'publish-day', WEEKDAYS),
      solo: bool(flags, 'team') ? false : bool(flags, 'solo') ? true : undefined,
      store: oneOf(flags, 'store', STORES),
      neverAgain: str(flags, 'never-again'),
      now,
    })
    const saved = saveProfile(profile, file, { now })
    out({ path: file, profile: saved }, flags, () => [`Wrote ${file}`, renderProfileText(saved), '', 'Next: booster profile refresh once the ledger has rows aged 7 days or more; edit series in the file by hand.'].join('\n'))
    return 0
  }
  if (sub === 'show') {
    const profile: ProfileDoc = loadProfile(file)
    out(profile, flags, () => renderProfileText(profile, { path: file, exists: profileExists(file) }))
    return 0
  }
  if (sub === 'refresh') {
    const store = getStore(flags)
    const result = refreshBaselines(loadProfile(file), readLedger(store), { now, window: num(flags, 'window'), minAgeDays: num(flags, 'min-age-days') })
    const dryRun = bool(flags, 'dry-run')
    const prev = result.previous
    const prev168 = result.previous168
    // Both sets are gated: a 7-day read is judged against baselines168, so moving it unasked
    // is the same silent reset as moving the 48-hour one.
    const moved = [
      ...movedMetrics(result.baselines48, prev).map((m) => `48 h ${m}`),
      ...movedMetrics(result.baselines168, prev168).map((m) => `7 d ${m}`),
    ]
    // Resetting the baseline is human-only (AGENTS.md gate 6), but only a reset is: the first
    // computation on a fresh channel and a recompute that lands on the same medians write freely.
    if (!dryRun && (prev || prev168) && moved.length > 0) {
      requireYes(flags, { path: file, moved, previous: prev, previous168: prev168, baselines48: result.baselines48, baselines168: result.baselines168 }, [
        `About to reset the baselines in ${file}: ${moved.join(', ')} ${moved.length === 1 ? 'moves' : 'move'}.`,
        `  was: 48 h ${prev ? describeBaselines(prev) : 'not computed yet'} · 7 d ${prev168 ? describeBaselines(prev168) : 'not computed yet'}`,
        `  now: 48 h ${describeBaselines(result.baselines48)} · 7 d ${describeBaselines(result.baselines168)}`,
        'Every verdict after this is judged against the new medians; booster profile refresh --dry-run shows the whole profile first.',
      ], 'resetting the baseline')
    }
    if (!dryRun) saveProfile(result.profile, file, { now })
    const b168 = result.baselines168
    out({ path: file, dryRun, moved, baselines48: result.baselines48, baselines168: b168, previous: result.previous, shift: result.shift, shifted: result.shifted }, flags, () => [
      dryRun ? `Dry run: ${file} not written.` : `Wrote ${file}`,
      renderProfileText(result.profile),
      result.shift ? `Baseline SHIFT: ${result.shifted.join(', ')} moved more than one MAD since ${result.previous?.computedAt ?? 'the previous refresh'}` : 'No baseline shift.',
      `7-day: views median ${b168.views ? n1(b168.views.median) : '—'}, returning ${b168.returningPct ? n1(b168.returningPct.median) : '—'}% (n=${b168.n}, ${b168.tier})`,
    ].join('\n'))
    return 0
  }
  throw new Error(`usage: ${USAGE_PROFILE}`)
}

// ---------------------------------------------------------------- ingest

interface IngestPlan {
  slug: string
  videoId: string
  title: string
  bucket: Bucket
  ageHours: number
  read: LedgerRead
  /** The lever this row will carry (from --lever or the row); only written when the read is a 7-day read. */
  lever?: string
  writesLever: boolean
}

interface IngestSkip {
  videoId?: string
  title: string
  slug?: string
  reason: string
}

async function runIngest(given: string | undefined, flags: Flags): Promise<number> {
  if (!given) throw new Error(`usage: ${USAGE_INGEST}`)
  const file = resolveCsvArg(given)
  if (!existsSync(file)) throw new Error(`${file} not found. Drop the Studio Content export in inbox/ and pass its path.`)
  const store = getStore(flags)
  const now = nowFrom(flags)
  const at = isoFlag(flags, 'at') ?? now.toISOString()
  const forced = bucketFlag(flags)
  const leverFlag = str(flags, 'lever')
  const dryRun = bool(flags, 'dry-run')
  const { rows, unknownColumns, droppedTotalRow } = readStudioRows(readFileSync(file, 'utf8'))
  const ledger = readLedger(store)

  const planned: IngestPlan[] = []
  const skipped: IngestSkip[] = []
  for (const row of rows) {
    const videoId = row.videoId && VIDEO_ID.test(row.videoId) ? row.videoId : undefined
    if (!videoId) {
      skipped.push({ videoId: row.videoId, title: row.title, reason: 'no 11-character YouTube video id in the export' })
      continue
    }
    const match = ledger.find((r) => r.videoId === videoId)
    if (!match) {
      skipped.push({ videoId, title: row.title, reason: `no ledger row (booster publish confirm --video-id ${videoId} --at ISO, or booster ledger add --video-id ${videoId})` })
      continue
    }
    const age = (Date.parse(at) - Date.parse(match.publishedAt)) / 3_600_000
    const bucket = forced ?? bucketFor(match.publishedAt, at)
    if (!bucket) {
      skipped.push({ videoId, title: row.title, slug: match.slug, reason: `read at ${Math.round(age)} h is not within ${Math.round(thresholds.bucketTolerance.value * 100)}% of ${BUCKETS.join('/')} h; pass --bucket` })
      continue
    }
    // Merge over the read already at that bucket so numbers typed with `booster set` survive a re-ingest.
    const read: LedgerRead = { ...match.reads[bucket], ...ledgerReadFromRow(row, { at }) }
    const lever = bucket === '168' ? (leverFlag ?? match.lever) : match.lever
    if (bucket === '168' && !lever) {
      skipped.push({ videoId, title: row.title, slug: match.slug, reason: 'a 7-day read needs the lever learned: pass --lever "one sentence of learning" --yes' })
      continue
    }
    planned.push({ slug: match.slug, videoId, title: row.title, bucket, ageHours: Math.round(age), read, lever, writesLever: bucket === '168' && leverFlag !== undefined && leverFlag !== match.lever })
  }

  const leverRows = planned.filter((p) => p.writesLever)
  if (leverRows.length > 0 && !dryRun) {
    requireYes(flags, { file, at, lever: leverFlag, rows: leverRows.map((p) => p.slug) }, [
      `About to write the lever "${leverFlag}" on ${leverRows.length} 7-day read${leverRows.length === 1 ? '' : 's'}: ${leverRows.map((p) => p.slug).join(', ')}`,
    ], 'writing a lever')
  }

  const recorded: IngestPlan[] = []
  for (const p of planned) {
    if (dryRun) {
      recorded.push(p)
      continue
    }
    try {
      recordRead(store, { slug: p.slug, bucket: p.bucket, read: p.read, lever: p.writesLever ? p.lever : undefined, source: 'cli', now })
      recorded.push(p)
    } catch (error) {
      skipped.push({ videoId: p.videoId, title: p.title, slug: p.slug, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  out({ file, at, dryRun, unknownColumns, droppedTotalRow, recorded: recorded.map(({ writesLever, ...r }) => ({ ...r, leverWritten: writesLever && !dryRun })), skipped }, flags, () => {
    const lines = [`Ingest ${file} · read taken at ${at}${dryRun ? ' · DRY RUN (nothing written)' : ''}`]
    if (unknownColumns.length > 0) lines.push(`ignored columns: ${unknownColumns.join(', ')}`)
    if (droppedTotalRow) lines.push('Total row dropped')
    for (const r of recorded) lines.push(`${dryRun ? 'would record' : 'recorded'} ${r.slug} (${r.videoId}) at ${r.bucket} h [${r.ageHours} h old]: ${describeRead(r.read)}${r.writesLever ? `  lever: ${r.lever}` : ''}`)
    for (const s of skipped) lines.push(`skipped ${s.slug ?? s.videoId ?? '?'} ${s.title}: ${s.reason}`)
    lines.push(`${recorded.length} read${recorded.length === 1 ? '' : 's'} ${dryRun ? 'planned' : 'recorded'}, ${skipped.length} skipped`)
    return lines.join('\n')
  })
  return 0
}

// ---------------------------------------------------------------- set

const SET_FIELDS: Array<[flag: string, field: keyof Omit<LedgerRead, 'at'>]> = [
  ['ret30', 'retention30sPct'],
  ['returning', 'returningPct'],
  ['sub-share', 'subscriberSharePct'],
  ['browse-suggested', 'browseSuggestedPct'],
  ['impressions', 'impressions'],
  ['ctr', 'ctr'],
  ['avp', 'avpPct'],
  ['avd-sec', 'avdSec'],
  ['views', 'views'],
]

async function runSet(slug: string | undefined, flags: Flags): Promise<number> {
  if (!slug) throw new Error(`usage: ${USAGE_SET}`)
  const bucket = bucketFlag(flags)
  if (!bucket) throw new Error(`--bucket is required. Usage: ${USAGE_SET}`)
  const store = getStore(flags)
  const row = store.get('ledger', slug)
  if (!row) throw new Error(`no ledger row for "${slug}". Publish it first (booster publish confirm) or add it (booster ledger add).`)
  const now = nowFrom(flags)
  const typed: Partial<Omit<LedgerRead, 'at'>> = {}
  for (const [flag, field] of SET_FIELDS) {
    const v = num(flags, flag)
    if (v !== undefined) typed[field] = v
    else if (str(flags, flag) !== undefined) throw new Error(`--${flag} must be a number, got "${str(flags, flag)}"`)
  }
  const lever = str(flags, 'lever')
  if (Object.keys(typed).length === 0 && lever === undefined) throw new Error(`nothing to set. Usage: ${USAGE_SET}`)
  const existing = row.reads[bucket]
  const read: LedgerRead = { ...existing, ...typed, at: existing?.at ?? now.toISOString() }
  if (lever !== undefined && lever !== row.lever) {
    requireYes(flags, { slug, bucket, lever, previousLever: row.lever }, [
      `About to write the lever on ${slug}: "${lever}"${row.lever ? ` (replacing "${row.lever}")` : ''}`,
      `and record the ${bucket} h read: ${describeRead(read)}`,
    ], 'writing a lever')
  }
  const updated = recordRead(store, { slug, bucket, read, lever, source: 'cli', now })
  out(updated, flags, () => [
    `${slug} · ${bucket} h read ${existing ? `merged into the read from ${existing.at}` : `created at ${read.at}`}: ${describeRead(updated.reads[bucket] ?? read)}`,
    ...(lever !== undefined ? [`lever: ${updated.lever}`] : []),
  ].join('\n'))
  return 0
}

// ---------------------------------------------------------------- ledger

async function runLedger(sub: string | undefined, flags: Flags): Promise<number> {
  const store = getStore(flags)
  const now = nowFrom(flags)
  if (sub === 'add') {
    const slug = need(flags, 'slug', USAGE_LEDGER_ADD)
    const title = need(flags, 'title', USAGE_LEDGER_ADD)
    const publishedAt = isoFlag(flags, 'published-at')
    if (!publishedAt) throw new Error(`--published-at is required. Usage: ${USAGE_LEDGER_ADD}`)
    const videoId = str(flags, 'video-id')
    if (videoId !== undefined && !VIDEO_ID.test(videoId)) throw new Error(`--video-id must be the 11-character YouTube id, got "${videoId}"`)
    // The lever is what the 7-day read taught, so there is nothing to learn at add time; refusing
    // beats accepting a flag that would be dropped, and keeps the human gate on one writer.
    if (flags.lever !== undefined) throw new Error(`ledger add has no --lever: the lever is the sentence the 7-day read taught. Add the row, then booster set ${slug} --bucket 168 --lever ".." --yes (or booster ingest <studio.csv> --lever ".." --yes).`)
    const existed = store.get('ledger', slug) !== undefined
    const row = addRow(store, { slug, title, publishedAt, videoId, thumbA: str(flags, 'thumb-a'), thumbB: str(flags, 'thumb-b'), sequelOf: str(flags, 'sequel-of'), source: 'cli', now })
    const due = dueReads([row], now)
    out(row, flags, () => [
      `${existed ? 'updated' : 'added'} ${row.slug} "${row.title}" published ${row.publishedAt}${row.videoId ? ` (video ${row.videoId})` : ''}`,
      due.length > 0 ? `reads due now: ${due.map((d) => `${d.bucket} h`).join(', ')} (booster ingest <studio.csv> or booster set ${row.slug} --bucket ..)` : `first read due at ${new Date(Date.parse(row.publishedAt) + BUCKET_HOURS['24'] * 3_600_000).toISOString()}`,
    ].join('\n'))
    return 0
  }
  if (sub === 'show') {
    const slugFilter = str(flags, 'slug')
    const rows = readLedger(store).filter((r) => !slugFilter || r.slug === slugFilter)
    if (slugFilter && rows.length === 0) throw new Error(`no ledger row for "${slugFilter}"`)
    out(rows, flags, () => (bool(flags, 'md') ? renderLedgerMarkdown(rows) : rows.length > 0 ? rows.map(renderRow).join('\n') : 'Ledger is empty (booster ledger add, or booster publish confirm after upload).'))
    return 0
  }
  if (sub === 'baseline') {
    const bucket = bucketFlag(flags) ?? '48'
    if (bucket !== '48' && bucket !== '168') throw new Error('ledger baseline: --bucket must be 48 or 168 (the buckets a baseline is judged at)')
    const excludeSlug = str(flags, 'exclude')
    const window = num(flags, 'window')
    const minAgeDays = num(flags, 'min-age-days')
    const b = baselineFrom(readLedger(store), { bucket, now, excludeSlug, window, minAgeDays })
    const extra = [`window ${window ?? 10}`, `min age ${minAgeDays ?? 7} d`, ...(excludeSlug ? [`excluding ${excludeSlug}`] : [])]
    out({ ...b, excludeSlug, window: window ?? 10, minAgeDays: minAgeDays ?? 7 }, flags, () => renderBaselines(b, extra))
    return 0
  }
  if (sub === 'levers') {
    const tally = leverTally(readLedger(store))
    out(tally, flags, () => (tally.length > 0 ? tally.map((t) => `${String(t.count).padStart(3)}x  ${t.lever}  (${t.slugs.join(', ')})`).join('\n') : 'No levers recorded yet (a 7-day read carries one: booster set <slug> --bucket 168 --lever ".." --yes).'))
    return 0
  }
  if (sub === 'winners') {
    const winners = ownOutliers(readLedger(store), num(flags, 'multiplier'))
    const multiplier = num(flags, 'multiplier') ?? thresholds.ownWinnerMultiplier.value
    out(winners.map((w) => ({ slug: w.row.slug, title: w.row.title, multiple: w.multiple, views168: w.row.reads['168']?.views, publishedAt: w.row.publishedAt })), flags, () => (winners.length > 0
      ? winners.map((w) => `${w.multiple.toFixed(1)}x  ${w.row.slug}  "${w.row.title}"  ${n1(w.row.reads['168']?.views ?? 0)} views at 7 d`).join('\n')
      : `No own winners yet: needs 7-day reads and a row at ${multiplier}x the median [${thresholds.ownWinnerMultiplier.evidence}].`))
    return 0
  }
  if (sub === 'due') {
    const rows = readLedger(store)
    const due = dueReads(rows, now)
    out(due, flags, () => (due.length > 0
      ? due.map((d) => {
          const row = rows.find((r) => r.slug === d.slug)
          return `${d.slug.padEnd(24)} ${d.bucket} h read  overdue ${d.overdueHours} h${row ? `  (age ${Math.round(ageHours(row, now))} h)` : ''}`
        }).join('\n')
      : 'Nothing due.'))
    return 0
  }
  if (sub === 'export') {
    const rows = readLedger(store)
    const md = bool(flags, 'md')
    const outFile = str(flags, 'out')
    const text = md ? `${renderLedgerMarkdown(rows)}\n` : `${JSON.stringify(rows, null, 2)}\n`
    if (outFile) {
      const target = path.resolve(outFile)
      writeText(target, text)
      out({ out: target, rows: rows.length, format: md ? 'md' : 'json' }, flags, () => `wrote ${rows.length} row${rows.length === 1 ? '' : 's'} to ${target}`)
      return 0
    }
    if (flags.json) out(rows, flags, () => '')
    else writeOut(text)
    return 0
  }
  throw new Error(`usage: ${USAGE_LEDGER}`)
}

// ---------------------------------------------------------------- fetch

/**
 * Where a fetched upload list lands without --out: the inbox (--inbox, or
 * <workspace>/inbox) when either is given; with neither, <--root or the
 * working directory>/inbox, where fetch has always written.
 */
function fetchInbox(flags: Flags): string {
  if (str(flags, 'inbox')?.trim() || activeWorkspace(flags)) return inboxDir(flags)
  return path.join(packagesRoot(flags), 'inbox')
}

async function runFetch(sub: string | undefined, rest: string[], flags: Flags): Promise<number> {
  if (sub !== 'channel') throw new Error(`usage: ${USAGE_FETCH}`)
  const ref = rest[0]
  if (!ref) throw new Error(`usage: ${USAGE_FETCH}`)
  const name = channelFileName(ref)
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey || !apiKey.trim()) throw new Error('fetch channel: YOUTUBE_API_KEY is not set. Export a YouTube Data API v3 key (Google Cloud) in the environment; it is never printed or stored.')
  const max = num(flags, 'max') ?? 50
  if (max < 1) throw new Error('--max must be at least 1')
  const target = path.resolve(str(flags, 'out') ?? path.join(fetchInbox(flags), `${name}.csv`))
  const rows = await fetchChannelVideos({ handleOrId: ref, apiKey, max })
  writeText(target, toCsv(rows))
  out({ channel: ref, videos: rows.length, out: target, columns: [...CSV_HEADER] }, flags, () => [
    `fetched ${rows.length} video${rows.length === 1 ? '' : 's'} from ${ref} → ${target}`,
    `columns: ${CSV_HEADER.join(',')}`,
    `next: booster outliers ${target}`,
  ].join('\n'))
  return 0
}

// ---------------------------------------------------------------- thresholds

async function runThresholds(sub: string | undefined, flags: Flags): Promise<number> {
  const keys = Object.keys(DEFAULT_THRESHOLDS) as ThresholdKey[]
  if (sub !== undefined && !keys.includes(sub as ThresholdKey)) throw new Error(`unknown threshold "${sub}". Run booster thresholds to list them.`)
  const shown = sub ? [sub as ThresholdKey] : keys
  const table = Object.fromEntries(shown.map((k) => [k, thresholds[k]]))
  const width = Math.max(...shown.map((k) => k.length))
  out(table, flags, () => shown.map((k) => `${k.padEnd(width)} ${thresholds[k].value} [${thresholds[k].evidence}] ${thresholds[k].note}`).join('\n'))
  return 0
}

export const dataModule: CommandModule = {
  verbs: ['profile', 'ingest', 'set', 'ledger', 'fetch', 'thresholds'],
  help: [
    'profile init [--positioning ..] [--persona ..] [--colors "yellow,black"] [--face always|never|either] [--max-words 3] [--framing ..] [--typeface ..] [--competitors "A, B"] [--max-per-week 1] [--publish-day thu] [--solo|--team] [--store local|db] [--never-again "a; b"] [--force]',
    'profile show [--path channel.json]                                  the channel profile and its baselines',
    'profile refresh [--window 10] [--min-age-days 7] [--dry-run] [--yes]  recompute baselines from the ledger; moving an existing baseline needs --yes (human-only gate 6)',
    'ingest <studio-content.csv> [--at ISO] [--bucket 24|48|168|672] [--lever ".." --yes] [--dry-run]   record a Studio export as ledger reads',
    'set <slug> --bucket 48 [--ret30 n] [--returning n] [--sub-share n] [--browse-suggested n] [--impressions n] [--ctr n] [--avp n] [--views n] [--lever ".." --yes]   type the numbers Studio does not export',
    'ledger add --slug <slug> --title ".." --published-at ISO [--video-id id] [--thumb-a ..] [--thumb-b ..] [--sequel-of slug]',
    'ledger show [--slug <slug>] [--md]                                  the ledger, as text or the playbook table',
    'ledger baseline [--bucket 48|168] [--exclude slug] [--window 10] [--min-age-days 7]   median and MAD from your own history',
    'ledger levers | ledger winners [--multiplier 5] | ledger due        lever tally, own outliers, reads due',
    'ledger export [--out file.json | --md [--out file.md]]              dump the ledger',
    'fetch channel <@handle|UC-id> [--max 50] [--out inbox/<name>.csv] [--inbox dir]   Data API v3 upload list into the inbox (needs YOUTUBE_API_KEY)',
    'thresholds [<key>]                                                  every gate as "key value [evidence] note"',
  ],
  async run(cmd, sub, rest, flags) {
    switch (cmd) {
      case 'profile':
        return runProfile(sub, flags)
      case 'ingest':
        return runIngest(sub, flags)
      case 'set':
        return runSet(sub, flags)
      case 'ledger':
        return runLedger(sub, flags)
      case 'fetch':
        return runFetch(sub, rest, flags)
      case 'thresholds':
        return runThresholds(sub, flags)
      default:
        throw new Error(`unknown command "${cmd}"`)
    }
  },
}
