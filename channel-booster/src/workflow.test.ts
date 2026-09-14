import { describe, expect, it } from 'vitest'
import type { WorkflowStatusDoc } from './schema.js'
import { thresholds } from './thresholds.js'
import type { GatePredicate } from './types.js'
import {
  assertRunnable,
  buildCalendar,
  describeGate,
  describeRun,
  generateWorkflow,
  getJsonPath,
  governCalendar,
  newWorkflowStatus,
  nextRunnable,
  publishDaysFor,
  renderWorkflowMarkdown,
  renderWorkflowStatus,
  resolveCommand,
  shiftWeekday,
  slugify,
  weeklyCadence,
  weekStartOf,
} from './workflow.js'

const NOW = new Date('2026-09-14T09:00:00Z')

describe('generateWorkflow', () => {
  it('keeps the gate order and scales due days to the cycle', () => {
    const wf = generateWorkflow('I tried 30 days of cold showers', { format: 'challenge', days: 28 })
    expect(wf.slug).toBe('i-tried-30-days-of-cold-showers')
    expect(wf.stages.map((s) => s.id)).toEqual(['demand', 'packaging', 'story', 'plan', 'production', 'edit', 'thumbnail', 'publish', 'review48', 'postmortem'])
    for (let i = 1; i < wf.stages.length; i += 1) expect(wf.stages[i].dueDay).toBeGreaterThanOrEqual(wf.stages[i - 1].dueDay)
    expect(wf.stages.find((s) => s.id === 'publish')!.dueDay).toBe(21)
    expect(wf.stages.find((s) => s.id === 'production')!.checklist.join(' ')).toMatch(/failures are the retention/)
  })

  it('keeps the prose gate and gives every stage a run and a check', () => {
    const wf = generateWorkflow('Test idea')
    for (const s of wf.stages) {
      expect(typeof s.gate).toBe('string')
      expect(s.gate.length).toBeGreaterThan(10)
      expect(s.run).toBeDefined()
      expect(s.check).toBeDefined()
      expect(s.run!.artifact).toMatch(/^[a-z0-9.-]+$/i)
    }
  })

  it('makes the agent stages booster commands with <slug> placeholders and the creative stages human with evidence files', () => {
    const wf = generateWorkflow('Test idea')
    const byId = Object.fromEntries(wf.stages.map((s) => [s.id, s]))
    for (const id of ['demand', 'packaging', 'story', 'plan', 'thumbnail', 'publish', 'review48', 'postmortem']) {
      const run = byId[id].run!
      expect(run.kind).toBe('command')
      expect(run.command!.slice(0, 4)).toEqual(['npm', 'run', 'booster', '--'])
      expect(run.command!.join(' ')).toContain('<slug>')
      expect(run.evidence).toBeUndefined()
    }
    expect(byId.plan.run).toEqual({ kind: 'command', command: ['npm', 'run', 'booster', '--', 'plan', 'shots', '<slug>', '--format', 'talking-head'], artifact: 'shots.md' })
    expect(generateWorkflow('Test idea', { format: 'challenge' }).stages.find((s) => s.id === 'plan')!.run!.command!.slice(-1)).toEqual(['challenge'])
    expect(byId.production.run).toEqual({ kind: 'human', artifact: 'footage.txt', evidence: 'footage.txt' })
    expect(byId.edit.run).toEqual({ kind: 'human', artifact: 'cut.txt', evidence: 'cut.txt' })
    expect(byId.plan.check).toEqual({
      kind: 'all-of',
      checks: [
        { kind: 'file-exists', path: 'shots.md' },
        { kind: 'json-path-min', path: 'story.json', jsonPath: 'payoffLadder.length', min: 1 },
      ],
    })
  })

  it('gates the story on the hook threshold and the promise, and the package on gateReport.pass', () => {
    const wf = generateWorkflow('Test idea')
    const story = wf.stages.find((s) => s.id === 'story')!.check as Extract<GatePredicate, { kind: 'all-of' }>
    expect(story.kind).toBe('all-of')
    expect(story.checks).toContainEqual({ kind: 'json-path-min', path: 'story.json', jsonPath: 'hookScore', min: thresholds.hookGateScore.value })
    expect(story.checks).toContainEqual({ kind: 'json-path-eq', path: 'story.json', jsonPath: 'promiseInFirst25Words', value: true })
    const pkg = wf.stages.find((s) => s.id === 'packaging')!.check as Extract<GatePredicate, { kind: 'all-of' }>
    expect(pkg.checks).toContainEqual({ kind: 'json-path-eq', path: 'package.json', jsonPath: 'gateReport.pass', value: true })
    expect(wf.stages.find((s) => s.id === 'review48')!.check).toEqual({ kind: 'json-path-eq', path: 'review-48.json', jsonPath: 'bucket', value: '48' })
    expect(wf.stages.find((s) => s.id === 'postmortem')!.check).toEqual({ kind: 'json-path-eq', path: 'review-168.json', jsonPath: 'bucket', value: '168' })
  })

  it('scores the banked idea by slug and gates demand on the score and a person\'s approval', () => {
    const demand = generateWorkflow('Test idea').stages.find((s) => s.id === 'demand')!
    expect(demand.run).toEqual({ kind: 'command', command: ['npm', 'run', 'booster', '--', 'idea', 'score', '<slug>', '--out', '<dir>/demand.json'], artifact: 'demand.json' })
    expect(demand.check).toEqual({
      kind: 'all-of',
      checks: [
        { kind: 'json-path-eq', path: 'demand.json', jsonPath: 'verdict', value: 'green' },
        { kind: 'json-path-eq', path: 'demand.json', jsonPath: 'status', value: 'green' },
      ],
    })
    expect(demand.checklist.join(' ')).toMatch(/booster bank approve "<idea>" --yes/)
  })

  it('carries the scheduled-review confirmation into the publish command so its gate is reachable', () => {
    const publish = generateWorkflow('Test idea').stages.find((s) => s.id === 'publish')!
    expect(publish.run!.command).toEqual(['npm', 'run', 'booster', '--', 'publish', 'check', '<slug>', '--review-scheduled'])
    expect(publish.checklist.join(' ')).toMatch(/Put the 48-hour review on the calendar/)
  })

  it('renders a runbook with dates when a kickoff is given', () => {
    const md = renderWorkflowMarkdown(generateWorkflow('Test idea', { days: 14 }), new Date('2026-09-14T00:00:00Z'))
    expect(md).toContain('# Workflow: Test idea')
    expect(md).toContain('| 1 | Demand check | strategist | 2026-09-14 |')
    expect(md).toContain('- [ ] ')
  })

  it('prints the resolved command and the machine check for every stage in the runbook', () => {
    const md = renderWorkflowMarkdown(generateWorkflow('Test idea'))
    expect(md).toContain('Run: `npm run booster -- package build test-idea`')
    expect(md).toContain('Run: `npm run booster -- plan shots test-idea --format talking-head`')
    expect(md).toContain('Run: `human step; evidence: packages/test-idea/footage.txt`')
    expect(md).toContain('Check: story.json: hookScore >= 70 and story.json: promiseInFirst25Words == true')
    expect(md).toContain('workflow run test-idea --next --agent <name>')
    expect(md).not.toContain('<slug>')
  })
})

describe('resolveCommand, describeGate, describeRun, getJsonPath', () => {
  it('substitutes every placeholder', () => {
    expect(resolveCommand(['x', '<slug>', '--out', '<dir>/a.json', 'a<slug>b'], 'my-video')).toEqual(['x', 'my-video', '--out', 'packages/my-video/a.json', 'amy-videob'])
  })
  it('describes each predicate kind', () => {
    expect(describeGate(undefined)).toMatch(/no machine check/)
    expect(describeGate({ kind: 'file-exists', path: 'a.txt' })).toBe('a.txt exists')
    expect(describeGate({ kind: 'json-path-min', path: 'a.json', jsonPath: 'x.y', min: 3 })).toBe('a.json: x.y >= 3')
    expect(describeGate({ kind: 'json-path-eq', path: 'a.json', jsonPath: 'v', value: 'green' })).toBe('a.json: v == "green"')
    expect(describeGate({ kind: 'all-of', checks: [{ kind: 'file-exists', path: 'a' }, { kind: 'file-exists', path: 'b' }] })).toBe('a exists and b exists')
  })
  it('describes runs', () => {
    const wf = generateWorkflow('Test idea')
    expect(describeRun(wf.stages[0], wf.slug)).toBe('npm run booster -- idea score test-idea --out packages/test-idea/demand.json')
    expect(describeRun({ ...wf.stages[0], run: undefined }, wf.slug)).toMatch(/no run declared/)
  })
  it('reads dotted paths with indices', () => {
    const doc = { gateReport: { pass: true }, titles: [{ score: 71 }, { score: 40 }], n: 0 }
    expect(getJsonPath(doc, 'gateReport.pass')).toBe(true)
    expect(getJsonPath(doc, 'titles[1].score')).toBe(40)
    expect(getJsonPath(doc, 'n')).toBe(0)
    expect(getJsonPath(doc, 'titles[5].score')).toBeUndefined()
    expect(getJsonPath(doc, 'gateReport.pass.deeper')).toBeUndefined()
    expect(getJsonPath(null, 'a')).toBeUndefined()
  })
})

describe('slugify', () => {
  it('produces safe slugs', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world')
    expect(slugify('!!!')).toBe('video')
  })
})

describe('weeklyCadence and buildCalendar', () => {
  it('has six rituals and lays out a calendar with kickoffs before publish', () => {
    expect(weeklyCadence()).toHaveLength(6)
    const slots = buildCalendar(['A', 'B', 'C'], new Date('2026-10-01T00:00:00Z'), 2, 14)
    expect(slots.map((s) => s.date)).toEqual(['2026-10-01', '2026-10-05', '2026-10-08'])
    expect(slots[0].kickoff).toBe('2026-09-17')
  })

  it('anchors the default (Thursday, solo) cadence to real weekdays with the review two days after publish', () => {
    const rituals = weeklyCadence()
    expect(rituals.map((r) => r.when)).toEqual(['Monday', 'Tuesday', 'Wednesday to Friday', 'Friday', 'Saturday (48 hours after the Thursday publish)', 'Sunday'])
    expect(rituals[1].agenda.join(' ')).toMatch(/Solo mode: pick the pair 12 hours after the build/)
    expect(rituals[0].agenda.join(' ')).toMatch(/at most 3 greens/)
  })

  it('moves every ritual with the publish day and drops the solo gap when there is a second reviewer', () => {
    const rituals = weeklyCadence({ publishDay: 'mon', solo: false })
    expect(rituals.map((r) => r.when)).toEqual(['Friday', 'Saturday', 'Sunday to Tuesday', 'Tuesday', 'Wednesday (48 hours after the Monday publish)', 'Thursday'])
    expect(rituals[1].agenda).toContain('Packaging review with the designer.')
    expect(rituals[1].agenda.join(' ')).not.toMatch(/Solo mode/)
  })

  it('lists a review day for every publish when perWeek is above one', () => {
    const review = weeklyCadence({ publishDay: 'thu', perWeek: 2 }).find((r) => r.name === '48-hour review')!
    expect(review.when).toBe('Saturday and Wednesday (48 hours after each publish)')
    expect(publishDaysFor('thu', 2)).toEqual(['thu', 'mon'])
    expect(publishDaysFor('thu', 1)).toEqual(['thu'])
    expect(publishDaysFor('thu', 0)).toEqual(['thu'])
  })

  it('shifts weekdays in both directions', () => {
    expect(shiftWeekday('thu', 2)).toBe('sat')
    expect(shiftWeekday('mon', -3)).toBe('fri')
    expect(shiftWeekday('sun', 7)).toBe('sun')
  })
})

describe('governCalendar', () => {
  const slots = buildCalendar(['A', 'B', 'C', 'D'], new Date('2026-10-01T00:00:00Z'), 2, 14) // thu, mon, thu, mon

  it('is quiet at or below the cap', () => {
    expect(governCalendar(slots, { maxPerWeek: 2 })).toEqual([])
    expect(governCalendar(buildCalendar(['A', 'B'], new Date('2026-10-01T00:00:00Z'), 1), { maxPerWeek: 1 })).toEqual([])
  })

  it('warns per week above the cap and says a written reason is required', () => {
    const warnings = governCalendar(slots, { maxPerWeek: 1 })
    expect(warnings.map((w) => [w.weekStart, w.count])).toEqual([['2026-10-05', 2]])
    expect(warnings[0].message).toMatch(/2 publishes, above maxPerWeek 1 \[house\]/)
    expect(warnings[0].message).toMatch(/written reason is required/)
    expect(warnings[0].message).toMatch(/none given/)
    expect(warnings[0].reason).toBeUndefined()
  })

  it('quotes the reason when one is given and still warns', () => {
    const warnings = governCalendar(slots, { maxPerWeek: 1, reason: 'launch week, two lever tests' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].reason).toBe('launch week, two lever tests')
    expect(warnings[0].message).toMatch(/written reason is required/)
    expect(warnings[0].message).toContain('reason given: "launch week, two lever tests"')
    expect(governCalendar(slots, { maxPerWeek: 1, reason: '   ' })[0].message).toMatch(/none given/)
  })

  it('defaults to one per week and groups by Monday-based weeks', () => {
    expect(weekStartOf('2026-10-01')).toBe('2026-09-28')
    expect(weekStartOf('2026-10-05')).toBe('2026-10-05')
    expect(weekStartOf('2026-10-04')).toBe('2026-09-28')
    expect(governCalendar([{ date: '2026-10-04' }, { date: '2026-09-29' }]).map((w) => w.weekStart)).toEqual(['2026-09-28'])
  })
})

describe('status helpers', () => {
  const wf = generateWorkflow('Test idea')

  it('creates a pending status document keyed by slug', () => {
    const doc = newWorkflowStatus(wf, NOW)
    expect(doc.id).toBe('test-idea')
    expect(doc.stages.map((s) => s.status)).toEqual(Array(10).fill('pending'))
    expect(doc.updatedAt).toBe('2026-09-14T09:00:00.000Z')
    expect(nextRunnable(doc)).toBe('demand')
  })

  it('nextRunnable walks passed and overridden stages and returns undefined at the end', () => {
    const doc: WorkflowStatusDoc = newWorkflowStatus(wf, NOW)
    doc.stages[0].status = 'passed'
    doc.stages[1].status = 'overridden'
    expect(nextRunnable(doc)).toBe('story')
    doc.stages[2].status = 'failed'
    expect(nextRunnable(doc)).toBe('story')
    for (const s of doc.stages) s.status = 'passed'
    expect(nextRunnable(doc)).toBeUndefined()
  })

  it('assertRunnable refuses to skip a stage', () => {
    const doc = newWorkflowStatus(wf, NOW)
    expect(() => assertRunnable(doc, 'demand')).not.toThrow()
    expect(() => assertRunnable(doc, 'story')).toThrow(/"packaging"|"demand"/)
    expect(() => assertRunnable(doc, 'nope')).toThrow(/no stage "nope"/)
    doc.stages[0].status = 'passed'
    doc.stages[1].status = 'overridden'
    expect(() => assertRunnable(doc, 'story')).not.toThrow()
  })

  it('renders the status table', () => {
    const doc = newWorkflowStatus(wf, NOW)
    doc.stages[0] = { ...doc.stages[0], status: 'overridden', overrideReason: 'yellow with a named fix', agent: 'jony' }
    const text = renderWorkflowStatus(doc)
    expect(text).toContain('[o] demand      overridden by jony · override: yellow with a named fix')
    expect(text).toContain('Next: packaging')
  })
})
