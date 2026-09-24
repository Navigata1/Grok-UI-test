/**
 * The handoff between stages, end to end through the CLI: what one command
 * writes, the next one must accept. Two pipelines are walked here in temp dirs:
 *
 *   package build -> hook score -> publish pack -> publish check    (the title
 *     the builder stamps and the chapters the packer writes are the ones the
 *     checklist reads, so the two must apply the same thresholds)
 *   package build -> publish confirm -> set --bucket 168 -> rules compile
 *     (the flywheel: a package pre-registers its levers, the confirm carries
 *     them onto the ledger row, and the compiler counts that row as a test)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../cli/booster.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'

const NOW = '2026-09-14T12:00:00Z'
const IDEA = 'I lived off a $300 solar generator for 30 days'
const SLUG = 'i-lived-off-a-300-solar-generator-for-30-days'
const PROMISE = 'thirty days on a $300 solar generator, every failure shown'
/** The title a person writes at package time (package build --title): offline, the builder never picks one. */
const TITLE = 'Thirty Days on a $300 Solar Generator, Every Failure'

/** Six short paragraphs: at 150 wpm hook score marks a chapter every 8 s, inside YouTube's 10 s minimum. */
const SCRIPT = [
  'Thirty days on a $300 solar generator, every failure shown. Here is what broke first and what finally worked.',
  'Day one: the fridge. The panel could not keep up and the ice melted by noon, which was the first real failure.',
  'Then the inverter started clicking. I pulled it apart on the floor and found a scorched board inside it.',
  'But the second week changed everything. I found the one setting that doubled the charge and held it there.',
  'By day thirty the whole cabin ran on it, lights and fridge and laptop together, on three hundred dollars.',
  'Here is the bill, line by line, and what I would buy again if I had to start this whole build over.',
].join('\n\n')

let tmp: string
let data: string
let profile: string
let playbook: string
let savedKey: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-publish-'))
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
  playbook = path.join(tmp, 'playbook')
  writeFileSync(profile, JSON.stringify({
    positioning: 'Solar for renters',
    signature: { colors: ['yellow', 'black'] },
    publishDay: 'fri',
    baselines: { computedAt: '2026-09-01T00:00:00Z', bucket: '48', n: 6, tier: 'thin' },
  }))
  savedKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})
afterEach(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey
  vi.restoreAllMocks()
  resetThresholds()
  rmSync(tmp, { recursive: true, force: true })
})

function scoped(argv: string[]): string[] {
  return [...argv, '--data', data, '--path', profile, '--now', NOW, '--root', tmp]
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true })
  try {
    const code = await main(scoped(argv))
    return { code, out, err }
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
}

async function json(argv: string[]): Promise<{ code: number; parsed: any; err: string }> {
  const { code, out, err } = await run([...argv, '--json'])
  return { code, parsed: JSON.parse(out), err }
}

async function fails(argv: string[]): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await main(scoped(argv))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
  throw new Error(`expected "${argv.join(' ')}" to fail`)
}

/** A minimal PNG header (signature + IHDR) at `width`x`height`; the header check reads nothing past it. */
function png(width: number, height: number): Buffer {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0])
}

/** The thumbnail stage's deliverable: thumb-A.png and thumb-B.png at 1280x720 in the package, which publish check reads. */
function exportThumbs(): void {
  for (const name of ['thumb-A.png', 'thumb-B.png']) writeFileSync(path.join(tmp, 'packages', SLUG, name), png(1280, 720))
}

/** package build (with the person's title) -> hook score -> publish pack, the documented order. */
async function walkToPack(): Promise<any> {
  const built = await json(['package', 'build', IDEA, '--promise', PROMISE, '--title', TITLE, '--subject', 'me', '--stake', 'the fridge dying', '--result', 'a full month on $300 of solar', '--offline'])
  expect(built.code).toBe(0)
  const script = path.join(tmp, 'script.txt')
  writeFileSync(script, SCRIPT)
  expect((await run(['hook', 'score', '--script', script, '--slug', SLUG])).code).toBe(0)
  const packed = await json(['publish', 'pack', SLUG, '--related', 'I Powered My Shed With a Car Battery'])
  expect(packed.code).toBe(0)
  return { built: built.parsed, packed: packed.parsed, packedErr: packed.err }
}

describe('the package build -> publish check handoff', () => {
  it('passes every publish checklist line on the title and chapters the earlier stages wrote', async () => {
    const { built, packed } = await walkToPack()
    // The title publish check reads is the one package build stamped GATES PASS on: the person's.
    expect(built.gateReport.pass).toBe(true)
    expect(built.chosenTitle).toBe(TITLE)
    expect(packed.title).toBe(built.chosenTitle)
    expect(built.chosenTitle.length).toBeGreaterThanOrEqual(30)
    expect(built.chosenTitle.length).toBeLessThanOrEqual(55)
    exportThumbs()
    const { code, parsed } = await json(['publish', 'check', SLUG, '--review-scheduled', '--window-confirmed'])
    expect(parsed.items.filter((i: any) => !i.ok)).toEqual([])
    expect(parsed.pass).toBe(true)
    expect(code).toBe(0)
  })

  it('writes only chapters the checklist accepts and names the beats that did not survive', async () => {
    const { packed, packedErr } = await walkToPack()
    const gaps = packed.chapters.slice(1).map((c: any, i: number) => c.atSec - packed.chapters[i].atSec)
    expect(packed.chapters[0].atSec).toBe(0)
    expect(gaps.every((g: number) => g >= 10)).toBe(true)
    expect(packedErr).toMatch(/story beat\(s\) are not chapters: YouTube needs 10 s between marks/)
    const story = JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'story.json'), 'utf8'))
    expect(story.chapters.length).toBeGreaterThan(packed.chapters.length)
    const { parsed } = await json(['publish', 'check', SLUG, '--review-scheduled', '--window-confirmed'])
    expect(parsed.items[3]).toEqual({ label: 'Chapters match the retention map beats.', ok: true })
  })

  it('refuses the package instead of handing publish check a title it will reject', async () => {
    const over = 'I Tested Every Portable Power Station for Van Solar in 24 Hours'
    expect(over.length).toBeGreaterThan(55)
    const { code, parsed } = await json(['package', 'build', 'Portable power stations for van solar', '--promise', 'Every portable power station tested for van solar in 24 hours', '--title', over, '--offline'])
    expect(code).toBe(1)
    expect(parsed.gateReport.titleGate.pass).toBe(false)
    expect(parsed.gateReport.titleGate.reason).toMatch(/publish check needs 30 \[house\] to 55 \[house\]/)
  })
})

describe('the thumbnail -> publish stages through the workflow runner', () => {
  it('passes the publish stage on real 1280x720 exports and fails it on a file the header check rejects', async () => {
    await walkToPack()
    expect((await run(['workflow', IDEA, '--promise', PROMISE, '--out', path.join(tmp, 'packages')])).code).toBe(0)
    for (const id of ['demand', 'packaging', 'story', 'plan', 'production', 'edit']) {
      expect((await run(['workflow', 'run', SLUG, '--override', '--stage', id, '--reason', `covered earlier in this test: ${id}`, '--yes', '--agent', 'tester'])).code).toBe(0)
    }
    exportThumbs()
    const thumbnail = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(thumbnail.parsed.result).toMatchObject({ stageId: 'thumbnail', status: 'passed' })
    // An export swapped after the proof: the publish stage reads the file itself rather than trusting the earlier stage.
    writeFileSync(path.join(tmp, 'packages', SLUG, 'thumb-B.png'), png(800, 450))
    const bad = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(bad.parsed.result).toMatchObject({ stageId: 'publish', status: 'failed' })
    const failed = JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'publish-check.json'), 'utf8'))
    // The runner runs the stage from the packages root (in-process, it changes directory for the stage), so the file prints relative to it.
    expect(failed.items.filter((i: any) => !i.ok).map((i: any) => i.detail)).toEqual([`packages/${SLUG}/thumb-B.png fails booster thumbnail check: 800x450 is smaller than 1280x720`])
    exportThumbs()
    const good = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(good.parsed.result).toMatchObject({ stageId: 'publish', status: 'passed' })
    expect(good.code).toBe(0)
  }, 90_000)
})

describe('the flywheel: package build -> publish confirm -> 7-day read -> rules compile', () => {
  it('compiles a rule with n >= 1 from a package that pre-registered its levers', async () => {
    const { built } = await walkToPack()
    expect(built.hypothesis.levers.length).toBeGreaterThan(0)
    const confirmed = await json(['publish', 'confirm', SLUG, '--video-id', 'aB3dEfGh1jK', '--at', '2026-09-01T12:00:00Z', '--yes'])
    expect(confirmed.code).toBe(0)
    const row = openStore(data).get('ledger', SLUG)!
    expect(row.hypothesis).toEqual({ levers: built.hypothesis.levers, angle: 'result', predictedCtrMultiple: 1, registeredAt: '2026-09-01T12:00:00.000Z' })

    await run(['set', SLUG, '--bucket', '168', '--impressions', '300000', '--ctr', '5.8', '--views', '17000', '--avp', '42', '--lever', 'cost breakdowns are the channel best proven format', '--yes'])
    const compiled = await json(['rules', 'compile', '--playbook', playbook])
    expect(compiled.parsed.tested).toBe(1)
    expect(compiled.parsed.rules.length).toBe(built.hypothesis.levers.length)
    for (const rule of compiled.parsed.rules) {
      expect(rule.tests).toBeGreaterThanOrEqual(1)
      expect(built.hypothesis.levers.map((l: string) => l.toLowerCase())).toContain(rule.lever)
    }
    expect(readFileSync(path.join(playbook, '00-learned-rules.md'), 'utf8')).not.toContain('none yet: 0 levers under test')
    const shown = await run(['rules', 'show', '--playbook', playbook])
    expect(shown.out).toMatch(/ {2}under test: "[^"]+" \(1 test, /)
  })

  it('counts the lever a person names for their title at package build, next to the two A/B angles', async () => {
    // Offline the title is the person's and names no formula; a rebuild with --lever (what the build prints) puts it in
    // the hypothesis before any number is in, and keeps the title.
    await walkToPack()
    const built = await json(['package', 'build', SLUG, '--lever', 'every failure shown', '--offline'])
    expect(built.parsed.chosenTitle).toBe(TITLE)
    expect(built.parsed.hypothesis.levers[0]).toBe('every failure shown')
    expect(built.parsed.hypothesis.levers.length).toBe(3)
    const confirmed = await json(['publish', 'confirm', SLUG, '--video-id', 'aB3dEfGh1jK', '--at', '2026-09-01T12:00:00Z', '--yes'])
    expect(confirmed.parsed.row.hypothesis.levers).toEqual(built.parsed.hypothesis.levers)
    expect(confirmed.err).not.toMatch(/--levers replaces/)
    await run(['set', SLUG, '--bucket', '168', '--impressions', '300000', '--ctr', '5.8', '--views', '17000', '--avp', '42', '--lever', 'failures up front held the audience', '--yes'])
    const compiled = await json(['rules', 'compile', '--playbook', playbook])
    expect(compiled.parsed.rules.map((r: any) => r.lever)).toContain('every failure shown')
  })

  it('takes --levers and --predicted-ctr over the package, and never rewrites a registered hypothesis', async () => {
    const { built } = await walkToPack()
    const j = await json(['publish', 'confirm', SLUG, '--video-id', 'aB3dEfGh1jK', '--at', '2026-09-01T12:00:00Z', '--levers', 'face in thumbnail, number in title', '--predicted-ctr', '1.4', '--yes'])
    expect(j.parsed.row.hypothesis).toMatchObject({ levers: ['face in thumbnail', 'number in title'], predictedCtrMultiple: 1.4, registeredAt: '2026-09-01T12:00:00.000Z' })
    // --levers replaces the package's list; the A/B angles it drops are named, not lost in silence.
    expect(j.err).toContain(`--levers replaces the levers the package pre-registered: ${built.hypothesis.levers.join(', ')} are not on this row.`)
    // Pre-registration is the point: a lever named once the read is in would be hindsight, not a test.
    expect(await fails(['publish', 'confirm', SLUG, '--video-id', 'aB3dEfGh1jK', '--at', '2026-09-01T12:00:00Z', '--levers', 'hindsight', '--yes']))
      .toMatch(/pre-registered its hypothesis at 2026-09-01T12:00:00.000Z .* and it is not rewritable/)
    expect(openStore(data).get('ledger', SLUG)!.hypothesis!.levers).toEqual(['face in thumbnail', 'number in title'])
    // A re-run that does not argue with the registration is still allowed to correct the rest of the row.
    const again = await json(['publish', 'confirm', SLUG, '--video-id', 'aB3dEfGh1jK', '--at', '2026-09-01T12:00:00Z', '--thumb-b', 'The Identity v2', '--yes'])
    expect(again.parsed.row.hypothesis.levers).toEqual(['face in thumbnail', 'number in title'])
    expect(again.parsed.row.thumbB).toBe('The Identity v2')
    expect(await fails(['publish', 'confirm', SLUG, '--video-id', 'aB3dEfGh1jK', '--at', '2026-09-01T12:00:00Z', '--predicted-ctr', 'lots', '--yes'])).toMatch(/--predicted-ctr must be a number/)
  })
})
