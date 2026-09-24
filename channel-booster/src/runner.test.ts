import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeErr, writeOut } from './io.js'
import {
  applyStageResult, evaluateGate, findStage, nextRunnable, overrideStage, packageDir, resolveTsxCli, runNext, runStage, stageArgv, stageEnv, startWorkflow, toSpawnable,
  type RunBoosterFn, type SpawnFn, type StageResult,
} from './runner.js'
import { parseArgs } from '../cli/shared.js'
import { openStore, type Store } from './store.js'
import type { GatePredicate, Workflow } from './types.js'
import { generateWorkflow } from './workflow.js'

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'booster-runner-'))
  store = openStore(path.join(root, 'data'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A deterministic clock: every call advances one second from 2026-09-14T09:00:00Z. */
function clock(): () => Date {
  let t = Date.parse('2026-09-14T09:00:00Z')
  return () => {
    const d = new Date(t)
    t += 1000
    return d
  }
}
const NOW = new Date('2026-09-14T09:00:00Z')

function pkg(wf: Workflow): string {
  const dir = packageDir(root, wf.slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(path.join(dir, name), JSON.stringify(value))
}

/** A spawner that records calls (and the environment each got) and optionally writes an artifact the way the real command would. */
function fakeSpawn(record: string[][], options: { status?: number | null; write?: () => void; error?: Error; envs?: NodeJS.ProcessEnv[] } = {}): SpawnFn {
  return (command, args, { env }) => {
    record.push([command, ...args])
    options.envs?.push(env)
    options.write?.()
    return { status: options.status === undefined ? 0 : options.status, stdout: 'ok\n', stderr: '', error: options.error }
  }
}

/** A spawner for runs that must stay in this process: any call fails the test. */
const noSpawn: SpawnFn = (command, args) => {
  throw new Error(`spawned ${[command, ...args].join(' ')}; a booster stage with runBooster must run in-process`)
}

/** Stands in for main(): records its argv and the directory it ran from, writes what `write` says, prints and returns `code`. */
function fakeBooster(record: Array<{ argv: string[]; cwd: string }>, options: { code?: number; write?: (argv: string[]) => void; stdout?: string; stderr?: string } = {}): RunBoosterFn {
  return async (argv) => {
    record.push({ argv, cwd: process.cwd() })
    options.write?.(argv)
    if (options.stdout) writeOut(options.stdout)
    if (options.stderr) writeErr(options.stderr)
    return options.code ?? 0
  }
}

describe('evaluateGate', () => {
  let dir: string
  beforeEach(() => {
    dir = path.join(root, 'packages', 'x')
    mkdirSync(dir, { recursive: true })
  })

  it('checks file existence', () => {
    expect(evaluateGate({ kind: 'file-exists', path: 'shots.md' }, dir)).toMatchObject({ pass: false, detail: 'FAIL: shots.md is missing' })
    writeFileSync(path.join(dir, 'shots.md'), '# shots')
    expect(evaluateGate({ kind: 'file-exists', path: 'shots.md' }, dir)).toMatchObject({ pass: true, detail: 'ok: shots.md exists' })
  })

  it('checks a numeric minimum through a dotted path', () => {
    const check: GatePredicate = { kind: 'json-path-min', path: 'story.json', jsonPath: 'hookScore', min: 70 }
    expect(evaluateGate(check, dir).detail).toBe('FAIL: missing story.json')
    writeJson(dir, 'story.json', { hookScore: 64 })
    expect(evaluateGate(check, dir)).toMatchObject({ pass: false, detail: 'FAIL: story.json: hookScore 64 < 70' })
    writeJson(dir, 'story.json', { hookScore: 70 })
    expect(evaluateGate(check, dir)).toMatchObject({ pass: true, detail: 'ok: story.json: hookScore 70 >= 70' })
    writeJson(dir, 'story.json', { hookScore: '90' })
    expect(evaluateGate(check, dir)).toMatchObject({ pass: false, detail: 'FAIL: story.json: hookScore is not a number' })
    writeJson(dir, 'story.json', {})
    expect(evaluateGate(check, dir).detail).toBe('FAIL: story.json: hookScore is missing')
  })

  it('checks equality strictly, including nested paths, booleans, strings and array indices', () => {
    writeJson(dir, 'package.json', { gateReport: { pass: true }, titles: [{ score: 71 }], verdict: 'green' })
    expect(evaluateGate({ kind: 'json-path-eq', path: 'package.json', jsonPath: 'gateReport.pass', value: true }, dir).pass).toBe(true)
    expect(evaluateGate({ kind: 'json-path-eq', path: 'package.json', jsonPath: 'gateReport.pass', value: 'true' }, dir)).toMatchObject({ pass: false, detail: 'FAIL: package.json: gateReport.pass is true, expected "true"' })
    expect(evaluateGate({ kind: 'json-path-eq', path: 'package.json', jsonPath: 'verdict', value: 'green' }, dir).pass).toBe(true)
    expect(evaluateGate({ kind: 'json-path-eq', path: 'package.json', jsonPath: 'titles[0].score', value: 71 }, dir).pass).toBe(true)
    expect(evaluateGate({ kind: 'json-path-eq', path: 'package.json', jsonPath: 'missing', value: 1 }, dir).detail).toBe('FAIL: package.json: missing is missing, expected 1')
  })

  it('fails on malformed JSON without throwing', () => {
    writeFileSync(path.join(dir, 'story.json'), '{not json')
    expect(evaluateGate({ kind: 'json-path-min', path: 'story.json', jsonPath: 'hookScore', min: 1 }, dir)).toMatchObject({ pass: false, detail: 'FAIL: story.json is not valid JSON' })
  })

  it('all-of passes only when every check passes and lists failures first', () => {
    const check: GatePredicate = {
      kind: 'all-of',
      checks: [
        { kind: 'file-exists', path: 'thumb-A.png' },
        { kind: 'all-of', checks: [{ kind: 'file-exists', path: 'thumb-B.png' }, { kind: 'file-exists', path: 'proof-sheet.html' }] },
      ],
    }
    writeFileSync(path.join(dir, 'thumb-A.png'), 'png')
    const r = evaluateGate(check, dir)
    expect(r.pass).toBe(false)
    expect(r.checks).toHaveLength(3)
    expect(r.detail).toBe('FAIL: thumb-B.png is missing; FAIL: proof-sheet.html is missing; ok: thumb-A.png exists')
    writeFileSync(path.join(dir, 'thumb-B.png'), 'png')
    writeFileSync(path.join(dir, 'proof-sheet.html'), '<html>')
    expect(evaluateGate(check, dir).pass).toBe(true)
  })

  it('fails an absent predicate and says an override is the way through', () => {
    const r = evaluateGate(undefined, dir)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/override/)
    expect(r.checks).toEqual([])
  })
})

// Stage commands are stored as `booster <verb> ..` now (they were `npm run booster -- <verb> ..`),
// and runStage is async because a booster stage may run in this process: every expectation below
// that names a command uses the neutral form, and every call awaits.
describe('runStage', () => {
  const wf = generateWorkflow('I tried 30 days of cold showers')

  it('dry-runs a command stage: resolved argv, nothing spawned, gate still read', async () => {
    const calls: string[][] = []
    const r = await runStage(wf, 'packaging', { cwd: root, agent: 'claude', dryRun: true, now: clock(), spawn: fakeSpawn(calls) })
    expect(calls).toEqual([])
    expect(r).toMatchObject({ stageId: 'packaging', kind: 'command', dryRun: true, status: 'dry-run', agent: 'claude', startedAt: '2026-09-14T09:00:00.000Z', finishedAt: '2026-09-14T09:00:01.000Z' })
    expect(r.command).toEqual(['booster', 'package', 'build', 'i-tried-30-days-of-cold-showers'])
    expect(r.gate.pass).toBe(false)
    expect(r.exitCode).toBeUndefined()
  })

  it('spawns the resolved command from cwd when no runBooster is given, and passes when the exit code is 0 and the artifact satisfies the gate', async () => {
    const dir = pkg(wf)
    const calls: string[][] = []
    const spawn = fakeSpawn(calls, { write: () => { writeJson(dir, 'package.json', { gateReport: { pass: true } }); writeFileSync(path.join(dir, 'package.md'), '# package') } })
    const r = await runStage(wf, 'packaging', { cwd: root, agent: 'claude', now: clock(), spawn })
    expect(calls).toEqual([['booster', 'package', 'build', 'i-tried-30-days-of-cold-showers']])
    expect(r.status).toBe('passed')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('ok\n')
    expect(r.gate.detail).toBe('ok: package.json: gateReport.pass is true; ok: package.md exists')
  })

  it('fails when the command exits non-zero even if the artifact looks fine', async () => {
    const dir = pkg(wf)
    writeJson(dir, 'package.json', { gateReport: { pass: true } })
    writeFileSync(path.join(dir, 'package.md'), '#')
    const r = await runStage(wf, 'packaging', { cwd: root, now: clock(), spawn: fakeSpawn([], { status: 2 }) })
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(2)
    expect(r.gate.pass).toBe(false)
    expect(r.gate.detail).toMatch(/^FAIL: command exited 2; ok: package.json/)
  })

  it('fails when the command cannot start', async () => {
    const r = await runStage(wf, 'demand', { cwd: root, now: clock(), spawn: fakeSpawn([], { status: null, error: new Error('ENOENT') }) })
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(-1)
    expect(r.gate.detail).toMatch(/could not start booster \(ENOENT\)/)
  })

  it('fails when the command succeeded but the gate does not hold, and says which check', async () => {
    const dir = pkg(wf)
    const spawn = fakeSpawn([], { write: () => writeJson(dir, 'story.json', { hookScore: 55, promiseInFirst25Words: false }) })
    const r = await runStage(wf, 'story', { cwd: root, now: clock(), spawn })
    expect(r.status).toBe('failed')
    expect(r.gate.detail).toBe('FAIL: story.json: hookScore 55 < 70; FAIL: story.json: promiseInFirst25Words is false, expected true')
  })

  it('runs the publish checklist with the confirmation it needs, so the stage passes on the file it just wrote', async () => {
    const dir = pkg(wf)
    const calls: string[][] = []
    const spawn = fakeSpawn(calls, { write: () => { writeFileSync(path.join(dir, 'publish.md'), '# publish'); writeJson(dir, 'publish-check.json', { pass: true }) } })
    const r = await runStage(wf, 'publish', { cwd: root, now: clock(), spawn })
    expect(calls).toEqual([['booster', 'publish', 'check', 'i-tried-30-days-of-cold-showers', '--review-scheduled']])
    expect(r.status).toBe('passed')
    expect(r.gate.detail).toBe('ok: publish.md exists; ok: publish-check.json: pass is true')
  })

  it('runs any other command as a real process with node:child_process, even when runBooster is given', async () => {
    const dir = pkg(wf)
    const custom: Workflow = {
      ...wf,
      stages: wf.stages.map((s) => (s.id === 'demand'
        ? { ...s, run: { kind: 'command', artifact: 'demand.json', command: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify({verdict:"green",status:"green"}))', path.join(dir, 'demand.json')] } }
        : s)),
    }
    const booster: Array<{ argv: string[]; cwd: string }> = []
    const r = await runStage(custom, 'demand', { cwd: root, now: clock(), runBooster: fakeBooster(booster) })
    expect(r.exitCode).toBe(0)
    expect(r.status).toBe('passed')
    expect(r.gate.detail).toBe('ok: demand.json: verdict is "green"; ok: demand.json: status is "green"')
    expect(booster).toEqual([])
    const bad = await runStage({ ...custom, stages: custom.stages.map((s) => (s.id === 'demand' ? { ...s, run: { kind: 'command', artifact: 'x', command: [process.execPath, '-e', 'process.exit(3)'] } } : s)) }, 'demand', { cwd: root, now: clock() })
    expect(bad.exitCode).toBe(3)
    expect(bad.status).toBe('failed')
  })

  it('checks the evidence file for a human stage and never spawns', async () => {
    const calls: string[][] = []
    const before = await runStage(wf, 'production', { cwd: root, agent: 'jony', now: clock(), spawn: fakeSpawn(calls) })
    expect(before).toMatchObject({ kind: 'human', evidence: 'footage.txt', status: 'failed', dryRun: false })
    expect(before.gate.detail).toMatch(/^FAIL: evidence file packages\/i-tried-30-days-of-cold-showers\/footage.txt is missing/)
    writeFileSync(path.join(pkg(wf), 'footage.txt'), 'shot list covered; thumbnail photos at the peak moment')
    const after = await runStage(wf, 'production', { cwd: root, agent: 'jony', now: clock(), spawn: fakeSpawn(calls) })
    expect(after.status).toBe('passed')
    expect(after.gate.detail).toBe('ok: footage.txt exists')
    expect(calls).toEqual([])
    expect((await runStage(wf, 'production', { cwd: root, dryRun: true, now: clock() })).status).toBe('dry-run')
  })

  it('treats a stage without a run as a human stage with only its check', async () => {
    const custom: Workflow = { ...wf, stages: wf.stages.map((s) => (s.id === 'plan' ? { ...s, run: undefined } : s)) }
    writeFileSync(path.join(pkg(wf), 'shots.md'), 'x')
    writeJson(pkg(wf), 'story.json', { payoffLadder: [{ atSec: 45, moment: 'the light comes on' }] })
    const r = await runStage(custom, 'plan', { cwd: root, now: clock() })
    expect(r).toMatchObject({ kind: 'human', evidence: undefined, status: 'passed' })
  })

  it('refuses an unknown stage and a command stage without a command', async () => {
    await expect(runStage(wf, 'nope', { cwd: root })).rejects.toThrow(/no stage "nope"/)
    expect(() => findStage(wf, 'nope')).toThrow(/stages: demand, packaging/)
    const custom: Workflow = { ...wf, stages: wf.stages.map((s) => (s.id === 'demand' ? { ...s, run: { kind: 'command', artifact: 'x' } } : s)) }
    await expect(runStage(custom, 'demand', { cwd: root })).rejects.toThrow(/no command/)
  })
})

describe('runStage in this process', () => {
  const wf = generateWorkflow('I tried 30 days of cold showers')
  const slug = 'i-tried-30-days-of-cold-showers'
  const locations = { data: '/ch/data', profile: '/ch/channel.json', workspace: '/ch', now: '2026-09-14T09:00:00.000Z' }

  it('runs a booster stage through runBooster from the packages root, with the run\'s locations before its own flags and --root after them, and spawns nothing', async () => {
    const calls: Array<{ argv: string[]; cwd: string }> = []
    const before = process.cwd()
    // The command's --out is relative, as the runbook stores it: it must land under the root the gate reads.
    const runBooster = fakeBooster(calls, {
      write: (argv) => {
        const out = argv[argv.indexOf('--out') + 1]
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify({ verdict: 'green', status: 'green' }))
      },
    })
    const r = await runStage(wf, 'demand', { cwd: root, agent: 'claude', now: clock(), runBooster, spawn: noSpawn, locations })
    expect(calls.map((c) => c.argv)).toEqual([[
      '--data', '/ch/data', '--path', '/ch/channel.json', '--workspace', '/ch', '--now', '2026-09-14T09:00:00.000Z',
      'idea', 'score', slug, '--out', `packages/${slug}/demand.json`, '--root', root,
    ]])
    expect(realpathSync(calls[0].cwd)).toBe(realpathSync(root))
    expect(process.cwd()).toBe(before)
    expect(r).toMatchObject({ stageId: 'demand', kind: 'command', command: ['booster', 'idea', 'score', slug, '--out', `packages/${slug}/demand.json`], exitCode: 0, status: 'passed', agent: 'claude' })
    expect(r.gate.detail).toBe('ok: demand.json: verdict is "green"; ok: demand.json: status is "green"')
  })

  it('records the stage\'s stdout and stderr and its exit code, as a child process\'s were', async () => {
    const runBooster = fakeBooster([], { code: 1, stdout: 'Package · x · GATES FAIL\n', stderr: 'No title yet for x: a person writes it\n' })
    const r = await runStage(wf, 'packaging', { cwd: root, now: clock(), runBooster, spawn: noSpawn })
    expect(r).toMatchObject({ exitCode: 1, stdout: 'Package · x · GATES FAIL\n', stderr: 'No title yet for x: a person writes it\n', status: 'failed' })
    expect(r.gate.detail).toMatch(/^FAIL: command exited 1; FAIL: missing package.json/)
  })

  it('records a stage that throws as exit 1 with the line the command line prints for it, and returns to the working directory', async () => {
    const before = process.cwd()
    const runBooster: RunBoosterFn = async () => {
      writeErr('reading the bank\n')
      throw new Error('no idea "idea:nope" in the bank')
    }
    const r = await runStage(wf, 'demand', { cwd: root, now: clock(), runBooster, spawn: noSpawn })
    expect(r).toMatchObject({ exitCode: 1, stdout: '', stderr: 'reading the bank\nbooster: no idea "idea:nope" in the bank\n', status: 'failed' })
    expect(r.gate.detail).toMatch(/^FAIL: command exited 1; /)
    expect(process.cwd()).toBe(before)
  })

  it('fails as a stage that could not start when the packages root does not exist, and runs nothing', async () => {
    const calls: Array<{ argv: string[]; cwd: string }> = []
    const r = await runStage(wf, 'packaging', { cwd: path.join(root, 'missing'), now: clock(), runBooster: fakeBooster(calls), spawn: noSpawn })
    expect(calls).toEqual([])
    expect(r).toMatchObject({ exitCode: -1, status: 'failed' })
    expect(r.gate.detail).toMatch(/^FAIL: could not start booster \(ENOENT/)
  })

  it('gives a stage with no locations only --root, so an old runbook resolves the rest as it always did', async () => {
    const calls: Array<{ argv: string[]; cwd: string }> = []
    await runStage(wf, 'plan', { cwd: root, now: clock(), runBooster: fakeBooster(calls), spawn: noSpawn })
    expect(calls[0].argv).toEqual(['plan', 'shots', slug, '--format', 'talking-head', '--root', root])
  })

  it('runs a command stored with the legacy `npm run booster --` prefix exactly like the neutral one', async () => {
    const legacy: Workflow = {
      ...wf,
      stages: wf.stages.map((s) => (s.run?.kind === 'command' ? { ...s, run: { ...s.run, command: ['npm', 'run', 'booster', '--', ...s.run.command!.slice(1)] } } : s)),
    }
    expect(legacy.stages[0].run!.command!.slice(0, 5)).toEqual(['npm', 'run', 'booster', '--', 'idea'])
    const write = () => writeJson(pkg(wf), 'demand.json', { verdict: 'green', status: 'banked' })
    const neutralCalls: Array<{ argv: string[]; cwd: string }> = []
    const legacyCalls: Array<{ argv: string[]; cwd: string }> = []
    const neutral = await runStage(wf, 'demand', { cwd: root, agent: 'claude', now: clock(), runBooster: fakeBooster(neutralCalls, { write, stdout: 'scored\n' }), spawn: noSpawn, locations })
    const old = await runStage(legacy, 'demand', { cwd: root, agent: 'claude', now: clock(), runBooster: fakeBooster(legacyCalls, { write, stdout: 'scored\n' }), spawn: noSpawn, locations })
    expect(old).toEqual(neutral)
    expect(old.command![0]).toBe('booster')
    expect(legacyCalls.map((c) => c.argv)).toEqual(neutralCalls.map((c) => c.argv))
    // Isolated, the legacy command is spawned as the same neutral argv too.
    const spawned: string[][] = []
    await runStage(legacy, 'demand', { cwd: root, now: clock(), isolate: true, spawn: fakeSpawn(spawned) })
    expect(spawned).toEqual([['booster', 'idea', 'score', slug, '--out', `packages/${slug}/demand.json`]])
  })

  it('--isolate spawns the booster stage even when runBooster is given, and hands it the locations through the environment', async () => {
    const booster: Array<{ argv: string[]; cwd: string }> = []
    const calls: string[][] = []
    const envs: NodeJS.ProcessEnv[] = []
    const r = await runStage(wf, 'packaging', { cwd: root, now: clock(), runBooster: fakeBooster(booster), isolate: true, spawn: fakeSpawn(calls, { envs }), locations, env: { PATH: '/bin' } })
    expect(booster).toEqual([])
    expect(calls).toEqual([['booster', 'package', 'build', slug]])
    expect(envs[0]).toEqual({ PATH: '/bin', BOOSTER_DATA: '/ch/data', BOOSTER_PROFILE: '/ch/channel.json', BOOSTER_HOME: '/ch', BOOSTER_NOW: '2026-09-14T09:00:00.000Z' })
    expect(r).toMatchObject({ exitCode: 0, stdout: 'ok\n' })
  })
})

describe('stageArgv and stageEnv', () => {
  it('put only the locations the run has in front of the stage\'s own arguments, and --root always last', () => {
    expect(stageArgv(['plan', 'shots', 'x'], '/r')).toEqual(['plan', 'shots', 'x', '--root', '/r'])
    expect(stageArgv(['plan', 'shots', 'x'], '/r', { data: '/d', now: '2026-09-14T09:00:00.000Z' })).toEqual(['--data', '/d', '--now', '2026-09-14T09:00:00.000Z', 'plan', 'shots', 'x', '--root', '/r'])
  })

  it('let a location the stored command names itself win, as it does over the environment a spawned stage gets, and never its --root', () => {
    const locations = { data: '/run/data', profile: '/run/channel.json', workspace: '/run', now: '2026-09-14T09:00:00.000Z' }
    const own = ['idea', 'score', 'x', '--data', '/own/data', '--path', '/own/channel.json', '--workspace', '/own', '--now', '2026-01-01T00:00:00.000Z', '--root', '/own/root']
    const { positional, flags } = parseArgs(stageArgv(own, '/r', locations))
    expect(positional).toEqual(['idea', 'score', 'x'])
    expect(flags).toEqual({ data: '/own/data', path: '/own/channel.json', workspace: '/own', now: '2026-01-01T00:00:00.000Z', root: '/r' })
    // A stage that names none of them gets the run's.
    expect(parseArgs(stageArgv(['idea', 'score', 'x'], '/r', locations)).flags).toEqual({ data: '/run/data', path: '/run/channel.json', workspace: '/run', now: '2026-09-14T09:00:00.000Z', root: '/r' })
  })

  it('add no clock and no workspace to a spawned stage\'s environment unless the run has them, and never change the base', () => {
    const base = { PATH: '/bin', BOOSTER_NOW: '2026-01-01T00:00:00Z' }
    expect(stageEnv(base, { data: '/d', profile: '/p.json' })).toEqual({ PATH: '/bin', BOOSTER_NOW: '2026-01-01T00:00:00Z', BOOSTER_DATA: '/d', BOOSTER_PROFILE: '/p.json' })
    expect(stageEnv(base)).toEqual(base)
    expect(base).toEqual({ PATH: '/bin', BOOSTER_NOW: '2026-01-01T00:00:00Z' })
  })
})

describe('workflow status in the store', () => {
  const wf = generateWorkflow('Test idea')

  function passed(stageId: string, at = '2026-09-14T09:00:00.000Z'): StageResult {
    return { stageId, kind: 'command', dryRun: false, exitCode: 0, gate: { pass: true, detail: 'ok: x', checks: [] }, status: 'passed', startedAt: at, finishedAt: at, agent: 'claude' }
  }

  it('startWorkflow creates the document once and never resets progress', () => {
    const doc = startWorkflow(store, wf, NOW)
    expect(doc.id).toBe('test-idea')
    expect(store.read('workflows')).toHaveLength(1)
    expect(nextRunnable(doc)).toBe('demand')
    applyStageResult(store, wf.slug, 'demand', passed('demand'), NOW)
    const again = startWorkflow(store, wf, new Date('2026-09-15T09:00:00Z'))
    expect(again.stages[0].status).toBe('passed')
    expect(again.updatedAt).toBe('2026-09-14T09:00:00.000Z')
  })

  it('applyStageResult records status, timestamps, gate detail and agent, and validates the document', () => {
    startWorkflow(store, wf, NOW)
    const failed: StageResult = { ...passed('demand'), status: 'failed', exitCode: 1, gate: { pass: false, detail: 'FAIL: demand.json: verdict is "yellow", expected "green"', checks: [] } }
    const doc = applyStageResult(store, wf.slug, 'demand', failed, new Date('2026-09-14T10:00:00Z'))
    expect(doc.stages[0]).toEqual({ id: 'demand', status: 'failed', startedAt: '2026-09-14T09:00:00.000Z', finishedAt: '2026-09-14T09:00:00.000Z', gateResult: 'FAIL: demand.json: verdict is "yellow", expected "green"', agent: 'claude' })
    expect(doc.updatedAt).toBe('2026-09-14T10:00:00.000Z')
    expect(nextRunnable(doc)).toBe('demand')
    expect(store.get('workflows', wf.slug)!.stages[0].status).toBe('failed')
    const ok = applyStageResult(store, wf.slug, 'demand', passed('demand', '2026-09-14T11:00:00.000Z'), new Date('2026-09-14T11:00:00Z'))
    expect(ok.stages[0].status).toBe('passed')
    expect(nextRunnable(ok)).toBe('packaging')
  })

  it('refuses dry-run results, mismatched stage ids, unknown workflows and out-of-order stages', () => {
    // From source the hint is typed `npm run booster --` (cliName); it names no --out, which only the runbook needs.
    expect(() => applyStageResult(store, wf.slug, 'demand', passed('demand'), NOW)).toThrow('no workflow status for "test-idea". Create it first: npm run booster -- workflow "<idea>" (startWorkflow)')
    startWorkflow(store, wf, NOW)
    expect(() => applyStageResult(store, wf.slug, 'demand', { ...passed('demand'), dryRun: true, status: 'dry-run' }, NOW)).toThrow(/dry run records nothing/)
    expect(() => applyStageResult(store, wf.slug, 'packaging', passed('demand'), NOW)).toThrow(/result is for stage "demand"/)
    expect(() => applyStageResult(store, wf.slug, 'story', passed('story'), NOW)).toThrow(/"story" is not runnable: "demand" is pending/)
    expect(store.get('workflows', wf.slug)!.stages.every((s) => s.status === 'pending')).toBe(true)
  })

  it('overrideStage needs a reason, respects order, records who and why, and unblocks the next stage', () => {
    startWorkflow(store, wf, NOW)
    expect(() => overrideStage(store, wf.slug, 'demand', '  ', 'jony', NOW)).toThrow(/written reason/)
    expect(() => overrideStage(store, wf.slug, 'story', 'skip', 'jony', NOW)).toThrow(/not runnable/)
    applyStageResult(store, wf.slug, 'demand', { ...passed('demand'), status: 'failed', gate: { pass: false, detail: 'FAIL: verdict yellow', checks: [] } }, NOW)
    const doc = overrideStage(store, wf.slug, 'demand', 'yellow with the fix applied: angle rewritten', 'jony', new Date('2026-09-14T12:00:00Z'))
    expect(doc.stages[0]).toMatchObject({ status: 'overridden', overrideReason: 'yellow with the fix applied: angle rewritten', agent: 'jony', finishedAt: '2026-09-14T12:00:00.000Z', gateResult: 'FAIL: verdict yellow' })
    expect(nextRunnable(doc)).toBe('packaging')
    const pending = overrideStage(store, wf.slug, 'packaging', 'reviewed on paper', 'jony', NOW)
    expect(pending.stages[1]).toMatchObject({ status: 'overridden', gateResult: 'overridden without a machine check', startedAt: '2026-09-14T09:00:00.000Z' })
    expect(() => overrideStage(store, wf.slug, 'packaging', 'again', 'jony', NOW)).not.toThrow()
    applyStageResult(store, wf.slug, 'story', passed('story'), NOW)
    expect(() => overrideStage(store, wf.slug, 'story', 'x', 'jony', NOW)).toThrow(/already passed/)
  })

  it('a passed result clears an earlier override reason', () => {
    startWorkflow(store, wf, NOW)
    overrideStage(store, wf.slug, 'demand', 'first pass', 'jony', NOW)
    const doc = applyStageResult(store, wf.slug, 'demand', passed('demand'), NOW)
    expect(doc.stages[0].overrideReason).toBeUndefined()
    expect(store.get('workflows', wf.slug)!.stages[0].overrideReason).toBeUndefined()
  })
})

describe('runNext', () => {
  const wf = generateWorkflow('Test idea')

  it('runs the next stage, records it, and stops at the first failure', async () => {
    const dir = pkg(wf)
    const calls: string[][] = []
    // A green score the person has not approved: the second half of the demand gate holds it.
    const spawn = fakeSpawn(calls, { write: () => writeJson(dir, 'demand.json', { verdict: 'green', status: 'banked' }) })
    const first = await runNext(store, wf, { cwd: root, agent: 'claude', now: clock(), spawn })
    expect(first.done).toBe(false)
    expect(first.result!.stageId).toBe('demand')
    expect(first.result!.status).toBe('failed')
    expect(first.result!.gate.detail).toBe('FAIL: demand.json: status is "banked", expected one of "green", "packaging", "production", "published"; ok: demand.json: verdict is "green"')
    expect(first.status.stages[0].status).toBe('failed')
    const second = await runNext(store, wf, { cwd: root, agent: 'claude', now: clock(), spawn })
    expect(second.result!.stageId).toBe('demand')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['booster', 'idea', 'score', 'test-idea', '--out', 'packages/test-idea/demand.json'])
  })

  it('advances after a pass and reports done when nothing is left', async () => {
    const dir = pkg(wf)
    const spawn = fakeSpawn([], { write: () => writeJson(dir, 'demand.json', { verdict: 'green', status: 'green' }) })
    expect((await runNext(store, wf, { cwd: root, now: clock(), spawn })).result!.status).toBe('passed')
    expect(nextRunnable(store.get('workflows', wf.slug)!)).toBe('packaging')
    const dry = await runNext(store, wf, { cwd: root, now: clock(), spawn, dryRun: true })
    expect(dry.result!.status).toBe('dry-run')
    expect(store.get('workflows', wf.slug)!.stages[1].status).toBe('pending')
    let doc = store.get('workflows', wf.slug)!
    for (const s of doc.stages) if (s.status !== 'passed') doc = overrideStage(store, wf.slug, s.id, 'test', 'jony', NOW)
    const end = await runNext(store, wf, { cwd: root, now: clock(), spawn })
    expect(end.done).toBe(true)
    expect(end.result).toBeUndefined()
  })

  it('runs the next booster stage in this process and records its result', async () => {
    const dir = pkg(wf)
    const calls: Array<{ argv: string[]; cwd: string }> = []
    const runBooster = fakeBooster(calls, { write: () => writeJson(dir, 'demand.json', { verdict: 'green', status: 'green' }), stdout: 'scored\n' })
    const r = await runNext(store, wf, { cwd: root, agent: 'claude', now: clock(), runBooster, spawn: noSpawn })
    expect(calls).toHaveLength(1)
    expect(r.result).toMatchObject({ stageId: 'demand', status: 'passed', stdout: 'scored\n' })
    expect(r.status.stages[0]).toMatchObject({ status: 'passed', agent: 'claude' })
  })
})

describe('toSpawnable', () => {
  it('runs a booster stage as the command line by absolute path with --root, from either prefix, and leaves other commands alone', () => {
    const booster = toSpawnable('booster', ['package', 'build', 'my-slug'], '/tmp/somewhere', false)
    expect(booster.file).toBe(process.execPath)
    expect(booster.args.slice(0, 2).map((a) => a.replace(/\\/g, '/'))).toEqual([expect.stringMatching(/node_modules\/tsx\/dist\/cli\.mjs$/), expect.stringMatching(/channel-booster\/cli\/booster\.ts$/)])
    expect(booster.args.slice(2)).toEqual(['package', 'build', 'my-slug', '--root', '/tmp/somewhere'])
    expect(toSpawnable('npm', ['run', 'booster', '--', 'package', 'build', 'my-slug'], '/tmp/somewhere', false)).toEqual(booster)
    expect(toSpawnable('node', ['-e', 'process.exit(0)'], '/tmp')).toEqual({ file: 'node', args: ['-e', 'process.exit(0)'] })
    expect(toSpawnable('npm', ['run'], '/tmp')).toEqual({ file: 'npm', args: ['run'] })
  })

  it('spawns the packaged bin itself for a booster stage inside the bundle', () => {
    expect(toSpawnable('booster', ['plan', 'shots', 'my-slug'], '/tmp/r', true)).toEqual({ file: process.execPath, args: [process.argv[1], 'plan', 'shots', 'my-slug', '--root', '/tmp/r'] })
  })

  it('finds tsx wherever node resolves it, and falls back to the repository\'s node_modules', () => {
    expect(resolveTsxCli((id) => `/hoisted/node_modules/${id === 'tsx/cli' ? 'tsx/dist/cli.mjs' : id}`)).toBe('/hoisted/node_modules/tsx/dist/cli.mjs')
    const fallback = resolveTsxCli(() => {
      throw new Error('Cannot find module tsx/cli')
    })
    expect(fallback.replace(/\\/g, '/')).toMatch(/\/node_modules\/tsx\/dist\/cli\.mjs$/)
    expect(path.isAbsolute(fallback)).toBe(true)
    expect(resolveTsxCli().replace(/\\/g, '/')).toMatch(/\/tsx\/dist\/cli\.mjs$/)
  })
})

describe('runStage inside the packaged bundle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('records a stage that throws signed with the bin\'s name, as the bin prints it and an isolated stage records it', async () => {
    // The bundle defines __BOOSTER_BUNDLED__ (src/build-info.ts); a fresh import reads it.
    vi.stubGlobal('__BOOSTER_BUNDLED__', true)
    vi.resetModules()
    const bundled = await import('./runner.js')
    const runBooster: RunBoosterFn = async () => {
      throw new Error('unknown command "nosuchcommand". Run channel-booster help.')
    }
    const r = await bundled.runStage(generateWorkflow('I tried 30 days of cold showers'), 'demand', { cwd: root, now: clock(), runBooster, spawn: noSpawn })
    expect(r).toMatchObject({ exitCode: 1, stderr: 'channel-booster: unknown command "nosuchcommand". Run channel-booster help.\n', status: 'failed' })
  })
})
