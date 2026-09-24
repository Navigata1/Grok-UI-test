/**
 * Commands: workflow (runbook, run, status), cadence / week, calendar.
 *
 * `workflow "<idea>"` writes the runbook and creates the status document;
 * `workflow run <slug>` drives one stage at a time through src/runner.ts
 * (architecture 2.13). A booster stage runs in this process, sharing the
 * run's store, profile, workspace and clock; --isolate (or
 * BOOSTER_STAGE_ISOLATION=process) spawns it as a child process instead.
 * Overriding a gate is a person's call: it prints what it is about to record
 * and needs --yes as well as --reason.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ideaId, wipWarnings } from '../../src/bank.js'
import { cliName } from '../../src/build-info.js'
import { nextRunnable, overrideStage, runNext, runStage, applyStageResult, startWorkflow, type RunStageOptions, type StageResult } from '../../src/runner.js'
import type { WorkflowStatusDoc } from '../../src/schema.js'
import type { Store } from '../../src/store.js'
import {
  buildCalendar, commandLine, generateWorkflow, governCalendar, renderWorkflowMarkdown, renderWorkflowStatus, weeklyCadence, WEEKDAYS, WORKFLOW_FORMATS,
  type Weekday,
} from '../../src/workflow.js'
import type { Workflow, WorkflowFormat } from '../../src/types.js'
import { activeWorkspace, bool, getProfile, getStore, list, num, out, packagesRoot, profilePath, str, warn, type CommandModule, type Flags } from '../shared.js'

const USAGE_RUN = `${cliName()} workflow run <slug> [--next | --stage <id>] [--agent <name>] [--dry-run] [--isolate] [--override --reason ".." --yes] [--root dir] [--workflow file]`
const USAGE_STATUS = `${cliName()} workflow status <slug>`
const USAGE_IDEA = `${cliName()} workflow "<idea>" [--promise ".."] [--format ..] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]`
const USAGE_CALENDAR = `${cliName()} calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14] [--max-per-week N] [--reason ".."]`

/**
 * main() from cli/main.ts, the one every booster stage runs through in this
 * process. Imported when a stage runs: main.ts imports this module, so a
 * static import would be a cycle.
 */
async function runBooster(argv: string[]): Promise<number> {
  const { main } = await import('../main.js')
  return main(argv)
}

/** Whether stages are spawned as child processes: --isolate, or BOOSTER_STAGE_ISOLATION=process. */
function isolated(flags: Flags): boolean {
  return bool(flags, 'isolate') || process.env.BOOSTER_STAGE_ISOLATION === 'process'
}

/** The clock for the runner: fixed when --now is given, else the wall clock. */
function clockFrom(flags: Flags): () => Date {
  const fixed = str(flags, 'now')
  if (!fixed) return () => new Date()
  const d = new Date(fixed)
  if (Number.isNaN(d.getTime())) throw new Error(`--now must be an ISO date, got "${fixed}"`)
  return () => d
}

/** In a workspace, the folder `workflow run` reads runbooks from: <packages root>/packages. Undefined outside one. */
function workspaceRunbooks(flags: Flags): string | undefined {
  return activeWorkspace(flags) ? path.join(packagesRoot(flags), 'packages') : undefined
}

/** The command that creates a workflow so `workflow run` finds its runbook: in a workspace the runbook goes to its packages/ without --out. */
function createCommand(flags: Flags): string {
  return activeWorkspace(flags) ? `${cliName()} workflow "<idea>"` : `${cliName()} workflow "<idea>" --out packages`
}

/**
 * The Workflow for `workflow run`: `--workflow <file>`, else <root>/packages/<slug>.json
 * (what `booster workflow "<idea>"` wrote there: by default in a workspace, with
 * --out packages outside one), else regenerated from the idea and format on the
 * status document (default cycle length).
 */
function loadWorkflow(store: Store, slug: string, root: string, flags: Flags): Workflow {
  const explicit = str(flags, 'workflow')
  const file = explicit ?? path.join(root, 'packages', `${slug}.json`)
  if (existsSync(file)) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new Error(`${file} is not valid JSON`)
    }
    const wf = raw as Partial<Workflow>
    if (typeof wf?.slug !== 'string' || !Array.isArray(wf.stages) || typeof wf.idea !== 'string') throw new Error(`${file} is not a workflow (expected slug, idea, stages)`)
    if (wf.slug !== slug) throw new Error(`${file} describes workflow "${wf.slug}", not "${slug}"`)
    return wf as Workflow
  }
  if (explicit) throw new Error(`--workflow ${explicit} does not exist`)
  const doc = store.get('workflows', slug)
  if (!doc) throw new Error(`no workflow "${slug}": neither ${file} nor a status document. Create it first: ${createCommand(flags)}`)
  const format = (WORKFLOW_FORMATS as string[]).includes(doc.format) ? (doc.format as WorkflowFormat) : undefined
  warn(`${file} not found; regenerating the workflow from the status document (idea "${doc.idea}", format ${format ?? 'talking-head'}, default cycle length)`)
  return generateWorkflow(doc.idea, { format })
}

/** One line per stage result for the terminal: what ran (or would run) and what the gate said. */
function renderResult(result: StageResult, slug: string): string {
  const lines: string[] = []
  const what = result.kind === 'command' ? `\`${commandLine(result.command ?? [])}\`` : `human step; evidence packages/${slug}/${result.evidence ?? '(none)'}`
  if (result.status === 'dry-run') {
    lines.push(`DRY RUN ${result.stageId}: would run ${what}`)
    lines.push(`Gate now: ${result.gate.pass ? 'PASS' : 'FAIL'} · ${result.gate.detail}`)
    lines.push('Nothing was run or recorded.')
    return lines.join('\n')
  }
  lines.push(`Stage ${result.stageId} ${result.status.toUpperCase()}${result.agent ? ` (by ${result.agent})` : ''}: ${what}`)
  if (result.exitCode !== undefined) lines.push(`Exit code ${result.exitCode}`)
  lines.push(`Gate: ${result.gate.detail}`)
  const stderr = result.stderr?.trim()
  if (stderr && result.status === 'failed') lines.push(...stderr.split('\n').slice(-8).map((l) => `  | ${l}`))
  if (result.status === 'failed') lines.push('Not advanced. Fix the artifact and run again, or a person overrides it: --override --reason ".." --yes')
  return lines.join('\n')
}

/**
 * Overriding a gate is a person's responsibility (AGENTS.md: never advance
 * past a failed gate). Print what is about to be recorded; without --yes stop
 * with a clear message instead of writing.
 */
function runOverride(store: Store, wf: Workflow, flags: Flags, clock: () => Date): number {
  const reason = str(flags, 'reason')?.trim()
  if (!reason) throw new Error('--override needs --reason "..." (a written reason is recorded and the retro shows it)')
  const doc = startWorkflow(store, wf, clock())
  const stageId = str(flags, 'stage') ?? nextRunnable(doc)
  if (!stageId) throw new Error(`every stage of "${wf.slug}" is done; nothing to override`)
  const current = doc.stages.find((s) => s.id === stageId)
  if (!current) throw new Error(`workflow "${wf.slug}" has no stage "${stageId}" (stages: ${doc.stages.map((s) => s.id).join(', ')})`)
  const agent = str(flags, 'agent') ?? 'cli'
  const plan = { action: 'override', slug: wf.slug, stageId, from: current.status, to: 'overridden', reason, agent, applied: false, needs: '--yes' }
  if (!bool(flags, 'yes')) {
    out(plan, flags, () => [
      `About to override stage "${stageId}" of ${wf.slug} (currently ${current.status}) as ${agent}.`,
      `Reason: ${reason}`,
      'Overriding a gate is a human-only decision: the person takes responsibility for a gate the machine did not pass, and the retro shows it.',
    ].join('\n'))
    throw new Error(`nothing written. A person re-runs with --yes to record the override of "${stageId}".`)
  }
  const updated = overrideStage(store, wf.slug, stageId, reason, agent, clock())
  out({ ...plan, applied: true, status: updated }, flags, () => [`Recorded: stage "${stageId}" of ${wf.slug} overridden by ${agent}. Reason: ${reason}`, '', renderWorkflowStatus(updated)].join('\n'))
  return 0
}

async function runWorkflow(slug: string | undefined, flags: Flags): Promise<number> {
  if (!slug) throw new Error(`usage: ${USAGE_RUN}`)
  const store = getStore(flags)
  const root = path.resolve(packagesRoot(flags))
  const wf = loadWorkflow(store, slug, root, flags)
  const clock = clockFrom(flags)
  if (bool(flags, 'override')) return runOverride(store, wf, flags, clock)

  const agent = str(flags, 'agent')
  const dryRun = bool(flags, 'dry-run')
  const stageFlag = str(flags, 'stage')
  const options: RunStageOptions = {
    cwd: root,
    agent,
    dryRun,
    now: clock,
    runBooster,
    isolate: isolated(flags),
    // Every stage shares this run's store, profile and workspace, and its fixed clock when --now pinned it,
    // so a time-sensitive stage reads the same instant its gate is stamped with.
    locations: {
      data: path.resolve(store.root),
      profile: profilePath(flags),
      workspace: activeWorkspace(flags)?.root,
      now: str(flags, 'now') ? clock().toISOString() : undefined,
    },
  }

  let result: StageResult | undefined
  let status: WorkflowStatusDoc
  let done = false
  if (stageFlag) {
    status = startWorkflow(store, wf, clock())
    result = await runStage(wf, stageFlag, options)
    if (result.status !== 'dry-run') status = applyStageResult(store, slug, stageFlag, result, clock())
  } else {
    ;({ result, status, done } = await runNext(store, wf, options))
  }
  const value = { slug, root, stageId: result?.stageId, dryRun, result, status, done }
  out(value, flags, () => [
    ...(result ? [renderResult(result, slug), ''] : []),
    renderWorkflowStatus(status),
  ].join('\n'))
  return result && result.status === 'failed' ? 1 : 0
}

export const workflowModule: CommandModule = {
  verbs: ['workflow', 'cadence', 'week', 'calendar'],
  help: [
    'workflow "<idea>" [--promise ".."] [--format talking-head] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]   the runbook (in a workspace, to its packages/ by default) + status document; the promise feeds the packaging stage',
    'workflow run <slug> [--next | --stage <id>] [--agent <name>] [--dry-run] [--isolate] [--root dir] [--workflow packages/<slug>.json]   runs the stage in this process; --isolate (or BOOSTER_STAGE_ISOLATION=process) spawns it',
    'workflow run <slug> --override --reason ".." --yes [--stage <id>]   a person overrides a gate; recorded, shown in the retro',
    'workflow status <slug>                                             stage status of one workflow',
    'cadence | week [--publish thu] [--per-week 1] [--solo | --team]    the weekly operating rhythm (defaults from channel.json)',
    'calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14] [--max-per-week N] [--reason ".."]',
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'workflow') {
      if (sub === 'run') return runWorkflow(rest[0], flags)
      if (sub === 'status') {
        const slug = rest[0]
        if (!slug) throw new Error(`usage: ${USAGE_STATUS}`)
        const doc = getStore(flags).get('workflows', slug)
        if (!doc) throw new Error(`no workflow status for "${slug}". Create it first: ${createCommand(flags)}`)
        out(doc, flags, () => renderWorkflowStatus(doc))
        return 0
      }
      const idea = sub
      if (!idea) throw new Error(`usage: ${USAGE_IDEA}`)
      const format = (str(flags, 'format') ?? 'talking-head') as WorkflowFormat
      if (!WORKFLOW_FORMATS.includes(format)) throw new Error(`format must be one of ${WORKFLOW_FORMATS.join(', ')}`)
      const wf = generateWorkflow(idea, { format, days: num(flags, 'days') })
      const kickoffText = str(flags, 'kickoff')
      const kickoff = kickoffText ? new Date(`${kickoffText}T00:00:00Z`) : undefined
      const md = renderWorkflowMarkdown(wf, kickoff)
      // --out keeps its meaning, relative to the working directory; without it a workspace's runbook goes where `workflow run` reads it.
      const runbooks = workspaceRunbooks(flags)
      const dir = str(flags, 'out') ?? runbooks
      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, `${wf.slug}.md`), md)
        writeFileSync(path.join(dir, `${wf.slug}.json`), `${JSON.stringify(wf, null, 2)}\n`)
        warn(`wrote ${path.join(dir, wf.slug)}.md and .json`)
        const written = `${path.resolve(dir, wf.slug)}.json`
        if (runbooks && path.resolve(dir) !== runbooks) warn(`${written} is not in ${runbooks}, where \`workflow run\` looks for it: run it with --workflow ${written}, or leave out --out`)
      }
      const store = getStore(flags)
      const existed = Boolean(store.get('workflows', wf.slug))
      const doc = startWorkflow(store, wf, clockFrom(flags)())
      // The promise the package must keep travels with the workflow so `package build <slug>` (the packaging stage) has it: --promise, else the banked idea's.
      const promise = str(flags, 'promise') ?? store.get('ideas', ideaId(idea))?.promise ?? doc.promise
      if (promise && doc.promise !== promise) store.upsert('workflows', { ...doc, promise })
      if (!promise) warn(`no promise for ${wf.slug}: the packaging stage needs one (${cliName()} workflow "<idea>" --promise ".." or bank the idea with --promise)`)
      warn(existed ? `status document for ${wf.slug} already exists; progress kept (${cliName()} workflow status ${wf.slug})` : `status document created: ${cliName()} workflow run ${wf.slug} --next --agent <name>`)
      out({ ...wf, promise: promise ?? null }, flags, () => md)
      return 0
    }
    if (cmd === 'cadence' || cmd === 'week') {
      const profile = getProfile(flags)
      const publishDay = (str(flags, 'publish') ?? profile.publishDay) as Weekday
      if (!WEEKDAYS.includes(publishDay)) throw new Error(`--publish must be one of ${WEEKDAYS.join(', ')}, got "${publishDay}"`)
      const perWeek = num(flags, 'per-week') ?? profile.maxPerWeek
      const solo = bool(flags, 'solo') ? true : bool(flags, 'team') ? false : profile.solo
      const rituals = weeklyCadence({ publishDay, perWeek, solo })
      const warnings = wipWarnings(getStore(flags))
      for (const w of warnings) warn(`WARN ${w.message}`)
      const body = rituals.map((r) => [`${r.when} · ${r.name} (${r.owner}, ${r.minutes} min)`, ...r.agenda.map((a) => `  - ${a}`)].join('\n')).join('\n\n')
      out({ publishDay, perWeek, solo, rituals, warnings }, flags, () => (warnings.length ? `${body}\n\n${warnings.map((w) => `WARN ${w.message}`).join('\n')}` : body))
      return 0
    }
    const ideas = list(flags, 'ideas')
    const start = str(flags, 'start')
    if (!ideas || !start) throw new Error(`usage: ${USAGE_CALENDAR}`)
    const startDate = new Date(`${start}T00:00:00Z`)
    if (Number.isNaN(startDate.getTime())) throw new Error(`--start must be YYYY-MM-DD, got "${start}"`)
    const profile = getProfile(flags)
    const slots = buildCalendar(ideas, startDate, num(flags, 'per-week') ?? 1, num(flags, 'cycle-days') ?? 14)
    const warnings = governCalendar(slots, { maxPerWeek: num(flags, 'max-per-week') ?? profile.maxPerWeek ?? 1, reason: str(flags, 'reason') })
    for (const w of warnings) warn(`WARN ${w.message}`)
    out({ slots, warnings }, flags, () => ['Publish     Kickoff     Idea', ...slots.map((s) => `${s.date}  ${s.kickoff}  ${s.idea}`)].join('\n'))
    return 0
  },
}
