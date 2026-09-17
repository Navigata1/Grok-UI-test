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
  it('scores titles with --json before the positional', async () => {
    const { code, out } = await run(['titles', '--json', 'cold showers', '--number', '30 days'])
    expect(code).toBe(0)
    expect(JSON.parse(out).length).toBeGreaterThanOrEqual(10)
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
