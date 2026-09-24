import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../cli/booster.js'
import { addRow, recordRead } from '../src/ledger.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'

const NOW = '2026-09-14T12:00:00Z'
const nowMs = Date.parse(NOW)

let tmp: string
let data: string
let profile: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-direction-'))
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  resetThresholds()
  rmSync(tmp, { recursive: true, force: true })
})

function scoped(argv: string[]): string[] {
  return [...argv, '--data', data, '--path', profile, '--now', NOW]
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

async function json(argv: string[]): Promise<any> {
  const { code, out } = await run([...argv, '--json'])
  expect(code).toBe(0)
  return JSON.parse(out)
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

/** Twelve videos with 7-day reads: two "I tried" challenge winners at 10x, the rest at the median, four losers with a generic title word. */
function seedLedger(): void {
  const store = openStore(data)
  for (let i = 0; i < 12; i += 1) {
    const publishedAt = new Date(nowMs - (20 + i * 7) * 86_400_000).toISOString()
    const winner = i < 2
    const loser = i >= 8
    const slug = winner ? `i-tried-${i}` : loser ? `vlog-${i}` : `video-${i}`
    const title = winner ? `I Tried Living in a Van for ${30 + i} Days` : loser ? `My Vlog ${i}` : `Van Build Part ${i}`
    addRow(store, { slug, title, publishedAt, now: new Date(NOW) })
    recordRead(store, { slug, bucket: '168', read: { impressions: 60000, ctr: 5, avpPct: 40, views: winner ? 50000 : loser ? 800 : 5000, returningPct: winner ? 30 + i * 10 : 40 }, lever: 'lever noted', now: new Date(NOW) })
  }
}

describe('booster direction', () => {
  it('renders positioning, proven formats from own winners, series trends, never-again and three bets', async () => {
    writeFileSync(profile, JSON.stringify({ positioning: 'Van builds for first-timers', series: [{ name: 'I Tried', promise: 'one hard thing, thirty days' }], neverAgain: ['thumbnail text over three words'] }))
    seedLedger()
    const d = await json(['direction'])
    expect(d.positioning).toBe('Van builds for first-timers')
    expect(d.provenFormats.map((f: any) => f.format)).toContain('challenge')
    expect(d.series[0].name).toBe('I Tried')
    expect(d.series[0].videos.length).toBe(2)
    expect(d.neverAgain).toContain('thumbnail text over three words')
    expect(d.bets.length).toBeGreaterThan(0)
    expect(d.scan).toBeNull()
    const { out } = await run(['direction'])
    expect(out).toContain('Van builds for first-timers')
    expect(out).toMatch(/challenge/)
  })

  it('folds a saved audit scan into the proven formats and refuses a missing or malformed one', async () => {
    writeFileSync(profile, JSON.stringify({ positioning: 'x' }))
    seedLedger()
    const scan = path.join(tmp, 'last-scan.json')
    const ranked = [
      { title: 'Van vs Bus: which is cheaper?', tier: 'outlier', formats: ['comparison', 'question'], multiplier: 6 },
      { title: 'Van vs RV: real costs', tier: 'outlier', formats: ['comparison'], multiplier: 5 },
      { title: 'Van vs Tent', tier: 'outlier', formats: ['comparison'], multiplier: 5.5 },
      { title: 'Van Build Part 1', tier: 'normal', formats: ['series'], multiplier: 1 },
      { title: 'Van Build Part 2', tier: 'normal', formats: ['series'], multiplier: 0.9 },
      { title: 'Van Build Part 3', tier: 'normal', formats: [], multiplier: 1.1 },
    ]
    writeFileSync(scan, JSON.stringify({ scannedAt: NOW, sinceDays: 90, ranked }))
    const d = await json(['direction', '--scan', scan])
    expect(d.scan).toBe(scan)
    expect(d.provenFormats.map((f: any) => f.format)).toContain('comparison')
    // A bare `audit --save` lands in the store: "data/last-scan.json" from the repo root resolves there too.
    mkdirSync(data, { recursive: true })
    writeFileSync(path.join(data, 'last-scan.json'), JSON.stringify({ scannedAt: NOW, sinceDays: 90, ranked }))
    expect((await json(['direction', '--scan', 'data/last-scan.json'])).scan).toBe(path.join(data, 'last-scan.json'))
    expect((await json(['direction', '--scan', 'last-scan.json'])).scan).toBe(path.join(data, 'last-scan.json'))
    expect(await fails(['direction', '--scan', path.join(tmp, 'nope.json')])).toMatch(/does not exist \(looked at/)
    // Only the name asked for is read. Standing the competitor scan in for the channel's own
    // audit would print other channels' videos under "proven formats" with nothing saying so.
    expect(await fails(['direction', '--scan', 'last-audit.json'])).toMatch(/--scan last-audit.json does not exist/)
    writeFileSync(path.join(data, 'last-audit.json'), JSON.stringify({ scannedAt: NOW, sinceDays: 90, ranked }))
    expect((await json(['direction', '--scan', 'last-audit.json'])).scan).toBe(path.join(data, 'last-audit.json'))
    writeFileSync(scan, '{"rows": []}')
    expect(await fails(['direction', '--scan', scan])).toMatch(/not a saved scan/)
    expect(await fails(['direction', 'extra'])).toMatch(/usage: booster direction/)
  })

  it('works on an empty channel', async () => {
    writeFileSync(profile, JSON.stringify({}))
    const d = await json(['direction'])
    expect(d.provenFormats).toEqual([])
    expect(d.sampleSize).toBe(0)
  })
})

const PACKAGE = {
  chosenTitle: 'I Built a Solar Generator From Scrap',
  promise: 'a working solar generator from scrap for under $40',
  titles: [{ title: 'I Built a Solar Generator From Scrap', score: 82 }],
  thumbnails: [
    { name: 'result-panel', angle: 'result', spec: { focalSubject: 'the finished generator', emotion: 'proud', elements: ['generator', 'price tag', 'text "$40"'], text: '$40', background: 'garage', colors: ['yellow', 'black'] }, qa: { grade: 'ship', score: 90 }, composition: 'generator front and centre, price tag bottom right' },
    { name: 'stakes-bill', angle: 'stakes', spec: { focalSubject: 'a $400 electricity bill', emotion: 'shocked', elements: ['bill', 'me'], text: 'REALLY?', background: 'kitchen' }, qa: { grade: 'ship', score: 85 } },
    { name: 'curiosity-box', angle: 'curiosity', spec: { focalSubject: 'a taped box', elements: ['box'] }, qa: { grade: 'revise', score: 70 } },
  ],
  abPick: { a: 'result-panel', b: 'stakes-bill', reason: 'strongest and most different' },
}

const STORY = {
  hookScore: 80,
  payoffLadder: [{ atSec: 45, moment: 'the first panel lights the bulb' }, { atSec: 240, moment: 'the whole generator runs the fridge' }],
  rehooks: [{ atSec: 70, line: 'But the second panel fails.', lineIndex: 9, device: 'question' }],
  thumbnailMomentPosition: 'middle',
  thumbnailMomentAtSec: 240,
}

function writePkg(slug: string, pkg: unknown = PACKAGE, story: unknown | null = STORY): string {
  const dir = path.join(tmp, 'packages', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  if (story !== null) writeFileSync(path.join(dir, 'story.json'), JSON.stringify(story, null, 2))
  return dir
}

describe('booster plan shots', () => {
  beforeEach(() => writeFileSync(profile, JSON.stringify({ positioning: 'x' })))

  it('writes packages/<slug>/shots.md from the package and the story, with a setup per A/B concept', async () => {
    const dir = writePkg('solar')
    const r = await json(['plan', 'shots', 'solar', '--root', tmp, '--format', 'challenge'])
    expect(r.out).toBe(path.join(dir, 'shots.md'))
    expect(r.story).toBe(true)
    expect(r.format).toBe('challenge')
    expect(r.title).toBe('I Built a Solar Generator From Scrap')
    const names = r.setups.map((s: any) => s.name)
    expect(names.some((n: string) => n.includes('result-panel'))).toBe(true)
    expect(names.some((n: string) => n.includes('stakes-bill'))).toBe(true)
    expect(names.some((n: string) => n.includes('curiosity-box'))).toBe(false)
    expect(r.formatNotes.length).toBeGreaterThan(0)
    const md = readFileSync(r.out, 'utf8')
    expect(md).toContain('the first panel lights the bulb')
    expect(md).toContain('But the second panel fails.')
    expect(md).toContain('generator front and centre')
    const { out } = await run(['plan', 'shots', 'solar', '--root', tmp])
    expect(out).toContain(`Wrote ${path.join(dir, 'shots.md')}`)
  })

  it('warns without a story, honours --out, takes the format from the workflow status, and refuses a bad format or a missing package', async () => {
    writePkg('solar', PACKAGE, null)
    const outFile = path.join(tmp, 'elsewhere', 'shots.md')
    const { code, err } = await run(['plan', 'shots', 'solar', '--root', tmp, '--out', outFile])
    expect(code).toBe(0)
    expect(err).toMatch(/story.json not found/)
    expect(existsSync(outFile)).toBe(true)
    expect(await fails(['plan', 'shots', 'solar', '--root', tmp, '--format', 'opera'])).toMatch(/--format must be one of/)
    expect(await fails(['plan', 'shots', 'missing', '--root', tmp])).toMatch(/build the package first/)
    expect(await fails(['plan', 'shots'])).toMatch(/usage: booster plan shots/)
    expect(await fails(['plan', 'nope'])).toMatch(/usage: booster plan shots/)
    await run(['workflow', 'I built a solar generator from scrap', '--format', 'documentary', '--out', path.join(tmp, 'packages')])
    writePkg('i-built-a-solar-generator-from-scrap')
    const r = await json(['plan', 'shots', 'i-built-a-solar-generator-from-scrap', '--root', tmp])
    expect(r.format).toBe('documentary')
  })

  it('is the workflow Plan stage: the runner produces shots.md and passes the gate', async () => {
    const slug = 'i-built-a-solar-generator-from-scrap'
    await run(['workflow', 'I built a solar generator from scrap', '--out', path.join(tmp, 'packages')])
    writePkg(slug)
    const wf = JSON.parse(readFileSync(path.join(tmp, 'packages', `${slug}.json`), 'utf8'))
    const plan = wf.stages.find((s: any) => s.id === 'plan')
    expect(plan.run.command).toEqual(['booster', 'plan', 'shots', '<slug>', '--format', 'talking-head'])
    expect(plan.check).toEqual({
      kind: 'all-of',
      checks: [
        { kind: 'file-exists', path: 'shots.md' },
        { kind: 'json-path-min', path: 'story.json', jsonPath: 'payoffLadder.length', min: 1 },
      ],
    })
  })
})
