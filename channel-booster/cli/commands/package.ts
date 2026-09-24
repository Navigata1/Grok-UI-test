/**
 * Commands: titles, thumbnail, package, signature, hook, promise.
 *
 * The thumbnail factory floor (architecture 2.7): QA against the channel
 * signature, the proof sheet, image prompts, delivered-file checks, and the
 * signature registry. The story stage (2.6): the hook score written to
 * packages/<slug>/story.json and the promise drift check.
 *
 * Slug commands read packages/<slug>/package.json as the package builder
 * writes it ({ chosenTitle, promise, titles, thumbnails: [{ name, angle, spec, qa }], abPick }).
 * When that file is absent they fall back to buildThumbnailBrief concepts from
 * --idea/--title so the floor works before a package exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { canTransition, ideaId } from '../../src/bank.js'
import { cliName } from '../../src/build-info.js'
import { shellQuote } from '../../src/shell.js'
import { scoreHook, renderHookReport } from '../../src/hook.js'
import { buildPackage, writePackage, type GenerateHooks } from '../../src/package.js'
import { checkThumbnailFile } from '../../src/imagemeta.js'
import { loadProfile, saveProfile } from '../../src/profile.js'
import { checkPromise, type PromiseSurfaces } from '../../src/promise.js'
import { renderProofSheet, type ProofSheetConcept } from '../../src/proofsheet.js'
import { Signature, type ProfileDoc } from '../../src/schema.js'
import { describeSignature } from '../../src/signature.js'
import { scoreTitle, titleShapes, titleThumbnailOverlap } from '../../src/titles.js'
import { buildThumbnailBrief, qaThumbnail, renderImagePrompts } from '../../src/thumbnails.js'
import type { ThumbnailQa, ThumbnailSpec } from '../../src/types.js'
import { slugify as packageSlug } from '../../src/workflow.js'
import { activeWorkspace, bool, getProfile, getStore, list, need, nowFrom, num, out, packagesRoot, profilePath, str, warn, type CommandModule, type Flags } from '../shared.js'

const USAGE_PROOF = `${cliName()} thumbnail proof <slug> [--out packages/<slug>/proof-sheet.html] [--competitors "a|b|c"] [--images dir] [--root dir]`
const USAGE_RENDER = `${cliName()} thumbnail render <slug> [--out packages/<slug>/image-prompts.md] [--all] [--root dir]`
const USAGE_CHECK = `${cliName()} thumbnail check <file.png|file.jpg>`
const USAGE_SIG_SET = `${cliName()} signature set --colors "yellow,black" [--face always|never|either] [--max-words 3] [--framing ".."] [--typeface ".."] [--notes ".."]`
const USAGE_HOOK = `${cliName()} hook score --script <file> --slug <slug> [--title ".."] [--promise ".."] [--thumbnail-moment ".."] [--payoffs <retention-map.json>] [--wpm 150] [--root dir]`
const USAGE_PROMISE = `${cliName()} promise check --promise ".." [--title ".."] [--script <file>] [--description <file>|".."] [--thumb-text ".."]`
const USAGE_BUILD = `${cliName()} package build "<idea>"|<idea:id>|<slug> --promise ".." [--title ".." [--lever ".."]] [--subject ..] [--stake ..] [--result ..] [--number ..] [--audience ..] [--predicted-ctr 1.3] [--rounds 3] [--offline] [--no-signature] [--root dir] [--out dir]`
const USAGE_TITLES = `${cliName()} titles "<topic>" [--number ..] [--subject ..] [--audience ..]`

/** One thumbnail concept as packages/<slug>/package.json stores it (section 2.5). */
interface PackagedConcept {
  name: string
  angle?: string
  spec: ThumbnailSpec
  qa: ThumbnailQa
}

/** The fields of packages/<slug>/package.json this module reads. Every field is optional: the file may predate a builder. */
interface PackageFile {
  idea?: string
  title?: string
  chosenTitle?: string
  /** 'person' when a person wrote chosenTitle (package build --title); a rebuild keeps only that one. */
  titleSource?: string
  ownTitles?: string[]
  titles?: Array<{ title: string; score?: number; lever?: string }>
  promise?: string
  thumbnails?: Array<Partial<PackagedConcept> & { name: string }>
  abPick?: { a?: string; b?: string }
}

function packageDir(flags: Flags, slug: string): string {
  return path.join(packagesRoot(flags), 'packages', slug)
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
}

function readPackage(flags: Flags, slug: string): PackageFile | undefined {
  return readJson<PackageFile>(path.join(packageDir(flags, slug), 'package.json'))
}

function writeFile(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}

/** "my-video-slug" -> "My video slug", the working title before a package exists. */
function humanise(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** The package's title; an empty chosenTitle (offline, before a person writes one) counts as none. */
function packageTitle(pkg: PackageFile | undefined): string | undefined {
  return pkg?.chosenTitle || pkg?.titles?.[0]?.title || pkg?.title || undefined
}

/**
 * The slug's concepts: package.json thumbnails (QA'd by the package builder;
 * a stored spec without a qa is scored here) or, without a package, the five
 * brief concepts from --idea/--title, each scored against the signature.
 */
function slugConcepts(flags: Flags, slug: string, profile: ProfileDoc): { concepts: PackagedConcept[]; title: string; source: 'package' | 'brief' } {
  const pkg = readPackage(flags, slug)
  const signature = bool(flags, 'no-signature') ? undefined : profile.signature
  const title = str(flags, 'title') ?? packageTitle(pkg) ?? humanise(slug)
  if (pkg?.thumbnails && pkg.thumbnails.length > 0) {
    const concepts = pkg.thumbnails.map((t) => {
      const spec: ThumbnailSpec = t.spec ?? { focalSubject: '', elements: [] }
      return { name: t.name, angle: t.angle, spec, qa: t.qa ?? qaThumbnail(spec, signature) }
    })
    return { concepts, title, source: 'package' }
  }
  const idea = str(flags, 'idea') ?? humanise(slug)
  const brief = buildThumbnailBrief(idea, title, { subject: str(flags, 'subject'), stake: str(flags, 'stake'), result: str(flags, 'result') })
  const concepts = brief.concepts.map((c) => {
    const spec: ThumbnailSpec = {
      focalSubject: c.focalSubject,
      elements: [c.focalSubject, c.supportingElement, ...(c.text ? [`text "${c.text}"`] : [])],
      text: c.text,
      colors: profile.signature?.colors,
      title,
    }
    return { name: c.name, angle: c.angle, spec, qa: qaThumbnail(spec, signature) }
  })
  return { concepts, title, source: 'brief' }
}

/** The delivered image for a concept: `<dir>/<slugified name>.png|jpg|jpeg`, or thumb-A/thumb-B in the package dir for the picked pair. */
function findImage(dirs: string[], names: string[]): string | undefined {
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of ['png', 'jpg', 'jpeg']) {
        const file = path.join(dir, `${name}.${ext}`)
        if (existsSync(file)) return file
      }
    }
  }
  return undefined
}

function renderQa(qa: ThumbnailQa): string {
  return [`Thumbnail QA · ${qa.score}/100 · ${qa.grade.toUpperCase()}`, ...qa.passes.map((p) => `  ✓ ${p}`), ...qa.failures.map((f) => `  ✕ ${f}`), ...(qa.fixes.length ? ['', 'Fixes:', ...qa.fixes.map((f) => `  - ${f}`)] : [])].join('\n')
}

async function thumbnailProof(slug: string, flags: Flags): Promise<number> {
  const profile = getProfile(flags)
  const { concepts, title, source } = slugConcepts(flags, slug, profile)
  const pkg = readPackage(flags, slug)
  const dir = packageDir(flags, slug)
  const outFile = path.resolve(str(flags, 'out') ?? path.join(dir, 'proof-sheet.html'))
  const competitors = str(flags, 'competitors')?.split('|').map((s) => s.trim()).filter(Boolean) ?? profile.competitors.slice(0, 3)
  const imagesDir = str(flags, 'images')
  const searchDirs = [imagesDir ? path.resolve(imagesDir) : undefined, dir].filter((d): d is string => d !== undefined)
  const pick = { a: pkg?.abPick?.a, b: pkg?.abPick?.b }
  const images: Array<{ concept: string; file: string; pass: boolean; issues: string[] }> = []
  const sheetConcepts: ProofSheetConcept[] = concepts.map((c) => {
    const names = [slugify(c.name)]
    if (pick.a && pick.a === c.name) names.push('thumb-A')
    if (pick.b && pick.b === c.name) names.push('thumb-B')
    const file = findImage(searchDirs, names)
    let imageDataUri: string | undefined
    if (file) {
      const buf = readFileSync(file)
      const check = checkThumbnailFile(buf)
      images.push({ concept: c.name, file, pass: check.pass, issues: check.issues })
      const ext = path.extname(file).toLowerCase()
      imageDataUri = `data:image/${ext === '.png' ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`
    }
    return { name: c.name, text: c.spec.text, focalSubject: c.spec.focalSubject, colors: c.spec.colors, imageDataUri }
  })
  const failed = images.filter((i) => !i.pass)
  for (const f of failed) warn(`${f.file}: ${f.issues.join('; ')}`)
  if (failed.length > 0 && !bool(flags, 'force')) {
    throw new Error(`${failed.length} delivered file(s) failed the thumbnail check (1280x720, 16:9, under 2 MB); nothing written. Fix the exports or pass --force to proof them anyway.`)
  }
  const notShip = concepts.filter((c) => [pick.a, pick.b].includes(c.name) && c.qa.grade !== 'ship')
  for (const c of notShip) warn(`${c.name} (picked for the test) grades ${c.qa.grade}, not ship`)
  const html = renderProofSheet({ title, concepts: sheetConcepts, competitors })
  writeFile(outFile, html)
  const value = { slug, out: outFile, title, source, concepts: concepts.map((c) => ({ name: c.name, grade: c.qa.grade, score: c.qa.score })), competitors, images }
  out(value, flags, () => [
    `Proof sheet · ${title}`,
    `${concepts.length} concept(s) from the ${source === 'package' ? 'package' : 'brief (no packages/' + slug + '/package.json yet)'}: ${concepts.map((c) => `${c.name} ${c.qa.grade}`).join(', ')}`,
    `Competitors: ${competitors.length ? competitors.join(' | ') : '(none; set competitors in channel.json or pass --competitors)'}`,
    ...(images.length ? [`Images inlined: ${images.map((i) => `${i.concept} <- ${path.basename(i.file)}${i.pass ? '' : ' (FAILED check)'}`).join(', ')}`] : ['Images: none delivered; placeholders drawn (pass --images <dir> with <concept-slug>.png files)']),
    `Wrote ${outFile}; open it in a browser.`,
  ].join('\n'))
  return 0
}

async function thumbnailRender(slug: string, flags: Flags): Promise<number> {
  const profile = getProfile(flags)
  const { concepts, source } = slugConcepts(flags, slug, profile)
  const all = bool(flags, 'all')
  const chosen = all ? concepts : concepts.filter((c) => c.qa.grade === 'ship')
  if (chosen.length === 0) throw new Error(`no concept of "${slug}" grades ship (${concepts.map((c) => `${c.name} ${c.qa.grade}`).join(', ')}); fix them or pass --all`)
  const prompts = renderImagePrompts(chosen.map((c) => ({ name: c.name, ...c.spec })), profile.signature)
  const outFile = path.resolve(str(flags, 'out') ?? path.join(packageDir(flags, slug), 'image-prompts.md'))
  const md = [`# Image prompts · ${slug}`, '', ...chosen.flatMap((c, i) => [`## ${c.name}`, '', prompts[i], ''])].join('\n')
  writeFile(outFile, md)
  out({ slug, out: outFile, source, all, prompts }, flags, () => `${md}\nWrote ${outFile} (${chosen.length} prompt(s)${all ? '' : ', grade ship only; --all for every concept'}).`)
  return 0
}

/** "m:ss", "h:mm:ss", "90s" or "90" -> seconds; undefined when unparseable. */
function parseAt(at: unknown): number | undefined {
  if (typeof at === 'number') return Number.isFinite(at) ? at : undefined
  if (typeof at !== 'string') return undefined
  const m = /^\s*(?:(\d+):)?(\d+):(\d{1,2})\s*$|^\s*(\d+(?:\.\d+)?)\s*s?\s*$/.exec(at)
  if (!m) return undefined
  if (m[4] !== undefined) return Number(m[4])
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])
}

/** The payoff ladder from `booster ai retention-map --out <file>` (payoff_ladder[].at as m:ss) or an already converted {atSec, moment}[] list. */
function readPayoffs(file: string): Array<{ atSec: number; moment: string }> {
  const raw = readJson<{ payoff_ladder?: unknown[]; payoffLadder?: unknown[] }>(file)
  const list = Array.isArray(raw?.payoff_ladder) ? raw.payoff_ladder : Array.isArray(raw?.payoffLadder) ? raw.payoffLadder : undefined
  if (!list) throw new Error(`${file} has no payoff_ladder: pass the file written by booster ai retention-map --out <file>, or a {"payoffLadder": [{"atSec": 45, "moment": ".."}]} list`)
  const ladder = list.flatMap((p) => {
    if (typeof p !== 'object' || p === null) return []
    const r = p as Record<string, unknown>
    const atSec = parseAt(r.atSec ?? r.at)
    return atSec !== undefined && typeof r.moment === 'string' && r.moment.trim() ? [{ atSec, moment: r.moment.trim() }] : []
  })
  if (ladder.length === 0) throw new Error(`${file}: no payoff moment with a parseable "at" (m:ss) and a moment`)
  return ladder.sort((a, b) => a.atSec - b.atSec)
}

async function hookScore(flags: Flags): Promise<number> {
  const scriptFile = need(flags, 'script', USAGE_HOOK)
  const slug = need(flags, 'slug', USAGE_HOOK)
  if (!existsSync(scriptFile)) throw new Error(`script ${scriptFile} does not exist`)
  const script = readFileSync(scriptFile, 'utf8')
  const pkg = readPackage(flags, slug)
  const title = str(flags, 'title') ?? packageTitle(pkg) ?? ''
  const promise = str(flags, 'promise') ?? pkg?.promise ?? ''
  if (!title && !promise) throw new Error(`no title or promise for "${slug}": pass --title/--promise or build the package first (packages/${slug}/package.json)`)
  let thumbnailMoment = str(flags, 'thumbnail-moment')
  if (!thumbnailMoment && pkg?.thumbnails && pkg.abPick?.a) {
    const a = pkg.thumbnails.find((t) => t.name === pkg.abPick?.a)
    thumbnailMoment = a?.spec?.focalSubject || a?.spec?.text || undefined
  }
  const report = scoreHook(script, { title, promise, thumbnailMoment, wpm: num(flags, 'wpm'), now: nowFrom(flags) })
  const storyFile = path.join(packageDir(flags, slug), 'story.json')
  const explicitPayoffs = str(flags, 'payoffs')
  if (explicitPayoffs !== undefined && !existsSync(explicitPayoffs)) throw new Error(`--payoffs ${explicitPayoffs} does not exist. Usage: ${USAGE_HOOK}`)
  // Without --payoffs, the conventional packages/<slug>/payoffs.json is picked up, so the ladder
  // can be written by hand and the shoot-plan gate is reachable with no API key.
  const conventionalPayoffs = path.join(packageDir(flags, slug), 'payoffs.json')
  const payoffsFile = explicitPayoffs ?? (existsSync(conventionalPayoffs) ? conventionalPayoffs : undefined)
  const previous = readJson<{ payoffLadder?: unknown[] }>(storyFile)
  const payoffLadder = payoffsFile ? readPayoffs(payoffsFile) : Array.isArray(previous?.payoffLadder) ? previous.payoffLadder : []
  const story = { slug, ...report, payoffLadder }
  writeFile(storyFile, `${JSON.stringify(story, null, 2)}\n`)
  if (payoffLadder.length === 0) warn(`story.json has no payoff ladder, so the shoot plan has no payoff shots and its gate stays closed. Write ${conventionalPayoffs} as {"payoffLadder": [{"atSec": 45, "moment": ".."}]}, or run booster ai retention-map --script ${scriptFile} --out ${conventionalPayoffs}, then run this command again.`)
  const gate = report.pass && report.promiseInFirst25Words
  out(story, flags, () => [renderHookReport(report), `Wrote ${storyFile}`, gate ? 'Story gate: PASS' : `Story gate: FAIL (${!report.pass ? `hook score ${report.hookScore} under ${report.gateScore}` : 'promise not in the first 25 words'})`].join('\n'))
  return gate ? 0 : 1
}

/** `--description <file>|"text"`: a readable path is read, anything else is the text. */
function fileOrText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length < 1024 && !/[\r\n]/.test(value) && existsSync(value)) return readFileSync(value, 'utf8')
  return value
}

async function promiseCheck(flags: Flags): Promise<number> {
  const promise = need(flags, 'promise', USAGE_PROMISE)
  const scriptFile = str(flags, 'script')
  if (scriptFile && !existsSync(scriptFile)) throw new Error(`script ${scriptFile} does not exist`)
  const surfaces: PromiseSurfaces = {}
  const title = str(flags, 'title')
  if (title !== undefined) surfaces.title = title
  if (scriptFile) surfaces.scriptHead = readFileSync(scriptFile, 'utf8')
  const description = fileOrText(str(flags, 'description'))
  if (description !== undefined) surfaces.descriptionLine1 = description
  const thumbText = str(flags, 'thumb-text')
  if (thumbText !== undefined) surfaces.thumbnailText = thumbText
  if (Object.keys(surfaces).length === 0) throw new Error(`nothing to check: pass at least one surface. Usage: ${USAGE_PROMISE}`)
  const report = checkPromise(promise, surfaces)
  out(report, flags, () => [
    ...report.checked.map((s) => {
      const c = report.surfaces[s]!
      return `${s}: ${c.pass ? 'pass' : 'DRIFT'} (${Math.round(c.overlap * 100)}%) ${c.reason}`
    }),
    report.pass
      ? `Promise: PASS on all ${report.checked.length} surface(s) checked`
      : `Promise: DRIFT on ${report.drift.length} of ${report.checked.length} surface(s) checked`,
    `Thresholds: ${report.thresholdsUsed.join('; ')}`,
  ].join('\n'))
  return report.pass ? 0 : 1
}

/**
 * What an earlier build left in `dir`/package.json that a rebuild must keep:
 * the idea and promise (so `package build <slug>` works for any built
 * package), the title a person wrote with the lever they named for it, and
 * their own-title lines. A model's chosen title is never carried: every model
 * run chooses again.
 */
function storedPackage(dir: string): { idea?: string; promise?: string; personTitle?: string; personLever?: string; ownTitles?: string[] } | undefined {
  const file = path.join(dir, 'package.json')
  let pkg: PackageFile | undefined
  try {
    pkg = readJson<PackageFile>(file)
  } catch {
    warn(`${file} is not valid JSON: nothing from it is reused (no stored title, idea or promise); it is rewritten below.`)
    return undefined
  }
  if (!pkg) return undefined
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  const personTitle = pkg.titleSource === 'person' ? text(pkg.chosenTitle)?.trim() : undefined
  // The person's title is titles[0] and carries the lever they named with --lever, if any.
  const first = Array.isArray(pkg.titles) ? pkg.titles[0] : undefined
  return {
    idea: text(pkg.idea),
    promise: text(pkg.promise),
    personTitle,
    personLever: personTitle !== undefined && text(first?.title)?.trim() === personTitle ? text(first?.lever)?.trim() : undefined,
    ownTitles: Array.isArray(pkg.ownTitles) && pkg.ownTitles.every((t) => typeof t === 'string') ? pkg.ownTitles : undefined,
  }
}

/**
 * The command that rebuilds this package with a title, repeating the options
 * this run was given so the concepts come out the same. The places it read
 * and wrote are repeated as absolute paths: the workspace when --workspace or
 * BOOSTER_HOME named it, --out and --root, and the store and profile (--data
 * or BOOSTER_DATA, --path or BOOSTER_PROFILE, which `workflow run` sets for
 * its stages). The runner appends --root to every stage and runs it from that
 * root, while a person's `npm run booster` starts at the repository root in a
 * shell that has none of these variables, so a relative path or a missing
 * --root would write the title into another packages/ folder than the one the
 * stage gate reads. The CLI is named the way this build is typed (cliName()),
 * and every value is quoted for a POSIX shell (shellQuote()).
 */
function rebuildCommand(slug: string, flags: Flags): string {
  const repeat = ['subject', 'stake', 'result', 'number', 'audience', 'predicted-ctr', 'rounds']
    .flatMap((k) => (str(flags, k) !== undefined ? [`--${k} ${shellQuote(str(flags, k)!)}`] : []))
  // A workspace found at or above the working directory is found again from there; one named by flag or variable is repeated.
  const ws = activeWorkspace(flags)
  const workspace = ws && ws.source !== 'discovered' ? [`--workspace ${shellQuote(ws.root)}`] : []
  const places: Array<[flag: string, env?: string]> = [['out'], ['root'], ['data', 'BOOSTER_DATA'], ['path', 'BOOSTER_PROFILE']]
  const dirs = places.flatMap(([k, env]) => {
    const v = str(flags, k) ?? (env ? process.env[env] : undefined)
    return v ? [`--${k} ${shellQuote(path.resolve(v))}`] : []
  })
  const switches = ['offline', 'no-signature'].filter((k) => bool(flags, k)).map((k) => `--${k}`)
  return [`${cliName()} package build`, slug, '--title "<your title>"', ...repeat, ...workspace, ...dirs, ...switches].join(' ')
}

/**
 * Build the package (architecture 2.5): titles, concepts, QA, the A/B pair,
 * the designer brief, the gate report and the pre-registered hypothesis (the
 * chosen title's lever, both A/B angles, and --predicted-ctr), written to
 * packages/<slug>/package.json and package.md. `booster publish confirm`
 * carries that hypothesis onto the ledger row, which is what makes the row a
 * test `booster rules compile` can count. Offline (no ANTHROPIC_API_KEY, or --offline)
 * the concepts come from the deterministic brief and run once, and the title
 * comes only from a person: --title, or the person's title an earlier build
 * stored (so the workflow's packaging stage, `package build <slug>`, keeps it).
 * Without one the title gate fails and says how to write it (human gate 2);
 * no formula fill is ever chosen. With the model the gate fixes go back to it
 * for up to --rounds rounds, and a person's title still wins. A bank idea
 * (idea:<id>, or its text) supplies the idea and its promise and moves to
 * packaging when it is green; a workflow slug or an already built package's
 * slug supplies them too. Exit 1 when the gates fail: the sheet is still
 * written, and the workflow runner reads gateReport.pass from it.
 */
async function packageBuild(raw: string | undefined, flags: Flags): Promise<number> {
  if (!raw) throw new Error(`usage: ${USAGE_BUILD}`)
  if (flags.title === true) throw new Error(`--title needs the title text: --title "<your title>". Usage: ${USAGE_BUILD}`)
  if (flags.lever === true) throw new Error(`--lever needs the lever your title pulls: --lever "<lever>". Usage: ${USAGE_BUILD}`)
  const store = getStore(flags)
  const packagesDir = path.resolve(str(flags, 'out') ?? path.join(packagesRoot(flags), 'packages'))
  let doc = store.get('ideas', raw.startsWith('idea:') ? raw : ideaId(raw))
  if (raw.startsWith('idea:') && !doc) throw new Error(`no idea "${raw}" in the bank (booster bank list shows ids)`)
  // The workflow runner passes the package slug: resolve it through the status document's idea text.
  const wf = !doc && !raw.startsWith('idea:') ? store.get('workflows', raw) : undefined
  if (wf) doc = store.get('ideas', ideaId(wf.idea))
  const reads = new Map<string, ReturnType<typeof storedPackage>>()
  const storedAt = (slug: string): ReturnType<typeof storedPackage> => {
    if (!reads.has(slug)) reads.set(slug, storedPackage(path.join(packagesDir, slug)))
    return reads.get(slug)
  }
  // A slug with a built package and no bank row or workflow: the stored idea, so the rebuild the title gate asks for works.
  const bySlug = !doc && !wf && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) ? storedAt(raw) : undefined
  const idea = doc?.idea ?? wf?.idea ?? bySlug?.idea ?? raw
  const stored = bySlug ?? storedAt(packageSlug(idea))
  // A slug resolved through the status document takes that document's promise: it is what
  // `booster workflow --promise` wrote, and that already defaults to the banked idea's.
  const promise = str(flags, 'promise') ?? (wf ? wf.promise ?? doc?.promise : doc?.promise) ?? stored?.promise
  if (!promise) throw new Error(`--promise is required: one sentence the video keeps${doc ? ` (bank ideas carry it: ${cliName()} bank add "<idea>" --promise "..")` : wf ? ` (the workflow carries it: ${cliName()} workflow "<idea>" --promise "..")` : ''}. Usage: ${USAGE_BUILD}`)
  const profile = getProfile(flags)
  const signature = bool(flags, 'no-signature') ? undefined : profile.signature
  const offline = bool(flags, 'offline') || !process.env.ANTHROPIC_API_KEY
  let generate: GenerateHooks | undefined
  if (!offline) {
    const { packageHooks } = await import('../../src/ai/index.js')
    generate = packageHooks(flags, { idea, promise })
  }
  const rounds = num(flags, 'rounds')
  if (rounds === undefined && str(flags, 'rounds') !== undefined) throw new Error(`--rounds must be a number, got "${str(flags, 'rounds')}"`)
  const predictedCtrMultiple = num(flags, 'predicted-ctr')
  if (predictedCtrMultiple === undefined && str(flags, 'predicted-ctr') !== undefined) throw new Error(`--predicted-ctr must be a number, got "${str(flags, 'predicted-ctr')}"`)
  const given = str(flags, 'title')?.trim() || undefined
  const givenLever = str(flags, 'lever')?.trim() || undefined
  // A stored lever belongs to the stored title: a new --title starts without one unless --lever names it.
  const keepsStoredTitle = given === undefined || given === stored?.personTitle
  const built = await buildPackage({
    idea,
    promise,
    subject: str(flags, 'subject'),
    stake: str(flags, 'stake'),
    result: str(flags, 'result'),
    number: str(flags, 'number'),
    audience: str(flags, 'audience'),
    signature,
    generate,
    title: given ?? stored?.personTitle,
    titleLever: givenLever ?? (keepsStoredTitle ? stored?.personLever : undefined),
    ownTitles: stored?.ownTitles,
    rounds,
    predictedCtrMultiple,
    now: nowFrom(flags),
  })
  const dir = path.join(packagesDir, built.slug)
  const { json, md } = writePackage(dir, built)
  let bank: { id: string; status: string; moved: boolean } | undefined
  if (doc) {
    const moved = canTransition(doc.status, 'packaging')
    const updated = store.upsert('ideas', { ...doc, packageId: built.slug, status: moved ? 'packaging' : doc.status, updatedAt: nowFrom(flags).toISOString(), source: 'cli' })
    bank = { id: doc.id, status: updated.status, moved }
    if (!moved && doc.status === 'banked') warn(`idea ${doc.id} is banked, not green: the package is built, but approve the idea before production (booster bank approve ${doc.id} --yes)`)
  }
  const g = built.gateReport
  const rebuild = rebuildCommand(built.slug, flags)
  // stderr, so the workflow runner (which shows a failed stage's stderr) carries the instruction too.
  if (!built.chosenTitle) warn(`No title yet for ${built.slug}: a person writes it, then ${rebuild}`)
  if (givenLever && built.titleSource !== 'person') warn(`--lever "${givenLever}" is not registered: it names the lever of a title you wrote, and this package has none. Pass it with --title.`)
  const personLever = built.titleSource === 'person' ? built.titles[0]?.lever : undefined
  const titleLine = built.chosenTitle
    ? `Title: ${built.chosenTitle} (${built.titleSource === 'person' ? 'yours' : 'model'}, ${built.titles[0]?.score ?? 0}/100)`
    : 'Title: none yet (offline, the builder never picks one; a person writes it)'
  const next = !built.chosenTitle
    ? `Next: write your title from the shapes in ${md}, check it with ${cliName()} titles score "<title>", then ${rebuild}`
    : g.pass
      ? built.titleSource === 'person'
        ? `Next: ${cliName()} hook score --script <file> --slug ${built.slug}. Rebuilds keep your title; --title replaces it.`
        : `Next: write three titles of your own in ${md} and pick the final one (${rebuild} keeps it), then ${cliName()} hook score --script <file> --slug ${built.slug}.`
      : !g.titleGate.pass && built.titleSource === 'person'
        ? `Next: rewrite the title (${cliName()} titles score "<title>" shows why it scores low), then ${rebuild}`
        : 'Fix the failing gates (change the promise or the inputs and rebuild, or re-run with the model on) before the story stage.'
  out({ ...built, json, md, mode: offline ? 'offline' : 'model', bank: bank ?? null }, flags, () => [
    `Package · ${built.slug} · ${g.pass ? 'GATES PASS' : 'GATES FAIL'} (${offline ? 'offline generators, one round' : `model, ${built.rounds} round${built.rounds === 1 ? '' : 's'}`})`,
    titleLine,
    `A/B: ${built.abPick.a || '—'} vs ${built.abPick.b || '—'} · ${built.abPick.reason}`,
    `Hypothesis: levers ${built.hypothesis.levers.join(', ') || '(none)'} · predicted CTR multiple ${built.hypothesis.predictedCtrMultiple}. booster publish confirm registers them on the ledger row.${built.titleSource === 'person' && !personLever ? ' Your title names no lever: rebuild with --lever "<the lever it pulls>" so rules compile counts the title too.' : ''}`,
    gateLine('title', g.titleGate.pass, g.titleGate.reason),
    gateLine('thumbnails', g.thumbGate.pass, g.thumbGate.reason),
    gateLine('overlap', g.overlapGate.pass, g.overlapGate.reason),
    gateLine('promise', g.promiseGate.pass, g.promiseGate.reason),
    ...(bank ? [`Bank: ${bank.id} ${bank.moved ? 'moved to packaging' : `stays ${bank.status}`}, packageId ${built.slug}.`] : []),
    `Wrote ${json} and ${md}.`,
    next,
  ].join('\n'))
  return g.pass ? 0 : 1
}

function gateLine(name: string, pass: boolean, reason: string): string {
  return `  ${pass ? 'PASS' : 'FAIL'} ${name}: ${reason}`
}

async function signatureShow(flags: Flags): Promise<number> {
  const profile = getProfile(flags)
  if (!profile.signature) {
    out({ signature: null }, flags, () => 'no signature in channel.json; run booster signature set --colors "yellow,black"')
    return 1
  }
  out(profile.signature, flags, () => describeSignature(profile.signature!))
  return 0
}

async function signatureSet(flags: Flags): Promise<number> {
  const colors = need(flags, 'colors', USAGE_SIG_SET).split(',').map((s) => s.trim()).filter(Boolean)
  const raw: Record<string, unknown> = { colors }
  const face = str(flags, 'face')
  if (face !== undefined) raw.facePolicy = face
  const maxWords = num(flags, 'max-words')
  if (maxWords !== undefined) raw.maxWords = maxWords
  for (const key of ['framing', 'typeface', 'notes'] as const) {
    const v = str(flags, key)
    if (v !== undefined) raw[key] = v
  }
  const parsed = Signature.safeParse(raw)
  if (!parsed.success) throw new Error(`signature does not match the schema: ${parsed.error.issues.map((x) => `${x.path.join('.') || '(root)'} ${x.message}`).join('; ')}. Usage: ${USAGE_SIG_SET}`)
  const file = profilePath(flags)
  const profile = loadProfile(file)
  const saved = saveProfile({ ...profile, signature: parsed.data }, file, { now: nowFrom(flags) })
  out(saved.signature, flags, () => `${describeSignature(parsed.data)}\nSaved to ${file}.`)
  return 0
}

export const packageModule: CommandModule = {
  verbs: ['titles', 'thumbnail', 'package', 'signature', 'hook', 'promise'],
  help: [
    'titles "<topic>" [--number ..] [--subject ..] [--audience ..]      the title formulas as shapes with a blank (no scores): write your own from them',
    'titles score "<title>"                                             score one title (template fills are held under the gate)',
    'thumbnail brief "<idea>" --title ".." [--subject ..] [--stake ..] [--result ..]',
    'thumbnail qa --subject ".." --elements "a,b,c" [--emotion ..] [--text ..] [--background ..] [--colors "yellow,black"] [--title ..] [--no-signature]',
    'thumbnail proof <slug> [--out ..] [--competitors "a|b|c"] [--images dir] [--root dir]   proof sheet at 120px beside the top three competitors',
    'thumbnail render <slug> [--out ..] [--all] [--root dir]            one image prompt per ship-grade concept',
    'thumbnail check <file>                                             delivered PNG/JPG: 1280x720, 16:9, under 2 MB',
    'signature show                                                     the channel signature from channel.json',
    'signature set --colors "yellow,black" [--face ..] [--max-words ..] [--framing ..] [--typeface ..] [--notes ..]',
    'hook score --script <file> --slug <slug> [--title ..] [--promise ..] [--thumbnail-moment ..] [--payoffs <retention-map.json>] [--wpm 150] [--root dir]   writes packages/<slug>/story.json (payoffLadder from --payoffs); exit 1 when the gate fails',
    'promise check --promise ".." [--title ..] [--script <file>] [--description <file>|".."] [--thumb-text ..]   exit 1 on drift',
    'package build "<idea>"|<idea:id>|<slug> --promise ".." [--title ".." [--lever ".."]] [--subject ..] [--stake ..] [--result ..] [--predicted-ctr 1.3] [--rounds 3] [--offline] [--root dir]   titles, concepts, QA, A/B pair, the pre-registered levers, gates -> packages/<slug>/package.json + .md; offline the title is yours (--title, kept on rebuild; --lever names what it tests); exit 1 when a gate fails',
    'package review --title ".." --thumb-text ".." [--elements ..]     title + thumbnail coherence',
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'titles') {
      if (sub === 'score') {
        const title = rest[0]
        if (!title) throw new Error(`usage: ${cliName()} titles score "<title>"`)
        const s = scoreTitle(title)
        out({ title, ...s }, flags, () => [`"${title}"`, `Score ${s.score}/100`, ...s.notes.map((n) => `  - ${n}`)].join('\n'))
        return 0
      }
      const topic = sub
      if (!topic) throw new Error(`usage: ${USAGE_TITLES}`)
      // Shapes, not titles: a formula cannot conjugate a verb or drop an article, so a pasted-in topic
      // reads "I Did A $300 solar generator Until It Worked". No score, no ranking; the person writes it.
      const shapes = titleShapes({ number: str(flags, 'number'), subject: str(flags, 'subject'), audience: str(flags, 'audience') })
      const width = Math.max(...shapes.map((s) => s.title.length))
      out(shapes, flags, () => [
        `Title shapes for "${topic}": templates with a blank, not titles, so no scores and no ranking.`,
        ...shapes.map((s) => `  ${s.title.padEnd(width)}  ${s.formula}${s.example ? `, e.g. "${s.example}"` : ''}`),
        `Write your own title in one of these shapes, in your own words, then score it: ${cliName()} titles score "<your title>".`,
      ].join('\n'))
      return 0
    }
    if (cmd === 'thumbnail') {
      if (sub === 'brief') {
        const idea = rest[0]
        const title = str(flags, 'title')
        if (!idea || !title) throw new Error(`usage: ${cliName()} thumbnail brief "<idea>" --title "<title>" [--subject ..] [--stake ..] [--result ..]`)
        const brief = buildThumbnailBrief(idea, title, { subject: str(flags, 'subject'), stake: str(flags, 'stake'), result: str(flags, 'result') })
        out(brief, flags, () => [
          `Thumbnail brief · ${idea}`, `Title: ${title}`, '',
          ...brief.concepts.flatMap((c, i) => [`${i + 1}. ${c.name} (${c.angle})`, `   focal: ${c.focalSubject}`, `   support: ${c.supportingElement}`, `   text: ${c.text || '(none)'}`, `   composition: ${c.composition}`, `   why: ${c.whyItWorks}`, '']),
          'Rules:', ...brief.rules.map((r) => `  - ${r}`), '', 'QA before export:', ...brief.qaChecklist.map((r) => `  - ${r}`), '', 'Test plan:', ...brief.testPlan.map((r) => `  - ${r}`),
        ].join('\n'))
        return 0
      }
      if (sub === 'qa') {
        const spec: ThumbnailSpec = {
          focalSubject: str(flags, 'subject') ?? '',
          emotion: str(flags, 'emotion'),
          elements: list(flags, 'elements') ?? [],
          text: str(flags, 'text'),
          background: str(flags, 'background'),
          colors: list(flags, 'colors'),
          title: str(flags, 'title'),
        }
        const signature = bool(flags, 'no-signature') ? undefined : getProfile(flags).signature
        const qa = qaThumbnail(spec, signature)
        out({ spec, signature: signature ?? null, ...qa }, flags, () => renderQa(qa))
        return 0
      }
      if (sub === 'proof') {
        const slug = rest[0]
        if (!slug) throw new Error(`usage: ${USAGE_PROOF}`)
        return thumbnailProof(slug, flags)
      }
      if (sub === 'render') {
        const slug = rest[0]
        if (!slug) throw new Error(`usage: ${USAGE_RENDER}`)
        return thumbnailRender(slug, flags)
      }
      if (sub === 'check') {
        const file = rest[0]
        if (!file) throw new Error(`usage: ${USAGE_CHECK}`)
        if (!existsSync(file)) throw new Error(`${file} does not exist. Usage: ${USAGE_CHECK}`)
        const r = checkThumbnailFile(readFileSync(file))
        out({ file, ...r }, flags, () => [
          `Thumbnail check · ${r.pass ? 'PASS' : 'FAIL'}`,
          ...(r.meta ? [`${r.meta.format} ${r.meta.width}x${r.meta.height}, ${r.meta.bytes} bytes`] : []),
          ...r.issues.map((i) => `  - ${i}`),
        ].join('\n'))
        return r.pass ? 0 : 1
      }
      throw new Error(`usage: ${cliName()} thumbnail brief | qa | proof <slug> | render <slug> | check <file>`)
    }
    if (cmd === 'signature') {
      if (sub === 'show') return signatureShow(flags)
      if (sub === 'set') return signatureSet(flags)
      throw new Error(`usage: ${cliName()} signature show | ${USAGE_SIG_SET}`)
    }
    if (cmd === 'hook') {
      if (sub === 'score') return hookScore(flags)
      throw new Error(`usage: ${USAGE_HOOK}`)
    }
    if (cmd === 'promise') {
      if (sub === 'check') return promiseCheck(flags)
      throw new Error(`usage: ${USAGE_PROMISE}`)
    }
    if (sub === 'build') return packageBuild(rest[0], flags)
    if (sub !== 'review') throw new Error(`usage: ${USAGE_BUILD} | ${cliName()} package review --title ".." --thumb-text ".." [--elements "a,b,c"]`)
    // package review
    const title = str(flags, 'title')
    const thumbText = str(flags, 'thumb-text') ?? ''
    if (!title) throw new Error(`usage: ${cliName()} package review --title ".." --thumb-text ".." [--elements "a,b,c"]`)
    const t = scoreTitle(title)
    const overlap = titleThumbnailOverlap(title, thumbText)
    const elements = list(flags, 'elements') ?? []
    const issues: string[] = []
    if (t.score < 60) issues.push('title scores under 60: rewrite before testing the thumbnail')
    if (overlap >= 0.67) issues.push('thumbnail text repeats the title: the pair says one thing twice instead of two things once')
    if (thumbText.split(/\s+/).filter(Boolean).length > 3) issues.push('thumbnail text is longer than three words')
    if (elements.length > 3) issues.push(`thumbnail has ${elements.length} elements; cut to three`)
    const verdict = issues.length === 0 ? 'pass' : issues.length === 1 ? 'revise' : 'fail'
    out({ title, thumbText, titleScore: t.score, overlap, verdict, issues, titleNotes: t.notes }, flags, () => [`Packaging review · ${verdict.toUpperCase()}`, `Title ${t.score}/100 · overlap ${Math.round(overlap * 100)}%`, ...t.notes.map((n) => `  · ${n}`), ...(issues.length ? ['', 'Issues:', ...issues.map((i) => `  - ${i}`)] : ['', 'Title tells, thumbnail shows. Ship it to Test & Compare.'])].join('\n'))
    return 0
  },
}
