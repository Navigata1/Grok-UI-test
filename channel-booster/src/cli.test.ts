import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, parseArgs } from '../cli/booster.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, '..', 'examples')

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  try {
    const code = await main(argv)
    return { code, out }
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => vi.restoreAllMocks())

describe('parseArgs', () => {
  it('keeps positionals after boolean flags and supports --key=value', () => {
    const a = parseArgs(['titles', '--json', 'cold showers', '--number=30 days', '--subject', 'Jackery'])
    expect(a.positional).toEqual(['titles', 'cold showers'])
    expect(a.flags).toEqual({ json: true, number: '30 days', subject: 'Jackery' })
  })
  it('treats a trailing value flag as boolean', () => {
    expect(parseArgs(['workflow', 'x', '--out']).flags.out).toBe(true)
  })
})

describe('main', () => {
  it('prints help', async () => {
    const { code, out } = await run(['help'])
    expect(code).toBe(0)
    expect(out).toMatch(/outliers <csv>/)
  })
  it('runs outliers on the example export as JSON', async () => {
    const { code, out } = await run(['outliers', path.join(examples, 'competitors.csv'), '--json', '--top', '3'])
    expect(code).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.ranked).toHaveLength(3)
    expect(parsed.ranked[0].tier).toBe('outlier')
  })
  it('prints title shapes with --json before the positional: a blank, no score, template true', async () => {
    const { code, out } = await run(['titles', '--json', 'cold showers', '--number', '30 days'])
    expect(code).toBe(0)
    const shapes = JSON.parse(out)
    expect(shapes.length).toBeGreaterThanOrEqual(10)
    expect(shapes[0]).toEqual({ title: 'I Tried ___ for 30 days', formula: 'first-person test', example: 'I Tried 30 Days of Cold Showers', template: true, score: null })
    expect(shapes.every((s: { title: string; template: boolean; score: null }) => s.title.includes('___') && s.template === true && s.score === null)).toBe(true)
  })
  it('prints shapes, not a ranked score table, and says to write and score your own', async () => {
    const { code, out } = await run(['titles', 'living off a $300 solar generator', '--number', '30 Days'])
    expect(code).toBe(0)
    const lines = out.trimEnd().split('\n')
    expect(lines[0]).toBe('Title shapes for "living off a $300 solar generator": templates with a blank, not titles, so no scores and no ranking.')
    expect(out).not.toMatch(/^Score\b/m)
    expect(out).not.toContain('solar generator Until It Worked')
    expect(out).toMatch(/^ {2}I Did ___ Until It Worked +until\/stakes, e\.g\. "I Took Cold Showers Until It Worked"$/m)
    expect(lines.at(-1)).toBe('Write your own title in one of these shapes, in your own words, then score it: booster titles score "<your title>".')
  })
  it('holds a pasted-in template fill under the title gate in titles score', async () => {
    const { out } = await run(['titles', 'score', '--json', 'I Did A $300 solar generator Until It Worked'])
    const scored = JSON.parse(out)
    expect(scored.score).toBeLessThan(60)
    expect(scored.notes).toContain('template fill: "Did A" starts the pasted-in topic with its article; no article belongs after "Did" here')
  })
  it('diagnoses and reviews a package', async () => {
    const pm = await run(['postmortem', '--json', '--impressions', '24000', '--ctr', '2.1', '--avp', '44', '--hours', '48', '--baseline-ctr', '4.5', '--baseline-avp', '40', '--baseline-views', '6000'])
    expect(JSON.parse(pm.out).bottleneck).toBe('packaging')
    const pr = await run(['package', 'review', '--json', '--title', 'I Lived Off a $300 Solar Generator for 30 Days', '--thumb-text', 'Day 30'])
    expect(JSON.parse(pr.out).verdict).toBe('pass')
  })
  it('rejects an unknown command', async () => {
    await expect(main(['nope'])).rejects.toThrow(/unknown command/)
  })
})
