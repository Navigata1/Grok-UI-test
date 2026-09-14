import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyStageResult, evaluateGate, findStage, nextRunnable, overrideStage, packageDir, runNext, runStage, startWorkflow, toSpawnable, type SpawnFn, type StageResult } from './runner.js'
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

/** A spawner that records calls and optionally writes an artifact the way the real command would. */
function fakeSpawn(record: string[][], options: { status?: number | null; write?: () => void; error?: Error } = {}): SpawnFn {
  return (command, args) => {
    record.push([command, ...args])
    options.write?.()
    return { status: options.status === undefined ? 0 : options.status, stdout: 'ok\n', stderr: '', error: options.error }
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

describe('runStage', () => {
  const wf = generateWorkflow('I tried 30 days of cold showers')

  it('dry-runs a command stage: resolved argv, nothing spawned, gate still read', () => {
    const calls: string[][] = []
    const r = runStage(wf, 'packaging', { cwd: root, agent: 'claude', dryRun: true, now: clock(), spawn: fakeSpawn(calls) })
    expect(calls).toEqual([])
    expect(r).toMatchObject({ stageId: 'packaging', kind: 'command', dryRun: true, status: 'dry-run', agent: 'claude', startedAt: '2026-09-14T09:00:00.000Z', finishedAt: '2026-09-14T09:00:01.000Z' })
    expect(r.command).toEqual(['npm', 'run', 'booster', '--', 'package', 'build', 'i-tried-30-days-of-cold-showers'])
    expect(r.gate.pass).toBe(false)
    expect(r.exitCode).toBeUndefined()
  })

  it('spawns the resolved command from cwd and passes when the exit code is 0 and the artifact satisfies the gate', () => {
    const dir = pkg(wf)
    const calls: string[][] = []
    const spawn = fakeSpawn(calls, { write: () => { writeJson(dir, 'package.json', { gateReport: { pass: true } }); writeFileSync(path.join(dir, 'package.md'), '# package') } })
    const r = runStage(wf, 'packaging', { cwd: root, agent: 'claude', now: clock(), spawn })
    expect(calls).toEqual([['npm', 'run', 'booster', '--', 'package', 'build', 'i-tried-30-days-of-cold-showers']])
    expect(r.status).toBe('passed')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('ok\n')
    expect(r.gate.detail).toBe('ok: package.json: gateReport.pass is true; ok: package.md exists')
  })

  it('fails when the command exits non-zero even if the artifact looks fine', () => {
    const dir = pkg(wf)
    writeJson(dir, 'package.json', { gateReport: { pass: true } })
    writeFileSync(path.join(dir, 'package.md'), '#')
    const r = runStage(wf, 'packaging', { cwd: root, now: clock(), spawn: fakeSpawn([], { status: 2 }) })
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(2)
    expect(r.gate.pass).toBe(false)
    expect(r.gate.detail).toMatch(/^FAIL: command exited 2; ok: package.json/)
  })

  it('fails when the command cannot start', () => {
    const r = runStage(wf, 'demand', { cwd: root, now: clock(), spawn: fakeSpawn([], { status: null, error: new Error('ENOENT') }) })
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(-1)
    expect(r.gate.detail).toMatch(/could not start npm \(ENOENT\)/)
  })

  it('fails when the command succeeded but the gate does not hold, and says which check', () => {
    const dir = pkg(wf)
    const spawn = fakeSpawn([], { write: () => writeJson(dir, 'story.json', { hookScore: 55, promiseInFirst25Words: false }) })
    const r = runStage(wf, 'story', { cwd: root, now: clock(), spawn })
    expect(r.status).toBe('failed')
    expect(r.gate.detail).toBe('FAIL: story.json: hookScore 55 < 70; FAIL: story.json: promiseInFirst25Words is false, expected true')
  })

  it('runs the publish checklist with the confirmation it needs, so the stage passes on the file it just wrote', () => {
    const dir = pkg(wf)
    const calls: string[][] = []
    const spawn = fakeSpawn(calls, { write: () => { writeFileSync(path.join(dir, 'publish.md'), '# publish'); writeJson(dir, 'publish-check.json', { pass: true }) } })
    const r = runStage(wf, 'publish', { cwd: root, now: clock(), spawn })
    expect(calls).toEqual([['npm', 'run', 'booster', '--', 'publish', 'check', 'i-tried-30-days-of-cold-showers', '--review-scheduled']])
    expect(r.status).toBe('passed')
    expect(r.gate.detail).toBe('ok: publish.md exists; ok: publish-check.json: pass is true')
  })

  it('runs a real process with node:child_process when no spawner is injected', () => {
    const dir = pkg(wf)
    const custom: Workflow = {
      ...wf,
      stages: wf.stages.map((s) => (s.id === 'demand'
        ? { ...s, run: { kind: 'command', artifact: 'demand.json', command: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify({verdict:"green",status:"green"}))', path.join(dir, 'demand.json')] } }
        : s)),
    }
    const r = runStage(custom, 'demand', { cwd: root, now: clock() })
    expect(r.exitCode).toBe(0)
    expect(r.status).toBe('passed')
    expect(r.gate.detail).toBe('ok: demand.json: verdict is "green"; ok: demand.json: status is "green"')
    const bad = runStage({ ...custom, stages: custom.stages.map((s) => (s.id === 'demand' ? { ...s, run: { kind: 'command', artifact: 'x', command: [process.execPath, '-e', 'process.exit(3)'] } } : s)) }, 'demand', { cwd: root, now: clock() })
    expect(bad.exitCode).toBe(3)
    expect(bad.status).toBe('failed')
  })

  it('checks the evidence file for a human stage and never spawns', () => {
    const calls: string[][] = []
    const before = runStage(wf, 'production', { cwd: root, agent: 'jony', now: clock(), spawn: fakeSpawn(calls) })
    expect(before).toMatchObject({ kind: 'human', evidence: 'footage.txt', status: 'failed', dryRun: false })
    expect(before.gate.detail).toMatch(/^FAIL: evidence file packages\/i-tried-30-days-of-cold-showers\/footage.txt is missing/)
    writeFileSync(path.join(pkg(wf), 'footage.txt'), 'shot list covered; thumbnail photos at the peak moment')
    const after = runStage(wf, 'production', { cwd: root, agent: 'jony', now: clock(), spawn: fakeSpawn(calls) })
    expect(after.status).toBe('passed')
    expect(after.gate.detail).toBe('ok: footage.txt exists')
    expect(calls).toEqual([])
    expect(runStage(wf, 'production', { cwd: root, dryRun: true, now: clock() }).status).toBe('dry-run')
  })

  it('treats a stage without a run as a human stage with only its check', () => {
    const custom: Workflow = { ...wf, stages: wf.stages.map((s) => (s.id === 'plan' ? { ...s, run: undefined } : s)) }
    writeFileSync(path.join(pkg(wf), 'shots.md'), 'x')
    const r = runStage(custom, 'plan', { cwd: root, now: clock() })
    expect(r).toMatchObject({ kind: 'human', evidence: undefined, status: 'passed' })
  })

  it('refuses an unknown stage and a command stage without a command', () => {
    expect(() => runStage(wf, 'nope', { cwd: root })).toThrow(/no stage "nope"/)
    expect(() => findStage(wf, 'nope')).toThrow(/stages: demand, packaging/)
    const custom: Workflow = { ...wf, stages: wf.stages.map((s) => (s.id === 'demand' ? { ...s, run: { kind: 'command', artifact: 'x' } } : s)) }
    expect(() => runStage(custom, 'demand', { cwd: root })).toThrow(/no command/)
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
    expect(() => applyStageResult(store, wf.slug, 'demand', passed('demand'), NOW)).toThrow(/no workflow status for "test-idea"/)
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

  it('runs the next stage, records it, and stops at the first failure', () => {
    const dir = pkg(wf)
    const calls: string[][] = []
    // A green score the person has not approved: the second half of the demand gate holds it.
    const spawn = fakeSpawn(calls, { write: () => writeJson(dir, 'demand.json', { verdict: 'green', status: 'banked' }) })
    const first = runNext(store, wf, { cwd: root, agent: 'claude', now: clock(), spawn })
    expect(first.done).toBe(false)
    expect(first.result!.stageId).toBe('demand')
    expect(first.result!.status).toBe('failed')
    expect(first.result!.gate.detail).toBe('FAIL: demand.json: status is "banked", expected "green"; ok: demand.json: verdict is "green"')
    expect(first.status.stages[0].status).toBe('failed')
    const second = runNext(store, wf, { cwd: root, agent: 'claude', now: clock(), spawn })
    expect(second.result!.stageId).toBe('demand')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['npm', 'run', 'booster', '--', 'idea', 'score', 'test-idea', '--out', 'packages/test-idea/demand.json'])
  })

  it('advances after a pass and reports done when nothing is left', () => {
    const dir = pkg(wf)
    const spawn = fakeSpawn([], { write: () => writeJson(dir, 'demand.json', { verdict: 'green', status: 'green' }) })
    expect(runNext(store, wf, { cwd: root, now: clock(), spawn }).result!.status).toBe('passed')
    expect(nextRunnable(store.get('workflows', wf.slug)!)).toBe('packaging')
    const dry = runNext(store, wf, { cwd: root, now: clock(), spawn, dryRun: true })
    expect(dry.result!.status).toBe('dry-run')
    expect(store.get('workflows', wf.slug)!.stages[1].status).toBe('pending')
    let doc = store.get('workflows', wf.slug)!
    for (const s of doc.stages) if (s.status !== 'passed') doc = overrideStage(store, wf.slug, s.id, 'test', 'jony', NOW)
    const end = runNext(store, wf, { cwd: root, now: clock(), spawn })
    expect(end.done).toBe(true)
    expect(end.result).toBeUndefined()
  })
})

describe('toSpawnable', () => {
  it('runs a booster stage as the CLI by absolute path with --root, and leaves other commands alone', () => {
    const booster = toSpawnable('npm', ['run', 'booster', '--', 'package', 'build', 'my-slug'], '/tmp/somewhere')
    expect(booster.file).toBe(process.execPath)
    expect(booster.args.slice(0, 2).map((a) => a.replace(/\\/g, '/'))).toEqual([expect.stringMatching(/node_modules\/tsx\/dist\/cli\.mjs$/), expect.stringMatching(/channel-booster\/cli\/booster\.ts$/)])
    expect(booster.args.slice(2)).toEqual(['package', 'build', 'my-slug', '--root', '/tmp/somewhere'])
    expect(toSpawnable('node', ['-e', 'process.exit(0)'], '/tmp')).toEqual({ file: 'node', args: ['-e', 'process.exit(0)'] })
    expect(toSpawnable('npm', ['run'], '/tmp')).toEqual({ file: 'npm', args: ['run'] })
  })
})
