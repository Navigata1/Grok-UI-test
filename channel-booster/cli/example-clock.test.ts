import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/booster.js'
import { readVideoRows } from '../src/csv.js'
import { EXAMPLE_AS_OF, exampleAsOf, exampleNote } from './example-clock.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const module = path.resolve(here, '..')
const repo = path.resolve(module, '..')
const examples = path.join(module, 'examples')
const competitors = path.join(examples, 'competitors.csv')
const myChannel = path.join(examples, 'my-channel.csv')
/** Well after every bundled example: the wall clock a new user has on the day they clone. */
const LATER = '2027-03-01T12:00:00Z'
const IDEA_SCORE = 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'

let tmp: string
let data: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-example-clock-'))
  data = path.join(tmp, 'data')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(LATER))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true })
  try {
    const code = await main(argv)
    return { code, out, err }
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
}

async function json(argv: string[]): Promise<Record<string, any>> {
  const { code, out } = await run([...argv, '--json'])
  expect(code).toBe(0)
  return JSON.parse(out)
}

/** Split one shell line into argv: double-quoted words stay whole, as bash reads the README. */
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

/** The `npm run booster -- ...` lines of the README quick start, as argv with repo-relative paths made absolute. */
function quickStart(): string[][] {
  const readme = readFileSync(path.join(module, 'README.md'), 'utf8')
  const block = /## Quick start\s+```bash\n([\s\S]*?)```/.exec(readme)
  expect(block, 'README.md has a ```bash block under ## Quick start').not.toBeNull()
  return (block as RegExpExecArray)[1].split('\n')
    .filter((l) => l.startsWith('npm run booster -- '))
    .map((l) => shellWords(l.slice('npm run booster -- '.length)).map((w) => (w.startsWith('channel-booster/') ? path.join(repo, w) : w)))
}

describe('the bundled examples read as of the date they were written for', () => {
  it('gives the README quick start its documented result on any later date, and says which date it used', async () => {
    const commands = quickStart()
    const verbs = commands.map((c) => c.slice(0, c[0] === 'idea' ? 2 : 1).join(' '))
    expect(verbs).toEqual(['help', 'outliers', 'audit', 'idea score'])
    const readme = readFileSync(path.join(module, 'README.md'), 'utf8')

    for (const argv of commands) {
      const { code, out } = await run([...argv, '--data', data])
      expect(code, argv.join(' ')).toBe(0)
      if (argv[0] === 'help') continue
      const csv = argv.find((w) => w.endsWith('.csv')) as string
      expect(out).toContain(exampleNote(EXAMPLE_AS_OF[path.basename(csv)]))
    }

    const [, scanArgv, auditArgv, ideaArgv] = commands
    const scan = await json([...scanArgv, '--data', data])
    expect(scan.scannedAt).toBe('2026-07-10T00:00:00.000Z')
    expect(scan.exampleAsOf).toBe('2026-07-10T00:00:00Z')
    // On the wall clock 19 of 20 rows read stale; at the example's date, 8 do.
    expect(scan.staleCount).toBe(8)
    expect(scan.ranked.find((r: any) => r.title === 'How I Built a Solar Generator for $300')).toMatchObject({ tier: 'outlier', stale: false })

    const audit = await json([...auditArgv, '--data', data])
    expect(audit.scannedAt).toBe('2026-08-16T00:00:00.000Z')
    expect(audit.ranked[0]).toMatchObject({ title: 'I Tried Sleeping in the Camper for 7 Nights', tier: 'outlier', stale: false })

    const idea = await json([...ideaArgv, '--data', data])
    expect(idea.verdict).not.toBe('red')
    expect(idea.demand).toMatchObject({ score: 3, exampleAsOf: '2026-07-10T00:00:00Z' })
    expect(idea.demand.evidence.map((e: any) => e.title)).toEqual(['How I Built a Solar Generator for $300', 'Generator vs Solar: Which Is Cheaper?'])
    // The sentence under the quick start states this result; the two cannot drift apart.
    expect(readme).toContain(`${idea.verdict.toUpperCase()} ${idea.total}, with demand ${idea.demand.score}/5`)
  })

  it('stamps a saved scan with the example date and scores demand=auto on the same clock, while bank rows keep the real date', async () => {
    const saved = await json(['outliers', competitors, '--data', data, '--save'])
    const doc = JSON.parse(readFileSync(saved.savedTo, 'utf8'))
    expect(doc.scannedAt).toBe('2026-07-10T00:00:00.000Z')
    expect(Object.keys(doc).sort()).toEqual(['ranked', 'scannedAt', 'sinceDays'])

    const again = await json(['outliers', competitors, '--data', data, '--diff', 'last-scan.json'])
    expect(again.diff).toEqual({ added: [], removed: [], changed: [] })

    const scored = await json(['idea', 'score', 'solar generator budget build', '--score', IDEA_SCORE, '--outliers', competitors, '--data', data])
    const solar = scored.demand.evidence.find((e: any) => e.title === 'How I Built a Solar Generator for $300')
    const inScan = doc.ranked.find((r: any) => r.title === 'How I Built a Solar Generator for $300')
    expect(solar.multiplier).toBe(inScan.multiplier)
    expect(Math.round(solar.ageDays)).toBe(66)

    const text = await run(['idea', 'score', 'solar generator budget build', '--score', IDEA_SCORE, '--outliers', competitors, '--data', data])
    expect(text.out).toMatch(/Demand 3\/5 \(auto\): .*\[house\]\n(?:.*\n)*Example data: scored as of 2026-07-10, the date it was written for; pass --now to override\./)

    const banked = await json(['bank', 'add', 'solar generator budget build', '--score', IDEA_SCORE, '--csv', competitors, '--data', data])
    expect(banked.scores.demand).toBe(3)
    expect(banked.demand.exampleAsOf).toBe('2026-07-10T00:00:00Z')
    expect(banked.createdAt).toBe(new Date(LATER).toISOString())
  })

  it('leaves any other CSV on the wall clock, a copy of an example included', async () => {
    const copy = path.join(tmp, 'competitors.csv')
    copyFileSync(competitors, copy)
    expect(exampleAsOf(copy)).toBeUndefined()
    const scan = await json(['outliers', copy, '--data', data])
    expect(scan.scannedAt).toBe(new Date(LATER).toISOString())
    expect(scan.exampleAsOf).toBeUndefined()
    const { out } = await run(['outliers', copy, '--data', data])
    expect(out).not.toContain('Example data')

    const idea = await json(['idea', 'score', 'solar generator budget build', '--score', IDEA_SCORE, '--outliers', copy, '--data', data])
    expect(idea.verdict).toBe('red')
    expect(idea.demand.exampleAsOf).toBeUndefined()
  })

  it('finds the example through a relative path, and gives way to --now and BOOSTER_NOW', async () => {
    expect(exampleAsOf(path.relative(process.cwd(), competitors))).toBe('2026-07-10T00:00:00Z')
    expect(exampleAsOf(path.join(examples, '..', 'examples', 'my-channel.csv'))).toBe('2026-08-16T00:00:00Z')
    expect(exampleAsOf(path.join(examples, 'nope.csv'))).toBeUndefined()
    expect(exampleAsOf(path.join(examples, 'constructor'))).toBeUndefined()

    const pinned = await run(['outliers', competitors, '--data', data, '--now', '2026-09-14T08:00:00Z'])
    expect(pinned.out).toContain('as of 2026-09-14')
    expect(pinned.out).not.toContain('Example data')

    vi.stubEnv('BOOSTER_NOW', '2026-09-14T08:00:00Z')
    const env = await json(['audit', myChannel, '--data', data])
    expect(env.scannedAt).toBe('2026-09-14T08:00:00.000Z')
    expect(env.exampleAsOf).toBeUndefined()
  })

  it('dates every bundled export a few days after its newest row', () => {
    const files = readdirSync(examples).filter((f) => f.endsWith('.csv')).sort()
    expect(Object.keys(EXAMPLE_AS_OF).sort()).toEqual(files)
    for (const file of files) {
      const asOf = Date.parse(EXAMPLE_AS_OF[file])
      const newest = Math.max(...readVideoRows(readFileSync(path.join(examples, file), 'utf8')).map((r) => Date.parse(r.published ?? '')).filter((t) => !Number.isNaN(t)))
      const days = (asOf - newest) / 86_400_000
      // Not before the newest row (no video from the future) and not so late that the file reads as a stale export.
      expect(days, `${file}: ${EXAMPLE_AS_OF[file]} is ${days} days after its newest row`).toBeGreaterThanOrEqual(0)
      expect(days, `${file}: ${EXAMPLE_AS_OF[file]} is ${days} days after its newest row`).toBeLessThanOrEqual(14)
    }
  })
})
