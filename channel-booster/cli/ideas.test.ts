import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../cli/booster.js'
import { ideaId } from '../src/bank.js'
import { addRow, recordRead } from '../src/ledger.js'
import { openStore } from '../src/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, '..', 'examples')
const competitors = path.join(examples, 'competitors.csv')
const own = path.join(examples, 'my-channel.csv')
const NOW = '2026-07-01T00:00:00Z'
const now = new Date(NOW)

let data: string
beforeEach(() => { data = mkdtempSync(path.join(tmpdir(), 'booster-ideas-cli-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(data, { recursive: true, force: true }) })

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

/** Run with the temp store and a fixed clock; --json parsed. */
async function json(argv: string[]): Promise<any> {
  const { code, out } = await run([...argv, '--data', data, '--now', NOW, '--json'])
  expect(code).toBe(0)
  return JSON.parse(out)
}

async function text(argv: string[]): Promise<string> {
  const { code, out } = await run([...argv, '--data', data, '--now', NOW])
  expect(code).toBe(0)
  return out
}

/** Capture stdout even when main() rejects (the approve gate prints, then throws). */
async function failing(argv: string[]): Promise<{ out: string; error: string }> {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  try {
    await main([...argv, '--data', data, '--now', NOW])
    throw new Error('expected the command to fail')
  } catch (e) {
    return { out, error: e instanceof Error ? e.message : String(e) }
  } finally {
    spy.mockRestore()
  }
}

const MANUAL = 'demand=4,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

/** Six own videos in the ledger, one of them a >= 5x winner at 168 hours. */
function seedLedger(): void {
  const store = openStore(data)
  for (let i = 0; i < 6; i += 1) {
    const slug = `v${i}`
    addRow(store, { slug, title: i === 3 ? 'I Built a Cheap Camper' : `Video ${i}`, publishedAt: daysAgo((i + 2) * 7), now })
    recordRead(store, { slug, bucket: '168', read: { views: i === 3 ? 60_000 : 5_000 + i * 100 }, lever: 'l', now })
  }
}

describe('help', () => {
  it('lists the idea and bank commands', async () => {
    const { out } = await run(['help'])
    expect(out).toMatch(/idea score "<idea>" --score "demand=auto,\.\.\." --outliers <csv>/)
    for (const cmd of ['bank add', 'bank list', 'bank approve', 'bank park', 'bank reject', 'bank status', 'bank rescore', 'bank sequels', 'bank import', 'bank wip']) {
      expect(out).toContain(cmd)
    }
  })
})

describe('idea score', () => {
  it('still scores typed axes', async () => {
    const r = await json(['idea', 'score', 'Cold showers', '--score', MANUAL])
    expect(r.total).toBe(77)
    expect(r.verdict).toBe('green')
    expect(r.demand).toBeUndefined()
  })

  it('resolves demand=auto from the scan and prints the [house] reason with the evidence rows', async () => {
    const out = await text(['idea', 'score', 'solar generator budget build', '--score', 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4', '--outliers', competitors])
    expect(out).toContain('demand       ███·· 3/5')
    expect(out).toContain('Demand 3/5 (auto): 2 matches at >= 5x inside 90 days [house]')
    expect(out).toMatch(/32\.4x\s+57d\s+OffGridLab\s+How I Built a Solar Generator for \$300/)
    expect(out).toMatch(/8\.5x\s+15d\s+OffGridLab\s+Generator vs Solar: Which Is Cheaper\?/)
    expect(out).toContain('Total 72/100 · verdict YELLOW')
  })

  it('carries the suggestion in --json, honours the positional auto form and --since', async () => {
    const r = await json(['idea', 'score', 'van life budget build', '--score', 'auto,4,4,3,4,4', '--outliers', competitors])
    expect(r.score.demand).toBe(1)
    expect(r.demand).toMatchObject({ auto: true, score: 1, evidenceTag: 'house', windowDays: 90, staleMatches: 0 })
    expect(r.demand.reason).toMatch(/one match at >= 1x/)
    expect(r.demand.evidence.map((e: any) => e.title)).toEqual(['Why I Almost Quit Van Life'])
    const narrow = await json(['idea', 'score', 'solar generator', '--score', 'auto,4,4,3,4,4', '--outliers', competitors, '--since', '30'])
    expect(narrow.demand.windowDays).toBe(30)
    expect(narrow.demand.staleMatches).toBe(1)
    expect(narrow.demand.evidence).toHaveLength(1)
  })

  it('refuses demand=auto without a scan and says how to phrase the idea', async () => {
    const { error } = await failing(['idea', 'score', 'solar generator', '--score', 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'])
    expect(error).toMatch(/--outliers <competitors\.csv>/)
    expect(error).toMatch(/two key nouns/)
  })
})

describe('bank add and list', () => {
  it('banks an idea with demand=auto, keeps the evidence as sources, and lists it', async () => {
    const added = await json(['bank', 'add', 'solar generator', '--score', 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4', '--csv', competitors, '--series', 'Off-grid', '--promise', 'power for $300'])
    expect(added.id).toBe(ideaId('solar generator'))
    expect(added.status).toBe('banked')
    expect(added.topicKey).toBe('generator+solar')
    expect(added.scores.demand).toBe(3)
    expect(added.sources).toHaveLength(2)
    expect(added.sources[0]).toMatchObject({ title: 'How I Built a Solar Generator for $300', channel: 'OffGridLab', date: '2026-05-05' })
    expect(added.series).toBe('Off-grid')
    expect(added.promise).toBe('power for $300')
    expect(added.demand.reason).toMatch(/2 matches at >= 5x/)
    expect(added.total).toBe(72)
    expect(added.weakestAxis).toBe('demand')

    const listed = await json(['bank', 'list'])
    expect(listed.ideas).toHaveLength(1)
    expect(listed.ideas[0]).toMatchObject({ id: added.id, total: 72, status: 'banked' })
    expect(listed.ideas[0].verdict.verdict).toBe('yellow')
    expect(listed.warnings).toEqual([])

    const line = await text(['bank', 'list'])
    expect(line).toMatch(/^YELLOW\s+72\s+banked\s+solar generator\s+weakest: demand\s+sources: 2\s+idea:/m)
  })

  it('prints the auto demand line on add and refuses demand=auto without --csv', async () => {
    const out = await text(['bank', 'add', 'solar generator', '--score', 'auto,4,4,3,4,4', '--csv', competitors])
    expect(out).toMatch(/^idea:\w+ banked generator\+solar total 72 weakest demand verdict YELLOW$/m)
    expect(out).toContain('Demand 3/5 (auto): 2 matches at >= 5x inside 90 days [house]')
    const { error } = await failing(['bank', 'add', 'solar generator', '--score', 'auto,4,4,3,4,4'])
    expect(error).toMatch(/--csv <competitors\.csv>/)
  })

  it('filters by status, sorts, and pins sequels first unless --no-sequel-first', async () => {
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    await json(['bank', 'add', 'Bad idea', '--score', 'demand=1,packaging=1,fit=1,angle=1,payoff=1,feasibility=1'])
    seedLedger()
    await json(['bank', 'sequels'])
    const all = await json(['bank', 'list'])
    expect(all.ideas.map((r: any) => r.idea)).toEqual(['Sequel: I Built a Cheap Camper', 'Cold showers', 'Bad idea'])
    const pure = await json(['bank', 'list', '--no-sequel-first'])
    expect(pure.ideas.map((r: any) => r.idea)).toEqual(['Cold showers', 'Sequel: I Built a Cheap Camper', 'Bad idea'])
    const alpha = await json(['bank', 'list', '--sort', 'idea', '--no-sequel-first'])
    expect(alpha.ideas.map((r: any) => r.idea)).toEqual(['Bad idea', 'Cold showers', 'Sequel: I Built a Cheap Camper'])
    await json(['bank', 'park', 'Bad idea', '--reason', 'no demand'])
    const parked = await json(['bank', 'list', '--status', 'parked'])
    expect(parked.ideas.map((r: any) => r.idea)).toEqual(['Bad idea'])
    const both = await json(['bank', 'list', '--status', 'parked,banked', '--sort', 'idea'])
    expect(both.ideas).toHaveLength(3)
    expect((await failing(['bank', 'list', '--status', 'nope'])).error).toMatch(/status must be one of banked, green/)
    expect((await failing(['bank', 'list', '--sort', 'nope'])).error).toMatch(/--sort must be one of total, demand/)
    const line = await text(['bank', 'list', '--status', 'banked'])
    expect(line).toMatch(/Sequel: I Built a Cheap Camper \(sequel of v3\)/)
  })

  it('says the bank is empty', async () => {
    expect(await text(['bank', 'list'])).toMatch(/The bank is empty/)
  })
})

describe('bank approve (human-only gate)', () => {
  it('prints the plan and writes nothing without --yes', async () => {
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    const { out, error } = await failing(['bank', 'approve', 'Cold showers'])
    expect(out).toContain('About to approve "Cold showers"')
    expect(out).toContain('banked -> green')
    expect(out).toMatch(/human-only gate \(AGENTS\.md gate 1\)/)
    expect(error).toMatch(/nothing written.*--yes/)
    const listed = await json(['bank', 'list'])
    expect(listed.ideas[0].status).toBe('banked')
  })

  it('prints the plan as JSON with --json and still refuses', async () => {
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    const { out, error } = await failing(['bank', 'approve', 'Cold showers', '--json'])
    expect(JSON.parse(out)).toMatchObject({ action: 'approve', idea: 'Cold showers', from: 'banked', to: 'green', allowed: true, applied: false, needs: '--yes' })
    expect(error).toMatch(/--yes/)
  })

  it('approves with --yes, by text or by idea:<hash> id', async () => {
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    await json(['bank', 'add', 'Hot baths', '--score', MANUAL])
    const a = await json(['bank', 'approve', 'Cold showers', '--yes'])
    expect(a.status).toBe('green')
    expect(a.updatedAt).toBe(now.toISOString())
    const out = await text(['bank', 'approve', ideaId('Hot baths'), '--yes'])
    expect(out).toMatch(/^Hot baths: green \(approved by a person/)
    const { error } = await failing(['bank', 'approve', 'Cold showers', '--yes'])
    expect(error).toMatch(/already green/)
  })

  it('refuses an unknown idea and a disallowed transition before the gate', async () => {
    expect((await failing(['bank', 'approve', 'Nothing here'])).error).toMatch(/no idea with id "idea:/)
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    await json(['bank', 'reject', 'Cold showers', '--reason', 'done before'])
    const { out, error } = await failing(['bank', 'approve', 'Cold showers', '--yes'])
    expect(out).toBe('')
    expect(error).toMatch(/from retired to green: retired is final/)
    expect((await failing(['bank', 'approve'])).error).toMatch(/usage: booster bank approve/)
  })
})

describe('bank park, reject, status', () => {
  it('parks and rejects with a reason, and requires the reason', async () => {
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    await json(['bank', 'add', 'Hot baths', '--score', MANUAL])
    const parked = await json(['bank', 'park', 'Cold showers', '--reason', 'wait for winter'])
    expect(parked).toMatchObject({ status: 'parked', parkedReason: 'wait for winter' })
    expect(await text(['bank', 'reject', 'Hot baths', '--reason', 'a clone'])).toBe('Hot baths: retired (a clone)\n')
    expect((await failing(['bank', 'park', 'Cold showers'])).error).toMatch(/--reason is required/)
    expect((await failing(['bank', 'reject', 'Cold showers'])).error).toMatch(/--reason is required/)
    const listed = await json(['bank', 'list'])
    expect(listed.ideas.map((r: any) => r.status)).toEqual(['parked'])
    const retired = await json(['bank', 'list', '--status', 'retired'])
    expect(retired.ideas[0]).toMatchObject({ idea: 'Hot baths', parkedReason: 'a clone' })
  })

  it('moves along the lifecycle, gates green, and explains a bad move', async () => {
    await json(['bank', 'add', 'Cold showers', '--score', MANUAL])
    const { error: gated } = await failing(['bank', 'status', 'Cold showers', 'green'])
    expect(gated).toMatch(/--yes/)
    expect((await json(['bank', 'list'])).ideas[0].status).toBe('banked')
    expect((await json(['bank', 'status', 'Cold showers', 'green', '--yes'])).status).toBe('green')
    expect(await text(['bank', 'status', 'Cold showers', 'packaging'])).toBe('Cold showers: green -> packaging\n')
    expect(await text(['bank', 'status', ideaId('Cold showers'), 'production'])).toBe('Cold showers: packaging -> production\n')
    const { error } = await failing(['bank', 'status', 'Cold showers', 'banked'])
    expect(error).toMatch(/cannot move "Cold showers" from production to banked: allowed: published, retired/)
    expect((await failing(['bank', 'status', 'Cold showers', 'shipped'])).error).toMatch(/status must be one of banked, green, packaging, production, published, parked, retired/)
    expect((await failing(['bank', 'status', 'Cold showers'])).error).toMatch(/Usage: booster bank status <id-or-text>/)
    expect(await text(['bank', 'status', 'Cold showers', 'retired', '--reason', 'scope blew up'])).toBe('Cold showers: production -> retired (scope blew up)\n')
  })
})

describe('bank rescore', () => {
  it('appends scan evidence, raises demand, reopens a parked idea, and decays a stale one', async () => {
    await json(['bank', 'add', 'solar generator', '--score', 'demand=1,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'])
    await json(['bank', 'park', 'solar generator', '--reason', 'not yet'])
    // Banked half a year before the fixed clock with no evidence since: one point of decay.
    const stale = await run(['bank', 'add', 'Cold showers', '--score', MANUAL, '--data', data, '--now', '2026-01-01T00:00:00Z', '--json'])
    expect(stale.code).toBe(0)
    const out = await text(['bank', 'rescore', competitors])
    expect(out).toMatch(/^scanned 20, \d+ inside 90 days; 0 ideas unchanged$/m)
    expect(out).toMatch(/^\+2 sources -> solar generator demand 1->3 \(2 matches at >= 5x inside 90 days \[house\]\)$/m)
    expect(out).toMatch(/^REOPENED solar generator: reopened: "How I Built a Solar Generator for \$300" \(OffGridLab\) at 32\.4x is a fresh >= 5x match on generator\+solar$/m)
    expect(out).toMatch(/^DECAY Cold showers demand 4->3 \(no evidence for 180 days \[house\]\)$/m)
    const listed = await json(['bank', 'list', '--sort', 'idea'])
    expect(listed.ideas.map((r: any) => [r.idea, r.status, r.scores.demand, r.sources.length])).toEqual([['Cold showers', 'banked', 3, 0], ['solar generator', 'banked', 3, 2]])
    // Idempotent: the same scan appends nothing and does not decay twice.
    const again = await json(['bank', 'rescore', competitors])
    expect(again).toMatchObject({ scanned: 20, matched: [], reopened: [], decayed: [], unchanged: 2, sequels: [], ownWinners: [] })
  })

  it('honours --since and --decay-days', async () => {
    await json(['bank', 'add', 'solar generator', '--score', 'demand=1,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'])
    const r = await json(['bank', 'rescore', competitors, '--since', '30', '--decay-days', '400'])
    expect(r.windowDays).toBe(30)
    expect(r.decayDays).toBe(400)
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].added.map((s: any) => s.title)).toEqual(['Generator vs Solar: Which Is Cheaper?'])
  })

  it('with --own banks sequels from the ledger and names own winners the ledger is missing', async () => {
    seedLedger()
    const r = await json(['bank', 'rescore', competitors, '--own', own])
    expect(r.sequels).toHaveLength(1)
    expect(r.sequels[0]).toMatchObject({ idea: 'Sequel: I Built a Cheap Camper', sequelOf: 'v3', status: 'banked' })
    const camper = r.ownWinners.find((w: any) => w.title === 'I Tried Sleeping in the Camper for 7 Nights')
    expect(camper).toMatchObject({ inLedger: false })
    expect(camper.multiplier).toBeGreaterThanOrEqual(5)
    const out = await text(['bank', 'rescore', competitors, '--own', own])
    expect(out).toMatch(/OWN WINNER [\d.]+x not in the ledger: "I Tried Sleeping in the Camper for 7 Nights"/)
    expect(out).toContain('No new own winner without a sequel idea.')
    expect(out).not.toContain('SEQUEL ')
    expect((await failing(['bank', 'rescore'])).error).toMatch(/usage: booster bank rescore/)
  })
})

describe('bank sequels', () => {
  it('banks one sequel per own winner, once, and honours --multiplier', async () => {
    seedLedger()
    const created = await json(['bank', 'sequels'])
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ idea: 'Sequel: I Built a Cheap Camper', sequelOf: 'v3', scores: { demand: 5 } })
    expect(await text(['bank', 'sequels'])).toBe('No new own winner without a sequel idea.\n')
    const more = await text(['bank', 'sequels', '--multiplier', '1.03'])
    expect(more).toMatch(/^idea:\w+ Sequel: Video 5 \(sequel of v5\)$/m)
    expect((await json(['bank', 'list'])).ideas).toHaveLength(2)
  })
})

describe('bank import', () => {
  it('imports idea-engine output, prints the fields the schema has no column for, and skips bad rows', async () => {
    const file = path.join(data, 'ideas.json')
    writeFileSync(file, JSON.stringify({
      ideas: [
        { idea: 'Solar generator on a budget', working_title: 'I Built a $300 Solar Generator', thumbnail_concept: 'generator + price tag', demand_evidence: 'How I Built a Solar Generator for $300 (32x)', angle: 'budget constraint', scores: { demand: 4, packaging: 4, fit: 4, angle: 3, payoff: 4, feasibility: 4 } },
        { idea: 'Broken', working_title: 'x', scores: { demand: 9, packaging: 4, fit: 4, angle: 3, payoff: 4, feasibility: 4 } },
        'not an object',
      ],
    }))
    const out = await text(['bank', 'import', file])
    expect(out).toMatch(/^added\s+idea:\w+ Solar generator on a budget  title: I Built a \$300 Solar Generator  thumb: generator \+ price tag  angle: budget constraint$/m)
    expect(out).toMatch(/^skipped #1: .*demand/m)
    expect(out).toMatch(/^skipped #2: not an object$/m)
    expect(out).toMatch(/^1 imported, 2 skipped$/m)
    const r = await json(['bank', 'import', file, '--source', 'agent:test'])
    expect(r.imported[0].outcome).toBe('updated')
    const listed = await json(['bank', 'list'])
    expect(listed.ideas).toHaveLength(1)
    expect(listed.ideas[0]).toMatchObject({ source: 'agent:test', sources: [{ title: 'How I Built a Solar Generator for $300 (32x)', channel: 'idea-engine' }] })
    expect((await failing(['bank', 'import'])).error).toMatch(/usage: booster bank import/)
  })
})

describe('bank wip', () => {
  it('reports caps as warnings in wip and list', async () => {
    expect(await text(['bank', 'wip'])).toBe('WIP within caps.\n')
    for (const idea of ['A', 'B', 'C', 'D']) {
      await json(['bank', 'add', idea, '--score', MANUAL])
      await json(['bank', 'approve', idea, '--yes'])
      await json(['bank', 'status', idea, 'packaging'])
    }
    const w = await json(['bank', 'wip'])
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ stage: 'packaging', count: 4, cap: 3, evidence: 'house' })
    expect(await text(['bank', 'wip'])).toBe('4 ideas in packaging, cap 3 [house]: finish one before starting another\n')
    expect(await text(['bank', 'list'])).toMatch(/^WARN 4 ideas in packaging, cap 3 \[house\]/m)
  })

  it('rejects an unknown bank sub-command', async () => {
    expect((await failing(['bank', 'nope'])).error).toMatch(/usage: booster bank add\|list\|approve/)
  })
})
