import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/booster.js'
import { cliName } from '../src/build-info.js'
import { PackageDocSchema } from '../src/package.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'

const NOW = '2026-09-14T12:00:00Z'
const IDEA = 'I lived off a $300 solar generator for 30 days'
const SLUG = 'i-lived-off-a-300-solar-generator-for-30-days'
const PROMISE = 'thirty days on a $300 solar generator, every failure shown'
/** The title a person writes for IDEA (package build --title). Offline it is the only way the package gets one. */
const TITLE = 'Thirty Days on a $300 Solar Generator, Every Failure'

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

/** The repository root: `npm run booster --` runs cli/booster.ts through tsx from here. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** How the CLI names itself in the lines it prints for a person to paste (`npm run booster --` from source). */
const CLI = cliName()

/**
 * Run a line the CLI printed, word for word, the way a person pastes it: a new process in `cwd`
 * (`npm run booster --` is cli/booster.ts through tsx), with only the environment given (no
 * scoped() flags). Double-quoted words are JSON strings, as the CLI prints them; `<your title>`
 * becomes `title`.
 */
function runPrinted(line: string, title: string, cwd: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  expect(line.startsWith(`${CLI} `)).toBe(true)
  const words = (line.slice(CLI.length).match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((w) => (w.startsWith('"') ? JSON.parse(w) as string : w))
  const argv = words.map((w) => (w === '<your title>' ? title : w))
  const r = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO, 'channel-booster', 'cli', 'booster.ts'), ...argv], { cwd, env, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
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
  it('builds the package offline, never picks a formula fill, and passes once a person writes the title', async () => {
    const opts = ['--subject', 'me', '--stake', 'the fridge dying', '--result', 'a full month on $300 of solar']
    const bare = await json(['package', 'build', IDEA, '--promise', PROMISE, ...opts, '--offline'])
    expect(bare.parsed.slug).toBe(SLUG)
    expect(bare.parsed.mode).toBe('offline')
    expect(bare.parsed.rounds).toBe(1)
    // No title until a person writes one: no fill is ranked, scored or chosen, and the title gate says what to do.
    expect(bare.parsed.chosenTitle).toBe('')
    expect(bare.parsed.titleSource).toBeUndefined()
    expect(bare.parsed.titles).toEqual([])
    expect(bare.parsed.titleShapes.length).toBeGreaterThan(10)
    expect(bare.parsed.titleShapes.every((t: any) => t.template === true && t.score === null && t.title.includes('___'))).toBe(true)
    expect(bare.parsed.gateReport.titleGate.pass).toBe(false)
    expect(bare.parsed.gateReport.titleGate.reason).toMatch(/offline, the builder never picks a formula fill; a person writes the title \(AGENTS.md, human gate 2\)/)
    expect(bare.parsed.gateReport.pass).toBe(false)
    expect(bare.code).toBe(1)
    expect(bare.parsed.thumbnails.length).toBeGreaterThanOrEqual(4)
    expect(bare.parsed.thumbnails.every((t: any) => t.qa && t.spec && typeof t.overlap === 'number')).toBe(true)
    expect(bare.parsed.abPick.a).not.toBe('')
    expect(bare.parsed.ownTitles).toEqual(['', '', ''])
    expect(bare.parsed.bank).toBeNull()
    const text = await run(['package', 'build', IDEA, '--promise', PROMISE, ...opts, '--offline'])
    expect(text.out).toMatch(/^Package · i-lived-off-a-300-solar-generator-for-30-days · GATES FAIL \(offline generators, one round\)\nTitle: none yet/)
    const rebuild = `${CLI} package build ${SLUG} --title "<your title>" --subject "me" --stake "the fridge dying" --result "a full month on $300 of solar"`
    expect(text.out).toContain(`then ${rebuild}`)
    // stderr carries it too: it is what the workflow runner shows for a failed stage.
    expect(text.err).toContain(`No title yet for ${SLUG}: a person writes it, then ${rebuild}`)
    // The directories this run used are repeated as absolute paths, so the line works from any directory.
    expect(text.err).toContain(` --root ${JSON.stringify(tmp)} --data ${JSON.stringify(data)} --path ${JSON.stringify(profile)} --offline\n`)
    expect(text.code).toBe(1)

    // The person writes the title and rebuilds by slug: the stored idea and promise come back with it.
    const { code, parsed } = await json(['package', 'build', SLUG, '--title', TITLE, ...opts, '--offline'])
    expect(parsed.idea).toBe(IDEA)
    expect(parsed.promise).toBe(PROMISE)
    expect(parsed.chosenTitle).toBe(TITLE)
    expect(parsed.titleSource).toBe('person')
    expect(parsed.titles).toEqual([expect.objectContaining({ title: TITLE })])
    expect(parsed.gateReport.pass).toBe(true)
    expect(code).toBe(0)
    // The pre-registered hypothesis is what makes the ledger row a test rules compile can count; a person's title names no formula.
    expect(parsed.hypothesis.levers).toEqual([parsed.thumbnails.find((t: any) => t.name === parsed.abPick.a).angle, parsed.thumbnails.find((t: any) => t.name === parsed.abPick.b).angle])
    expect(parsed.hypothesis.predictedCtrMultiple).toBe(1)
    expect(parsed.gateReport.thresholdsUsed.length).toBeGreaterThan(0)
    const dir = path.join(tmp, 'packages', SLUG)
    expect(parsed.json).toBe(path.join(dir, 'package.json'))
    expect(parsed.md).toBe(path.join(dir, 'package.md'))
    const onDisk = PackageDocSchema.parse(JSON.parse(readFileSync(parsed.json, 'utf8')))
    expect(onDisk.slug).toBe(SLUG)
    expect(onDisk.titleSource).toBe('person')
    expect(onDisk.createdAt).toBe('2026-09-14T12:00:00.000Z')
    const md = readFileSync(parsed.md, 'utf8')
    expect(md).toContain(`Chosen: **${TITLE}** (yours)`)
    expect(md).toContain(PROMISE)

    // A rebuild without --title (what the workflow's packaging stage runs) keeps the person's title.
    const again = await run(['package', 'build', SLUG, '--offline'])
    expect(again.code).toBe(0)
    expect(again.out).toContain(`Title: ${TITLE} (yours, `)
    expect(again.out).toContain('Rebuilds keep your title; --title replaces it.')
    expect(JSON.parse(readFileSync(parsed.json, 'utf8')).chosenTitle).toBe(TITLE)
  })

  it('refuses --title without the title text', async () => {
    expect(await fails(['package', 'build', IDEA, '--promise', PROMISE, '--title', '--offline'])).toMatch(/--title needs the title text/)
    expect(await fails(['package', 'build', IDEA, '--promise', PROMISE, '--title', TITLE, '--lever', '--offline'])).toMatch(/--lever needs the lever your title pulls/)
  })

  it('pre-registers the lever a person names for their title, keeps it on rebuild, and drops it with a new title', async () => {
    // Offline the title is a person's, and a person's title names no formula: --lever is how it enters the hypothesis.
    const bare = await run(['package', 'build', IDEA, '--promise', PROMISE, '--title', TITLE, '--offline'])
    expect(bare.out).toContain('Your title names no lever: rebuild with --lever "<the lever it pulls>" so rules compile counts the title too.')
    const named = await json(['package', 'build', IDEA, '--promise', PROMISE, '--title', TITLE, '--lever', 'number in title', '--offline'])
    const angles = [named.parsed.thumbnails.find((t: any) => t.name === named.parsed.abPick.a).angle, named.parsed.thumbnails.find((t: any) => t.name === named.parsed.abPick.b).angle]
    expect(named.parsed.hypothesis.levers).toEqual(['number in title', ...angles])
    expect(named.parsed.titles[0]).toMatchObject({ title: TITLE, lever: 'number in title' })
    // The workflow's packaging stage rebuilds by slug with neither flag: the title and its lever both stay.
    const kept = await json(['package', 'build', SLUG, '--offline'])
    expect(kept.parsed.chosenTitle).toBe(TITLE)
    expect(kept.parsed.hypothesis.levers).toEqual(['number in title', ...angles])
    const again = await run(['package', 'build', SLUG, '--offline'])
    expect(again.out).not.toContain('Your title names no lever')
    // A different title does not inherit the old title's lever.
    const other = await json(['package', 'build', SLUG, '--title', 'I Ran My Fridge on $300 of Solar for 30 Days', '--offline'])
    expect(other.parsed.hypothesis.levers).toEqual(angles)
    // With no title of the person's, --lever registers nothing and says so.
    const none = await run(['package', 'build', 'Van life budget build under 5000', '--promise', 'a full camper build for under $5,000', '--lever', 'price in title', '--offline'])
    expect(none.err).toContain('--lever "price in title" is not registered: it names the lever of a title you wrote, and this package has none. Pass it with --title.')
    expect(none.out).toMatch(/Hypothesis: levers (?!.*price in title)/)
  })

  it('keeps a person\'s title in Start Case, or with one word in capitals, at its own score through the title gate', async () => {
    // Both used to be read as template fills and held at 40/100: GATES FAIL on a title the person wrote.
    for (const [title, score] of [['I Did A 30 Day Test On A $300 Solar Generator', 85], ['Why cheap solar generators are NOT worth it', 85]] as const) {
      const { parsed } = await json(['package', 'build', IDEA, '--promise', PROMISE, '--title', title, '--offline'])
      expect(parsed.chosenTitle).toBe(title)
      expect(parsed.titles[0].score).toBe(score)
      expect(parsed.titles[0].notes.join(' ')).not.toMatch(/template fill/)
      expect(parsed.gateReport.titleGate.pass).toBe(true)
    }
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

  it('resolves a workflow slug (the packaging stage) through the status document and its promise', async () => {
    // The banked idea carries the promise; the workflow is created from the same text.
    await run(['bank', 'add', IDEA, '--score', 'demand=4,packaging=4,fit=4,angle=4,payoff=4,feasibility=4', '--promise', PROMISE])
    const created = await run(['workflow', IDEA, '--out', path.join(tmp, 'packages')])
    expect(created.err).not.toMatch(/no promise/)
    expect(openStore(data).get('workflows', SLUG)!.promise).toBe(PROMISE)
    const { code, parsed } = await json(['package', 'build', SLUG, '--offline'])
    expect(parsed.idea).toBe(IDEA)
    expect(parsed.promise).toBe(PROMISE)
    expect(parsed.slug).toBe(SLUG)
    expect(code).toBe(parsed.gateReport.pass ? 0 : 1)
    // An unbanked workflow carries the promise given on the command line, and says so when it has none.
    const other = 'Van life budget build under 5000'
    const bare = await run(['workflow', other, '--out', path.join(tmp, 'packages')])
    expect(bare.err).toMatch(/no promise for van-life-budget-build-under-5000/)
    expect(await fails(['package', 'build', 'van-life-budget-build-under-5000', '--offline'])).toMatch(/--promise is required.*the workflow carries it/)
    await run(['workflow', other, '--promise', 'a full camper build for under $5,000, every receipt shown', '--out', path.join(tmp, 'packages')])
    const built = await json(['package', 'build', 'van-life-budget-build-under-5000', '--offline'])
    expect(built.parsed.idea).toBe(other)
    expect(built.parsed.promise).toBe('a full camper build for under $5,000, every receipt shown')
    expect(built.parsed.bank).toBeNull()
  })

  it('runs the packaging stage for real from --root through the workflow runner, and keeps the title a person wrote', async () => {
    await run(['workflow', IDEA, '--promise', PROMISE, '--out', path.join(tmp, 'packages')])
    await run(['workflow', 'run', SLUG, '--override', '--reason', 'demand confirmed', '--yes'])
    // Offline and no title yet: the stage fails and its stderr (which the runner prints) says who writes the title.
    const first = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(first.parsed.result.stageId).toBe('packaging')
    expect(first.parsed.result.command).toEqual(['booster', 'package', 'build', SLUG])
    expect(first.parsed.result.kind).toBe('command')
    expect(first.parsed.result.status).toBe('failed')
    expect(first.parsed.result.stderr).toContain(`No title yet for ${SLUG}: a person writes it, then ${CLI} package build ${SLUG} --title "<your title>"`)
    expect(first.code).toBe(1)
    expect(existsSync(path.join(tmp, 'packages', SLUG, 'package.json'))).toBe(true)
    expect(JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'package.json'), 'utf8')).chosenTitle).toBe('')

    // The person writes it, then the stage re-runs `package build <slug>` and keeps it rather than choosing again.
    expect((await run(['package', 'build', SLUG, '--title', TITLE, '--offline'])).code).toBe(0)
    const { code, parsed } = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(parsed.result.stageId).toBe('packaging')
    const pkg = JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'package.json'), 'utf8'))
    expect(pkg.promise).toBe(PROMISE)
    expect(pkg.chosenTitle).toBe(TITLE)
    expect(pkg.titleSource).toBe('person')
    expect(pkg.gateReport.pass).toBe(true)
    expect(parsed.result.status).toBe('passed')
    expect(code).toBe(0)
  }, 90_000)

  it('prints a title command that, pasted as printed from another directory, lets the --root packaging stage pass', async () => {
    // The workflow runs from --root (scoped() passes tmp), which is not the directory the person types in
    // (npm run starts at the repository root), and shares its store and profile with the stage through
    // BOOSTER_DATA and BOOSTER_PROFILE.
    const root = tmp
    const elsewhere = path.join(tmp, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    await run(['workflow', IDEA, '--promise', PROMISE, '--out', path.join(root, 'packages')])
    await run(['workflow', 'run', SLUG, '--override', '--reason', 'demand confirmed', '--yes'])
    const first = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(first.parsed.result).toMatchObject({ stageId: 'packaging', status: 'failed' })
    const printed = new RegExp(`No title yet for [a-z0-9-]+: a person writes it, then (${CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} package build [^\\n]+)`).exec(first.parsed.result.stderr)?.[1]
    expect(printed).toBeDefined()
    expect(printed).toContain(`--root ${JSON.stringify(root)}`)

    // The person's shell has neither BOOSTER_DATA nor BOOSTER_PROFILE (the runner set both for its stage): the line stands alone.
    expect(printed).toContain(`--data ${JSON.stringify(data)} --path ${JSON.stringify(profile)}`)
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of ['ANTHROPIC_API_KEY', 'BOOSTER_DATA', 'BOOSTER_PROFILE']) delete env[k]
    const pasted = runPrinted(printed!, TITLE, elsewhere, env)
    expect(pasted.stdout, pasted.stderr).toContain('GATES PASS')
    expect(pasted.status).toBe(0)
    // The title landed where the stage gate reads it, not in a packages/ folder under the typing directory.
    expect(existsSync(path.join(elsewhere, 'packages'))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(root, 'packages', SLUG, 'package.json'), 'utf8'))).toMatchObject({ chosenTitle: TITLE, titleSource: 'person' })
    const second = await json(['workflow', 'run', SLUG, '--next', '--agent', 'runner-test'])
    expect(second.parsed.result).toMatchObject({ stageId: 'packaging', status: 'passed' })
    expect(second.code).toBe(0)
  }, 90_000)

  it('refuses a missing promise, an unknown bank id, a bad round count and a missing idea', async () => {
    expect(await fails(['package', 'build', IDEA, '--offline'])).toMatch(/--promise is required/)
    expect(await fails(['package', 'build', 'idea:nope', '--promise', PROMISE, '--offline'])).toMatch(/no idea "idea:nope" in the bank/)
    expect(await fails(['package', 'build', IDEA, '--promise', PROMISE, '--rounds', 'many', '--offline'])).toMatch(/--rounds must be a number/)
    expect(await fails(['package', 'build', IDEA, '--promise', PROMISE, '--predicted-ctr', 'double', '--offline'])).toMatch(/--predicted-ctr must be a number/)
    expect(await fails(['package', 'build'])).toMatch(/usage: booster package build/)
    expect(await fails(['package', 'nope'])).toMatch(/usage: booster package build/)
  })

  it('feeds the story and the shot list: hook score reads the package title and promise, plan shots reads both files', async () => {
    const built = await json(['package', 'build', IDEA, '--promise', PROMISE, '--title', TITLE, '--offline'])
    expect(built.parsed.chosenTitle).toBe(TITLE)
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
    expect(hook.err).toMatch(/story.json has no payoff ladder/)
    const empty = await json(['plan', 'shots', SLUG])
    expect(empty.code).toBe(0)
    expect(readFileSync(path.join(tmp, 'packages', SLUG, 'shots.md'), 'utf8')).toContain('No payoff moments in the story')
    // The retention map (ai retention-map --out) carries the ladder into story.json; then every payoff gets a shot.
    const payoffs = path.join(tmp, 'payoffs.json')
    writeFileSync(payoffs, JSON.stringify({ first_30_seconds_script: '..', payoff_ladder: [{ at: '0:45', moment: 'the fridge dies on day one' }, { at: '3:00', moment: 'the cabin runs on it' }, { at: 'later', moment: 'unparseable' }], rehooks: [], cuts: [], chapter_titles: [] }))
    const withLadder = await run(['hook', 'score', '--script', script, '--slug', SLUG, '--payoffs', payoffs])
    expect(withLadder.err).not.toMatch(/no payoff ladder/)
    const story = JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'story.json'), 'utf8'))
    expect(story.payoffLadder).toEqual([{ atSec: 45, moment: 'the fridge dies on day one' }, { atSec: 180, moment: 'the cabin runs on it' }])
    const shots = await json(['plan', 'shots', SLUG])
    expect(shots.code).toBe(0)
    expect(shots.parsed.title).toBe(built.parsed.chosenTitle)
    expect(shots.parsed.story).toBe(true)
    const md = readFileSync(path.join(tmp, 'packages', SLUG, 'shots.md'), 'utf8')
    expect(md).toContain('the fridge dies on day one')
    expect(md).not.toContain('No payoff moments')
    // The ladder survives a re-score without --payoffs; a bad file is refused.
    await run(['hook', 'score', '--script', script, '--slug', SLUG])
    expect(JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'story.json'), 'utf8')).payoffLadder.length).toBe(2)
    writeFileSync(payoffs, JSON.stringify({ cuts: [] }))
    expect(await fails(['hook', 'score', '--script', script, '--slug', SLUG, '--payoffs', payoffs])).toMatch(/has no payoff_ladder/)
    expect(await fails(['hook', 'score', '--script', script, '--slug', SLUG, '--payoffs', path.join(tmp, 'nope.json')])).toMatch(/--payoffs .* does not exist/)
  })
})
