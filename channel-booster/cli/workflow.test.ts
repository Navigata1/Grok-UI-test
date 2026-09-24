/**
 * CLI tests for the workflow module: runbook + status document, `workflow run`
 * (dry-run, --stage, --override gate, human stages with evidence files),
 * `workflow status`, `cadence` / `week` with channel.json defaults and WIP
 * warnings, and `calendar` with the governor. Every run uses temp dirs for
 * --data, --path, --out and --root. Command stages run in this process:
 * node:child_process is mocked so any spawn fails the test, except where a
 * test isolates a stage on purpose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../cli/booster.js'
import { openStore } from '../src/store.js'
import { slugify } from '../src/workflow.js'
import { WORKSPACE_MARKER } from '../src/workspace.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn(() => {
      throw new Error('spawnSync was called: a booster stage runs in-process unless it is isolated')
    }),
  }
})
const spawned = vi.mocked(spawnSync)

const NOW = '2026-09-14T09:00:00Z'
const IDEA = 'Empty Sprinter to camper in 90 days'
const SLUG = slugify(IDEA)

let tmp: string
let data: string
let noProfile: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-workflow-'))
  data = path.join(tmp, 'data')
  noProfile = path.join(tmp, 'missing-channel.json')
  // Back to the throwing spawnSync, with no calls recorded, whatever the shell asked for.
  spawned.mockReset()
  vi.stubEnv('BOOSTER_STAGE_ISOLATION', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

/** Run with --json and parse; also returns stderr and the exit code. */
async function json(argv: string[]): Promise<{ code: number; parsed: any; err: string }> {
  const { code, out, err } = await run([...argv, '--json'])
  return { code, parsed: JSON.parse(out), err }
}

/** The common flags: temp store, no channel.json (defaults), fixed clock. */
function base(): string[] {
  return ['--data', data, '--path', noProfile, '--now', NOW]
}

/** Create the runbook under <tmp>/packages (the repo-root layout) and the status document. */
async function createWorkflow(extra: string[] = []): Promise<void> {
  const { code } = await run(['workflow', IDEA, '--out', path.join(tmp, 'packages'), ...base(), ...extra])
  expect(code).toBe(0)
}

describe('booster workflow promise', () => {
  it('stores --promise on the status document, takes a banked idea\'s promise, and warns when there is none', async () => {
    const bare = await run(['workflow', IDEA, '--out', path.join(tmp, 'packages'), ...base()])
    expect(bare.err).toMatch(/no promise for empty-sprinter-to-camper-in-90-days/)
    expect(openStore(data).get('workflows', SLUG)!.promise).toBeUndefined()
    const typed = await run(['workflow', IDEA, '--promise', 'a road-ready camper in 90 days, every cost shown', '--out', path.join(tmp, 'packages'), ...base()])
    expect(typed.err).not.toMatch(/no promise/)
    expect(openStore(data).get('workflows', SLUG)!.promise).toBe('a road-ready camper in 90 days, every cost shown')
    expect(openStore(data).get('workflows', SLUG)!.stages.every((s) => s.status === 'pending')).toBe(true)
    await run(['bank', 'add', 'Living in the camper for a month', '--score', 'demand=4,packaging=4,fit=4,angle=4,payoff=4,feasibility=4', '--promise', 'thirty nights in the camper, nothing hidden', ...base()])
    const banked = await run(['workflow', 'Living in the camper for a month', '--out', path.join(tmp, 'packages'), ...base()])
    expect(banked.err).not.toMatch(/no promise/)
    expect(openStore(data).get('workflows', 'living-in-the-camper-for-a-month')!.promise).toBe('thirty nights in the camper, nothing hidden')
  })
})

function runFlags(extra: string[]): string[] {
  return ['workflow', 'run', SLUG, '--root', tmp, ...base(), ...extra]
}

async function override(stageId: string, reason: string): Promise<void> {
  const { code } = await run(runFlags(['--override', '--stage', stageId, '--reason', reason, '--yes', '--agent', 'tester']))
  expect(code).toBe(0)
}

describe('booster help', () => {
  it('lists the runner, status, week alias and governor flags', async () => {
    const { out } = await run(['help'])
    expect(out).toMatch(/workflow run <slug> \[--next \| --stage <id>\]/)
    expect(out).toMatch(/workflow run <slug> .*\[--isolate\].*BOOSTER_STAGE_ISOLATION=process/)
    expect(out).toMatch(/--override --reason ".." --yes/)
    expect(out).toMatch(/workflow status <slug>/)
    expect(out).toMatch(/cadence \| week/)
    expect(out).toMatch(/calendar .*--max-per-week N/)
  })
})

describe('booster workflow "<idea>"', () => {
  it('writes the runbook files and creates the status document', async () => {
    const { code, out, err } = await run(['workflow', IDEA, '--out', path.join(tmp, 'packages'), '--days', '14', ...base()])
    expect(code).toBe(0)
    expect(out).toMatch(/^# Workflow: Empty Sprinter/)
    expect(out).toMatch(/workflow run empty-sprinter-to-camper-in-90-days --next/)
    expect(err).toMatch(/wrote .*empty-sprinter-to-camper-in-90-days\.md and \.json/)
    expect(err).toMatch(/status document created/)
    const wf = JSON.parse(readFileSync(path.join(tmp, 'packages', `${SLUG}.json`), 'utf8'))
    expect(wf.slug).toBe(SLUG)
    expect(wf.stages).toHaveLength(10)
    const doc = openStore(data).get('workflows', SLUG)
    expect(doc).toMatchObject({ id: SLUG, idea: IDEA, format: 'talking-head', updatedAt: '2026-09-14T09:00:00.000Z' })
    expect(doc!.stages.every((s) => s.status === 'pending')).toBe(true)
  })

  it('keeps the JSON output as the Workflow and never resets progress on re-run', async () => {
    await createWorkflow()
    await override('demand', 'scored by hand')
    const { parsed, err } = await json(['workflow', IDEA, '--format', 'tutorial', ...base()])
    expect(parsed.slug).toBe(SLUG)
    expect(parsed.stages[0].id).toBe('demand')
    expect(err).toMatch(/already exists; progress kept/)
    expect(openStore(data).get('workflows', SLUG)!.stages[0].status).toBe('overridden')
  })

  it('rejects an unknown format and a missing idea', async () => {
    await expect(main(['workflow', IDEA, '--format', 'opera', ...base()])).rejects.toThrow(/format must be one of/)
    await expect(main(['workflow', ...base()])).rejects.toThrow(/usage: booster workflow/)
  })
})

describe('booster workflow status', () => {
  it('prints the table and the JSON document', async () => {
    await createWorkflow()
    const { code, out } = await run(['workflow', 'status', SLUG, ...base()])
    expect(code).toBe(0)
    expect(out).toMatch(/^Workflow empty-sprinter-to-camper-in-90-days · Empty Sprinter/)
    expect(out).toMatch(/\[ \] demand {6}pending/)
    expect(out).toMatch(/Next: demand/)
    const { parsed } = await json(['workflow', 'status', SLUG, ...base()])
    expect(parsed.stages).toHaveLength(10)
  })

  it('fails clearly for an unknown slug or no slug', async () => {
    await expect(main(['workflow', 'status', 'nope', ...base()])).rejects.toThrow(/no workflow status for "nope"/)
    await expect(main(['workflow', 'status', ...base()])).rejects.toThrow(/usage: booster workflow status/)
  })
})

describe('booster workflow run', () => {
  it('--next --dry-run resolves the demand command from the runbook and records nothing', async () => {
    await createWorkflow()
    const { code, out } = await run(runFlags(['--next', '--dry-run']))
    expect(code).toBe(0)
    expect(out).toMatch(/DRY RUN demand: would run `npm run booster -- idea score empty-sprinter-to-camper-in-90-days --out packages\/empty-sprinter-to-camper-in-90-days\/demand.json`/)
    expect(out).toMatch(/Gate now: FAIL · FAIL: missing demand.json/)
    expect(out).toMatch(/Nothing was run or recorded/)
    expect(openStore(data).get('workflows', SLUG)!.stages[0].status).toBe('pending')
    const { parsed } = await json(runFlags(['--next', '--dry-run', '--agent', 'bot']))
    expect(parsed).toMatchObject({ slug: SLUG, root: tmp, stageId: 'demand', dryRun: true, done: false })
    expect(parsed.result.status).toBe('dry-run')
    // Stored and recorded version-neutral; printed above as this build types it.
    expect(parsed.result.command.slice(0, 3)).toEqual(['booster', 'idea', 'score'])
    expect(parsed.result.agent).toBe('bot')
    expect(parsed.status.stages[0].status).toBe('pending')
  })

  it('really runs the demand stage in this process, spawning nothing, and only a person\'s approval opens the gate', async () => {
    const score = 'demand=5,packaging=4,fit=4,angle=4,payoff=5,feasibility=4'
    await run(['bank', 'add', IDEA, '--score', score, '--promise', 'a road-ready camper in 90 days, every cost shown', ...base()])
    await createWorkflow()

    // The scorecard is green, but the idea is still banked: the human-only gate holds the stage.
    const banked = await run(runFlags(['--next', '--agent', 'tester']))
    expect(banked.code).toBe(1)
    expect(banked.out).toMatch(/Stage demand FAILED \(by tester\): `npm run booster -- idea score empty-sprinter-to-camper-in-90-days --out packages\/empty-sprinter-to-camper-in-90-days\/demand.json`/)
    expect(banked.out).toMatch(/Exit code 0/)
    expect(banked.out).toMatch(/demand.json: status is "banked", expected one of "green", "packaging", "production", "published"/)
    const scorecard = JSON.parse(readFileSync(path.join(tmp, 'packages', SLUG, 'demand.json'), 'utf8'))
    expect(scorecard).toMatchObject({ idea: IDEA, verdict: 'green', status: 'banked' })

    await run(['bank', 'approve', IDEA, '--yes', ...base()])
    const approved = await json(runFlags(['--next', '--agent', 'tester']))
    expect(approved.code).toBe(0)
    // The stage's own output is its record, as a child process's stdout was; the runner's JSON stays one document.
    expect(approved.parsed.result).toMatchObject({ stageId: 'demand', status: 'passed', exitCode: 0, command: ['booster', 'idea', 'score', SLUG, '--out', `packages/${SLUG}/demand.json`] })
    expect(approved.parsed.result.stdout).toMatch(/^Idea: Empty Sprinter to camper in 90 days\nTotal \d+\/100 · verdict GREEN/)
    expect(approved.parsed.result.stdout).toContain(`Wrote ${path.join(tmp, 'packages', SLUG, 'demand.json')}`)
    expect(approved.parsed.result.gate.detail).toBe('ok: demand.json: verdict is "green"; ok: demand.json: status is "green"')
    expect(openStore(data).get('workflows', SLUG)!.stages[0].status).toBe('passed')
    const text = await run(['workflow', 'status', SLUG, ...base()])
    expect(text.out).toMatch(/Next: packaging/)
    expect(spawned).not.toHaveBeenCalled()
  })

  it('records a stage that throws in this process as exit 1 with the line the command line prints', async () => {
    // Nothing is banked, so `idea score <slug>` throws: the stage fails and says why, and the runner itself does not.
    await createWorkflow()
    const { code, parsed } = await json(runFlags(['--next', '--agent', 'tester']))
    expect(code).toBe(1)
    expect(parsed.result).toMatchObject({ stageId: 'demand', status: 'failed', exitCode: 1, stdout: '' })
    expect(parsed.result.stderr).toMatch(/^booster: usage: booster idea score .*Nothing in the bank matches "empty-sprinter-to-camper-in-90-days"/)
    expect(parsed.result.stderr.endsWith('\n')).toBe(true)
    expect(parsed.result.gate.detail).toMatch(/^FAIL: command exited 1; FAIL: missing demand.json/)
    expect(parsed.status.stages[0]).toMatchObject({ status: 'failed', agent: 'tester' })
    const text = await run(runFlags(['--next', '--agent', 'tester']))
    expect(text.out).toMatch(/Exit code 1\n/)
    expect(text.out).toMatch(/ {2}\| booster: usage: booster idea score/)
    expect(spawned).not.toHaveBeenCalled()
  })

  it('runs a runbook stored with the legacy `npm run booster --` prefix in this process, recorded and printed as before', async () => {
    await run(['bank', 'add', IDEA, '--score', 'demand=5,packaging=4,fit=4,angle=4,payoff=5,feasibility=4', ...base()])
    await run(['bank', 'approve', IDEA, '--yes', ...base()])
    await createWorkflow()
    const file = path.join(tmp, 'packages', `${SLUG}.json`)
    const wf = JSON.parse(readFileSync(file, 'utf8'))
    for (const s of wf.stages) if (s.run?.kind === 'command') s.run.command = ['npm', 'run', 'booster', '--', ...s.run.command.slice(1)]
    writeFileSync(file, JSON.stringify(wf, null, 2))
    expect(wf.stages[0].run.command.slice(0, 4)).toEqual(['npm', 'run', 'booster', '--'])

    const text = await run(runFlags(['--stage', 'demand', '--agent', 'tester']))
    expect(text.code).toBe(0)
    expect(text.out).toMatch(/Stage demand PASSED \(by tester\): `npm run booster -- idea score empty-sprinter-to-camper-in-90-days --out packages\/empty-sprinter-to-camper-in-90-days\/demand.json`/)
    const { parsed } = await json(runFlags(['--stage', 'demand', '--agent', 'tester']))
    expect(parsed.result.command).toEqual(['booster', 'idea', 'score', SLUG, '--out', `packages/${SLUG}/demand.json`])
    expect(parsed.result.status).toBe('passed')
    expect(spawned).not.toHaveBeenCalled()
  })

  it('--isolate spawns the stage as the command line from the root, and hands it the store, profile and clock through the environment', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    spawned.mockImplementationOnce(actual.spawnSync as typeof spawnSync)
    await run(['bank', 'add', IDEA, '--score', 'demand=5,packaging=4,fit=4,angle=4,payoff=5,feasibility=4', ...base()])
    await run(['bank', 'approve', IDEA, '--yes', ...base()])
    await createWorkflow()

    const { code, parsed } = await json(runFlags(['--next', '--agent', 'tester', '--isolate']))
    expect(spawned).toHaveBeenCalledTimes(1)
    const [file, args, options] = spawned.mock.calls[0] as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }]
    expect(file).toBe(process.execPath)
    expect(args[0].replace(/\\/g, '/')).toMatch(/\/tsx\/dist\/cli\.mjs$/)
    expect(args[1].replace(/\\/g, '/')).toMatch(/channel-booster\/cli\/booster\.ts$/)
    expect(args.slice(2)).toEqual(['idea', 'score', SLUG, '--out', `packages/${SLUG}/demand.json`, '--root', tmp])
    expect(options.cwd).toBe(tmp)
    expect(options.env).toMatchObject({ BOOSTER_DATA: data, BOOSTER_PROFILE: noProfile, BOOSTER_NOW: '2026-09-14T09:00:00.000Z' })
    expect(options.env.BOOSTER_HOME).toBeUndefined()
    // The child really ran: it wrote the scorecard under the root and the gate read it.
    expect(parsed.result).toMatchObject({ stageId: 'demand', status: 'passed', exitCode: 0 })
    expect(parsed.result.stdout).toMatch(/^Idea: Empty Sprinter to camper in 90 days/)
    expect(code).toBe(0)
  }, 60_000)

  it('BOOSTER_STAGE_ISOLATION=process isolates every stage without the flag', async () => {
    vi.stubEnv('BOOSTER_STAGE_ISOLATION', 'process')
    spawned.mockImplementationOnce((() => ({ status: 3, stdout: 'from the child\n', stderr: '', pid: 1, output: [], signal: null })) as unknown as typeof spawnSync)
    await createWorkflow()
    const { code, parsed } = await json(runFlags(['--next']))
    expect(spawned).toHaveBeenCalledTimes(1)
    expect(parsed.result).toMatchObject({ exitCode: 3, stdout: 'from the child\n', status: 'failed' })
    expect(code).toBe(1)
  })

  it('in a workspace, runs the stage against the workspace\'s store, profile and packages with no location flags', async () => {
    const ws = path.join(tmp, 'channel')
    mkdirSync(ws, { recursive: true })
    writeFileSync(path.join(ws, WORKSPACE_MARKER), JSON.stringify({ schemaVersion: 1, kind: 'channel-booster-workspace', channel: 'Vans', createdAt: NOW }))
    const inWs = ['--workspace', ws, '--now', NOW]
    await run(['bank', 'add', IDEA, '--score', 'demand=5,packaging=4,fit=4,angle=4,payoff=5,feasibility=4', ...inWs])
    await run(['bank', 'approve', IDEA, '--yes', ...inWs])
    expect((await run(['workflow', IDEA, '--out', path.join(ws, 'packages'), ...inWs])).code).toBe(0)
    // Run from outside the workspace, so only --workspace can put the packages root there.
    const cwd = process.cwd()
    process.chdir(tmp)
    try {
      const { code, parsed } = await json(['workflow', 'run', SLUG, '--next', '--agent', 'tester', ...inWs])
      expect(parsed.root).toBe(ws)
      expect(parsed.result).toMatchObject({ stageId: 'demand', status: 'passed', exitCode: 0 })
      expect(code).toBe(0)
    } finally {
      process.chdir(cwd)
    }
    expect(JSON.parse(readFileSync(path.join(ws, 'packages', SLUG, 'demand.json'), 'utf8'))).toMatchObject({ idea: IDEA, status: 'green' })
    expect(openStore(path.join(ws, 'data')).get('workflows', SLUG)!.stages[0].status).toBe('passed')
    expect(existsSync(path.join(tmp, 'packages'))).toBe(false)
    expect(spawned).not.toHaveBeenCalled()
  })

  it('defaults to --next when neither --next nor --stage is given', async () => {
    await createWorkflow()
    const { parsed } = await json(runFlags(['--dry-run']))
    expect(parsed.stageId).toBe('demand')
  })

  it('--override without --yes prints the plan and writes nothing; with --yes it records the reason', async () => {
    await createWorkflow()
    const plan = await run(runFlags(['--override', '--reason', 'demand confirmed by the strategist']))
      .catch((e: Error) => ({ code: -1, out: '', err: e.message }))
    expect(plan.code).toBe(-1)
    expect(plan.err).toMatch(/nothing written. A person re-runs with --yes/)
    expect(openStore(data).get('workflows', SLUG)!.stages[0].status).toBe('pending')

    let planOut = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { planOut += String(chunk); return true })
    await expect(main(runFlags(['--override', '--reason', 'demand confirmed by the strategist', '--json']))).rejects.toThrow(/--yes/)
    spy.mockRestore()
    expect(JSON.parse(planOut)).toMatchObject({ action: 'override', slug: SLUG, stageId: 'demand', from: 'pending', to: 'overridden', applied: false, needs: '--yes' })

    const { code, out } = await run(runFlags(['--override', '--reason', 'demand confirmed by the strategist', '--yes', '--agent', 'sam']))
    expect(code).toBe(0)
    expect(out).toMatch(/Recorded: stage "demand" of .* overridden by sam. Reason: demand confirmed by the strategist/)
    expect(out).toMatch(/\[o\] demand {6}overridden {1}by sam/)
    expect(out).toMatch(/Next: packaging/)
    const doc = openStore(data).get('workflows', SLUG)!
    expect(doc.stages[0]).toMatchObject({ status: 'overridden', overrideReason: 'demand confirmed by the strategist', agent: 'sam', finishedAt: '2026-09-14T09:00:00.000Z' })
  })

  it('--override needs a reason and refuses to skip ahead', async () => {
    await createWorkflow()
    await expect(main(runFlags(['--override', '--yes']))).rejects.toThrow(/--override needs --reason/)
    await expect(main(runFlags(['--override', '--yes', '--reason', '   ']))).rejects.toThrow(/--override needs --reason/)
    await expect(main(runFlags(['--override', '--yes', '--reason', 'x', '--stage', 'story']))).rejects.toThrow(/stage "story" is not runnable: "demand" is pending/)
    await expect(main(runFlags(['--override', '--yes', '--reason', 'x', '--stage', 'nope']))).rejects.toThrow(/has no stage "nope"/)
  })

  it('runs a human stage against its evidence file: failed until the file exists, then passed', async () => {
    await createWorkflow()
    await override('demand', 'a')
    await override('packaging', 'b')
    await override('story', 'c')
    await override('plan', 'd')
    const failed = await run(runFlags(['--next', '--agent', 'sam']))
    expect(failed.code).toBe(1)
    expect(failed.out).toMatch(/Stage production FAILED \(by sam\): human step; evidence packages\/empty-sprinter-to-camper-in-90-days\/footage.txt/)
    expect(failed.out).toMatch(/evidence file packages\/.*\/footage.txt is missing/)
    expect(failed.out).toMatch(/Not advanced/)
    expect(failed.out).toMatch(/\[!\] production {2}failed/)
    expect(openStore(data).get('workflows', SLUG)!.stages[4].status).toBe('failed')

    const dir = path.join(tmp, 'packages', SLUG)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'footage.txt'), 'every payoff covered\n')
    const { code, parsed } = await json(runFlags(['--next', '--agent', 'sam']))
    expect(code).toBe(0)
    expect(parsed.result).toMatchObject({ stageId: 'production', kind: 'human', status: 'passed', evidence: 'footage.txt', agent: 'sam' })
    expect(parsed.status.stages[4]).toMatchObject({ status: 'passed', agent: 'sam', gateResult: 'ok: footage.txt exists' })
    expect(parsed.done).toBe(false)
    const status = await run(['workflow', 'status', SLUG, ...base()])
    expect(status.out).toMatch(/\[x\] production {2}passed/)
    expect(status.out).toMatch(/Next: edit/)
  })

  it('re-running the demand stage on a workflow that moved on still passes', async () => {
    // `package build` moves the bank row to packaging, so a gate pinned to status == green
    // would freeze a finished workflow the moment anyone re-ran its first stage.
    await run(['bank', 'add', IDEA, '--score', 'demand=5,packaging=4,fit=4,angle=4,payoff=5,feasibility=4', '--promise', 'a road-ready camper in 90 days', ...base()])
    await run(['bank', 'approve', IDEA, '--yes', ...base()])
    await createWorkflow()
    const first = await run(runFlags(['--stage', 'demand', '--agent', 'sam']))
    expect(first.code).toBe(0)
    await run(['bank', 'status', IDEA, 'packaging', ...base()])
    const again = await run(runFlags(['--stage', 'demand', '--agent', 'sam']))
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/demand.json: status is "packaging"/)
    // A person's approval is still the gate: a retired idea does not open it.
    await run(['bank', 'status', IDEA, 'retired', '--reason', 'shelved', ...base()])
    const retired = await run(runFlags(['--stage', 'demand', '--agent', 'sam']))
    expect(retired.code).toBe(1)
    expect(retired.out).toMatch(/status is "retired", expected one of/)
  })

  it('the plan stage is a booster command whose gate is the shot list it writes', async () => {
    await createWorkflow()
    await override('demand', 'a')
    await override('packaging', 'b')
    await override('story', 'c')
    const dry = await json(runFlags(['--next', '--dry-run']))
    expect(dry.parsed.result).toMatchObject({ stageId: 'plan', kind: 'command', status: 'dry-run' })
    expect(dry.parsed.result.command).toEqual(['booster', 'plan', 'shots', SLUG, '--format', 'talking-head'])
    expect(dry.parsed.result.gate.detail).toMatch(/shots.md is missing/)
  })

  it('--stage runs a named stage, refuses out-of-order stages and dry-runs without writing', async () => {
    await createWorkflow()
    await override('demand', 'a')
    await override('packaging', 'b')
    await override('story', 'c')
    await override('plan', 'd')
    await expect(main(runFlags(['--stage', 'edit']))).rejects.toThrow(/stage "edit" is not runnable: "production" is pending/)
    await expect(main(runFlags(['--stage', 'nope']))).rejects.toThrow(/has no stage "nope"/)
    const dry = await json(runFlags(['--stage', 'production', '--dry-run']))
    expect(dry.parsed.result.status).toBe('dry-run')
    expect(openStore(data).get('workflows', SLUG)!.stages[4].status).toBe('pending')
    const dir = path.join(tmp, 'packages', SLUG)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'footage.txt'), 'footage\n')
    const real = await json(runFlags(['--stage', 'production', '--agent', 'sam']))
    expect(real.code).toBe(0)
    expect(real.parsed.status.stages[4].status).toBe('passed')
  })

  it('reports done when every stage is passed or overridden', async () => {
    await createWorkflow()
    for (const id of ['demand', 'packaging', 'story', 'plan', 'production', 'edit', 'thumbnail', 'publish', 'review48', 'postmortem']) await override(id, `ok ${id}`)
    const { code, out } = await run(runFlags(['--next']))
    expect(code).toBe(0)
    expect(out).toMatch(/Every stage is done/)
    const { parsed } = await json(runFlags(['--next']))
    expect(parsed.done).toBe(true)
    expect(parsed.result).toBeUndefined()
    await expect(main(runFlags(['--override', '--yes', '--reason', 'again']))).rejects.toThrow(/every stage of .* is done; nothing to override/)
  })

  it('loads the workflow from --workflow, falls back to regenerating from the status document, and checks the slug', async () => {
    await createWorkflow(['--format', 'tutorial'])
    const file = path.join(tmp, 'packages', `${SLUG}.json`)
    const moved = path.join(tmp, 'elsewhere.json')
    writeFileSync(moved, readFileSync(file))
    unlinkSync(file)
    const explicit = await json(runFlags(['--next', '--dry-run', '--workflow', moved]))
    expect(explicit.parsed.stageId).toBe('demand')
    expect(explicit.err).not.toMatch(/regenerating/)

    const fallback = await json(runFlags(['--next', '--dry-run']))
    expect(fallback.parsed.stageId).toBe('demand')
    expect(fallback.err).toMatch(/not found; regenerating the workflow from the status document \(idea "Empty Sprinter to camper in 90 days", format tutorial/)

    await expect(main(runFlags(['--next', '--dry-run', '--workflow', path.join(tmp, 'nope.json')]))).rejects.toThrow(/--workflow .* does not exist/)
    writeFileSync(file, JSON.stringify({ slug: 'other', idea: 'x', stages: [] }))
    await expect(main(runFlags(['--next', '--dry-run']))).rejects.toThrow(/describes workflow "other", not/)
    writeFileSync(file, '{ not json')
    await expect(main(runFlags(['--next', '--dry-run']))).rejects.toThrow(/is not valid JSON/)
    writeFileSync(file, JSON.stringify({ hello: 1 }))
    await expect(main(runFlags(['--next', '--dry-run']))).rejects.toThrow(/is not a workflow/)
  })

  it('fails clearly without a slug or without any workflow', async () => {
    await expect(main(['workflow', 'run', ...base()])).rejects.toThrow(/usage: booster workflow run <slug>/)
    await expect(main(runFlags(['--next']))).rejects.toThrow(/no workflow "empty-sprinter-to-camper-in-90-days": neither .* nor a status document/)
    expect(existsSync(data)).toBe(false)
  })
})

describe('booster cadence and week', () => {
  it('describes a Thursday solo publish by default and puts the same thing under week', async () => {
    const { code, out } = await run(['cadence', ...base()])
    expect(code).toBe(0)
    expect(out).toMatch(/^Monday · Outlier scan and idea bank \(strategist, 60 min\)/)
    expect(out).toMatch(/Saturday \(48 hours after the Thursday publish\) · 48-hour review/)
    expect(out).toMatch(/Solo mode: pick the pair 12 hours after the build/)
    expect(out).not.toMatch(/WARN/)
    const week = await run(['week', ...base()])
    expect(week.out).toBe(out)
    const { parsed } = await json(['cadence', ...base()])
    expect(parsed).toMatchObject({ publishDay: 'thu', perWeek: 1, solo: true, warnings: [] })
    expect(parsed.rituals).toHaveLength(6)
  })

  it('reads --publish, --per-week and --solo/--team, and validates the weekday', async () => {
    const { parsed } = await json(['week', '--publish', 'fri', '--per-week', '2', '--team', ...base()])
    expect(parsed).toMatchObject({ publishDay: 'fri', perWeek: 2, solo: false })
    expect(parsed.rituals[0].when).toBe('Tuesday')
    expect(parsed.rituals[4].when).toMatch(/Sunday and Thursday \(48 hours after each publish\)/)
    expect(parsed.rituals[1].agenda[1]).toBe('Packaging review with the designer.')
    await expect(main(['cadence', '--publish', 'someday', ...base()])).rejects.toThrow(/--publish must be one of mon, tue, wed, thu, fri, sat, sun, got "someday"/)
  })

  it('takes publishDay, maxPerWeek and solo from channel.json and lets flags override them', async () => {
    const profile = path.join(tmp, 'channel.json')
    writeFileSync(profile, JSON.stringify({ publishDay: 'mon', maxPerWeek: 2, solo: false }))
    const { parsed } = await json(['cadence', '--data', data, '--path', profile])
    expect(parsed).toMatchObject({ publishDay: 'mon', perWeek: 2, solo: false })
    const flagged = await json(['cadence', '--data', data, '--path', profile, '--publish', 'wed', '--per-week', '1', '--solo'])
    expect(flagged.parsed).toMatchObject({ publishDay: 'wed', perWeek: 1, solo: true })
  })

  it('prints the WIP warnings from the idea bank on stderr and in the JSON', async () => {
    const store = openStore(data)
    const scores = { demand: 4, packaging: 3, fit: 3, angle: 3, payoff: 3, feasibility: 3 }
    for (let i = 0; i < 4; i += 1) store.upsert('ideas', { id: `idea:${i}`, idea: `idea ${i}`, sources: [], scores, status: 'packaging', createdAt: NOW, updatedAt: NOW, source: 'cli' })
    const { code, out, err } = await run(['cadence', ...base()])
    expect(code).toBe(0)
    expect(err).toMatch(/WARN 4 ideas in packaging, cap 3 \[house\]: finish one before starting another/)
    expect(out).toMatch(/\n\nWARN 4 ideas in packaging, cap 3/)
    const { parsed } = await json(['week', ...base()])
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toMatchObject({ stage: 'packaging', count: 4, cap: 3 })
  })
})

describe('booster calendar', () => {
  const ideas = 'Solar install;Water system;Bed frame'

  it('lays out the slots and stays quiet within maxPerWeek', async () => {
    const { code, out, err } = await run(['calendar', '--ideas', ideas, '--start', '2026-10-01', ...base()])
    expect(code).toBe(0)
    expect(out).toMatch(/^Publish {5}Kickoff {5}Idea\n2026-10-01 {2}2026-09-17 {2}Solar install\n2026-10-08 {2}2026-09-24 {2}Water system\n2026-10-15 {2}2026-10-01 {2}Bed frame$/m)
    expect(err).toBe('')
    const { parsed } = await json(['calendar', '--ideas', ideas, '--start', '2026-10-01', '--cycle-days', '7', ...base()])
    expect(parsed.slots).toHaveLength(3)
    expect(parsed.slots[0]).toEqual({ date: '2026-10-01', kickoff: '2026-09-24', idea: 'Solar install' })
    expect(parsed.warnings).toEqual([])
  })

  it('warns, never refuses, above maxPerWeek and quotes the reason', async () => {
    // 2026-10-01 is a Thursday; seven a week puts Oct 1, 2 and 3 in the week of Monday 2026-09-28.
    const { code, err } = await run(['calendar', '--ideas', ideas, '--start', '2026-10-01', '--per-week', '7', ...base()])
    expect(code).toBe(0)
    expect(err).toMatch(/WARN Week of 2026-09-28: 3 publishes, above maxPerWeek 1 \[house\].*none given \(pass --reason\)/)
    const { parsed } = await json(['calendar', '--ideas', ideas, '--start', '2026-10-01', '--per-week', '7', '--reason', 'launch week', ...base()])
    expect(parsed.slots).toHaveLength(3)
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toMatchObject({ weekStart: '2026-09-28', count: 3, maxPerWeek: 1, reason: 'launch week' })
    expect(parsed.warnings[0].message).toMatch(/reason given: "launch week"/)
  })

  it('takes the cap from --max-per-week or channel.json maxPerWeek', async () => {
    const lifted = await json(['calendar', '--ideas', ideas, '--start', '2026-10-01', '--per-week', '7', '--max-per-week', '3', ...base()])
    expect(lifted.parsed.warnings).toEqual([])
    const profile = path.join(tmp, 'channel.json')
    writeFileSync(profile, JSON.stringify({ maxPerWeek: 2 }))
    const { parsed } = await json(['calendar', '--ideas', ideas, '--start', '2026-10-01', '--per-week', '7', '--data', data, '--path', profile])
    expect(parsed.warnings[0]).toMatchObject({ count: 3, maxPerWeek: 2 })
  })

  it('needs ideas and a valid start date', async () => {
    await expect(main(['calendar', '--start', '2026-10-01', ...base()])).rejects.toThrow(/usage: booster calendar/)
    await expect(main(['calendar', '--ideas', ideas, ...base()])).rejects.toThrow(/usage: booster calendar/)
    await expect(main(['calendar', '--ideas', ideas, '--start', 'soon', ...base()])).rejects.toThrow(/--start must be YYYY-MM-DD/)
  })
})
