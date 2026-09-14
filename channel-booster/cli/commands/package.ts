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
import { scoreHook, renderHookReport } from '../../src/hook.js'
import { buildPackage, writePackage, type GenerateHooks } from '../../src/package.js'
import { checkThumbnailFile } from '../../src/imagemeta.js'
import { loadProfile, saveProfile } from '../../src/profile.js'
import { checkPromise, type PromiseSurfaces } from '../../src/promise.js'
import { renderProofSheet, type ProofSheetConcept } from '../../src/proofsheet.js'
import { Signature, type ProfileDoc } from '../../src/schema.js'
import { describeSignature } from '../../src/signature.js'
import { generateTitles, scoreTitle, titleThumbnailOverlap } from '../../src/titles.js'
import { buildThumbnailBrief, qaThumbnail, renderImagePrompts } from '../../src/thumbnails.js'
import type { ThumbnailQa, ThumbnailSpec } from '../../src/types.js'
import { bool, getProfile, getStore, list, need, nowFrom, num, out, str, warn, type CommandModule, type Flags } from '../shared.js'

const USAGE_PROOF = 'booster thumbnail proof <slug> [--out packages/<slug>/proof-sheet.html] [--competitors "a|b|c"] [--images dir] [--root dir]'
const USAGE_RENDER = 'booster thumbnail render <slug> [--out packages/<slug>/image-prompts.md] [--all] [--root dir]'
const USAGE_CHECK = 'booster thumbnail check <file.png|file.jpg>'
const USAGE_SIG_SET = 'booster signature set --colors "yellow,black" [--face always|never|either] [--max-words 3] [--framing ".."] [--typeface ".."] [--notes ".."]'
const USAGE_HOOK = 'booster hook score --script <file> --slug <slug> [--title ".."] [--promise ".."] [--thumbnail-moment ".."] [--payoffs <retention-map.json>] [--wpm 150] [--root dir]'
const USAGE_PROMISE = 'booster promise check --promise ".." [--title ".."] [--script <file>] [--description <file>|".."] [--thumb-text ".."]'
const USAGE_BUILD = 'booster package build "<idea>"|<idea:id> --promise ".." [--subject ..] [--stake ..] [--result ..] [--number ..] [--audience ..] [--predicted-ctr 1.3] [--rounds 3] [--offline] [--no-signature] [--root dir] [--out dir]'

/** One thumbnail concept as packages/<slug>/package.json stores it (section 2.5). */
interface PackagedConcept {
  name: string
  angle?: string
  spec: ThumbnailSpec
  qa: ThumbnailQa
}

/** The fields of packages/<slug>/package.json this module reads. Every field is optional: the file may predate a builder. */
interface PackageFile {
  title?: string
  chosenTitle?: string
  titles?: Array<{ title: string; score?: number }>
  promise?: string
  thumbnails?: Array<Partial<PackagedConcept> & { name: string }>
  abPick?: { a?: string; b?: string }
}

/** `--root dir` (default cwd): packages/<slug>/ is resolved against it. */
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

function packageTitle(pkg: PackageFile | undefined): string | undefined {
  return pkg?.chosenTitle ?? pkg?.titles?.[0]?.title ?? pkg?.title
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
  const payoffsFile = str(flags, 'payoffs')
  if (payoffsFile !== undefined && !existsSync(payoffsFile)) throw new Error(`--payoffs ${payoffsFile} does not exist. Usage: ${USAGE_HOOK}`)
  const previous = readJson<{ payoffLadder?: unknown[] }>(storyFile)
  const payoffLadder = payoffsFile ? readPayoffs(payoffsFile) : Array.isArray(previous?.payoffLadder) ? previous.payoffLadder : []
  const story = { slug, ...report, payoffLadder }
  writeFile(storyFile, `${JSON.stringify(story, null, 2)}\n`)
  if (payoffLadder.length === 0) warn(`story.json has no payoff ladder: run booster ai retention-map --idea ".." --title ".." --script ${scriptFile} --out payoffs.json, then booster hook score --script ${scriptFile} --slug ${slug} --payoffs payoffs.json; plan shots has no payoff shots until then`)
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
    `Promise: ${report.pass ? 'PASS' : 'DRIFT'} on ${report.checked.length} surface(s)`,
    `Thresholds: ${report.thresholdsUsed.join('; ')}`,
  ].join('\n'))
  return report.pass ? 0 : 1
}

/**
 * Build the package (architecture 2.5): titles, concepts, QA, the A/B pair,
 * the designer brief, the gate report and the pre-registered hypothesis (the
 * chosen title's lever, both A/B angles, and --predicted-ctr), written to
 * packages/<slug>/package.json and package.md. `booster publish confirm`
 * carries that hypothesis onto the ledger row, which is what makes the row a
 * test `booster rules compile` can count. Offline (no ANTHROPIC_API_KEY, or --offline)
 * the generators are the deterministic engines and run once; with the model
 * the gate fixes go back to it for up to --rounds rounds. A bank idea
 * (idea:<id>, or its text) supplies the idea and its promise and moves to
 * packaging when it is green. Exit 1 when the gates fail: the sheet is still
 * written, and the workflow runner reads gateReport.pass from it.
 */
async function packageBuild(raw: string | undefined, flags: Flags): Promise<number> {
  if (!raw) throw new Error(`usage: ${USAGE_BUILD}`)
  const store = getStore(flags)
  let doc = store.get('ideas', raw.startsWith('idea:') ? raw : ideaId(raw))
  if (raw.startsWith('idea:') && !doc) throw new Error(`no idea "${raw}" in the bank (booster bank list shows ids)`)
  // The workflow runner passes the package slug: resolve it through the status document's idea text.
  const wf = !doc && !raw.startsWith('idea:') ? store.get('workflows', raw) : undefined
  if (wf) doc = store.get('ideas', ideaId(wf.idea))
  const idea = doc?.idea ?? wf?.idea ?? raw
  const promise = str(flags, 'promise') ?? doc?.promise ?? wf?.promise
  if (!promise) throw new Error(`--promise is required: one sentence the video keeps${doc ? ` (bank ideas carry it: booster bank add "<idea>" --promise "..")` : wf ? ` (the workflow carries it: booster workflow "<idea>" --promise "..")` : ''}. Usage: ${USAGE_BUILD}`)
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
    rounds,
    predictedCtrMultiple,
    now: nowFrom(flags),
  })
  const packagesDir = path.resolve(str(flags, 'out') ?? path.join(rootFrom(flags), 'packages'))
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
  const gateLine = (name: string, pass: boolean, reason: string) => `  ${pass ? 'PASS' : 'FAIL'} ${name}: ${reason}`
  out({ ...built, json, md, mode: offline ? 'offline' : 'model', bank: bank ?? null }, flags, () => [
    `Package · ${built.slug} · ${g.pass ? 'GATES PASS' : 'GATES FAIL'} (${offline ? 'offline generators, one round' : `model, ${built.rounds} round${built.rounds === 1 ? '' : 's'}`})`,
    `Title: ${built.chosenTitle || '(none)'} (${built.titles[0]?.score ?? 0}/100)`,
    `A/B: ${built.abPick.a || '—'} vs ${built.abPick.b || '—'} · ${built.abPick.reason}`,
    `Hypothesis: levers ${built.hypothesis.levers.join(', ') || '(none)'} · predicted CTR multiple ${built.hypothesis.predictedCtrMultiple}. booster publish confirm registers them on the ledger row.`,
    gateLine('title', g.titleGate.pass, g.titleGate.reason),
    gateLine('thumbnails', g.thumbGate.pass, g.thumbGate.reason),
    gateLine('overlap', g.overlapGate.pass, g.overlapGate.reason),
    gateLine('promise', g.promiseGate.pass, g.promiseGate.reason),
    ...(bank ? [`Bank: ${bank.id} ${bank.moved ? 'moved to packaging' : `stays ${bank.status}`}, packageId ${built.slug}.`] : []),
    `Wrote ${json} and ${md}.`,
    g.pass ? `Next: write your three own titles in ${md}, then booster hook score --script <file> --slug ${built.slug}.` : 'Fix the failing gates (edit the sheet, or re-run with the model on) before the story stage.',
  ].join('\n'))
  return g.pass ? 0 : 1
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
  const profilePath = str(flags, 'path')
  const profile = loadProfile(profilePath)
  const saved = saveProfile({ ...profile, signature: parsed.data }, profilePath, { now: nowFrom(flags) })
  out(saved.signature, flags, () => `${describeSignature(parsed.data)}\nSaved to channel.json (${profilePath ?? 'default path'}).`)
  return 0
}

export const packageModule: CommandModule = {
  verbs: ['titles', 'thumbnail', 'package', 'signature', 'hook', 'promise'],
  help: [
    'titles "<topic>" [--number ..] [--subject ..] [--audience ..]      generate and rank titles',
    'titles score "<title>"                                             score one title',
    'thumbnail brief "<idea>" --title ".." [--subject ..] [--stake ..] [--result ..]',
    'thumbnail qa --subject ".." --elements "a,b,c" [--emotion ..] [--text ..] [--background ..] [--colors "yellow,black"] [--title ..] [--no-signature]',
    'thumbnail proof <slug> [--out ..] [--competitors "a|b|c"] [--images dir] [--root dir]   proof sheet at 120px beside the top three competitors',
    'thumbnail render <slug> [--out ..] [--all] [--root dir]            one image prompt per ship-grade concept',
    'thumbnail check <file>                                             delivered PNG/JPG: 1280x720, 16:9, under 2 MB',
    'signature show                                                     the channel signature from channel.json',
    'signature set --colors "yellow,black" [--face ..] [--max-words ..] [--framing ..] [--typeface ..] [--notes ..]',
    'hook score --script <file> --slug <slug> [--title ..] [--promise ..] [--thumbnail-moment ..] [--payoffs <retention-map.json>] [--wpm 150] [--root dir]   writes packages/<slug>/story.json (payoffLadder from --payoffs); exit 1 when the gate fails',
    'promise check --promise ".." [--title ..] [--script <file>] [--description <file>|".."] [--thumb-text ..]   exit 1 on drift',
    'package build "<idea>"|<idea:id> --promise ".." [--subject ..] [--stake ..] [--result ..] [--predicted-ctr 1.3] [--rounds 3] [--offline] [--root dir]   titles, concepts, QA, A/B pair, the pre-registered levers, gates -> packages/<slug>/package.json + .md; exit 1 when a gate fails',
    'package review --title ".." --thumb-text ".." [--elements ..]     title + thumbnail coherence',
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'titles') {
      if (sub === 'score') {
        const title = rest[0]
        if (!title) throw new Error('usage: booster titles score "<title>"')
        const s = scoreTitle(title)
        out({ title, ...s }, flags, () => [`"${title}"`, `Score ${s.score}/100`, ...s.notes.map((n) => `  - ${n}`)].join('\n'))
        return 0
      }
      const topic = sub
      if (!topic) throw new Error('usage: booster titles "<topic>" [--number ..] [--subject ..] [--audience ..]')
      const candidates = generateTitles({ topic, number: str(flags, 'number'), subject: str(flags, 'subject'), audience: str(flags, 'audience') })
      out(candidates, flags, () => ['Score  Formula               Title', ...candidates.map((c) => `${String(c.score).padStart(5)}  ${c.formula.padEnd(21)} ${c.title}`), '', 'Pick two: the highest score and the one most different from it. Then write three of your own that beat both.'].join('\n'))
      return 0
    }
    if (cmd === 'thumbnail') {
      if (sub === 'brief') {
        const idea = rest[0]
        const title = str(flags, 'title')
        if (!idea || !title) throw new Error('usage: booster thumbnail brief "<idea>" --title "<title>" [--subject ..] [--stake ..] [--result ..]')
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
      throw new Error('usage: booster thumbnail brief | qa | proof <slug> | render <slug> | check <file>')
    }
    if (cmd === 'signature') {
      if (sub === 'show') return signatureShow(flags)
      if (sub === 'set') return signatureSet(flags)
      throw new Error(`usage: booster signature show | ${USAGE_SIG_SET}`)
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
    if (sub !== 'review') throw new Error(`usage: ${USAGE_BUILD} | booster package review --title ".." --thumb-text ".." [--elements "a,b,c"]`)
    // package review
    const title = str(flags, 'title')
    const thumbText = str(flags, 'thumb-text') ?? ''
    if (!title) throw new Error('usage: booster package review --title ".." --thumb-text ".." [--elements "a,b,c"]')
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
