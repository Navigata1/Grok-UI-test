/** Commands: workflow, cadence, calendar. */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildCalendar, generateWorkflow, renderWorkflowMarkdown, weeklyCadence, WORKFLOW_FORMATS } from '../../src/workflow.js'
import type { WorkflowFormat } from '../../src/types.js'
import { list, num, out, str, warn, type CommandModule } from '../shared.js'

export const workflowModule: CommandModule = {
  verbs: ['workflow', 'cadence', 'calendar'],
  help: [
    'workflow "<idea>" [--format talking-head] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]',
    'cadence                                                            the weekly operating rhythm',
    'calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14]',
  ],
  async run(cmd, sub, _rest, flags) {
    if (cmd === 'workflow') {
      const idea = sub
      if (!idea) throw new Error('usage: booster workflow "<idea>" [--format ..] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]')
      const format = (str(flags, 'format') ?? 'talking-head') as WorkflowFormat
      if (!WORKFLOW_FORMATS.includes(format)) throw new Error(`format must be one of ${WORKFLOW_FORMATS.join(', ')}`)
      const wf = generateWorkflow(idea, { format, days: num(flags, 'days') })
      const kickoffText = str(flags, 'kickoff')
      const kickoff = kickoffText ? new Date(`${kickoffText}T00:00:00Z`) : undefined
      const md = renderWorkflowMarkdown(wf, kickoff)
      const dir = str(flags, 'out')
      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, `${wf.slug}.md`), md)
        writeFileSync(path.join(dir, `${wf.slug}.json`), `${JSON.stringify(wf, null, 2)}\n`)
        warn(`wrote ${path.join(dir, wf.slug)}.md and .json`)
      }
      out(wf, flags, () => md)
      return 0
    }
    if (cmd === 'cadence') {
      const rituals = weeklyCadence()
      out(rituals, flags, () => rituals.map((r) => [`${r.when} · ${r.name} (${r.owner}, ${r.minutes} min)`, ...r.agenda.map((a) => `  - ${a}`)].join('\n')).join('\n\n'))
      return 0
    }
    const ideas = list(flags, 'ideas')
    const start = str(flags, 'start')
    if (!ideas || !start) throw new Error('usage: booster calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14]')
    const slots = buildCalendar(ideas, new Date(`${start}T00:00:00Z`), num(flags, 'per-week') ?? 1, num(flags, 'cycle-days') ?? 14)
    out(slots, flags, () => ['Publish     Kickoff     Idea', ...slots.map((s) => `${s.date}  ${s.kickoff}  ${s.idea}`)].join('\n'))
    return 0
  },
}
