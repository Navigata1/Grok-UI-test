import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../cli/booster.js'
import { PackageDocSchema } from '../src/package.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'

const NOW = '2026-09-14T12:00:00Z'
const IDEA = 'I lived off a $300 solar generator for 30 days'
const SLUG = 'i-lived-off-a-300-solar-generator-for-30-days'
const PROMISE = 'thirty days on a $300 solar generator, every failure shown'

let tmp: string
let data: string
let profile: string
let savedKey: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-build-'))
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
  writeFileSync(profile, JSON.stringify({ positioning: 'Solar for renters', signature: { colors: ['yellow', 'black'] } }))
  // The build must never reach the network from a test, whatever the shell exported.
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

async function json(argv: string[]): Promise<{ code: number; parsed: any }> {
  const { code, out } = await run([...argv, '--json'])
  return { code, parsed: JSON.parse(out) }
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

describe('booster package build', () => {
  it('builds the package offline, writes package.json and package.md, and exits on the gate report', async () => {
    const { code, parsed } = await json(['package', 'build', IDEA, '--promise', PROMISE, '--subject', 'me', '--stake', 'the fridge dying', '--result', 'a full month on $300 of solar', '--offline'])
    expect(parsed.slug).toBe(SLUG)
    expect(parsed.mode).toBe('offline')
    expect(parsed.rounds).toBe(1)
    expect(parsed.titles.length).toBeGreaterThan(3)
    expect(parsed.chosenTitle).toBe(parsed.titles[0].title)
    expect(parsed.thumbnails.length).toBeGreaterThanOrEqual(4)
    expect(parsed.thumbnails.every((t: any) => t.qa && t.spec && typeof t.overlap === 'number')).toBe(true)
    expect(parsed.abPick.a).not.toBe('')
    expect(parsed.ownTitles).toEqual(['', '', ''])
    expect(parsed.gateReport.thresholdsUsed.length).toBeGreaterThan(0)
    expect(code).toBe(parsed.gateReport.pass ? 0 : 1)
    expect(parsed.bank).toBeNull()
    const dir = path.join(tmp, 'packages', SLUG)
    expect(parsed.json).toBe(path.join(dir, 'package.json'))
    expect(parsed.md).toBe(path.join(dir, 'package.md'))
    const onDisk = PackageDocSchema.parse(JSON.parse(readFileSync(parsed.json, 'utf8')))
    expect(onDisk.slug).toBe(SLUG)
    expect(onDisk.createdAt).toBe('2026-09-14T12:00:00.000Z')
    const md = readFileSync(parsed.md, 'utf8')
    expect(md).toContain(parsed.chosenTitle)
    expect(md).toContain(PROMISE)
    const text = await run(['package', 'build', IDEA, '--promise', PROMISE, '--offline'])
    expect(text.out).toMatch(/^Package · i-lived-off-a-300-solar-generator-for-30-days · GATES (PASS|FAIL) \(offline generators, one round\)/)
    expect(text.out).toContain(`Wrote ${parsed.json} and ${parsed.md}.`)
    expect(text.code).toBe(parsed.gateReport.pass ? 0 : 1)
  })

  it('stays offline without an API key even when --offline is not given, and honours --out', async () => {
    const outDir = path.join(tmp, 'elsewhere')
    const { parsed } = await json(['package', 'build', IDEA, '--promise', PROMISE, '--out', outDir])
    expect(parsed.mode).toBe('offline')
    expect(parsed.json).toBe(path.join(outDir, SLUG, 'package.json'))
    expect(existsSync(parsed.md)).toBe(true)
  })

  it('takes the idea and the promise from the bank, moves a green idea to packaging and leaves a banked one where it is', async () => {
    await run(['bank', 'add', IDEA, '--score', 'demand=4,packaging=4,fit=4,angle=4,payoff=4,feasibility=4', '--promise', PROMISE])
    const store = openStore(data)
    const doc = store.read('ideas')[0]
    expect(doc.status).toBe('banked')
    const banked = await json(['package', 'build', `idea:${doc.id.slice(5)}`.replace('idea:idea:', 'idea:'), '--offline'])
    expect(banked.parsed.idea).toBe(IDEA)
    expect(banked.parsed.promise).toBe(PROMISE)
    expect(banked.parsed.bank).toEqual({ id: doc.id, status: 'banked', moved: false })
    expect(store.get('ideas', doc.id)!.packageId).toBe(SLUG)
    const warned = await run(['package', 'build', doc.id, '--offline'])
    expect(warned.err).toMatch(/is banked, not green/)

    await run(['bank', 'approve', doc.id, '--yes'])
    expect(store.get('ideas', doc.id)!.status).toBe('green')
    const green = await json(['package', 'build', IDEA, '--offline'])
    expect(green.parsed.bank).toEqual({ id: doc.id, status: 'packaging', moved: true })
    expect(store.get('ideas', doc.id)!).toMatchObject({ status: 'packaging', packageId: SLUG })
    const again = await json(['package', 'build', doc.id, '--offline'])
    expect(again.parsed.bank).toEqual({ id: doc.id, status: 'packaging', moved: false })
  })

  it('refuses a missing promise, an unknown bank id, a bad round count and a missing idea', async () => {
    expect(await fails(['package', 'build', IDEA, '--offline'])).toMatch(/--promise is required/)
    expect(await fails(['package', 'build', 'idea:nope', '--promise', PROMISE, '--offline'])).toMatch(/no idea "idea:nope" in the bank/)
    expect(await fails(['package', 'build', IDEA, '--promise', PROMISE, '--rounds', 'many', '--offline'])).toMatch(/--rounds must be a number/)
    expect(await fails(['package', 'build'])).toMatch(/usage: booster package build/)
    expect(await fails(['package', 'nope'])).toMatch(/usage: booster package build/)
  })

  it('feeds the story and the shot list: hook score reads the package title and promise, plan shots reads both files', async () => {
    const built = await json(['package', 'build', IDEA, '--promise', PROMISE, '--offline'])
    const script = path.join(tmp, 'script.txt')
    writeFileSync(script, [
      `Thirty days on a $300 solar generator, every failure shown. Here is what broke first.`,
      'Day one: the fridge. [0:45] The panel could not keep up and the ice melted by noon.',
      'But the second week changed everything. [1:30] I found the one setting that doubled the charge.',
      'By day thirty the whole cabin ran on it. [3:00] Here is the bill.',
    ].join('\n'))
    const hook = await run(['hook', 'score', '--script', script, '--slug', SLUG])
    expect(existsSync(path.join(tmp, 'packages', SLUG, 'story.json'))).toBe(true)
    expect([0, 1]).toContain(hook.code)
    const shots = await json(['plan', 'shots', SLUG])
    expect(shots.code).toBe(0)
    expect(shots.parsed.title).toBe(built.parsed.chosenTitle)
    expect(shots.parsed.story).toBe(true)
    expect(existsSync(path.join(tmp, 'packages', SLUG, 'shots.md'))).toBe(true)
  })
})
