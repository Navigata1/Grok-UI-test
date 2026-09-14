/**
 * Commands: publish (pack, check, confirm), test (judge).
 *
 * The publish package (architecture 2.10): `publish pack` assembles what
 * Studio needs into packages/<slug>/publish.json + publish.md from the
 * package and the story; `publish check` ticks the checklist by machine and
 * writes publish-check.json (the workflow's publish gate reads it);
 * `publish confirm` adds the ledger row once a person has clicked publish,
 * which starts the review clock, so it prints its plan and needs --yes; it
 * carries the package's pre-registered hypothesis (levers and predicted CTR
 * multiple, overridable with --levers / --predicted-ctr) onto that row, which
 * is what makes the row a test `booster rules compile` can count.
 * `test judge` reads a Test & Compare panel a person typed and, with
 * --record, stores the experiment and the ledger winner letter.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { judgeTest, renderJudgement, toExperimentDoc, winnerLetter, type TestVariant } from '../../src/experiments.js'
import { addRow } from '../../src/ledger.js'
import { loadProfile } from '../../src/profile.js'
import { assemblePublish, checkPublish, mmss, PUBLISH_RULES, renderPublishCheck, renderPublishMarkdown, type PayoffMoment, type PublishChapter, type PublishPack } from '../../src/publish.js'
import { LedgerRow, type ProfileDoc } from '../../src/schema.js'
import { thresholds } from '../../src/thresholds.js'
import { scoreTitle, titleThumbnailOverlap } from '../../src/titles.js'
import { qaThumbnail } from '../../src/thumbnails.js'
import type { ThumbnailQa, ThumbnailSpec } from '../../src/types.js'
import { bool, getProfile, getStore, list, need, needVideoId, nowFrom, num, out, str, warn, type CommandModule, type Flags } from '../shared.js'

const USAGE_PACK = 'booster publish pack <slug> [--title ..] [--promise ..] [--story packages/<slug>/story.json] [--thumb-a <name> --thumb-b <name>] [--sequel-question ..] [--related <title|url>] [--profile channel.json] [--out packages/<slug>/publish.md] [--root dir]'
const USAGE_CHECK = 'booster publish check <slug> [--thumb-text-a ..] [--thumb-text-b ..] [--thumb-files-ok] [--window-confirmed] [--review-scheduled] [--root dir]'
const USAGE_CONFIRM = 'booster publish confirm <slug> --video-id <id> --at <ISO> [--thumb-a <name> --thumb-b <name>] [--levers "a,b"] [--predicted-ctr 1.3] --yes [--root dir]'
const USAGE_JUDGE = 'booster test judge --slug <slug> --a "<impressions>,<ctr>[,<sharePct>[,<avdSec>]]" --b ".." [--c ".."] --hours <h> [--cold-start] [--min-impressions <n>] [--min-hours <h>] [--drop-pct <n>] [--n 1] [--record]'

/** The fields of packages/<slug>/package.json this module reads (section 2.5); every field optional. */
interface PackageFile {
  title?: string
  chosenTitle?: string
  titles?: Array<{ title: string; score?: number }>
  promise?: string
  thumbnails?: Array<{ name: string; spec?: ThumbnailSpec; qa?: ThumbnailQa }>
  abPick?: { a?: string; b?: string }
  hypothesis?: LedgerRow['hypothesis']
}

/** What `hook score` writes to story.json plus whatever the AI retention map adds to payoffLadder. */
interface StoryFile {
  chapters?: PublishChapter[]
  payoffLadder?: Array<{ atSec?: number; moment?: string; text?: string; line?: string; strength?: number }>
}

function rootFrom(flags: Flags): string {
  return path.resolve(str(flags, 'root') ?? process.cwd())
}

function packageDir(flags: Flags, slug: string): string {
  return path.join(rootFrom(flags), 'packages', slug)
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
}

function writeFile(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}

function readPackage(flags: Flags, slug: string): PackageFile | undefined {
  return readJson<PackageFile>(path.join(packageDir(flags, slug), 'package.json'))
}

function readPack(flags: Flags, slug: string): PublishPack {
  const file = path.join(packageDir(flags, slug), 'publish.json')
  const pack = readJson<PublishPack>(file)
  if (!pack) throw new Error(`${file} does not exist: run booster publish pack ${slug} first`)
  return pack
}

/** `--profile <file>` (the wiring's name) or the shared `--path`; thresholds were applied at startup. */
function profileFrom(flags: Flags): ProfileDoc {
  const explicit = str(flags, 'profile')
  return explicit ? loadProfile(explicit) : getProfile(flags)
}

async function publishPack(slug: string, flags: Flags): Promise<number> {
  const pkg = readPackage(flags, slug)
  const title = str(flags, 'title') ?? pkg?.chosenTitle ?? pkg?.titles?.[0]?.title ?? pkg?.title
  const promise = str(flags, 'promise') ?? pkg?.promise
  if (!title) throw new Error(`no title for "${slug}": pass --title or build the package (packages/${slug}/package.json chosenTitle). Usage: ${USAGE_PACK}`)
  if (!promise) throw new Error(`no promise for "${slug}": pass --promise or build the package (packages/${slug}/package.json promise). Usage: ${USAGE_PACK}`)
  const storyFile = path.resolve(str(flags, 'story') ?? path.join(packageDir(flags, slug), 'story.json'))
  const story = readJson<StoryFile>(storyFile)
  if (!story) warn(`no story at ${storyFile}: chapters and Shorts cuts are empty until booster hook score runs`)
  const chapters: PublishChapter[] = (story?.chapters ?? []).filter((c) => typeof c.atSec === 'number' && typeof c.title === 'string')
  const payoffLadder: PayoffMoment[] = (story?.payoffLadder ?? [])
    .map((m) => ({ atSec: Number(m.atSec), moment: String(m.moment ?? m.text ?? m.line ?? '').trim(), strength: typeof m.strength === 'number' ? m.strength : undefined }))
    .filter((m) => Number.isFinite(m.atSec) && m.moment.length > 0)
  const profile = profileFrom(flags)
  const pack = assemblePublish({
    title,
    promise,
    chapters,
    payoffLadder,
    sequelQuestion: str(flags, 'sequel-question'),
    thumbs: { a: str(flags, 'thumb-a') ?? pkg?.abPick?.a ?? 'A', b: str(flags, 'thumb-b') ?? pkg?.abPick?.b ?? 'B' },
    profile,
    relatedVideo: str(flags, 'related'),
  })
  const kept = new Set(pack.chapters.map((c) => c.atSec))
  const dropped = chapters.filter((c) => !kept.has(Math.max(0, Math.round(c.atSec))))
  if (dropped.length > 0) warn(`${dropped.length} story beat(s) are not chapters: YouTube needs ${PUBLISH_RULES.minChapterGapSec.value} s between marks and a 0:00 open (${dropped.map((c) => `${mmss(c.atSec)} ${c.title}`).join(', ')})`)
  const jsonFile = path.join(packageDir(flags, slug), 'publish.json')
  const mdFile = path.resolve(str(flags, 'out') ?? path.join(packageDir(flags, slug), 'publish.md'))
  writeFile(jsonFile, `${JSON.stringify(pack, null, 2)}\n`)
  const md = renderPublishMarkdown(pack)
  writeFile(mdFile, md)
  out({ slug, ...pack, files: { json: jsonFile, md: mdFile } }, flags, () => `${md}\nWrote ${jsonFile} and ${mdFile}.`)
  return 0
}

/** The QA grade and text of a picked concept from package.json, or `rethink` with a warning when the concept is unknown. */
function conceptGrade(pkg: PackageFile | undefined, name: string, signature: ProfileDoc['signature'], textFlag: string | undefined): { grade: ThumbnailQa['grade']; text: string } {
  const concept = pkg?.thumbnails?.find((t) => t.name.toLowerCase() === name.toLowerCase())
  if (!concept) {
    warn(`thumbnail "${name}" is not in package.json; graded rethink until the package names it`)
    return { grade: 'rethink', text: textFlag ?? '' }
  }
  const spec = concept.spec
  const text = textFlag ?? spec?.text ?? ''
  if (concept.qa && textFlag === undefined) return { grade: concept.qa.grade, text }
  if (!spec) {
    warn(`thumbnail "${name}" has no spec or qa in package.json; graded rethink`)
    return { grade: 'rethink', text }
  }
  return { grade: qaThumbnail({ ...spec, text }, signature).grade, text }
}

async function publishCheck(slug: string, flags: Flags): Promise<number> {
  const pack = readPack(flags, slug)
  const pkg = readPackage(flags, slug)
  const profile = getProfile(flags)
  const a = conceptGrade(pkg, pack.thumbs.a, profile.signature, str(flags, 'thumb-text-a'))
  const b = conceptGrade(pkg, pack.thumbs.b, profile.signature, str(flags, 'thumb-text-b'))
  const overlapOk = [a.text, b.text].every((t) => titleThumbnailOverlap(pack.title, t) < thresholds.titleThumbOverlapMax.value)
  const check = checkPublish(pack, {
    titleScore: scoreTitle(pack.title).score,
    thumbGrades: [a.grade, b.grade],
    overlapOk,
    thumbFilesOk: bool(flags, 'thumb-files-ok') ? true : undefined,
    publishWindowConfirmed: bool(flags, 'window-confirmed') ? true : undefined,
    reviewScheduled: bool(flags, 'review-scheduled'),
  })
  const file = path.join(packageDir(flags, slug), 'publish-check.json')
  writeFile(file, `${JSON.stringify(check, null, 2)}\n`)
  out({ slug, ...check, thumbs: { a: { name: pack.thumbs.a, ...a }, b: { name: pack.thumbs.b, ...b } }, file }, flags, () => `${renderPublishCheck(check)}\nWrote ${file}`)
  return check.pass ? 0 : 1
}

/**
 * The hypothesis this row pre-registers: `--levers` and `--predicted-ctr` over
 * what the package recorded, stamped with the publish time (the Desk's publish
 * panel registers the same three fields). `booster rules compile` counts only
 * rows that carry levers, so a row confirmed without them never becomes a test.
 *
 * A hypothesis already on the row is returned untouched and the flags are
 * refused: a lever named once the numbers are in is hindsight, not a test, and
 * the learning it belongs to is the 7-day `--lever` sentence instead.
 */
function hypothesisFor(slug: string, pkg: PackageFile | undefined, flags: Flags, existing: LedgerRow | undefined, publishedAt: string): LedgerRow['hypothesis'] {
  const levers = list(flags, 'levers')
  const predicted = num(flags, 'predicted-ctr')
  if (predicted === undefined && str(flags, 'predicted-ctr') !== undefined) throw new Error(`--predicted-ctr must be a number, got "${str(flags, 'predicted-ctr')}". Usage: ${USAGE_CONFIRM}`)
  if (existing?.hypothesis && existing.hypothesis.levers.length > 0) {
    const registered = existing.hypothesis
    if (levers || predicted !== undefined) {
      throw new Error(`"${slug}" pre-registered its hypothesis at ${registered.registeredAt ?? existing.publishedAt} (levers ${registered.levers.join(', ')}, predicted CTR multiple ${registered.predictedCtrMultiple}) and it is not rewritable: a lever chosen after the numbers are in is hindsight, not a test. Write what you learned with booster set ${slug} --bucket 168 --lever "..".`)
    }
    return registered
  }
  const fromPackage = pkg?.hypothesis
  if (!levers && predicted === undefined && !fromPackage) return undefined
  return {
    levers: levers ?? fromPackage?.levers ?? [],
    angle: fromPackage?.angle,
    predictedCtrMultiple: predicted ?? fromPackage?.predictedCtrMultiple ?? 1,
    registeredAt: publishedAt,
  }
}

function describeHypothesis(h: NonNullable<LedgerRow['hypothesis']>): string {
  return `levers ${h.levers.join(', ') || '(none)'}${h.angle ? `, angle ${h.angle}` : ''}, predicted CTR multiple ${h.predictedCtrMultiple}`
}

async function publishConfirm(slug: string, flags: Flags): Promise<number> {
  const videoId = needVideoId(flags, USAGE_CONFIRM)
  const at = need(flags, 'at', USAGE_CONFIRM)
  const published = new Date(at)
  if (Number.isNaN(published.getTime())) throw new Error(`--at must be an ISO date, got "${at}"`)
  const pack = readPack(flags, slug)
  const pkg = readPackage(flags, slug)
  const thumbA = str(flags, 'thumb-a') ?? pack.thumbs.a
  const thumbB = str(flags, 'thumb-b') ?? pack.thumbs.b
  const now = nowFrom(flags)
  const store = getStore(flags)
  const existing = store.get('ledger', slug)
  const hypothesis = hypothesisFor(slug, pkg, flags, existing, published.toISOString())
  if (!hypothesis || hypothesis.levers.length === 0) warn(`no lever pre-registered for "${slug}": booster rules compile counts only rows that carry one, so this video teaches the channel nothing. Pass --levers "a,b", or build the package with booster package build.`)
  const plan = { action: 'confirm', slug, title: pack.title, videoId, publishedAt: published.toISOString(), thumbA, thumbB, hypothesis, existingRow: existing !== undefined, applied: false, needs: '--yes' }
  if (!bool(flags, 'yes')) {
    out(plan, flags, () => [
      `About to add the ledger row for "${slug}" (human-only gate 4: this starts the review clock at 24/48/168/672 h):`,
      `  title:     ${pack.title}`,
      `  video id:  ${videoId}`,
      `  published: ${published.toISOString()}`,
      `  A / B:     ${thumbA} / ${thumbB}`,
      ...(hypothesis ? [`  hypothesis: ${describeHypothesis(hypothesis)}`] : []),
      ...(existing ? [`  (updates the existing row published ${existing.publishedAt})`] : []),
      '',
      'Nothing written. A person who clicked publish re-runs with --yes.',
    ].join('\n'))
    throw new Error(`nothing written. A person re-runs with --yes to confirm the publish of "${slug}".`)
  }
  const row = addRow(store, { slug, title: pack.title, publishedAt: published.toISOString(), videoId, thumbA, thumbB, hypothesis, now })
  out({ ...plan, applied: true, row }, flags, () => [
    `Recorded: ${slug} published ${row.publishedAt} as ${videoId}, A/B ${thumbA}/${thumbB}.`,
    ...(row.hypothesis ? [`Hypothesis pre-registered: ${describeHypothesis(row.hypothesis)}.`] : []),
    'The review clock is running: booster review due lists the 24/48/168/672-hour reads.',
  ].join('\n'))
  return 0
}

/** `--a "12000,4.5[,52[,210]]"` -> { name: 'A', impressions, ctr, watchTimeSharePct?, avdSec? }. */
function parseVariant(name: 'A' | 'B' | 'C', raw: string): TestVariant {
  const parts = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map(Number)
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) throw new Error(`--${name.toLowerCase()} must be "<impressions>,<ctr>[,<sharePct>[,<avdSec>]]", got "${raw}". Usage: ${USAGE_JUDGE}`)
  const [impressions, ctr, share, avd] = parts
  return { name, impressions, ctr, watchTimeSharePct: share, avdSec: avd }
}

async function testJudge(flags: Flags): Promise<number> {
  const slug = need(flags, 'slug', USAGE_JUDGE)
  const variants: TestVariant[] = [parseVariant('A', need(flags, 'a', USAGE_JUDGE)), parseVariant('B', need(flags, 'b', USAGE_JUDGE))]
  const c = str(flags, 'c')
  if (c) variants.push(parseVariant('C', c))
  const hours = num(flags, 'hours')
  if (hours === undefined) throw new Error(`--hours is required (hours the test has been running). Usage: ${USAGE_JUDGE}`)
  const profile = getProfile(flags)
  const coldStart = bool(flags, 'cold-start') || profile.baselines?.tier === 'prior'
  const judgement = judgeTest(variants, {
    hoursRunning: hours,
    coldStart,
    minImpressions: num(flags, 'min-impressions'),
    minHours: num(flags, 'min-hours'),
    overPromiseDropPct: num(flags, 'drop-pct'),
  })
  const record = bool(flags, 'record')
  let recorded: { experimentId: string; ledgerWinner?: 'A' | 'B' | 'none' } | undefined
  if (record) {
    const store = getStore(flags)
    const now = nowFrom(flags)
    const n = num(flags, 'n') ?? 1
    const doc = store.upsert('experiments', toExperimentDoc(slug, n, variants, judgement, now))
    recorded = { experimentId: doc.id }
    const letter = winnerLetter(judgement)
    const row = store.get('ledger', slug)
    if (letter && row) {
      store.upsert('ledger', LedgerRow.parse({ ...row, winner: letter, updatedAt: now.toISOString() }))
      recorded.ledgerWinner = letter
    } else if (letter && !row) {
      warn(`no ledger row for "${slug}"; the winner ${letter} is on the experiment only (booster publish confirm adds the row)`)
    }
  }
  out({ slug, variants, coldStart, ...judgement, recorded }, flags, () => [
    renderJudgement(judgement),
    ...(coldStart ? ['Cold start: no baseline yet, stricter floors apply.'] : []),
    ...(recorded ? [`Recorded experiment ${recorded.experimentId}${recorded.ledgerWinner ? `; ledger winner ${recorded.ledgerWinner}` : ''}.`] : ['Not recorded; add --record to store the experiment (and the ledger winner once conclusive).']),
  ].join('\n'))
  return 0
}

export const publishModule: CommandModule = {
  verbs: ['publish', 'test'],
  help: [
    'publish pack <slug> [--title ..] [--promise ..] [--story file] [--thumb-a ..] [--thumb-b ..] [--sequel-question ..] [--related ..] [--out ..] [--root dir]   description, chapters, pinned comment, Shorts, A/B; writes publish.json + publish.md',
    'publish check <slug> [--thumb-text-a ..] [--thumb-text-b ..] [--thumb-files-ok] [--window-confirmed] [--review-scheduled] [--root dir]   the publish checklist by machine; writes publish-check.json',
    'publish confirm <slug> --video-id <id> --at <ISO> [--thumb-a ..] [--thumb-b ..] [--levers "a,b"] [--predicted-ctr 1.3] --yes   adds the ledger row with its pre-registered hypothesis after a person clicks publish (human-only gate 4)',
    'test judge --slug <slug> --a "impr,ctr[,share[,avd]]" --b ".." [--c ".."] --hours <h> [--cold-start] [--min-impressions ..] [--min-hours ..] [--drop-pct ..] [--n 1] [--record]   judge a Test & Compare read',
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'test') {
      if (sub === 'judge') return testJudge(flags)
      throw new Error(`usage: ${USAGE_JUDGE}`)
    }
    const slug = rest[0]
    if (sub === 'pack') {
      if (!slug) throw new Error(`usage: ${USAGE_PACK}`)
      return publishPack(slug, flags)
    }
    if (sub === 'check') {
      if (!slug) throw new Error(`usage: ${USAGE_CHECK}`)
      return publishCheck(slug, flags)
    }
    if (sub === 'confirm') {
      if (!slug) throw new Error(`usage: ${USAGE_CONFIRM}`)
      return publishConfirm(slug, flags)
    }
    throw new Error(`usage: ${USAGE_PACK}\n       ${USAGE_CHECK}\n       ${USAGE_CONFIRM}`)
  },
}
