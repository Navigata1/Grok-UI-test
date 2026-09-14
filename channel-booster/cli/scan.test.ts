import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/booster.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, '..', 'examples')
const competitors = path.join(examples, 'competitors.csv')
const myChannel = path.join(examples, 'my-channel.csv')
/** Fixed clock: the fixtures span 2026-02..2026-08, so a 90-day window leaves only the last few rows in it. */
const NOW = '2026-09-14T08:00:00Z'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-scan-'))
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

async function json(argv: string[]): Promise<Record<string, any>> {
  const { code, out } = await run([...argv, '--json'])
  expect(code).toBe(0)
  return JSON.parse(out)
}

/** The competitor export plus a four-day-old video already at 4x the median: a fresh-tier row. */
function withFreshRow(): string {
  const file = path.join(tmp, 'fresh.csv')
  writeFileSync(file, `${readFileSync(competitors, 'utf8').trimEnd()}\nVan Life Budget Build Day 1,180000,2026-09-10,VanLifeCo,12:00\n`)
  return file
}

describe('booster outliers (v2)', () => {
  it('keeps the shipped JSON keys and adds the window, stale flags and fresh list', async () => {
    const parsed = await json(['outliers', competitors, '--now', NOW, '--top', '3'])
    expect(parsed.threshold).toBe(10)
    expect(parsed.sinceDays).toBe(90)
    expect(parsed.scannedAt).toBe('2026-09-14T08:00:00.000Z')
    expect(parsed.ranked).toHaveLength(3)
    expect(parsed.ranked[0].tier).toBe('outlier')
    expect(parsed.ranked[0].stale).toBe(true)
    expect(typeof parsed.ranked[0].velocityMultiplier).toBe('number')
    expect(parsed.summary.map((s: any) => s.channel)).toEqual(['VanLifeCo', 'OffGridLab'])
    expect(parsed.summary[0]).toMatchObject({ videos: 10, inWindow: 2 })
    expect(parsed.staleCount).toBe(18)
    expect(Array.isArray(parsed.fresh)).toBe(true)
    expect(parsed.formatLift[0]).toHaveProperty('thin')
    expect(parsed).not.toHaveProperty('topics')
    expect(parsed).not.toHaveProperty('diff')
    expect(parsed).not.toHaveProperty('saturation')
    expect(parsed).not.toHaveProperty('savedTo')
  })

  it('honours --since, --threshold and --min-age-days', async () => {
    const wide = await json(['outliers', competitors, '--now', NOW, '--since', '365', '--threshold', '20', '--min-age-days', '1'])
    expect(wide.sinceDays).toBe(365)
    expect(wide.threshold).toBe(20)
    expect(wide.minAgeDays).toBe(1)
    expect(wide.staleCount).toBe(0)
    expect(wide.ranked.every((r: any) => r.stale === false)).toBe(true)
    expect(wide.ranked.filter((r: any) => r.tier === 'outlier').length).toBeLessThan(
      (await json(['outliers', competitors, '--now', NOW, '--since', '365'])).ranked.filter((r: any) => r.tier === 'outlier').length,
    )
    await expect(main(['outliers', competitors, '--since', '0'])).rejects.toThrow(/--since must be a positive/)
  })

  it('prints the tier, velocity and stale flag in the table', async () => {
    const { code, out } = await run(['outliers', competitors, '--now', NOW, '--top', '2'])
    expect(code).toBe(0)
    expect(out).toMatch(/Outlier scan · threshold 10x · window 90d · 20 videos \(18 stale, 0 fresh\) · as of 2026-09-14/)
    expect(out).toMatch(/VanLifeCo: 10 videos \(2 in window\), median 46\.5K views/)
    expect(out).toMatch(/Rank {2}Mult {3}Tier {5}Vel {4}Flag {3}Views/)
    expect(out).toMatch(/ {3}1 {3}55\.9x outlier {2}\d+\.\dx {2}stale +1\.9M {2}challenge,negative,first-person I Tried Every Portable Power Station/)
    expect(out).toMatch(/smoothed lift/)
    expect(out).toMatch(/thin\)/)
    expect(out).not.toMatch(/Saved scan/)
  })

  it('marks a young, fast video as fresh and leads with it under --fresh', async () => {
    const file = withFreshRow()
    const all = await json(['outliers', file, '--now', NOW, '--top', '30'])
    expect(all.fresh).toHaveLength(1)
    expect(all.fresh[0]).toMatchObject({ title: 'Van Life Budget Build Day 1', tier: 'fresh', stale: false })
    // Too-young rows rank by velocity multiplier, so the plain view leads with it too, stale rows and all ...
    expect(all.ranked[0].tier).toBe('fresh')
    expect(all.ranked.some((r: any) => r.stale)).toBe(true)
    expect(all.ranked.length).toBe(21)

    const momentum = await json(['outliers', file, '--now', NOW, '--fresh'])
    // ... while the momentum view hides stale rows and keeps the fresh tier first.
    expect(momentum.ranked[0].tier).toBe('fresh')
    expect(momentum.ranked.every((r: any) => r.stale === false)).toBe(true)
    expect(momentum.ranked.length).toBe(3)

    const { out } = await run(['outliers', file, '--now', NOW, '--fresh'])
    expect(out).toMatch(/\(18 stale, 1 fresh\)/)
    expect(out).toMatch(/Momentum view: 18 stale rows hidden, fresh tier first\./)
    expect(out).toMatch(/ {3}1 .*fresh .*Van Life Budget Build Day 1/)
    expect(out).toMatch(/Fresh momentum \(age <= 21d, velocity >= 3x channel median \[house\]\):\n .*VanLifeCo .*Van Life Budget Build Day 1/)
  })

  it('groups the ranked rows by topic with --by topic', async () => {
    const parsed = await json(['outliers', competitors, '--now', NOW, '--by', 'topic', '--top', '4'])
    expect(parsed.topics.length).toBeGreaterThan(4)
    expect(parsed.topics[0]).toMatchObject({ topicKey: 'portable+station', count: 1, channels: ['OffGridLab'], stale: 1, fresh: 0 })
    expect(parsed.topics.find((t: any) => t.topicKey === 'generator+solar')).toMatchObject({ count: 2, bestTitle: 'How I Built a Solar Generator for $300' })

    const { out } = await run(['outliers', competitors, '--now', NOW, '--by', 'topic', '--top', '4'])
    expect(out).toMatch(/Topic demand/)
    expect(out).toMatch(/Best {3}Rows {2}Fresh {2}Stale {2}Channels/)
    expect(out).toMatch(/55\.9x {4}1 {6}0 {6}1 {2}OffGridLab .*portable\+station .*I Tried Every Portable Power Station/)
    // --top caps the topic table too.
    expect(out.split('\n').filter((l) => /^ +\d+\.\dx +\d+ +\d+ +\d+ {2}/.test(l))).toHaveLength(4)
    // The boolean spelling works as well.
    expect((await json(['outliers', competitors, '--now', NOW, '--by-topic'])).topics[0].topicKey).toBe('portable+station')
  })

  it('reports format saturation inside the window with --saturation', async () => {
    const parsed = await json(['outliers', competitors, '--now', NOW, '--since', '365', '--saturation'])
    expect(parsed.saturation.length).toBeGreaterThan(0)
    for (const s of parsed.saturation) {
      expect(s.totalChannels).toBe(2)
      expect(s.saturated).toBe(s.share >= 0.5)
    }
    const negative = parsed.saturation.find((s: any) => s.format === 'negative')
    expect(negative).toMatchObject({ channels: 2, share: 1, saturated: true })

    const { out } = await run(['outliers', competitors, '--now', NOW, '--since', '365', '--saturation'])
    expect(out).toMatch(/Format saturation \(share of channels carrying a format inside 365d; >= 50% is a copy, not a trend \[house\]\)/)
    expect(out).toMatch(/negative {8} 2\/2 channels {2}100% {2}saturated/)

    // Two in-window rows with no format cues: say so instead of printing an empty table.
    const narrow = await run(['outliers', competitors, '--now', NOW, '--saturation'])
    expect(narrow.out).toMatch(/No in-window title carries a format cue/)
  })

  it('writes the scan with --save and reads it back with --diff', async () => {
    const saved = path.join(tmp, 'nested', 'last-scan.json')
    const first = await json(['outliers', competitors, '--now', NOW, '--save', saved])
    expect(first.savedTo).toBe(saved)
    const doc = JSON.parse(readFileSync(saved, 'utf8'))
    expect(Object.keys(doc).sort()).toEqual(['ranked', 'scannedAt', 'sinceDays'])
    expect(doc.scannedAt).toBe('2026-09-14T08:00:00.000Z')
    expect(doc.sinceDays).toBe(90)
    // The full ranked list is saved, not the --top slice, so the next diff sees every row.
    expect(doc.ranked).toHaveLength(20)
    expect(doc.ranked[0]).toMatchObject({ tier: 'outlier', stale: true })

    const text = await run(['outliers', competitors, '--now', NOW, '--save', saved])
    expect(text.out).toMatch(new RegExp(`Saved scan to ${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    // A week later: one new upload, one video that kept climbing.
    const next = path.join(tmp, 'next.csv')
    const bumped = readFileSync(competitors, 'utf8').replace('Generator vs Solar: Which Is Cheaper?,290000', 'Generator vs Solar: Which Is Cheaper?,900000')
    writeFileSync(next, `${bumped.trimEnd()}\nVan Life Budget Build Day 1,180000,2026-09-17,VanLifeCo,12:00\n`)
    const later = await json(['outliers', next, '--now', '2026-09-21T08:00:00Z', '--diff', saved])
    expect(later.diff.added.map((r: any) => r.title)).toEqual(['Van Life Budget Build Day 1'])
    expect(later.diff.removed).toEqual([])
    expect(later.diff.changed).toHaveLength(1)
    expect(later.diff.changed[0]).toMatchObject({ before: expect.closeTo(8.5, 1), tierBefore: 'strong', tierAfter: 'outlier' })
    expect(later.diff.changed[0].row.title).toBe('Generator vs Solar: Which Is Cheaper?')
    expect(later.diff.changed[0].delta).toBeGreaterThan(10)
    // --diff alone does not overwrite the saved scan.
    expect(JSON.parse(readFileSync(saved, 'utf8')).ranked).toHaveLength(20)

    const { out } = await run(['outliers', next, '--now', '2026-09-21T08:00:00Z', '--diff', saved])
    expect(out).toMatch(/Since last scan \(scanned 2026-09-14T08:00:00\.000Z, window 90d\): 1 new, 0 gone, 1 moved by >= 0\.5x \[house\]/)
    expect(out).toMatch(/New:\n {4}\+ .*fresh .*VanLifeCo · Van Life Budget Build Day 1/)
    expect(out).toMatch(/Moved:\n {4}↑ 8\.5x -> 26\.5x \(strong -> outlier\) OffGridLab · Generator vs Solar/)
  })

  it('diffs against an unchanged scan as "nothing moved" and can save and diff in one run', async () => {
    const saved = path.join(tmp, 'last-scan.json')
    await json(['outliers', competitors, '--now', NOW, '--save', saved])
    const again = await json(['outliers', competitors, '--now', NOW, '--diff', saved, '--save', saved])
    expect(again.diff).toEqual({ added: [], removed: [], changed: [] })
    expect(again.savedTo).toBe(saved)
    const { out } = await run(['outliers', competitors, '--now', NOW, '--diff', saved])
    expect(out).toMatch(/Nothing moved\./)
  })

  it('warns and continues when --diff points at a scan that does not exist yet', async () => {
    const missing = path.join(tmp, 'none.json')
    const { code, out, err } = await run(['outliers', competitors, '--now', NOW, '--diff', missing, '--json'])
    expect(code).toBe(0)
    expect(err).toMatch(/no previous scan at .*none\.json; nothing to diff \(add --save/)
    expect(JSON.parse(out).diff).toBeNull()
    expect(existsSync(missing)).toBe(false)

    writeFileSync(missing, '{"ranked": "nope"}')
    await expect(main(['outliers', competitors, '--diff', missing])).rejects.toThrow(/not a saved scan/)
    writeFileSync(missing, 'not json')
    await expect(main(['outliers', competitors, '--diff', missing])).rejects.toThrow(/not valid JSON/)
  })

  it('bare --save lands in the --data store directory', async () => {
    const data = path.join(tmp, 'data')
    const parsed = await json(['outliers', competitors, '--now', NOW, '--data', data, '--save'])
    const expected = path.join(data, 'last-scan.json')
    expect(parsed.savedTo).toBe(expected)
    expect(JSON.parse(readFileSync(expected, 'utf8')).ranked).toHaveLength(20)
  })

  it('resolves a bare --save name into the store and a path with a separator against the cwd', async () => {
    const data = path.join(tmp, 'data')
    const cwd = path.join(tmp, 'run')
    mkdirSync(cwd, { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)

    const named = await json(['outliers', competitors, '--now', NOW, '--data', data, '--save', 'monday.json'])
    expect(named.savedTo).toBe(path.join(data, 'monday.json'))
    expect(existsSync(path.join(data, 'monday.json'))).toBe(true)

    const nested = await json(['outliers', competitors, '--now', NOW, '--data', data, '--save', 'scans/monday.json'])
    expect(nested.savedTo).toBe(path.join(cwd, 'scans', 'monday.json'))
    expect(existsSync(path.join(cwd, 'scans', 'monday.json'))).toBe(true)
  })

  it('finds the store copy behind a --diff path written from the repo root, and names the file it read', async () => {
    const data = path.join(tmp, 'data')
    const cwd = path.join(tmp, 'run')
    mkdirSync(cwd, { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    await json(['outliers', competitors, '--now', NOW, '--data', data, '--save'])

    const stored = path.join(data, 'last-scan.json')
    const diffed = await json(['outliers', competitors, '--now', NOW, '--data', data, '--diff', 'data/last-scan.json'])
    expect(diffed.diffedFrom).toBe(stored)
    expect(diffed.diff).toEqual({ added: [], removed: [], changed: [] })
    // Nothing was written into the cwd: the documented spelling reaches the --data store.
    expect(existsSync(path.join(cwd, 'data', 'last-scan.json'))).toBe(false)

    const { out } = await run(['outliers', competitors, '--now', NOW, '--data', data, '--diff', 'data/last-scan.json'])
    expect(out).toContain(`  read from ${stored}`)
  })

  it('still requires a csv', async () => {
    await expect(main(['outliers'])).rejects.toThrow(/usage: booster outliers <csv>/)
  })
})

describe('booster audit (v2)', () => {
  it('audits the own-channel export with the same flags and keeps the proven-formats tail', async () => {
    const parsed = await json(['audit', myChannel, '--now', NOW, '--since', '365', '--by', 'topic', '--saturation'])
    expect(parsed.threshold).toBe(5)
    expect(parsed.sinceDays).toBe(365)
    expect(parsed.summary).toEqual([{ channel: 'default', videos: 10, inWindow: 10, median: 3850 }])
    expect(parsed.ranked[0]).toMatchObject({ title: 'I Tried Sleeping in the Camper for 7 Nights', tier: 'outlier', stale: false })
    expect(parsed.topics[0].topicKey).toBe('camper+sleeping')
    expect(parsed.saturation.every((s: any) => s.totalChannels === 1)).toBe(true)

    const { code, out } = await run(['audit', myChannel, '--now', NOW, '--since', '365'])
    expect(code).toBe(0)
    expect(out).toMatch(/Channel audit · threshold 5x · window 365d · 10 videos \(0 stale, 0 fresh\)/)
    expect(out).toMatch(/default: 10 videos \(10 in window\), median 3\.9K views/)
    expect(out).toMatch(/Your proven formats: .*Brief a sequel to each winner before trying a new topic\./)
  })

  it('saves to its own default file so a bare --save never overwrites the competitor scan', async () => {
    const data = path.join(tmp, 'data')
    const scan = await json(['outliers', competitors, '--now', NOW, '--data', data, '--save'])
    expect(scan.savedTo).toBe(path.join(data, 'last-scan.json'))
    const audit = await json(['audit', myChannel, '--now', NOW, '--data', data, '--save'])
    expect(audit.savedTo).toBe(path.join(data, 'last-audit.json'))

    // The competitor scan is still the competitor scan: 20 ranked rows, not the 10 own uploads.
    expect(JSON.parse(readFileSync(path.join(data, 'last-scan.json'), 'utf8')).ranked).toHaveLength(20)
    expect(JSON.parse(readFileSync(path.join(data, 'last-audit.json'), 'utf8')).ranked).toHaveLength(10)
    const again = await json(['outliers', competitors, '--now', NOW, '--data', data, '--diff', 'last-scan.json'])
    expect(again.diff).toEqual({ added: [], removed: [], changed: [] })

    const { out } = await run(['audit', myChannel, '--now', NOW, '--data', data, '--save'])
    expect(out).toContain(`Saved scan to ${path.join(data, 'last-audit.json')}`)
  })

  it('names the threshold in the no-winner message', async () => {
    const { out } = await run(['audit', myChannel, '--now', NOW, '--threshold', '50'])
    expect(out).toMatch(/No video is 50x your median yet: the next win is a packaging win, not a production win\./)
  })
})
