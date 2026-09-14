import { describe, expect, it } from 'vitest'
import { buildCalendar, generateWorkflow, renderWorkflowMarkdown, slugify, weeklyCadence } from './workflow.js'

describe('generateWorkflow', () => {
  it('keeps the gate order and scales due days to the cycle', () => {
    const wf = generateWorkflow('I tried 30 days of cold showers', { format: 'challenge', days: 28 })
    expect(wf.slug).toBe('i-tried-30-days-of-cold-showers')
    expect(wf.stages.map((s) => s.id)).toEqual(['demand', 'packaging', 'story', 'plan', 'production', 'edit', 'thumbnail', 'publish', 'review48', 'postmortem'])
    for (let i = 1; i < wf.stages.length; i += 1) expect(wf.stages[i].dueDay).toBeGreaterThanOrEqual(wf.stages[i - 1].dueDay)
    expect(wf.stages.find((s) => s.id === 'publish')!.dueDay).toBe(21)
    expect(wf.stages.find((s) => s.id === 'production')!.checklist.join(' ')).toMatch(/failures are the retention/)
  })

  it('renders a runbook with dates when a kickoff is given', () => {
    const md = renderWorkflowMarkdown(generateWorkflow('Test idea', { days: 14 }), new Date('2026-09-14T00:00:00Z'))
    expect(md).toContain('# Workflow: Test idea')
    expect(md).toContain('| 1 | Demand check | strategist | 2026-09-14 |')
    expect(md).toContain('- [ ] ')
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
})
