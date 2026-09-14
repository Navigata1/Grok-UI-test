/**
 * CLI wiring tests for the factory module: thumbnail qa/proof/render/check,
 * signature show/set, hook score, promise check, publish pack/check/confirm
 * and test judge. Every run uses temp dirs (--data, --path, --root, --out)
 * and never touches channel-booster/data or channel-booster/packages.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../cli/booster.js'
import { addRow } from '../src/ledger.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'

const NOW = '2026-09-14T12:00:00Z'
const TITLE = 'I Built a Solar Generator From Scrap for $40'
const PROMISE = 'a solar generator built from scrap for under $40 that runs a fridge'

const GOOD_SCRIPT = [
  '[0:00] This solar generator runs my fridge. I built it from scrap for under $40.',
  '[0:10] The catch? Every part came from a junkyard, and the first one caught fire.',
  '[1:00] But then I found the panel that changed everything.',
  '[2:00] Wait, it actually charged the battery in 40 minutes?',
  '[3:00] And here it is powering the fridge for the first time.',
  '[3:30] Can it run the fridge overnight, though?',
  '[4:00] Next week I take it off grid for seven days.',
].join('\n')

const BAD_SCRIPT = [
  'Hey guys, welcome back to the channel, make sure you subscribe.',
  'Today we are going to talk about a few things I have been up to lately.',
  ...Array.from({ length: 40 }, () => 'and then we went along and along and along and along and along and along and along and along and along and along and along and along and along.'),
].join('\n')

/** One QA'd concept as the package builder stores it (spec + qa). */
function concept(name: string, angle: string, spec: Record<string, unknown>, grade: 'ship' | 'revise' | 'rethink' = 'ship') {
  return { name, angle, spec: { elements: [spec.focalSubject, 'one object'], title: TITLE, ...spec }, qa: { score: grade === 'ship' ? 90 : grade === 'revise' ? 65 : 40, grade, passes: [], failures: [], fixes: [] } }
}

const PACKAGE = {
  chosenTitle: TITLE,
  titles: [{ title: TITLE, score: 80 }, { title: 'Scrap Solar Generator Build', score: 55 }],
  promise: PROMISE,
  thumbnails: [
    concept('stakes', 'stakes', { focalSubject: 'the inverter caught fire', text: 'Or Else', colors: ['yellow', 'black'] }),
    concept('result', 'result', { focalSubject: 'the fridge running', text: 'Fridge On', colors: ['yellow', 'black'] }),
    concept('collage', 'contrast', { focalSubject: 'a busy collage', text: 'so many parts on the table here', colors: ['grey', 'white'] }, 'rethink'),
  ],
  abPick: { a: 'stakes', b: 'result' },
  hypothesis: { levers: ['stakes'], angle: 'fear of loss', predictedCtrMultiple: 1.3 },
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}
/** A minimal PNG (signature + IHDR) padded to `totalBytes`; the CRC is not checked by the header reader. */
function png(width: number, height: number, totalBytes?: number): Buffer {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]
  const buf = Buffer.alloc(Math.max(head.length, totalBytes ?? head.length))
  Buffer.from(head).copy(buf)
  return buf
}

let tmp: string
let data: string
let root: string
let profilePath: string
let slugDir: string
const SLUG = 'scrap-solar'

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'booster-factory-'))
  data = path.join(tmp, 'data')
  root = path.join(tmp, 'root')
  profilePath = path.join(tmp, 'channel.json')
  slugDir = path.join(root, 'packages', SLUG)
  mkdirSync(slugDir, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  resetThresholds()
  rmSync(tmp, { recursive: true, force: true })
})

function writeProfile(extra: Record<string, unknown> = {}): void {
  writeFileSync(profilePath, JSON.stringify({
    positioning: 'scrap builds',
    signature: { colors: ['yellow', 'black'], facePolicy: 'either', maxWords: 3 },
    competitors: ['Van Life Builds', 'The Indie Projects', 'Nate Murphy', 'Eamon and Bec'],
    publishDay: 'fri',
    baselines: { computedAt: '2026-09-01T00:00:00Z', bucket: '48', n: 6, tier: 'thin' },
    ...extra,
  }))
}

function writePackage(pkg: unknown = PACKAGE): void {
  writeFileSync(path.join(slugDir, 'package.json'), JSON.stringify(pkg))
}

function writeScript(body = GOOD_SCRIPT): string {
  const file = path.join(tmp, 'script.txt')
  writeFileSync(file, body)
  return file
}

/** The common flags every run gets: temp store, temp profile, temp root, fixed clock. */
function common(): string[] {
  return ['--data', data, '--path', profilePath, '--root', root, '--now', NOW]
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const code = await main([...argv, ...common()])
    return { code, out }
  } finally {
    spy.mockRestore()
    err.mockRestore()
  }
}

async function json(argv: string[], expectCode = 0): Promise<any> {
  const { code, out } = await run([...argv, '--json'])
  expect(code).toBe(expectCode)
  return JSON.parse(out)
}

/** Capture stdout even when main() rejects (a gate prints its plan, then throws). */
async function failing(argv: string[]): Promise<{ out: string; error: string }> {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await main([...argv, ...common()])
    throw new Error('expected the command to fail')
  } catch (e) {
    return { out, error: e instanceof Error ? e.message : String(e) }
  } finally {
    spy.mockRestore()
    err.mockRestore()
  }
}

describe('help', () => {
  it('lists every factory and publish command', async () => {
    const { out } = await run(['help'])
    for (const line of ['thumbnail proof <slug>', 'thumbnail render <slug>', 'thumbnail check <file>', 'signature show', 'signature set --colors', 'hook score --script <file> --slug <slug>', 'promise check --promise', 'publish pack <slug>', 'publish check <slug>', 'publish confirm <slug> --video-id <id> --at <ISO>', 'test judge --slug <slug>']) {
      expect(out).toContain(line)
    }
  })
})

describe('thumbnail qa', () => {
  it('checks the channel signature by default and reports drift as a failure line', async () => {
    writeProfile()
    const { code, out } = await run(['thumbnail', 'qa', '--subject', 'the fridge', '--elements', 'fridge,cable', '--text', 'Runs A Fridge Now', '--colors', 'red,green'])
    expect(code).toBe(0)
    expect(out).toMatch(/✕ signature drift: colours red\/green miss the signature pair yellow\/black/)
    expect(out).toMatch(/4 words of text, signature allows at most 3/)
    const j = await json(['thumbnail', 'qa', '--subject', 'the fridge', '--elements', 'fridge', '--text', 'Runs A Fridge Now', '--colors', 'red,green'])
    expect(j.signature.colors).toEqual(['yellow', 'black'])
    expect(j.failures.some((f: string) => f.startsWith('signature drift'))).toBe(true)
  })
  it('skips the signature with --no-signature and when the profile has none', async () => {
    writeProfile()
    const skipped = await json(['thumbnail', 'qa', '--subject', 'the fridge', '--elements', 'fridge', '--text', 'Runs', '--colors', 'red,green', '--no-signature'])
    expect(skipped.signature).toBeNull()
    expect(skipped.failures.some((f: string) => f.startsWith('signature drift'))).toBe(false)
    writeProfile({ signature: undefined })
    const none = await json(['thumbnail', 'qa', '--subject', 'the fridge', '--elements', 'fridge', '--colors', 'yellow,black'])
    expect(none.signature).toBeNull()
    expect(none.grade).toBe('ship')
  })
})

describe('signature', () => {
  it('show exits 1 without a signature and prints the sentence once set', async () => {
    const missing = await run(['signature', 'show'])
    expect(missing.code).toBe(1)
    expect(missing.out).toMatch(/no signature in channel.json/)
    const set = await run(['signature', 'set', '--colors', 'yellow, black', '--face', 'always', '--max-words', '2', '--framing', 'subject in the lower third', '--typeface', 'condensed caps'])
    expect(set.code).toBe(0)
    expect(set.out).toMatch(/Keep the channel signature: the yellow\/black colour pair, always a face, at most 2 words of text, framing subject in the lower third, typeface condensed caps\./)
    const saved = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(saved.signature).toEqual({ colors: ['yellow', 'black'], facePolicy: 'always', maxWords: 2, framing: 'subject in the lower third', typeface: 'condensed caps' })
    expect(saved.updatedAt).toBe(new Date(NOW).toISOString())
    const shown = await json(['signature', 'show'])
    expect(shown.facePolicy).toBe('always')
    const text = await run(['signature', 'show'])
    expect(text.out).toMatch(/^Keep the channel signature/)
  })
  it('keeps the rest of the profile, applies zod defaults, and rejects a bad face policy', async () => {
    writeProfile({ signature: undefined })
    await run(['signature', 'set', '--colors', 'white,red'])
    const saved = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(saved.positioning).toBe('scrap builds')
    expect(saved.signature).toMatchObject({ colors: ['white', 'red'], facePolicy: 'either', maxWords: 3 })
    await expect(main(['signature', 'set', '--colors', 'white', '--face', 'sometimes', ...common()])).rejects.toThrow(/facePolicy/)
    await expect(main(['signature', 'set', ...common()])).rejects.toThrow(/--colors is required/)
  })
})

describe('thumbnail check', () => {
  it('passes a 1280x720 PNG and fails a small one with exit 1', async () => {
    const good = path.join(tmp, 'good.png')
    writeFileSync(good, png(1280, 720))
    const ok = await run(['thumbnail', 'check', good])
    expect(ok.code).toBe(0)
    expect(ok.out).toMatch(/Thumbnail check · PASS\npng 1280x720, 33 bytes/)
    const small = path.join(tmp, 'small.png')
    writeFileSync(small, png(640, 360))
    const bad = await json(['thumbnail', 'check', small], 1)
    expect(bad.pass).toBe(false)
    expect(bad.issues[0]).toContain('640x360 is smaller than 1280x720')
    await expect(main(['thumbnail', 'check', path.join(tmp, 'nope.png'), ...common()])).rejects.toThrow(/does not exist/)
  })
})

describe('thumbnail proof', () => {
  it('falls back to brief concepts before a package exists and writes proof-sheet.html under --root', async () => {
    writeProfile()
    const j = await json(['thumbnail', 'proof', SLUG, '--title', TITLE, '--idea', 'scrap solar generator'])
    expect(j.source).toBe('brief')
    expect(j.concepts).toHaveLength(5)
    expect(j.competitors).toEqual(['Van Life Builds', 'The Indie Projects', 'Nate Murphy'])
    expect(j.out).toBe(path.join(slugDir, 'proof-sheet.html'))
    const html = readFileSync(j.out, 'utf8')
    expect(html).toContain('The Stakes')
    expect(html).toContain('Van Life Builds')
    expect(html).not.toContain('Eamon and Bec')
    expect(html).toContain(TITLE.replace('$40', '$40'))
  })
  it('uses the package concepts, --competitors, --out and inlines delivered images from --images and thumb-A/B', async () => {
    writeProfile()
    writePackage()
    const images = path.join(tmp, 'images')
    mkdirSync(images)
    writeFileSync(path.join(images, 'stakes.png'), png(1280, 720))
    writeFileSync(path.join(slugDir, 'thumb-B.png'), png(1920, 1080))
    const outFile = path.join(tmp, 'sheet.html')
    const { code, out } = await run(['thumbnail', 'proof', SLUG, '--images', images, '--competitors', 'Rival one|Rival two|Rival three|Rival four', '--out', outFile])
    expect(code).toBe(0)
    expect(out).toContain('Images inlined: stakes <- stakes.png, result <- thumb-B.png')
    expect(out).toContain(`Wrote ${outFile}; open it in a browser.`)
    const html = readFileSync(outFile, 'utf8')
    expect(html).toContain('Rival three')
    expect(html).not.toContain('Rival four')
    // Two delivered images, each drawn four times (120px and 240px, light and dark).
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(8)
    expect(existsSync(path.join(slugDir, 'proof-sheet.html'))).toBe(false)
  })
  it('refuses to write when a delivered file fails the header check unless --force', async () => {
    writePackage()
    writeFileSync(path.join(slugDir, 'thumb-A.png'), png(800, 450))
    const { error } = await failing(['thumbnail', 'proof', SLUG])
    expect(error).toMatch(/1 delivered file\(s\) failed the thumbnail check/)
    expect(existsSync(path.join(slugDir, 'proof-sheet.html'))).toBe(false)
    const forced = await json(['thumbnail', 'proof', SLUG, '--force'])
    expect(forced.images[0]).toMatchObject({ concept: 'stakes', pass: false })
    expect(existsSync(path.join(slugDir, 'proof-sheet.html'))).toBe(true)
  })
})

describe('thumbnail render', () => {
  it('renders one prompt per ship-grade concept with the signature, every concept with --all', async () => {
    writeProfile()
    writePackage()
    const j = await json(['thumbnail', 'render', SLUG])
    expect(j.prompts).toHaveLength(2)
    expect(j.prompts[0]).toMatch(/^stakes: YouTube thumbnail, 16:9, 1280x720/)
    expect(j.prompts[0]).toContain('Keep the channel signature: the yellow/black colour pair')
    expect(j.out).toBe(path.join(slugDir, 'image-prompts.md'))
    const md = readFileSync(j.out, 'utf8')
    expect(md).toContain('## stakes')
    expect(md).toContain('## result')
    expect(md).not.toContain('## collage')
    const all = await run(['thumbnail', 'render', SLUG, '--all', '--out', path.join(tmp, 'all.md')])
    expect(all.code).toBe(0)
    expect(readFileSync(path.join(tmp, 'all.md'), 'utf8')).toContain('## collage')
  })
  it('works from the brief before a package exists and refuses when nothing ships', async () => {
    const j = await json(['thumbnail', 'render', SLUG, '--title', TITLE])
    expect(j.source).toBe('brief')
    expect(j.prompts.length).toBeGreaterThan(0)
    writePackage({ ...PACKAGE, thumbnails: [PACKAGE.thumbnails[2]] })
    await expect(main(['thumbnail', 'render', SLUG, ...common()])).rejects.toThrow(/no concept of "scrap-solar" grades ship/)
  })
})

describe('hook score', () => {
  it('takes title, promise and the thumbnail moment from package.json and writes story.json', async () => {
    writePackage()
    const script = writeScript()
    const { code, out } = await run(['hook', 'score', '--script', script, '--slug', SLUG])
    expect(code).toBe(0)
    expect(out).toMatch(/^Hook score: \d+\/100 \(pass, gate 70\)/)
    expect(out).toContain('Story gate: PASS')
    const story = JSON.parse(readFileSync(path.join(slugDir, 'story.json'), 'utf8'))
    expect(story.slug).toBe(SLUG)
    expect(story.pass).toBe(true)
    expect(story.promiseInFirst25Words).toBe(true)
    expect(story.promiseSource).toBe('promise')
    expect(story.thumbnailMomentPosition).not.toBe('missing')
    expect(story.payoffLadder).toEqual([])
    expect(story.chapters.length).toBeGreaterThanOrEqual(1)
    expect(story.computedAt).toBe(new Date(NOW).toISOString())
  })
  it('exits 1 when the gate fails, prints deductions, and keeps a payoffLadder the retention map filled', async () => {
    const script = writeScript(BAD_SCRIPT)
    writeFileSync(path.join(slugDir, 'story.json'), JSON.stringify({ slug: SLUG, payoffLadder: [{ atSec: 30, moment: 'kept' }] }))
    const { code, out } = await run(['hook', 'score', '--script', script, '--slug', SLUG, '--title', TITLE, '--promise', PROMISE])
    expect(code).toBe(1)
    expect(out).toMatch(/Story gate: FAIL/)
    expect(out).toContain('Deductions:')
    const story = JSON.parse(readFileSync(path.join(slugDir, 'story.json'), 'utf8'))
    expect(story.pass === false || story.promiseInFirst25Words === false).toBe(true)
    expect(story.payoffLadder).toEqual([{ atSec: 30, moment: 'kept' }])
    const j = await json(['hook', 'score', '--script', script, '--slug', SLUG, '--title', TITLE], 1)
    expect(j.promiseSource).toBe('title')
  })
  it('needs a title or promise, and an existing script', async () => {
    const script = writeScript()
    await expect(main(['hook', 'score', '--script', script, '--slug', SLUG, ...common()])).rejects.toThrow(/no title or promise/)
    await expect(main(['hook', 'score', '--script', path.join(tmp, 'missing.txt'), '--slug', SLUG, '--title', TITLE, ...common()])).rejects.toThrow(/does not exist/)
    await expect(main(['hook', 'score', '--slug', SLUG, ...common()])).rejects.toThrow(/--script is required/)
  })
})

describe('promise check', () => {
  it('passes when every surface restates the promise and exits 1 on drift', async () => {
    const script = writeScript()
    const ok = await run(['promise', 'check', '--promise', PROMISE, '--title', TITLE, '--script', script, '--description', `${PROMISE}\n\nlinks`, '--thumb-text', 'Fridge On'])
    expect(ok.code).toBe(0)
    expect(ok.out).toMatch(/title: pass \(\d+%\)/)
    expect(ok.out).toMatch(/scriptHead: pass/)
    expect(ok.out).toMatch(/descriptionLine1: pass/)
    expect(ok.out).toMatch(/thumbnailText: pass/)
    expect(ok.out).toMatch(/Promise: PASS on all 4 surface\(s\) checked/)
    expect(ok.out).toMatch(/Thresholds: /)
    const drift = await json(['promise', 'check', '--promise', PROMISE, '--title', 'What Nobody Tells You About Camping Vans'], 1)
    expect(drift.pass).toBe(false)
    expect(drift.checked).toEqual(['title'])
    const text = await run(['promise', 'check', '--promise', PROMISE, '--title', 'What Nobody Tells You About Camping Vans'])
    expect(text.code).toBe(1)
    expect(text.out).toMatch(/title: DRIFT/)
  })
  it('reads --description from a file and needs at least one surface', async () => {
    const desc = path.join(tmp, 'description.txt')
    writeFileSync(desc, `${PROMISE}\n\nmore`)
    const j = await json(['promise', 'check', '--promise', PROMISE, '--description', desc])
    expect(j.surfaces.descriptionLine1.pass).toBe(true)
    await expect(main(['promise', 'check', '--promise', PROMISE, ...common()])).rejects.toThrow(/nothing to check/)
    await expect(main(['promise', 'check', ...common()])).rejects.toThrow(/--promise is required/)
  })
})

describe('package build', () => {
  it('needs a promise (the full build is covered in package-build.test.ts) and keeps package review working', async () => {
    await expect(main(['package', 'build', SLUG, ...common()])).rejects.toThrow(/--promise is required/)
    const j = await json(['package', 'review', '--title', 'I Lived Off a $300 Solar Generator for 30 Days', '--thumb-text', 'Day 30'])
    expect(j.verdict).toBe('pass')
  })
})

/** story.json as hook score writes it, plus a payoff ladder the retention map filled. */
function writeStory(): void {
  writeFileSync(path.join(slugDir, 'story.json'), JSON.stringify({
    slug: SLUG,
    hookScore: 85,
    pass: true,
    promiseInFirst25Words: true,
    chapters: [{ atSec: 0, title: 'Open' }, { atSec: 45, title: 'The scrap pile' }, { atSec: 150, title: 'First test' }, { atSec: 400, title: 'It runs the fridge' }],
    payoffLadder: [{ atSec: 150, moment: 'first light' }, { atSec: 400, moment: 'the fridge runs on scrap', strength: 1 }, { atSec: 250, text: 'the inverter smokes' }],
  }))
}

describe('publish pack', () => {
  it('assembles publish.json and publish.md from package.json, story.json and the profile', async () => {
    writeProfile()
    writePackage()
    writeStory()
    const j = await json(['publish', 'pack', SLUG, '--related', 'I Powered My Shed With a Car Battery'])
    expect(j.title).toBe(TITLE)
    expect(j.descriptionLine1).toBe(PROMISE)
    expect(j.thumbs).toEqual({ a: 'stakes', b: 'result' })
    expect(j.chapters).toHaveLength(4)
    expect(j.shortsCuts).toHaveLength(2)
    expect(j.shortsCuts.map((s: any) => s.atSec)).toContain(400)
    expect(j.publishWindow).toMatch(/^Friday,/)
    expect(j.publishWindowSource).toBe('profile')
    expect(j.baselineReady).toBe(true)
    expect(j.endScreenTarget).toBe('I Powered My Shed With a Car Battery')
    const stored = JSON.parse(readFileSync(path.join(slugDir, 'publish.json'), 'utf8'))
    expect(stored.title).toBe(TITLE)
    expect(stored.files).toBeUndefined()
    const md = readFileSync(path.join(slugDir, 'publish.md'), 'utf8')
    expect(md).toContain(`# Publish: ${TITLE}`)
    expect(md).toContain('06:40 It runs the fridge')
    const text = await run(['publish', 'pack', SLUG])
    expect(text.out).toContain('## Test & Compare')
    expect(text.out).toContain(`Wrote ${path.join(slugDir, 'publish.json')}`)
  })
  it('takes flags over the package, honours --story/--out/--thumb-a/--thumb-b, and needs a title and promise', async () => {
    const story = path.join(tmp, 'elsewhere.json')
    writeStory()
    writeFileSync(story, readFileSync(path.join(slugDir, 'story.json')))
    rmSync(path.join(slugDir, 'story.json'))
    const outFile = path.join(tmp, 'publish.md')
    const j = await json(['publish', 'pack', SLUG, '--title', TITLE, '--promise', PROMISE, '--story', story, '--out', outFile, '--thumb-a', 'curiosity', '--thumb-b', 'identity', '--sequel-question', 'Can it run a freezer?'])
    expect(j.thumbs).toEqual({ a: 'curiosity', b: 'identity' })
    expect(j.pinnedComment).toContain('Can it run a freezer?')
    expect(j.chapters).toHaveLength(4)
    expect(j.publishWindow).toMatch(/^Thursday,/)
    expect(existsSync(outFile)).toBe(true)
    expect(existsSync(path.join(slugDir, 'publish.json'))).toBe(true)
    await expect(main(['publish', 'pack', SLUG, '--promise', PROMISE, ...common()])).rejects.toThrow(/no title for "scrap-solar"/)
    await expect(main(['publish', 'pack', SLUG, '--title', TITLE, ...common()])).rejects.toThrow(/no promise for "scrap-solar"/)
    await expect(main(['publish', 'pack', ...common()])).rejects.toThrow(/usage: booster publish pack/)
  })
})

describe('publish check', () => {
  async function packIt(extra: string[] = []): Promise<void> {
    writeProfile()
    writePackage()
    writeStory()
    await json(['publish', 'pack', SLUG, '--related', 'I Powered My Shed With a Car Battery', ...extra])
  }
  it('passes a complete pack, writes publish-check.json, and exits 1 until the human items are asserted', async () => {
    await packIt()
    const notYet = await json(['publish', 'check', SLUG], 1)
    expect(notYet.pass).toBe(false)
    expect(notYet.items.filter((i: any) => !i.ok).map((i: any) => i.label)).toEqual(['The 48-hour review is on the calendar with the baseline numbers ready.'])
    expect(notYet.thumbs.a).toMatchObject({ name: 'stakes', grade: 'ship', text: 'Or Else' })
    const written = JSON.parse(readFileSync(path.join(slugDir, 'publish-check.json'), 'utf8'))
    expect(written.pass).toBe(false)
    expect(written.items).toHaveLength(9)
    const { code, out } = await run(['publish', 'check', SLUG, '--review-scheduled', '--thumb-files-ok', '--window-confirmed'])
    expect(code).toBe(0)
    expect(out).toMatch(/^Publish checklist: PASS/)
    expect(JSON.parse(readFileSync(path.join(slugDir, 'publish-check.json'), 'utf8')).pass).toBe(true)
  })
  it('grades an unknown concept rethink, re-scores when --thumb-text overrides, and needs publish.json', async () => {
    await packIt(['--thumb-b', 'mystery'])
    const j = await json(['publish', 'check', SLUG, '--review-scheduled'], 1)
    expect(j.thumbs.b.grade).toBe('rethink')
    expect(j.items[1].detail).toContain('B graded rethink')
    const overlap = await json(['publish', 'check', SLUG, '--review-scheduled', '--thumb-text-a', 'Solar Generator From Scrap'], 1)
    expect(overlap.items[0].detail).toContain('repeats the title')
    await expect(main(['publish', 'check', 'other-slug', ...common()])).rejects.toThrow(/run booster publish pack other-slug first/)
  })
})

describe('publish confirm', () => {
  async function packIt(): Promise<void> {
    writeProfile()
    writePackage()
    writeStory()
    await json(['publish', 'pack', SLUG])
  }
  it('prints the plan and writes nothing without --yes', async () => {
    await packIt()
    const { out, error } = await failing(['publish', 'confirm', SLUG, '--video-id', 'abc123', '--at', '2026-09-18T15:00:00Z'])
    expect(out).toMatch(/About to add the ledger row for "scrap-solar"/)
    expect(out).toContain('A / B:     stakes / result')
    expect(error).toMatch(/nothing written.*--yes/)
    expect(openStore(data).get('ledger', SLUG)).toBeUndefined()
    const plan = await json(['publish', 'confirm', SLUG, '--video-id', 'abc123', '--at', '2026-09-18T15:00:00Z'], 0).catch((e: Error) => e)
    expect(plan).toBeInstanceOf(Error)
  })
  it('adds the ledger row with --yes, starting the review clock', async () => {
    await packIt()
    const j = await json(['publish', 'confirm', SLUG, '--video-id', 'abc123', '--at', '2026-09-18T15:00:00Z', '--thumb-b', 'result-v2', '--yes'])
    expect(j.applied).toBe(true)
    const row = openStore(data).get('ledger', SLUG)
    expect(row).toMatchObject({ slug: SLUG, title: TITLE, videoId: 'abc123', publishedAt: '2026-09-18T15:00:00.000Z', thumbA: 'stakes', thumbB: 'result-v2', updatedAt: new Date(NOW).toISOString() })
    // Pre-registered, stamped with the publish time, exactly as the Desk's publish panel writes it.
    expect(row?.hypothesis).toEqual({ levers: ['stakes'], angle: 'fear of loss', predictedCtrMultiple: 1.3, registeredAt: '2026-09-18T15:00:00.000Z' })
    const text = await run(['publish', 'confirm', SLUG, '--video-id', 'abc123', '--at', '2026-09-18T15:00:00Z', '--yes'])
    expect(text.out).toMatch(/Recorded: scrap-solar published 2026-09-18T15:00:00.000Z as abc123/)
    await expect(main(['publish', 'confirm', SLUG, '--video-id', 'abc123', '--at', 'friday', '--yes', ...common()])).rejects.toThrow(/--at must be an ISO date/)
    await expect(main(['publish', 'confirm', SLUG, '--at', NOW, '--yes', ...common()])).rejects.toThrow(/--video-id is required/)
  })
})

describe('test judge', () => {
  it('says too early before the floors and records nothing to the ledger', async () => {
    writeProfile()
    const { code, out } = await run(['test', 'judge', '--slug', SLUG, '--a', '400,4.1,48', '--b', '380,5.2,52', '--hours', '20'])
    expect(code).toBe(0)
    expect(out).toMatch(/^Test & Compare: TOO-EARLY/)
    expect(out).toContain('Not recorded; add --record')
    const j = await json(['test', 'judge', '--slug', SLUG, '--a', '400,4.1,48', '--b', '380,5.2,52', '--hours', '20', '--record'])
    expect(j.outcome).toBe('too-early')
    expect(j.recorded.experimentId).toBe(`${SLUG}:1`)
    const exp = openStore(data).get('experiments', `${SLUG}:1`)
    expect(exp?.outcome).toBeUndefined()
    expect(exp?.winner).toBeUndefined()
    expect(exp?.variants).toHaveLength(2)
  })
  it('records a clear winner on the experiment and the ledger row with --record', async () => {
    writeProfile()
    addRow(openStore(data), { slug: SLUG, title: TITLE, publishedAt: '2026-09-10T15:00:00Z', thumbA: 'stakes', thumbB: 'result', now: new Date(NOW) })
    const j = await json(['test', 'judge', '--slug', SLUG, '--a', '12000,4.1,42,180', '--b', '11800,4.4,58,210', '--hours', '96', '--n', '2', '--record'])
    expect(j.outcome).toBe('clear-winner')
    expect(j.winner).toBe('B')
    expect(j.coldStart).toBe(false)
    expect(j.recorded).toEqual({ experimentId: `${SLUG}:2`, ledgerWinner: 'B' })
    const store = openStore(data)
    expect(store.get('experiments', `${SLUG}:2`)).toMatchObject({ slug: SLUG, outcome: 'clear-winner', winner: 'B', updatedAt: new Date(NOW).toISOString() })
    expect(store.get('ledger', SLUG)?.winner).toBe('B')
  })
  it('applies cold-start floors from --cold-start or a prior-tier profile and parses three variants', async () => {
    writeProfile({ baselines: { computedAt: '2026-09-01T00:00:00Z', bucket: '48', n: 2, tier: 'prior' } })
    const prior = await json(['test', 'judge', '--slug', SLUG, '--a', '1500,4.1,42', '--b', '1500,4.4,58', '--c', '1500,3.9,40', '--hours', '96'])
    expect(prior.coldStart).toBe(true)
    expect(prior.outcome).toBe('too-early')
    expect(prior.variants.map((v: any) => v.name)).toEqual(['A', 'B', 'C'])
    writeProfile()
    const flagged = await json(['test', 'judge', '--slug', SLUG, '--a', '1500,4.1,42', '--b', '1500,4.4,58', '--hours', '96', '--cold-start'])
    expect(flagged.coldStart).toBe(true)
    const plain = await json(['test', 'judge', '--slug', SLUG, '--a', '1500,4.1,42', '--b', '1500,4.4,58', '--hours', '96'])
    expect(plain.coldStart).toBe(false)
    expect(plain.outcome).toBe('clear-winner')
    await expect(main(['test', 'judge', '--slug', SLUG, '--a', '1500', '--b', '1500,4.4', '--hours', '96', ...common()])).rejects.toThrow(/--a must be/)
    await expect(main(['test', 'judge', '--slug', SLUG, '--a', '1500,4', '--b', '1500,4.4', ...common()])).rejects.toThrow(/--hours is required/)
  })
})
