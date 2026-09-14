/**
 * CLI tests for the workflow module: runbook + status document, `workflow run`
 * (dry-run, --stage, --override gate, human stages with evidence files),
 * `workflow status`, `cadence` / `week` with channel.json defaults and WIP
 * warnings, and `calendar` with the governor. Every run uses temp dirs for
 * --data, --path, --out and --root; command stages are only ever dry-run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../cli/booster.js'
import { openStore } from '../src/store.js'
import { slugify } from '../src/workflow.js'

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
})
afterEach(() => {
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
    expect(out).toMatch(/DRY RUN demand: would run `npm run booster -- idea score empty-sprinter-to-camper-in-90-days --demand auto --out packages\/empty-sprinter-to-camper-in-90-days\/demand.json`/)
    expect(out).toMatch(/Gate now: FAIL · FAIL: missing demand.json/)
    expect(out).toMatch(/Nothing was run or recorded/)
    expect(openStore(data).get('workflows', SLUG)!.stages[0].status).toBe('pending')
    const { parsed } = await json(runFlags(['--next', '--dry-run', '--agent', 'bot']))
    expect(parsed).toMatchObject({ slug: SLUG, root: tmp, stageId: 'demand', dryRun: true, done: false })
    expect(parsed.result.status).toBe('dry-run')
    expect(parsed.result.command.slice(0, 4)).toEqual(['npm', 'run', 'booster', '--'])
    expect(parsed.result.agent).toBe('bot')
    expect(parsed.status.stages[0].status).toBe('pending')
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

  it('the plan stage is a booster command whose gate is the shot list it writes', async () => {
    await createWorkflow()
    await override('demand', 'a')
    await override('packaging', 'b')
    await override('story', 'c')
    const dry = await json(runFlags(['--next', '--dry-run']))
    expect(dry.parsed.result).toMatchObject({ stageId: 'plan', kind: 'command', status: 'dry-run' })
    expect(dry.parsed.result.command).toEqual(['npm', 'run', 'booster', '--', 'plan', 'shots', SLUG, '--format', 'talking-head'])
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
