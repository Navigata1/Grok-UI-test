import type { Workflow, WorkflowFormat, WorkflowStage } from './types.js'

export const WORKFLOW_FORMATS: WorkflowFormat[] = ['talking-head', 'documentary', 'tutorial', 'challenge', 'vlog', 'listicle', 'interview']

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

/**
 * Generate the production workflow for one video. Stage due days scale with
 * the cycle length; the order never changes because the gates depend on it:
 * demand before packaging, packaging before script, script before shoot.
 */
export function generateWorkflow(idea: string, options: { format?: WorkflowFormat; days?: number } = {}): Workflow {
  const format = options.format ?? 'talking-head'
  const days = options.days ?? 14
  const day = (fraction: number) => Math.round(fraction * days)
  const extras = FORMAT_EXTRAS[format]

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
    },
  ]

  return { idea, slug: slugify(idea), format, stages, timelineDays: days }
}

/** Render a workflow as a Markdown runbook. */
export function renderWorkflowMarkdown(wf: Workflow, kickoff?: Date): string {
  const lines: string[] = []
  lines.push(`# Workflow: ${wf.idea}`)
  lines.push('')
  lines.push(`Format: ${wf.format} · Cycle: ${wf.timelineDays} days · Slug: ${wf.slug}`)
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
  }
  return lines.join('\n')
}

export interface CadenceRitual {
  when: string
  name: string
  owner: WorkflowStage['owner']
  minutes: number
  agenda: string[]
}

/** The weekly operating cadence the workflow plugs into. */
export function weeklyCadence(): CadenceRitual[] {
  return [
    {
      when: 'Monday',
      name: 'Outlier scan and idea bank',
      owner: 'strategist',
      minutes: 60,
      agenda: ['Export or refresh competitor CSVs; run booster outliers.', 'Add every >= 5x video to the idea bank with its format cues.', 'Score the top five new ideas; promote greens to the packaging sprint.'],
    },
    {
      when: 'Tuesday',
      name: 'Packaging sprint',
      owner: 'strategist',
      minutes: 90,
      agenda: ['10 titles and 3 thumbnail concepts per green idea.', 'Packaging review with the designer.', 'Pick the pair; open the workflow.'],
    },
    {
      when: 'Wednesday to Friday',
      name: 'Production block',
      owner: 'creator',
      minutes: 480,
      agenda: ['Shoot to the shot list.', 'Thumbnail photos at the emotional peak.', 'Hand off with the story spine.'],
    },
    {
      when: 'Friday',
      name: 'Thumbnail review',
      owner: 'designer',
      minutes: 45,
      agenda: ['QA every variant with booster thumbnail qa.', 'Proof sheet at phone size against competitors.', 'Choose A and B for Test & Compare.'],
    },
    {
      when: '48 hours after each publish',
      name: '48-hour review',
      owner: 'analyst',
      minutes: 20,
      agenda: ['booster postmortem with the numbers.', 'Repackage if the bottleneck is packaging.', 'Update the ledger.'],
    },
    {
      when: 'Sunday',
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
