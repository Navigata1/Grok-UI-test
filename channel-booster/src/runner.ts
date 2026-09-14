/**
 * Workflow runner (architecture 2.13): executes one stage of a workflow,
 * evaluates its machine gate against the files in packages/<slug>/, and
 * persists the result in the `workflows` collection so any agent can pick
 * up where the last one stopped.
 *
 * `evaluateGate` is pure over the file system (read only). `runStage` is the
 * only function here that spawns a process; it never advances a stage on its
 * own. `applyStageResult` writes status and refuses out-of-order results, so
 * the story stage cannot be marked passed before the package (R1, R2).
 * Overrides are recorded with a reason and never silently.
 *
 * This file uses node built-ins; the browser bundle imports workflow.ts only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowStatusDoc } from './schema.js'
import type { Store } from './store.js'
import type { GatePredicate, Workflow, WorkflowStage } from './types.js'
import { assertRunnable, getJsonPath, newWorkflowStatus, nextRunnable, resolveCommand } from './workflow.js'

export { nextRunnable, assertRunnable, newWorkflowStatus, describeGate, describeRun } from './workflow.js'

/** The package directory for a slug: `<root>/packages/<slug>`. */
export function packageDir(root: string, slug: string): string {
  return path.join(root, 'packages', slug)
}

export interface GateCheckResult {
  pass: boolean
  detail: string
}

export interface GateResult {
  pass: boolean
  /** One line: every check joined, failures first. */
  detail: string
  checks: GateCheckResult[]
}

function readJsonArtifact(file: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (!existsSync(file)) return { ok: false, detail: `missing ${path.basename(file)}` }
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as unknown }
  } catch {
    return { ok: false, detail: `${path.basename(file)} is not valid JSON` }
  }
}

function flatten(check: GatePredicate, cwd: string): GateCheckResult[] {
  switch (check.kind) {
    case 'all-of':
      return check.checks.flatMap((c) => flatten(c, cwd))
    case 'file-exists': {
      const pass = existsSync(path.join(cwd, check.path))
      return [{ pass, detail: pass ? `${check.path} exists` : `${check.path} is missing` }]
    }
    case 'json-path-min': {
      const read = readJsonArtifact(path.join(cwd, check.path))
      if (!read.ok) return [{ pass: false, detail: read.detail }]
      const v = getJsonPath(read.value, check.jsonPath)
      if (typeof v !== 'number' || Number.isNaN(v)) return [{ pass: false, detail: `${check.path}: ${check.jsonPath} is ${v === undefined ? 'missing' : 'not a number'}` }]
      const pass = v >= check.min
      return [{ pass, detail: `${check.path}: ${check.jsonPath} ${v} ${pass ? '>=' : '<'} ${check.min}` }]
    }
    case 'json-path-eq': {
      const read = readJsonArtifact(path.join(cwd, check.path))
      if (!read.ok) return [{ pass: false, detail: read.detail }]
      const v = getJsonPath(read.value, check.jsonPath)
      const pass = v === check.value
      return [{ pass, detail: `${check.path}: ${check.jsonPath} is ${v === undefined ? 'missing' : JSON.stringify(v)}${pass ? '' : `, expected ${JSON.stringify(check.value)}`}` }]
    }
    case 'json-path-in': {
      const read = readJsonArtifact(path.join(cwd, check.path))
      if (!read.ok) return [{ pass: false, detail: read.detail }]
      const v = getJsonPath(read.value, check.jsonPath)
      const pass = check.values.includes(v as string | number | boolean)
      return [{ pass, detail: `${check.path}: ${check.jsonPath} is ${v === undefined ? 'missing' : JSON.stringify(v)}${pass ? '' : `, expected one of ${check.values.map((x) => JSON.stringify(x)).join(', ')}`}` }]
    }
  }
}

/**
 * Evaluate a gate predicate against the files under `cwd` (the package
 * directory, packages/<slug>/). Read only; never throws for a missing or
 * malformed artifact, it fails the check and says why. An absent predicate
 * fails: the runner cannot pass a stage it cannot check, a person overrides
 * it with a reason.
 */
export function evaluateGate(check: GatePredicate | undefined, cwd: string): GateResult {
  if (!check) return { pass: false, detail: 'no machine-checkable gate; override with --reason if a person confirmed it', checks: [] }
  const checks = flatten(check, cwd)
  const pass = checks.every((c) => c.pass)
  const ordered = [...checks.filter((c) => !c.pass), ...checks.filter((c) => c.pass)]
  return { pass, detail: ordered.map((c) => `${c.pass ? 'ok' : 'FAIL'}: ${c.detail}`).join('; '), checks }
}

/** What `spawn` must return; the default is node:child_process spawnSync. */
export interface SpawnOutcome {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnOutcome

/** The repository root (two levels above channel-booster/src). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BOOSTER_PREFIX = ['npm', 'run', 'booster', '--']

/**
 * `npm run booster -- ...` only works with the repository's package.json in
 * the working directory. A stage run from `--root <dir>` keeps that argv as
 * its record but is spawned as the CLI by absolute path (node + tsx +
 * cli/booster.ts) with `--root <dir>` appended, so every stage command
 * resolves packages/<slug>/ under the same root the gate checks. Any other
 * command is spawned as given.
 */
export function toSpawnable(command: string, args: string[], root: string): { file: string; args: string[] } {
  const argv = [command, ...args]
  if (argv.length < BOOSTER_PREFIX.length || BOOSTER_PREFIX.some((a, i) => argv[i] !== a)) return { file: command, args }
  const tsx = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const cli = path.join(REPO_ROOT, 'channel-booster', 'cli', 'booster.ts')
  return { file: process.execPath, args: [tsx, cli, ...argv.slice(BOOSTER_PREFIX.length), '--root', root] }
}

function defaultSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnOutcome {
  const spawnable = toSpawnable(command, args, options.cwd)
  const r = spawnSync(spawnable.file, spawnable.args, { cwd: options.cwd, env: options.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

export interface RunStageOptions {
  /** Repository root: commands run here and `packages/<slug>/` is resolved against it. */
  cwd: string
  /** Who ran it, recorded on the status document. */
  agent?: string
  /** Resolve the command and evaluate the gate, but spawn nothing. */
  dryRun?: boolean
  /** Reference clock for startedAt / finishedAt. Defaults to the wall clock. */
  now?: () => Date
  /** Process spawner, injectable for tests. Defaults to node:child_process spawnSync. */
  spawn?: SpawnFn
  /** Environment for spawned stage commands; `booster workflow run` passes BOOSTER_DATA and BOOSTER_PROFILE so stages share its store and profile. */
  env?: NodeJS.ProcessEnv
}

export interface StageResult {
  stageId: string
  kind: 'command' | 'human'
  /** The resolved argv for command stages. */
  command?: string[]
  /** The evidence file checked for human stages, relative to packages/<slug>/. */
  evidence?: string
  dryRun: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  gate: GateResult
  /** `dry-run` results describe what would run; applyStageResult refuses them. */
  status: 'passed' | 'failed' | 'dry-run'
  startedAt: string
  finishedAt: string
  agent?: string
}

/** Find a stage by id or throw a message that lists the ids. */
export function findStage(workflow: Workflow, stageId: string): WorkflowStage {
  const stage = workflow.stages.find((s) => s.id === stageId)
  if (!stage) throw new Error(`workflow "${workflow.slug}" has no stage "${stageId}" (stages: ${workflow.stages.map((s) => s.id).join(', ')})`)
  return stage
}

/**
 * Execute one stage. Command stages spawn their resolved argv from `cwd`
 * (with `dryRun` the command is returned unrun); human stages check that the
 * evidence file exists under packages/<slug>/. The gate is evaluated in every
 * case and a stage passes only when the run succeeded and the gate passed.
 * Nothing is persisted here: see applyStageResult.
 */
export function runStage(workflow: Workflow, stageId: string, options: RunStageOptions): StageResult {
  const stage = findStage(workflow, stageId)
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const dir = packageDir(options.cwd, workflow.slug)
  const run = stage.run ?? { kind: 'human' as const, artifact: '' }

  if (run.kind === 'command') {
    const command = resolveCommand(run.command ?? [], workflow.slug)
    if (command.length === 0) throw new Error(`stage "${stageId}" is a command stage with no command`)
    if (options.dryRun) {
      const gate = evaluateGate(stage.check, dir)
      return { stageId, kind: 'command', command, dryRun: true, gate, status: 'dry-run', startedAt, finishedAt: now().toISOString(), agent: options.agent }
    }
    const spawn = options.spawn ?? defaultSpawn
    const r = spawn(command[0], command.slice(1), { cwd: options.cwd, env: options.env ?? process.env })
    const exitCode = r.error ? -1 : (r.status ?? -1)
    const gate = evaluateGate(stage.check, dir)
    if (r.error) gate.detail = `FAIL: could not start ${command[0]} (${r.error.message}); ${gate.detail}`
    else if (exitCode !== 0) gate.detail = `FAIL: command exited ${exitCode}; ${gate.detail}`
    const passed = exitCode === 0 && gate.pass
    return { stageId, kind: 'command', command, dryRun: false, exitCode, stdout: r.stdout, stderr: r.stderr, gate: { ...gate, pass: passed }, status: passed ? 'passed' : 'failed', startedAt, finishedAt: now().toISOString(), agent: options.agent }
  }

  const evidence = run.evidence ?? (run.artifact || undefined)
  const gate = evaluateGate(stage.check, dir)
  let evidenceOk = true
  if (evidence) {
    evidenceOk = existsSync(path.join(dir, evidence))
    if (!evidenceOk) gate.detail = `FAIL: evidence file packages/${workflow.slug}/${evidence} is missing (a person leaves it when the step is done); ${gate.detail}`
  }
  const passed = evidenceOk && gate.pass
  const status = options.dryRun ? 'dry-run' : passed ? 'passed' : 'failed'
  return { stageId, kind: 'human', evidence, dryRun: Boolean(options.dryRun), gate: { ...gate, pass: passed }, status, startedAt, finishedAt: now().toISOString(), agent: options.agent }
}

/**
 * Create the status document for a workflow (id = slug, every stage pending).
 * Idempotent: an existing document is returned untouched so progress is never
 * reset by re-running `booster workflow`.
 */
export function startWorkflow(store: Store, workflow: Workflow, now: Date, source = 'cli'): WorkflowStatusDoc {
  const existing = store.get('workflows', workflow.slug)
  if (existing) return existing
  return store.upsert('workflows', newWorkflowStatus(workflow, now, source))
}

function loadStatus(store: Store, slug: string): WorkflowStatusDoc {
  const doc = store.get('workflows', slug)
  if (!doc) throw new Error(`no workflow status for "${slug}". Create it first: booster workflow "<idea>" (startWorkflow)`)
  return doc
}

function withStage(doc: WorkflowStatusDoc, stageId: string, patch: Partial<WorkflowStatusDoc['stages'][number]>, now: Date): WorkflowStatusDoc {
  return {
    ...doc,
    stages: doc.stages.map((s) => (s.id === stageId ? { ...s, ...patch } : s)),
    updatedAt: now.toISOString(),
  }
}

/**
 * Persist a stage result: status passed or failed, timestamps, the gate
 * detail and the agent. Refuses dry-run results and results for a stage whose
 * predecessors are not done, so the order of gates is enforced in the record
 * and not only in the runner.
 */
export function applyStageResult(store: Store, slug: string, stageId: string, result: StageResult, now: Date): WorkflowStatusDoc {
  if (result.status === 'dry-run' || result.dryRun) throw new Error(`stage "${stageId}": a dry run records nothing; run it without --dry-run`)
  if (result.stageId !== stageId) throw new Error(`result is for stage "${result.stageId}", not "${stageId}"`)
  const doc = loadStatus(store, slug)
  assertRunnable(doc, stageId)
  const next = withStage(doc, stageId, {
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    gateResult: result.gate.detail,
    agent: result.agent,
    overrideReason: undefined,
  }, now)
  return store.upsert('workflows', next)
}

/**
 * Mark a stage overridden: the person takes responsibility for a gate the
 * machine did not pass. A non-empty reason is required; it is stored and the
 * retro shows it. Predecessors must be done, so an override cannot skip
 * several stages at once.
 */
export function overrideStage(store: Store, slug: string, stageId: string, reason: string, agent: string, now: Date): WorkflowStatusDoc {
  const why = reason?.trim()
  if (!why) throw new Error(`stage "${stageId}": an override needs a written reason (--reason "...")`)
  const doc = loadStatus(store, slug)
  assertRunnable(doc, stageId)
  const current = doc.stages.find((s) => s.id === stageId)!
  if (current.status === 'passed') throw new Error(`stage "${stageId}" already passed; nothing to override`)
  const next = withStage(doc, stageId, {
    status: 'overridden',
    startedAt: current.startedAt ?? now.toISOString(),
    finishedAt: now.toISOString(),
    gateResult: current.gateResult ?? 'overridden without a machine check',
    overrideReason: why,
    agent,
  }, now)
  return store.upsert('workflows', next)
}

/**
 * Run the next runnable stage of a workflow and record the result. Returns
 * the result and the updated document; `done` is true when nothing is left.
 * The CLI's `workflow run <slug> --next`.
 */
export function runNext(store: Store, workflow: Workflow, options: RunStageOptions): { result?: StageResult; status: WorkflowStatusDoc; done: boolean } {
  const now = options.now ?? (() => new Date())
  const doc = startWorkflow(store, workflow, now())
  const stageId = nextRunnable(doc)
  if (!stageId) return { status: doc, done: true }
  const result = runStage(workflow, stageId, options)
  if (result.status === 'dry-run') return { result, status: doc, done: false }
  return { result, status: applyStageResult(store, workflow.slug, stageId, result, now()), done: false }
}
