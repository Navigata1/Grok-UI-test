/**
 * Workflow v2 (architecture 2.13): one video moves through ten gated stages.
 *
 * Every stage carries three things: the prose `gate` the runbook and the Desk
 * print, a `run` (a `booster` command the runner spawns, or a human step that
 * leaves an evidence file) and a `check` (a machine-checkable predicate over
 * the files in `packages/<slug>/`). The order never changes because the
 * gates depend on it: demand before packaging, packaging before story, story
 * before the shoot (R1, R2).
 *
 * This file stays free of node built-ins so the Desk bundle can import it;
 * the parts that touch the file system and spawn processes live in runner.ts.
 */
import { BUCKET_HOURS } from './buckets.js'
import type { WorkflowStatusDoc } from './schema.js'
import { thresholds } from './thresholds.js'
import type { GatePredicate, Workflow, WorkflowFormat, WorkflowRun, WorkflowStage } from './types.js'

export const WORKFLOW_FORMATS: WorkflowFormat[] = ['talking-head', 'documentary', 'tutorial', 'challenge', 'vlog', 'listicle', 'interview']

/** Weekday keys as channel.json spells them (`profile.publishDay`). */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const WEEKDAY_NAMES: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

/** Placeholder tokens substituted into stage commands at run time. */
export const COMMAND_PLACEHOLDERS = { slug: '<slug>', dir: '<dir>' } as const

/** The command every stage command starts with: `npm run booster -- <subcommand>`. */
const BOOSTER = ['npm', 'run', 'booster', '--']

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video'
}

/** Extra checklist lines that only apply to a format. */
const FORMAT_EXTRAS: Record<WorkflowFormat, { production: string[]; edit: string[] }> = {
  'talking-head': {
    production: ['Record the first 30 seconds three times; pick the take that states the promise fastest.', 'Capture B-roll for every claim you make.'],
    edit: ['Cut every pause longer than 0.5s in the first minute.', 'Add on-screen text for the promise in the first 5 seconds.'],
  },
  documentary: {
    production: ['Shoot the ending first so the open can tease it honestly.', 'Record ambient sound for every location.'],
    edit: ['Open with the most cinematic 5 seconds, then the question.', 'Chapter the story into acts with a visible turn at each.'],
  },
  tutorial: {
    production: ['Show the finished result before step one.', 'Record screen and face separately for flexibility.'],
    edit: ['Number the steps on screen.', 'Remove every step the viewer can skip; link it in the description instead.'],
  },
  challenge: {
    production: ['State the rules and the stake on camera in the first take.', 'Film every failure; failures are the retention.'],
    edit: ['Escalate: each segment must raise the stake or the difficulty.', 'Put a countdown or progress bar on screen.'],
  },
  vlog: {
    production: ['Decide the one story before you start the day; everything else is B-roll.', 'Film the moment of change, not the setup.'],
    edit: ['Cut the arrival and the goodbye.', 'Anchor the vlog to the title promise every 90 seconds.'],
  },
  listicle: {
    production: ['Rank the list; ordered lists retain better than unordered.', 'Get a concrete visual for every item.'],
    edit: ['Tease the number one item in the open.', 'Keep each item under 90 seconds unless it is the finale.'],
  },
  interview: {
    production: ['Pre-interview for the three best stories; build the shoot around them.', 'Record a clean reaction shot of the host for every story.'],
    edit: ['Open on the strongest quote, then the introduction.', 'Cut the questions; keep the answers.'],
  },
}

/** A `booster` command stage: argv with `<slug>` placeholders, the artifact it writes. */
function command(artifact: string, ...args: string[]): WorkflowRun {
  return { kind: 'command', command: [...BOOSTER, ...args], artifact }
}

/** A human stage: the evidence file the person leaves in packages/<slug>/. */
function human(evidence: string): WorkflowRun {
  return { kind: 'human', artifact: evidence, evidence }
}

/**
 * Generate the production workflow for one video. Stage due days scale with
 * the cycle length; the order never changes because the gates depend on it:
 * demand before packaging, packaging before script, script before shoot.
 * Every stage carries a `run` and a `check` so `booster workflow run` can
 * drive it (section 3 of the architecture). Artifact paths in `check` are
 * relative to `packages/<slug>/`.
 */
export function generateWorkflow(idea: string, options: { format?: WorkflowFormat; days?: number } = {}): Workflow {
  const format = options.format ?? 'talking-head'
  const days = options.days ?? 14
  const day = (fraction: number) => Math.round(fraction * days)
  const extras = FORMAT_EXTRAS[format]
  const slug = COMMAND_PLACEHOLDERS.slug
  const dir = COMMAND_PLACEHOLDERS.dir

  const stages: WorkflowStage[] = [
    {
      id: 'demand',
      name: 'Demand check',
      owner: 'strategist',
      dueDay: 0,
      inputs: ['idea one-liner', 'competitor CSV exports', 'last 90 days of your own analytics'],
      outputs: ['idea scorecard (six axes)', 'three outlier references with multipliers', 'go / no-go'],
      checklist: [
        'Run booster outliers on 2-3 adjacent channels; list every video >= 5x its channel median on this topic.',
        'Score the idea on demand, packaging, fit, angle, payoff, feasibility.',
        'Write the one-sentence promise a stranger would understand.',
      ],
      gate: 'Idea scorecard is green, or yellow with a named fix applied.',
      run: command('demand.json', 'idea', 'score', slug, '--demand', 'auto', '--out', `${dir}/demand.json`),
      check: { kind: 'json-path-eq', path: 'demand.json', jsonPath: 'verdict', value: 'green' },
    },
    {
      id: 'packaging',
      name: 'Packaging sprint',
      owner: 'strategist',
      dueDay: day(0.07),
      inputs: ['idea scorecard', 'outlier references'],
      outputs: ['10 title candidates', 'chosen title', '3 thumbnail concepts', 'thumbnail brief'],
      checklist: [
        'Generate 10 titles with booster titles; keep the two best and one wildcard.',
        'Build the thumbnail brief; sketch the three strongest concepts on paper at phone size.',
        'Run the packaging review: title tells, thumbnail shows, neither repeats the other.',
      ],
      gate: 'A title and a thumbnail concept exist that the strategist would click next to the top competing videos.',
      run: command('package.json', 'package', 'build', slug),
      check: {
        kind: 'all-of',
        checks: [
          { kind: 'json-path-eq', path: 'package.json', jsonPath: 'gateReport.pass', value: true },
          { kind: 'file-exists', path: 'package.md' },
        ],
      },
    },
    {
      id: 'story',
      name: 'Story spine',
      owner: 'writer',
      dueDay: day(0.15),
      inputs: ['chosen title', 'thumbnail concept'],
      outputs: ['first-30-seconds script', 'promise to payoff outline', 'rehook map (one every 60-90s)'],
      checklist: [
        'Write the first 30 seconds word for word: promise, stake, why now.',
        'List the payoff moments in order and mark which one the thumbnail shows.',
        'Plan a rehook (new question, reveal, or escalation) every 60-90 seconds.',
      ],
      gate: 'A cold reader can say what the video promises after reading the first 30 seconds.',
      run: command('story.json', 'hook', 'score', '--script', `${dir}/script.txt`, '--slug', slug),
      check: {
        kind: 'all-of',
        checks: [
          { kind: 'json-path-min', path: 'story.json', jsonPath: 'hookScore', min: thresholds.hookGateScore.value },
          { kind: 'json-path-eq', path: 'story.json', jsonPath: 'promiseInFirst25Words', value: true },
        ],
      },
    },
    {
      id: 'plan',
      name: 'Shoot plan',
      owner: 'creator',
      dueDay: day(0.22),
      inputs: ['story spine', 'thumbnail brief'],
      outputs: ['shot list', 'thumbnail photo list', 'props and locations'],
      checklist: [
        'Add a dedicated thumbnail photo setup to the shot list (lighting, expression, props).',
        'Mark every shot that proves a claim in the script.',
        'Schedule the shoot so the ending is filmed before the open.',
      ],
      gate: 'Every payoff moment in the spine has a shot that shows it.',
      run: command('shots.md', 'plan', 'shots', slug, '--format', format),
      check: { kind: 'file-exists', path: 'shots.md' },
    },
    {
      id: 'production',
      name: 'Production',
      owner: 'creator',
      dueDay: day(0.4),
      inputs: ['shot list'],
      outputs: ['footage', 'thumbnail photos (raw)', 'audio'],
      checklist: [...extras.production, 'Shoot the thumbnail photos at the peak emotional moment, not at the end of the day.'],
      gate: 'Footage covers the first 30 seconds, every payoff, and the thumbnail photos.',
      run: human('footage.txt'),
      check: { kind: 'file-exists', path: 'footage.txt' },
    },
    {
      id: 'edit',
      name: 'Edit and retention pass',
      owner: 'editor',
      dueDay: day(0.6),
      inputs: ['footage', 'story spine', 'rehook map'],
      outputs: ['v1 cut', 'retention map with timestamps', 'chapter list'],
      checklist: [...extras.edit, 'Watch v1 as a stranger: mark every point you would leave and fix it.', 'Confirm the packaging promise is on screen in the first line.'],
      gate: 'A cold viewer watches past the first 30 seconds without being asked to.',
      run: human('cut.txt'),
      check: { kind: 'file-exists', path: 'cut.txt' },
    },
    {
      id: 'thumbnail',
      name: 'Thumbnail production',
      owner: 'designer',
      dueDay: day(0.65),
      inputs: ['thumbnail brief', 'thumbnail photos'],
      outputs: ['3 thumbnail variants at 1280x720', 'phone-size proof sheet', 'QA scores'],
      checklist: [
        'Produce the A concept and the most different B concept, plus one wildcard.',
        'Run booster thumbnail qa on each spec; ship only at grade "ship".',
        'Proof at 120px wide next to the top three competing thumbnails.',
      ],
      gate: 'At least two variants grade "ship" and look different from each other.',
      run: command('proof-sheet.html', 'thumbnail', 'proof', slug),
      check: {
        kind: 'all-of',
        checks: [
          { kind: 'file-exists', path: 'thumb-A.png' },
          { kind: 'file-exists', path: 'thumb-B.png' },
          { kind: 'file-exists', path: 'proof-sheet.html' },
        ],
      },
    },
    {
      id: 'publish',
      name: 'Publish package',
      owner: 'strategist',
      dueDay: day(0.75),
      inputs: ['final cut', 'thumbnail variants', 'chosen title'],
      outputs: ['published video', 'Test & Compare running', 'description, chapters, end screen, pinned comment', 'community post', '2 Shorts cuts'],
      checklist: [
        'Title final: length 30-55 characters, promise in the first 40.',
        'Test & Compare with A and B thumbnails.',
        'Description first line restates the promise; chapters match the retention map.',
        'End screen points at the most related proven video; pinned comment asks a question.',
        'Schedule a community post and two Shorts within 48 hours.',
      ],
      gate: 'Every line of the publish checklist is ticked.',
      run: command('publish-check.json', 'publish', 'check', slug),
      check: {
        kind: 'all-of',
        checks: [
          { kind: 'file-exists', path: 'publish.md' },
          { kind: 'json-path-eq', path: 'publish-check.json', jsonPath: 'pass', value: true },
        ],
      },
    },
    {
      id: 'review48',
      name: '48-hour review',
      owner: 'analyst',
      dueDay: day(0.9),
      inputs: ['YouTube Studio: impressions, CTR, AVD, 30s retention'],
      outputs: ['diagnosis', 'repackage decision'],
      checklist: [
        'Run booster postmortem with the 48-hour numbers and the channel baseline.',
        'If the bottleneck is packaging and impressions are healthy, swap to the losing concept now.',
        'Log the numbers in the ledger.',
      ],
      gate: 'Diagnosis recorded and the repackage decision made.',
      run: command('review-48.json', 'review', 'run', '--slug', slug, '--bucket', '48'),
      check: { kind: 'json-path-eq', path: 'review-48.json', jsonPath: 'bucket', value: '48' },
    },
    {
      id: 'postmortem',
      name: '7-day post-mortem',
      owner: 'analyst',
      dueDay: day(1.0) + 5,
      inputs: ['7-day metrics', 'retention graph', 'Test & Compare result'],
      outputs: ['learnings added to the playbook', 'sequel / expand / park decision', 'next idea seeded'],
      checklist: [
        'Compare against the channel median: is this an outlier for you?',
        'Record which packaging lever won and which concept lost.',
        'If it is an outlier, brief the sequel this week.',
      ],
      gate: 'One sentence of learning is written into the playbook.',
      run: command('review-168.json', 'review', 'run', '--slug', slug, '--bucket', '168'),
      check: { kind: 'json-path-eq', path: 'review-168.json', jsonPath: 'bucket', value: '168' },
    },
  ]

  return { idea, slug: slugify(idea), format, stages, timelineDays: days }
}

/** Substitute `<slug>` and `<dir>` (packages/<slug>) into a stage command. */
export function resolveCommand(argv: string[], slug: string): string[] {
  const dir = `packages/${slug}`
  return argv.map((a) => a.split(COMMAND_PLACEHOLDERS.dir).join(dir).split(COMMAND_PLACEHOLDERS.slug).join(slug))
}

/** A gate predicate in one line of prose, for the runbook and the status printout. */
export function describeGate(check: GatePredicate | undefined): string {
  if (!check) return 'no machine check (override with a reason)'
  switch (check.kind) {
    case 'file-exists':
      return `${check.path} exists`
    case 'json-path-min':
      return `${check.path}: ${check.jsonPath} >= ${check.min}`
    case 'json-path-eq':
      return `${check.path}: ${check.jsonPath} == ${JSON.stringify(check.value)}`
    case 'all-of':
      return check.checks.map(describeGate).join(' and ')
  }
}

/** One line describing how a stage runs: the resolved command, or the human evidence file. */
export function describeRun(stage: WorkflowStage, slug: string): string {
  if (!stage.run) return 'no run declared; a person confirms the gate'
  if (stage.run.kind === 'human') return `human step; evidence: packages/${slug}/${stage.run.evidence ?? stage.run.artifact}`
  return resolveCommand(stage.run.command ?? [], slug).join(' ')
}

/**
 * Read a dotted JSON path with optional `[n]` indices (`gateReport.pass`,
 * `titles[0].score`). Returns undefined when any step is missing.
 */
export function getJsonPath(value: unknown, jsonPath: string): unknown {
  const steps = jsonPath.split('.').flatMap((part) => {
    const out: string[] = []
    const re = /([^[\]]+)|\[(\d+)\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(part)) !== null) out.push(m[1] ?? m[2])
    return out
  })
  let cur: unknown = value
  for (const step of steps) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[step]
  }
  return cur
}

/** Render a workflow as a Markdown runbook. */
export function renderWorkflowMarkdown(wf: Workflow, kickoff?: Date): string {
  const lines: string[] = []
  lines.push(`# Workflow: ${wf.idea}`)
  lines.push('')
  lines.push(`Format: ${wf.format} · Cycle: ${wf.timelineDays} days · Slug: ${wf.slug}`)
  lines.push('')
  lines.push(`Drive it one stage at a time: \`npm run booster -- workflow run ${wf.slug} --next --agent <name>\`. Artifacts live in \`packages/${wf.slug}/\`.`)
  lines.push('')
  lines.push('| # | Stage | Owner | Due | Gate |')
  lines.push('| --- | --- | --- | --- | --- |')
  wf.stages.forEach((s, i) => {
    const due = kickoff ? new Date(kickoff.getTime() + s.dueDay * 86_400_000).toISOString().slice(0, 10) : `day ${s.dueDay}`
    lines.push(`| ${i + 1} | ${s.name} | ${s.owner} | ${due} | ${s.gate} |`)
  })
  lines.push('')
  for (const s of wf.stages) {
    lines.push(`## ${s.name} (${s.owner}, day ${s.dueDay})`)
    lines.push('')
    lines.push(`Inputs: ${s.inputs.join('; ')}`)
    lines.push('')
    lines.push(`Outputs: ${s.outputs.join('; ')}`)
    lines.push('')
    for (const item of s.checklist) lines.push(`- [ ] ${item}`)
    lines.push('')
    lines.push(`Gate: ${s.gate}`)
    lines.push('')
    if (s.run || s.check) {
      lines.push(`Run: \`${describeRun(s, wf.slug)}\``)
      lines.push('')
      lines.push(`Check: ${describeGate(s.check)}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/** A stage status inside a WorkflowStatusDoc. */
export type StageStatus = WorkflowStatusDoc['stages'][number]

/** A stage counts as done when it passed or a person overrode it with a reason. */
export function isStageDone(stage: StageStatus): boolean {
  return stage.status === 'passed' || stage.status === 'overridden'
}

/**
 * The next stage the runner may execute: the first one not yet passed or
 * overridden. Undefined when every stage is done. Order is strict, so a
 * failed stage is the next runnable one until it passes or is overridden.
 */
export function nextRunnable(status: Pick<WorkflowStatusDoc, 'stages'>): string | undefined {
  return status.stages.find((s) => !isStageDone(s))?.id
}

/** Throw unless every stage before `stageId` is done (R1: no story before a passed package). */
export function assertRunnable(status: Pick<WorkflowStatusDoc, 'stages' | 'slug'>, stageId: string): void {
  const index = status.stages.findIndex((s) => s.id === stageId)
  if (index < 0) throw new Error(`workflow "${status.slug}" has no stage "${stageId}"`)
  const blocker = status.stages.slice(0, index).find((s) => !isStageDone(s))
  if (blocker) throw new Error(`stage "${stageId}" is not runnable: "${blocker.id}" is ${blocker.status}. Pass it first, or override it with --reason.`)
}

/** A fresh status document for a workflow: every stage pending, id = slug. */
export function newWorkflowStatus(workflow: Workflow, now: Date, source = 'cli'): WorkflowStatusDoc {
  return {
    id: workflow.slug,
    slug: workflow.slug,
    idea: workflow.idea,
    format: workflow.format,
    stages: workflow.stages.map((s) => ({ id: s.id, status: 'pending' as const })),
    updatedAt: now.toISOString(),
    source,
  }
}

/** The status document as a short table for the terminal. */
export function renderWorkflowStatus(status: WorkflowStatusDoc): string {
  const lines = [`Workflow ${status.slug} · ${status.idea} · ${status.format}`, '']
  for (const s of status.stages) {
    const mark = s.status === 'passed' ? '[x]' : s.status === 'overridden' ? '[o]' : s.status === 'failed' ? '[!]' : '[ ]'
    const extra = [s.agent ? `by ${s.agent}` : '', s.finishedAt ? `at ${s.finishedAt}` : '', s.overrideReason ? `override: ${s.overrideReason}` : '', s.gateResult ?? ''].filter(Boolean).join(' · ')
    lines.push(`${mark} ${s.id.padEnd(11)} ${s.status.padEnd(10)} ${extra}`)
  }
  const next = nextRunnable(status)
  lines.push('', next ? `Next: ${next}` : 'Every stage is done.')
  return lines.join('\n')
}

export interface CadenceRitual {
  when: string
  name: string
  owner: WorkflowStage['owner']
  minutes: number
  agenda: string[]
}

export interface CadenceOptions {
  /** The weekday the video goes live. Default Thursday (channel.json `publishDay`). */
  publishDay?: Weekday
  /** Publishes per week. Above one, the 48-hour review lists every review day. */
  perWeek?: number
  /** One person does strategy and design: the pair pick waits `soloReviewGapHours` after the build. */
  solo?: boolean
}

/** The weekday `offset` days after `day` (negative offsets go backwards). */
export function shiftWeekday(day: Weekday, offset: number): Weekday {
  const i = WEEKDAYS.indexOf(day)
  return WEEKDAYS[(((i + offset) % 7) + 7) % 7]
}

/** Long weekday name for a key: `thu` -> `Thursday`. */
export function weekdayName(day: Weekday): string {
  return WEEKDAY_NAMES[day]
}

/** Publish weekdays for `perWeek` uploads, spread across the week from `publishDay`. */
export function publishDaysFor(publishDay: Weekday, perWeek: number): Weekday[] {
  const n = Math.max(1, Math.min(7, Math.round(perWeek)))
  const gap = 7 / n
  const days: Weekday[] = []
  for (let k = 0; k < n; k += 1) {
    const d = shiftWeekday(publishDay, Math.round(k * gap))
    if (!days.includes(d)) days.push(d)
  }
  return days
}

/** Hours after publish at which the 48-hour review reads the funnel, in whole days (BUCKET_HOURS['48']). */
const REVIEW_DAYS_AFTER_PUBLISH = BUCKET_HOURS['48'] / 24

/**
 * The weekly operating cadence the workflow plugs into, anchored to the
 * publish day: strategy three days before, packaging two days before, the
 * 48-hour review two days after each publish, the retro three days after.
 * Called without arguments it describes a Thursday publish, solo.
 */
export function weeklyCadence(options: CadenceOptions = {}): CadenceRitual[] {
  const publishDay = options.publishDay ?? 'thu'
  const perWeek = options.perWeek ?? 1
  const solo = options.solo ?? true
  const at = (offset: number) => weekdayName(shiftWeekday(publishDay, offset))
  const reviewDays = publishDaysFor(publishDay, perWeek).map((d) => weekdayName(shiftWeekday(d, REVIEW_DAYS_AFTER_PUBLISH)))
  const reviewWhen = `${reviewDays.join(' and ')} (${BUCKET_HOURS['48']} hours after ${perWeek > 1 ? 'each' : `the ${at(0)}`} publish)`
  const wip = thresholds.wipPackaging.value
  const gap = thresholds.soloReviewGapHours.value
  return [
    {
      when: at(-3),
      name: 'Outlier scan and idea bank',
      owner: 'strategist',
      minutes: 60,
      agenda: ['Export or refresh competitor CSVs; run booster outliers.', 'Add every >= 5x video to the idea bank with its format cues.', `Score the top five new ideas; promote at most ${wip} greens to the packaging sprint (WIP cap [${thresholds.wipPackaging.evidence}]).`],
    },
    {
      when: at(-2),
      name: 'Packaging sprint',
      owner: 'strategist',
      minutes: 90,
      agenda: [
        '10 titles and 3 thumbnail concepts per green idea.',
        solo ? `Solo mode: pick the pair ${gap} hours after the build, the next morning; the gap stands in for the second reviewer [${thresholds.soloReviewGapHours.evidence}].` : 'Packaging review with the designer.',
        'Pick the pair; open the workflow.',
      ],
    },
    {
      when: `${at(-1)} to ${at(1)}`,
      name: 'Production block',
      owner: 'creator',
      minutes: 480,
      agenda: ['Shoot to the shot list.', 'Thumbnail photos at the emotional peak.', 'Hand off with the story spine.'],
    },
    {
      when: at(1),
      name: 'Thumbnail review',
      owner: 'designer',
      minutes: 45,
      agenda: ['QA every variant with booster thumbnail qa.', 'Proof sheet at phone size against competitors.', 'Choose A and B for Test & Compare.'],
    },
    {
      when: reviewWhen,
      name: '48-hour review',
      owner: 'analyst',
      minutes: 20,
      agenda: ['booster postmortem with the numbers.', 'Repackage if the bottleneck is packaging.', 'Update the ledger.'],
    },
    {
      when: at(3),
      name: 'Weekly retro',
      owner: 'strategist',
      minutes: 30,
      agenda: ['Which lever won this week (idea, packaging, hook, retention)?', 'One rule added or removed from the playbook.', 'Next week\'s three ideas locked.'],
    },
  ]
}

export interface CalendarSlot {
  date: string
  idea: string
  kickoff: string
}

/** Lay ideas onto a publishing calendar: `perWeek` publishes starting from `start`. */
export function buildCalendar(ideas: string[], start: Date, perWeek: number, cycleDays = 14): CalendarSlot[] {
  const slots: CalendarSlot[] = []
  const gapDays = 7 / Math.max(1, perWeek)
  ideas.forEach((idea, i) => {
    const publish = new Date(start.getTime() + Math.round(i * gapDays) * 86_400_000)
    const kickoff = new Date(publish.getTime() - cycleDays * 86_400_000)
    slots.push({ date: publish.toISOString().slice(0, 10), idea, kickoff: kickoff.toISOString().slice(0, 10) })
  })
  return slots
}

export interface CalendarWarning {
  /** Monday of the week (ISO date). */
  weekStart: string
  count: number
  maxPerWeek: number
  reason?: string
  message: string
}

/** ISO date of the Monday starting the week that contains `date`. */
export function weekStartOf(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`)
  const back = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The cadence governor (R6): warn, never refuse, for every week that carries
 * more publishes than `maxPerWeek`. A written reason is required to proceed
 * above the cap [house]; the warning says so and quotes the reason when one
 * is given so the retro can see it.
 */
export function governCalendar(slots: Pick<CalendarSlot, 'date'>[], options: { maxPerWeek?: number; reason?: string } = {}): CalendarWarning[] {
  const maxPerWeek = options.maxPerWeek ?? 1
  const reason = options.reason?.trim() || undefined
  const counts = new Map<string, number>()
  for (const s of slots) {
    const week = weekStartOf(s.date)
    counts.set(week, (counts.get(week) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > maxPerWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, count]) => ({
      weekStart,
      count,
      maxPerWeek,
      reason,
      message: `Week of ${weekStart}: ${count} publishes, above maxPerWeek ${maxPerWeek} [house]. Fewer, better-optimised uploads is the doctrine; a written reason is required to proceed above the cap${reason ? `; reason given: "${reason}"` : '; none given (pass --reason)'}.`,
    }))
}
