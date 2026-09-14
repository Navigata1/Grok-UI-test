/**
 * Commands: direction, plan shots.
 *
 * `direction` is the channel's positioning page (architecture 2.8): the
 * formats the ledger's own winners and the saved audit scan have proven,
 * each series with its returning-viewer trend, the never-again list from
 * the bottom quartile, and three bets. `plan shots <slug>` turns the
 * package and the story spine into the shoot's shot list at
 * packages/<slug>/shots.md, which is what the workflow's Plan stage runs.
 * `direction` only reads; `plan shots` writes one file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildDirection, renderDirectionMarkdown, renderShotListMarkdown, shotList, type ScanRowLike, type ShotListPackage, type ShotListStory, type ShotListThumbnail } from '../../src/direction.js'
import { readLedger } from '../../src/ledger.js'
import type { OutlierTier } from '../../src/outliers.js'
import { packageDir } from '../../src/runner.js'
import type { WorkflowFormat } from '../../src/types.js'
import { WORKFLOW_FORMATS } from '../../src/workflow.js'
import { getProfile, getStore, out, str, warn, type CommandModule, type Flags } from '../shared.js'

const USAGE_DIRECTION = 'booster direction [--scan last-audit.json] [--data dir] [--path channel.json] [--json]'
const USAGE_SHOTS = `booster plan shots <slug> [--format ${WORKFLOW_FORMATS.join('|')}] [--root dir] [--out packages/<slug>/shots.md] [--json]`

const TIERS: readonly string[] = ['fresh', 'mega', 'outlier', 'normal']

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    throw new Error(`${file} is not valid JSON; expected ${what}`)
  }
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []
}

/** The saved scan (`booster audit <csv> --save`): `{ scannedAt, sinceDays, ranked[] }`; only what the direction needs is kept. */
function scanRows(file: string): ScanRowLike[] {
  const raw = readJson(file, 'a scan written by booster audit <csv> --save')
  if (!isRecord(raw) || !Array.isArray(raw.ranked)) throw new Error(`${file} is not a saved scan: expected { scannedAt, sinceDays, ranked[] } from booster audit <csv> --save`)
  return raw.ranked.filter(isRecord).filter((r) => typeof r.title === 'string').map((r) => ({
    title: r.title as string,
    tier: (typeof r.tier === 'string' && TIERS.includes(r.tier) ? r.tier : 'normal') as OutlierTier,
    formats: strings(r.formats),
    multiplier: typeof r.multiplier === 'number' ? r.multiplier : undefined,
    videoId: typeof r.videoId === 'string' ? r.videoId : undefined,
  }))
}

async function runDirection(flags: Flags): Promise<number> {
  const profile = getProfile(flags)
  const store = getStore(flags)
  const scanArg = str(flags, 'scan')
  let scanFile: string | undefined
  if (scanArg !== undefined) {
    // A bare `--save` writes <store>/last-audit.json for audit and <store>/last-scan.json for
    // outliers, so a bare name means the store copy too. Only the name asked for is ever read:
    // the direction reads the channel's own uploads, and standing a competitor scan in for them
    // would print other people's videos under "proven formats".
    const candidates = [...new Set([path.resolve(scanArg), path.resolve(store.root, scanArg), path.resolve(store.root, path.basename(scanArg))])]
    scanFile = candidates.find((f) => existsSync(f))
    if (!scanFile) throw new Error(`--scan ${scanArg} does not exist (looked at ${candidates.join(', ')}); write one with booster audit <csv> --save. Usage: ${USAGE_DIRECTION}`)
  }
  const ownScan = scanFile ? scanRows(scanFile) : undefined
  const direction = buildDirection({ profile, ledgerRows: readLedger(store), ownScan, ideas: store.read('ideas') })
  out({ scan: scanFile ?? null, ...direction }, flags, () => renderDirectionMarkdown(direction))
  return 0
}

/** One thumbnail as package.json stores it (spec nested) or flat, as older builders wrote it. */
function toShotThumbnail(raw: unknown): ShotListThumbnail | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string') return undefined
  const spec = isRecord(raw.spec) ? raw.spec : raw
  if (typeof spec.focalSubject !== 'string') return undefined
  return {
    name: raw.name,
    focalSubject: spec.focalSubject,
    emotion: typeof spec.emotion === 'string' ? spec.emotion : undefined,
    elements: strings(spec.elements),
    text: typeof spec.text === 'string' ? spec.text : undefined,
    background: typeof spec.background === 'string' ? spec.background : undefined,
    colors: Array.isArray(spec.colors) ? strings(spec.colors) : undefined,
    composition: typeof raw.composition === 'string' ? raw.composition : typeof spec.composition === 'string' ? spec.composition : undefined,
  }
}

function toShotPackage(raw: unknown, file: string): ShotListPackage {
  if (!isRecord(raw)) throw new Error(`${file} is not a package (expected an object with promise and thumbnails)`)
  const thumbnails = (Array.isArray(raw.thumbnails) ? raw.thumbnails : []).map(toShotThumbnail).filter((t): t is ShotListThumbnail => t !== undefined)
  const chosenTitle = typeof raw.chosenTitle === 'string' && raw.chosenTitle ? raw.chosenTitle : typeof raw.title === 'string' ? raw.title : undefined
  const promise = typeof raw.promise === 'string' ? raw.promise : chosenTitle ?? ''
  const pick = isRecord(raw.abPick) ? raw.abPick : undefined
  const abPick = pick && typeof pick.a === 'string' && pick.a && typeof pick.b === 'string' && pick.b ? { a: pick.a, b: pick.b } : undefined
  return { chosenTitle, promise, thumbnails, abPick }
}

/** story.json as `booster hook score` writes it: the HookReport plus payoffLadder; anything missing is empty. */
function toShotStory(raw: unknown): ShotListStory {
  const r = isRecord(raw) ? raw : {}
  const payoffLadder = (Array.isArray(r.payoffLadder) ? r.payoffLadder : []).filter(isRecord)
    .filter((p) => typeof p.atSec === 'number' && typeof p.moment === 'string')
    .map((p) => ({ atSec: p.atSec as number, moment: p.moment as string }))
  const rehooks = (Array.isArray(r.rehooks) ? r.rehooks : []).filter(isRecord)
    .filter((h) => typeof h.atSec === 'number' && typeof h.line === 'string')
    .map((h) => ({ atSec: h.atSec as number, line: h.line as string, device: typeof h.device === 'string' ? (h.device as ShotListStory['rehooks'][number]['device']) : undefined }))
  return {
    payoffLadder,
    rehooks,
    thumbnailMomentPosition: typeof r.thumbnailMomentPosition === 'string' ? (r.thumbnailMomentPosition as ShotListStory['thumbnailMomentPosition']) : undefined,
    thumbnailMomentAtSec: typeof r.thumbnailMomentAtSec === 'number' ? r.thumbnailMomentAtSec : undefined,
  }
}

async function runShots(slug: string | undefined, flags: Flags): Promise<number> {
  if (!slug) throw new Error(`usage: ${USAGE_SHOTS}`)
  const root = path.resolve(str(flags, 'root') ?? process.cwd())
  const dir = packageDir(root, slug)
  const pkgFile = path.join(dir, 'package.json')
  const storyFile = path.join(dir, 'story.json')
  if (!existsSync(pkgFile)) throw new Error(`no ${pkgFile}: build the package first (booster package build "<idea>" --promise "..") or pass --root`)
  const pkg = toShotPackage(readJson(pkgFile, 'packages/<slug>/package.json'), pkgFile)
  const hasStory = existsSync(storyFile)
  const story = hasStory ? toShotStory(readJson(storyFile, 'packages/<slug>/story.json')) : { payoffLadder: [], rehooks: [] }
  if (!hasStory) warn(`${storyFile} not found: run booster hook score --script <file> --slug ${slug} first; until then the shot list has no payoff or rehook shots`)
  const formatFlag = str(flags, 'format') ?? getStore(flags).get('workflows', slug)?.format
  if (formatFlag !== undefined && !(WORKFLOW_FORMATS as readonly string[]).includes(formatFlag)) throw new Error(`--format must be one of ${WORKFLOW_FORMATS.join(', ')}, got "${formatFlag}"`)
  const list = shotList({ pkg, story, format: formatFlag as WorkflowFormat | undefined })
  const md = renderShotListMarkdown(list)
  const outFile = path.resolve(str(flags, 'out') ?? path.join(dir, 'shots.md'))
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, md.endsWith('\n') ? md : `${md}\n`)
  out({ slug, out: outFile, story: hasStory, format: formatFlag ?? null, ...list }, flags, () => `${md.trimEnd()}\n\nWrote ${outFile} (${list.setups.length} setups, ${list.setups.reduce((n, s) => n + s.shots.length, 0)} shots).`)
  return 0
}

export const directionModule: CommandModule = {
  verbs: ['direction', 'plan'],
  help: [
    'direction [--scan last-audit.json]                                 positioning, proven formats, series trends, never-again, three bets (the scan is your own uploads: booster audit <csv> --save)',
    `plan shots <slug> [--format ..] [--root dir] [--out ..]               the shoot's shot list from package.json + story.json; writes packages/<slug>/shots.md`,
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'direction') {
      if (sub !== undefined) throw new Error(`usage: ${USAGE_DIRECTION}`)
      return runDirection(flags)
    }
    if (sub === 'shots') return runShots(rest[0], flags)
    throw new Error(`usage: ${USAGE_SHOTS}`)
  },
}
