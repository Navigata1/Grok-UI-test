import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/booster.js'
import { openStore } from '../src/store.js'
import { DEFAULT_THRESHOLDS, resetThresholds } from '../src/thresholds.js'
import { CSV_HEADER, toCsv } from '../src/adapters/youtube-data.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, '..', 'examples')
const studio = path.join(examples, 'studio-content.csv')
/** Fixed clock: every fixture video is older than 7 days at this instant. */
const NOW = '2026-09-14T08:00:00Z'

let tmp: string
let data: string
let profile: string
let savedKey: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-data-'))
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
  savedKey = process.env.YOUTUBE_API_KEY
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetThresholds()
  if (savedKey === undefined) delete process.env.YOUTUBE_API_KEY
  else process.env.YOUTUBE_API_KEY = savedKey
  rmSync(tmp, { recursive: true, force: true })
})

/** Every command runs against the temp store and temp profile, never channel-booster/data or channel.json. */
function scoped(argv: string[]): string[] {
  return [...argv, '--data', data, '--path', profile]
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true })
  try {
    const code = await main(scoped(argv))
    return { code, out, err }
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
}

async function json(argv: string[]): Promise<any> {
  const { code, out } = await run([...argv, '--json'])
  expect(code).toBe(0)
  return JSON.parse(out)
}

/** Runs a command that must throw; returns the error message with stdout captured (a gate prints its plan before failing). */
async function fails(argv: string[]): Promise<{ message: string; out: string }> {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await main(scoped(argv))
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), out }
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
  throw new Error(`expected "${argv.join(' ')}" to fail`)
}

async function addRow(slug: string, title: string, publishedAt: string, videoId?: string): Promise<void> {
  const args = ['ledger', 'add', '--slug', slug, '--title', title, '--published-at', publishedAt, '--now', NOW]
  if (videoId) args.push('--video-id', videoId)
  const { code } = await run(args)
  expect(code).toBe(0)
}

/** Three finished videos with 48 h reads; the third also carries a 7-day read and its lever. */
async function seedHistory(): Promise<void> {
  await addRow('first-camper', 'Building my first camper', '2026-04-05T12:00:00Z', 'iJ7kLmNo5pQ')
  await addRow('fan-install', 'Installing the fan', '2026-05-03T12:00:00Z', 'kL8mNoPq6rS')
  await addRow('camper-7-nights', 'I Tried Sleeping in the Camper for 7 Nights', '2026-05-31T12:00:00Z', 'aB3dEfGh1jK')
  expect((await run(['set', 'first-camper', '--bucket', '48', '--impressions', '96000', '--ctr', '4.4', '--avp', '39.7', '--views', '4100'])).code).toBe(0)
  expect((await run(['set', 'fan-install', '--bucket', '48', '--impressions', '84000', '--ctr', '3.9', '--avp', '32.8', '--views', '3600'])).code).toBe(0)
  expect((await run(['set', 'camper-7-nights', '--bucket', '48', '--impressions', '721000', '--ctr', '5.9', '--avp', '36.8', '--views', '38000'])).code).toBe(0)
  expect((await run(['set', 'camper-7-nights', '--bucket', '168', '--views', '38000', '--returning', '38', '--lever', 'a first-person trial in the title', '--yes'])).code).toBe(0)
}

describe('booster help', () => {
  it('lists every data command', async () => {
    const { out } = await run(['help'])
    for (const verb of ['profile init', 'profile show', 'profile refresh', 'ingest <studio-content.csv>', 'set <slug> --bucket', 'ledger add', 'ledger show', 'ledger baseline', 'ledger levers', 'ledger export', 'fetch channel', 'thresholds [<key>]']) {
      expect(out).toContain(verb)
    }
  })
})

describe('booster profile', () => {
  it('init writes channel.json from flags and refuses to overwrite without --force', async () => {
    const parsed = await json(['profile', 'init', '--positioning', 'Weekend builders who want a camper that works', '--persona', 'Sam, 34, plans on Sundays', '--colors', 'yellow,black', '--face', 'always', '--max-words', '3', '--competitors', 'VanLifeCo, BuildIt', '--max-per-week', '2', '--publish-day', 'sat', '--team', '--never-again', 'clickbait arrows; red circles', '--now', NOW])
    expect(parsed.path).toBe(path.resolve(profile))
    expect(parsed.profile.positioning).toBe('Weekend builders who want a camper that works')
    expect(parsed.profile.signature).toMatchObject({ colors: ['yellow', 'black'], facePolicy: 'always', maxWords: 3 })
    expect(parsed.profile.competitors).toEqual(['VanLifeCo', 'BuildIt'])
    expect(parsed.profile.maxPerWeek).toBe(2)
    expect(parsed.profile.publishDay).toBe('sat')
    expect(parsed.profile.solo).toBe(false)
    expect(parsed.profile.neverAgain).toEqual(['clickbait arrows', 'red circles'])
    expect(parsed.profile.updatedAt).toBe('2026-09-14T08:00:00.000Z')
    expect(JSON.parse(readFileSync(profile, 'utf8')).persona).toBe('Sam, 34, plans on Sundays')

    const { message } = await fails(['profile', 'init', '--positioning', 'again'])
    expect(message).toContain('exists; pass --force')
    expect(JSON.parse(readFileSync(profile, 'utf8')).positioning).toBe('Weekend builders who want a camper that works')

    const text = await run(['profile', 'init', '--positioning', 'again', '--force'])
    expect(text.code).toBe(0)
    expect(text.out).toContain(`Wrote ${path.resolve(profile)}`)
    expect(text.out).toContain('Positioning: again')
    expect(JSON.parse(readFileSync(profile, 'utf8')).positioning).toBe('again')
  })

  it('init validates the enumerated flags and the signature colours', async () => {
    expect((await fails(['profile', 'init', '--face', 'sometimes', '--colors', 'red'])).message).toContain('--face must be one of always|never|either')
    expect((await fails(['profile', 'init', '--publish-day', 'someday'])).message).toContain('--publish-day must be one of')
    expect((await fails(['profile', 'init', '--face', 'always'])).message).toContain('at least one colour')
    expect(existsSync(profile)).toBe(false)
  })

  it('show renders defaults for a missing file and the saved profile afterwards', async () => {
    const before = await run(['profile', 'show'])
    expect(before.code).toBe(0)
    expect(before.out).toContain('not created yet')
    expect(before.out).toContain('Positioning: —')
    await run(['profile', 'init', '--positioning', 'Camper builds that work', '--solo'])
    const after = await run(['profile', 'show'])
    expect(after.out).toContain('Positioning: Camper builds that work')
    expect(after.out).not.toContain('not created yet')
    const parsed = await json(['profile', 'show'])
    expect(parsed.positioning).toBe('Camper builds that work')
    expect(parsed.solo).toBe(true)
  })

  it('refresh computes baselines from the ledger, honours --dry-run and reports the 7-day view', async () => {
    await run(['profile', 'init', '--positioning', 'Camper builds'])
    await seedHistory()
    const dry = await json(['profile', 'refresh', '--now', NOW, '--dry-run'])
    expect(dry.dryRun).toBe(true)
    expect(dry.baselines48.n).toBe(3)
    expect(dry.baselines48.tier).toBe('prior')
    expect(dry.baselines48.ctr.median).toBe(4.4)
    expect(dry.baselines168.n).toBe(1)
    expect(dry.baselines168.views.median).toBe(38000)
    expect(dry.shift).toBe(false)
    expect(JSON.parse(readFileSync(profile, 'utf8')).baselines).toBeUndefined()

    const real = await run(['profile', 'refresh', '--now', NOW])
    expect(real.code).toBe(0)
    expect(real.out).toContain(`Wrote ${path.resolve(profile)}`)
    expect(real.out).toContain('No baseline shift.')
    expect(real.out).toContain('7-day: views median 38000, returning 38% (n=1, prior)')
    const saved = JSON.parse(readFileSync(profile, 'utf8'))
    expect(saved.baselines.bucket).toBe('48')
    expect(saved.baselines.n).toBe(3)
    expect(saved.baselines.computedAt).toBe('2026-09-14T08:00:00.000Z')

    // A window of one row and a higher minimum age narrow the pool.
    const narrow = await json(['profile', 'refresh', '--now', NOW, '--window', '1', '--min-age-days', '120', '--dry-run'])
    expect(narrow.baselines48.n).toBe(1)
    expect(narrow.baselines48.ctr.median).toBe(3.9)
  })

  it('needs --yes only when a refresh would move a baseline that already exists', async () => {
    await run(['profile', 'init', '--positioning', 'Camper builds'])
    await seedHistory()
    // The first computation on a fresh channel is frictionless, and so is a recompute that lands
    // on the same medians: only a reset of numbers already in use is the human-only gate.
    expect((await run(['profile', 'refresh', '--now', NOW])).code).toBe(0)
    expect((await run(['profile', 'refresh', '--now', NOW])).code).toBe(0)
    expect(JSON.parse(readFileSync(profile, 'utf8')).baselines.n).toBe(3)

    // A fourth read moves the medians every verdict is judged against.
    await addRow('roof-fan', 'Roof fan swap', '2026-06-28T12:00:00Z', 'mN9oPqRs7tU')
    expect((await run(['set', 'roof-fan', '--bucket', '48', '--impressions', '150000', '--ctr', '6.8', '--avp', '44', '--views', '9000'])).code).toBe(0)

    const gated = await fails(['profile', 'refresh', '--now', NOW])
    expect(gated.message).toContain('resetting the baseline needs --yes')
    expect(gated.out).toContain(`About to reset the baselines in ${path.resolve(profile)}`)
    expect(gated.out).toContain('was: 48 h prior, n=3, CTR 4.4%, AVP 36.8%, views 4100')
    expect(gated.out).toContain('now: 48 h prior, n=4, CTR 5.2%, AVP 38.3%, views 6550')
    expect(gated.out).toContain('resetting the baseline is a human-only gate (AGENTS.md)')
    expect(JSON.parse(readFileSync(profile, 'utf8')).baselines.n).toBe(3)

    // --dry-run still previews the move without asking, and still writes nothing.
    const dry = await json(['profile', 'refresh', '--now', NOW, '--dry-run'])
    expect(dry.baselines48.n).toBe(4)
    // Both buckets are gated, so each moved metric says which one it came from.
    expect(dry.moved).toContain('48 h ctr')
    expect(JSON.parse(readFileSync(profile, 'utf8')).baselines.n).toBe(3)

    expect((await run(['profile', 'refresh', '--now', NOW, '--yes'])).code).toBe(0)
    expect(JSON.parse(readFileSync(profile, 'utf8')).baselines.n).toBe(4)
  })

  it('rejects an unknown subcommand with the usage line', async () => {
    expect((await fails(['profile', 'bogus'])).message).toContain('usage: booster profile init|show|refresh')
  })
})

describe('booster ledger add / show', () => {
  it('adds a row, reports the reads due at --now, and updates on re-add', async () => {
    const added = await run(['ledger', 'add', '--slug', 'camper-7-nights', '--title', 'I Tried Sleeping in the Camper for 7 Nights', '--published-at', '2026-05-31T12:00:00Z', '--video-id', 'aB3dEfGh1jK', '--thumb-a', 'face-in-bed', '--thumb-b', 'camper-at-night', '--sequel-of', 'first-camper', '--now', NOW])
    expect(added.code).toBe(0)
    expect(added.out).toContain('added camper-7-nights "I Tried Sleeping in the Camper for 7 Nights" published 2026-05-31T12:00:00.000Z (video aB3dEfGh1jK)')
    expect(added.out).toContain('reads due now: 24 h, 48 h, 168 h, 672 h')
    const row = openStore(data).get('ledger', 'camper-7-nights')
    expect(row).toMatchObject({ videoId: 'aB3dEfGh1jK', thumbA: 'face-in-bed', thumbB: 'camper-at-night', sequelOf: 'first-camper', source: 'cli' })
    expect(existsSync(path.join(data, 'ledger.jsonl'))).toBe(true)

    const fresh = await run(['ledger', 'add', '--slug', 'new-video', '--title', 'Just up', '--published-at', '2026-09-14T07:00:00Z', '--now', NOW])
    expect(fresh.out).toContain('first read due at 2026-09-15T07:00:00.000Z')

    const again = await json(['ledger', 'add', '--slug', 'camper-7-nights', '--title', 'Renamed', '--published-at', '2026-05-31T12:00:00Z', '--now', NOW])
    expect(again.title).toBe('Renamed')
    expect(again.videoId).toBe('aB3dEfGh1jK')
    expect(openStore(data).read('ledger')).toHaveLength(2)
  })

  it('validates the required flags and the video id', async () => {
    expect((await fails(['ledger', 'add', '--title', 'x', '--published-at', NOW])).message).toContain('--slug is required')
    expect((await fails(['ledger', 'add', '--slug', 'x', '--title', 'x'])).message).toContain('--published-at is required')
    expect((await fails(['ledger', 'add', '--slug', 'x', '--title', 'x', '--published-at', 'yesterday'])).message).toContain('--published-at must be an ISO date')
    expect((await fails(['ledger', 'add', '--slug', 'x', '--title', 'x', '--published-at', NOW, '--video-id', 'short'])).message).toContain('11-character')
    // The lever belongs to the 7-day read, so add-time is the wrong place to accept it: say so
    // and name the writer instead of dropping the flag.
    const lever = await fails(['ledger', 'add', '--slug', 'x', '--title', 'x', '--published-at', NOW, '--lever', 'learned X'])
    expect(lever.message).toContain('ledger add has no --lever')
    expect(lever.message).toContain('booster set x --bucket 168 --lever ".." --yes')
    expect(existsSync(path.join(data, 'ledger.jsonl'))).toBe(false)
  })

  it('shows the ledger as text, as the playbook table, and filtered by slug', async () => {
    const empty = await run(['ledger', 'show'])
    expect(empty.out).toContain('Ledger is empty')
    await seedHistory()
    const text = await run(['ledger', 'show'])
    expect(text.out).toContain('camper-7-nights')
    expect(text.out).toContain('reads: 24h — 48h ✓ 168h ✓ 672h —')
    expect(text.out).toContain('lever: a first-person trial in the title')
    const md = await run(['ledger', 'show', '--md'])
    expect(md.out).toContain('| Published | Video | A / B | Winner | Impr. 48h |')
    expect(md.out).toContain('| 2026-05-31 | I Tried Sleeping in the Camper for 7 Nights |')
    const one = await json(['ledger', 'show', '--slug', 'fan-install'])
    expect(one).toHaveLength(1)
    expect(one[0].slug).toBe('fan-install')
    expect((await fails(['ledger', 'show', '--slug', 'nope'])).message).toContain('no ledger row for "nope"')
  })
})

describe('booster ingest', () => {
  it('records Studio rows into the matching ledger reads and reports the rest', async () => {
    await addRow('camper-7-nights', 'I Tried Sleeping in the Camper for 7 Nights', '2026-05-31T12:00:00Z', 'aB3dEfGh1jK')
    await addRow('went-wrong', 'Why My Camper Build Went Wrong', '2026-07-12T12:00:00Z', 'cD4eFgHi2kL')
    const at = '2026-06-02T12:00:00Z'
    const dry = await json(['ingest', studio, '--at', at, '--dry-run'])
    expect(dry.dryRun).toBe(true)
    expect(dry.droppedTotalRow).toBe(true)
    expect(dry.unknownColumns).toEqual([])
    expect(dry.recorded).toHaveLength(1)
    expect(dry.recorded[0]).toMatchObject({ slug: 'camper-7-nights', videoId: 'aB3dEfGh1jK', bucket: '48', ageHours: 48, leverWritten: false })
    expect(dry.recorded[0].read).toMatchObject({ at: '2026-06-02T12:00:00.000Z', impressions: 721000, ctr: 5.9, views: 38000, avdSec: 342, avpPct: 36.8 })
    expect(dry.skipped).toHaveLength(7)
    expect(dry.skipped.find((s: any) => s.slug === 'went-wrong').reason).toContain('not within 20% of 24/48/168/672 h; pass --bucket')
    expect(dry.skipped.filter((s: any) => s.reason.startsWith('no ledger row'))).toHaveLength(6)
    expect(dry.skipped.find((s: any) => s.videoId === 'eF5gHiJk3lM').reason).toContain('booster publish confirm --video-id eF5gHiJk3lM')
    expect(openStore(data).get('ledger', 'camper-7-nights')!.reads['48']).toBeUndefined()

    const real = await run(['ingest', studio, '--at', at])
    expect(real.code).toBe(0)
    expect(real.out).toContain('Total row dropped')
    expect(real.out).toContain('recorded camper-7-nights (aB3dEfGh1jK) at 48 h [48 h old]: impressions 721000, CTR 5.9%, views 38000, AVD 342 s, AVP 36.8%')
    expect(real.out).toContain('skipped went-wrong Why My Camper Build Went Wrong:')
    expect(real.out).toContain('1 read recorded, 7 skipped')
    const row = openStore(data).get('ledger', 'camper-7-nights')!
    expect(row.reads['48']).toMatchObject({ impressions: 721000, ctr: 5.9, views: 38000 })
    expect(row.source).toBe('cli')
  })

  it('merges over numbers typed earlier, names unknown columns and refuses rows without an 11-character id', async () => {
    await addRow('camper-7-nights', 'I Tried Sleeping in the Camper for 7 Nights', '2026-05-31T12:00:00Z', 'aB3dEfGh1jK')
    expect((await run(['set', 'camper-7-nights', '--bucket', '48', '--ret30', '62'])).code).toBe(0)
    const file = path.join(tmp, 'partial.csv')
    writeFileSync(file, ['Content,Video title,Video publish time,Views,Impressions,Impressions click-through rate (%),Mystery column', 'aB3dEfGh1jK,I Tried Sleeping in the Camper for 7 Nights,"May 31, 2026",39000,730000,6.0,zzz', 'short,Not a video,"May 31, 2026",10,10,1.0,zzz', ''].join('\n'))
    const parsed = await json(['ingest', file, '--at', '2026-06-02T12:00:00Z'])
    expect(parsed.unknownColumns).toEqual(['Mystery column'])
    expect(parsed.droppedTotalRow).toBe(false)
    expect(parsed.recorded).toHaveLength(1)
    expect(parsed.recorded[0].read).toMatchObject({ retention30sPct: 62, impressions: 730000, ctr: 6, views: 39000 })
    expect(parsed.skipped).toHaveLength(1)
    expect(parsed.skipped[0].reason).toContain('no 11-character YouTube video id')
    const text = await run(['ingest', file, '--at', '2026-06-02T12:00:00Z', '--dry-run'])
    expect(text.out).toContain('ignored columns: Mystery column')
    expect(text.out).toContain('DRY RUN')
  })

  it('needs a lever for a 7-day read and --yes to write it', async () => {
    await addRow('camper-7-nights', 'I Tried Sleeping in the Camper for 7 Nights', '2026-05-31T12:00:00Z', 'aB3dEfGh1jK')
    const at = '2026-06-07T12:00:00Z'
    const noLever = await json(['ingest', studio, '--at', at])
    expect(noLever.recorded).toHaveLength(0)
    expect(noLever.skipped.find((s: any) => s.slug === 'camper-7-nights').reason).toContain('a 7-day read needs the lever learned')

    const gate = await fails(['ingest', studio, '--at', at, '--lever', 'a first-person trial in the title'])
    expect(gate.message).toContain('--yes')
    expect(gate.out).toContain('About to write the lever "a first-person trial in the title" on 1 7-day read: camper-7-nights')
    expect(gate.out).toContain('human-only gate')
    expect(openStore(data).get('ledger', 'camper-7-nights')!.reads['168']).toBeUndefined()

    // A dry run plans the write without asking, and writes nothing.
    const dry = await run(['ingest', studio, '--at', at, '--lever', 'a first-person trial in the title', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('would record camper-7-nights (aB3dEfGh1jK) at 168 h [168 h old]')
    expect(dry.out).toContain('lever: a first-person trial in the title')
    expect(openStore(data).get('ledger', 'camper-7-nights')!.lever).toBeUndefined()

    const yes = await json(['ingest', studio, '--at', at, '--lever', 'a first-person trial in the title', '--yes'])
    expect(yes.recorded[0]).toMatchObject({ bucket: '168', leverWritten: true, lever: 'a first-person trial in the title' })
    const row = openStore(data).get('ledger', 'camper-7-nights')!
    expect(row.lever).toBe('a first-person trial in the title')
    expect(row.reads['168']).toMatchObject({ views: 38000, impressions: 721000 })

    // With the lever on the row, a re-ingest at the same bucket needs no gate.
    const again = await json(['ingest', studio, '--at', at, '--bucket', '168'])
    expect(again.recorded[0]).toMatchObject({ bucket: '168', leverWritten: false })
  })

  it('honours --bucket, checks the file and the bucket value', async () => {
    await addRow('went-wrong', 'Why My Camper Build Went Wrong', '2026-07-12T12:00:00Z', 'cD4eFgHi2kL')
    const forced = await json(['ingest', studio, '--at', '2026-07-15T00:00:00Z', '--bucket', '48'])
    expect(forced.recorded[0]).toMatchObject({ slug: 'went-wrong', bucket: '48', ageHours: 60 })
    expect((await fails(['ingest', studio, '--bucket', '96'])).message).toContain('--bucket must be one of 24|48|168|672')
    expect((await fails(['ingest', path.join(tmp, 'missing.csv')])).message).toContain('not found')
    expect((await fails(['ingest'])).message).toContain('usage: booster ingest')
    expect((await fails(['ingest', studio, '--at', 'noon'])).message).toContain('--at must be an ISO date')
  })
})

describe('booster set', () => {
  it('types the numbers Studio does not export into the existing read without losing other fields', async () => {
    await addRow('camper-7-nights', 'I Tried Sleeping in the Camper for 7 Nights', '2026-05-31T12:00:00Z', 'aB3dEfGh1jK')
    await run(['ingest', studio, '--at', '2026-06-02T12:00:00Z'])
    const first = await run(['set', 'camper-7-nights', '--bucket', '48', '--ret30', '62', '--returning', '38', '--sub-share', '41', '--browse-suggested', '55', '--now', NOW])
    expect(first.code).toBe(0)
    expect(first.out).toContain('camper-7-nights · 48 h read merged into the read from 2026-06-02T12:00:00.000Z')
    expect(first.out).toContain('impressions 721000, CTR 5.9%, views 38000, AVD 342 s, AVP 36.8%, 30 s 62%, returning 38%, subscribers 41%, browse+suggested 55%')
    const row = openStore(data).get('ledger', 'camper-7-nights')!
    expect(row.reads['48']).toEqual({ at: '2026-06-02T12:00:00.000Z', impressions: 721000, ctr: 5.9, views: 38000, avdSec: 342, avpPct: 36.8, retention30sPct: 62, returningPct: 38, subscriberSharePct: 41, browseSuggestedPct: 55 })
    expect(row.updatedAt).toBe('2026-09-14T08:00:00.000Z')

    const created = await json(['set', 'camper-7-nights', '--bucket', '24', '--impressions', '300000', '--ctr', '6.2', '--avd-sec', '300', '--now', NOW])
    expect(created.reads['24']).toEqual({ at: '2026-09-14T08:00:00.000Z', impressions: 300000, ctr: 6.2, avdSec: 300 })
    expect(created.reads['48'].retention30sPct).toBe(62)
  })

  it('validates the slug, bucket and numbers', async () => {
    expect((await fails(['set'])).message).toContain('usage: booster set')
    expect((await fails(['set', 'x', '--ctr', '5'])).message).toContain('--bucket is required')
    expect((await fails(['set', 'x', '--bucket', '48', '--ctr', '5'])).message).toContain('no ledger row for "x"')
    await addRow('x', 'X', '2026-05-31T12:00:00Z')
    expect((await fails(['set', 'x', '--bucket', '48'])).message).toContain('nothing to set')
    expect((await fails(['set', 'x', '--bucket', '48', '--ctr', 'five'])).message).toContain('--ctr must be a number')
    expect((await fails(['set', 'x', '--bucket', '72', '--ctr', '5'])).message).toContain('--bucket must be one of')
    expect(openStore(data).get('ledger', 'x')!.reads).toEqual({})
  })

  it('treats the lever as a human-only gate and the 7-day read as needing one', async () => {
    await addRow('x', 'X', '2026-05-31T12:00:00Z')
    expect((await fails(['set', 'x', '--bucket', '168', '--views', '1000'])).message).toContain('a 7-day read needs the lever learned')
    const gate = await fails(['set', 'x', '--bucket', '168', '--views', '1000', '--lever', 'shorter titles'])
    expect(gate.message).toContain('--yes')
    expect(gate.out).toContain('About to write the lever on x: "shorter titles"')
    expect(gate.out).toContain('and record the 168 h read: views 1000')
    expect(openStore(data).get('ledger', 'x')!.lever).toBeUndefined()

    const written = await run(['set', 'x', '--bucket', '168', '--views', '1000', '--lever', 'shorter titles', '--yes'])
    expect(written.code).toBe(0)
    expect(written.out).toContain('lever: shorter titles')
    expect(openStore(data).get('ledger', 'x')!.lever).toBe('shorter titles')

    // Re-stating the same lever is not a new decision; replacing it is.
    expect((await run(['set', 'x', '--bucket', '168', '--returning', '30', '--lever', 'shorter titles'])).code).toBe(0)
    const replace = await fails(['set', 'x', '--bucket', '168', '--lever', 'a face in the thumbnail'])
    expect(replace.out).toContain('(replacing "shorter titles")')
    expect(openStore(data).get('ledger', 'x')!.lever).toBe('shorter titles')
    const gateJson = await fails(['set', 'x', '--bucket', '168', '--lever', 'a face in the thumbnail', '--json'])
    expect(JSON.parse(gateJson.out)).toMatchObject({ needsConfirmation: true, slug: 'x', bucket: '168', lever: 'a face in the thumbnail', previousLever: 'shorter titles' })
  })
})

describe('booster ledger baseline / levers / winners / due / export', () => {
  it('baseline prints tier, n, medians and MAD and accepts only the judged buckets', async () => {
    await seedHistory()
    const text = await run(['ledger', 'baseline', '--now', NOW])
    expect(text.code).toBe(0)
    expect(text.out).toContain('Baseline at 48 h: tier prior, n=3 (window 10, min age 7 d)')
    expect(text.out).toContain('CTR: median 4.4%, MAD 0.5, n=3')
    expect(text.out).toContain('views: median 4100, MAD 500, n=3')
    expect(text.out).toContain('30 s retention: not in the ledger')
    const parsed = await json(['ledger', 'baseline', '--now', NOW, '--exclude', 'camper-7-nights'])
    expect(parsed).toMatchObject({ bucket: '48', n: 2, tier: 'prior', excludeSlug: 'camper-7-nights', window: 10, minAgeDays: 7 })
    expect(parsed.ctr.median).toBe(4.15)
    const b168 = await run(['ledger', 'baseline', '--bucket', '168', '--now', NOW])
    expect(b168.out).toContain('Baseline at 168 h: tier prior, n=1')
    expect(b168.out).toContain('returning share: median 38%')
    expect((await fails(['ledger', 'baseline', '--bucket', '24'])).message).toContain('--bucket must be 48 or 168')
  })

  it('levers tallies the levers learned', async () => {
    const empty = await run(['ledger', 'levers'])
    expect(empty.out).toContain('No levers recorded yet')
    await seedHistory()
    const text = await run(['ledger', 'levers'])
    expect(text.out).toContain('1x  a first-person trial in the title  (camper-7-nights)')
    const parsed = await json(['ledger', 'levers'])
    expect(parsed).toEqual([{ lever: 'a first-person trial in the title', count: 1, slugs: ['camper-7-nights'] }])
  })

  it('winners lists rows at the own-winner multiple of the 7-day median', async () => {
    await seedHistory()
    const none = await run(['ledger', 'winners'])
    expect(none.out).toContain('No own winners yet')
    expect(none.out).toContain('5x the median [house]')
    await run(['set', 'first-camper', '--bucket', '168', '--views', '4000', '--lever', 'plain build', '--yes'])
    await run(['set', 'fan-install', '--bucket', '168', '--views', '3600', '--lever', 'plain build', '--yes'])
    const parsed = await json(['ledger', 'winners'])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ slug: 'camper-7-nights', views168: 38000 })
    expect(parsed[0].multiple).toBeCloseTo(9.5, 5)
    const text = await run(['ledger', 'winners'])
    expect(text.out).toContain('9.5x  camper-7-nights  "I Tried Sleeping in the Camper for 7 Nights"  38000 views at 7 d')
    expect(await json(['ledger', 'winners', '--multiplier', '20'])).toEqual([])
  })

  it('due lists the reads whose hour mark has passed', async () => {
    await seedHistory()
    const parsed = await json(['ledger', 'due', '--now', NOW])
    const camper = parsed.filter((d: any) => d.slug === 'camper-7-nights').map((d: any) => d.bucket)
    expect(camper.sort()).toEqual(['24', '672'])
    const text = await run(['ledger', 'due', '--now', NOW])
    expect(text.out).toMatch(/camper-7-nights\s+24 h read\s+overdue \d+ h\s+\(age \d+ h\)/)
    const nothing = await run(['ledger', 'due', '--now', '2026-04-05T12:30:00Z'])
    expect(nothing.out).toContain('Nothing due.')
  })

  it('export dumps the ledger as JSON or Markdown, to stdout or a file', async () => {
    await seedHistory()
    const stdout = await run(['ledger', 'export'])
    expect(JSON.parse(stdout.out)).toHaveLength(3)
    const asJson = await json(['ledger', 'export'])
    expect(asJson.map((r: any) => r.slug).sort()).toEqual(['camper-7-nights', 'fan-install', 'first-camper'])
    const md = await run(['ledger', 'export', '--md'])
    expect(md.out.startsWith('| Published | Video |')).toBe(true)
    const file = path.join(tmp, 'exports', 'ledger.json')
    const written = await json(['ledger', 'export', '--out', file])
    expect(written).toEqual({ out: file, rows: 3, format: 'json' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(3)
    const mdFile = path.join(tmp, 'exports', 'ledger.md')
    const text = await run(['ledger', 'export', '--md', '--out', mdFile])
    expect(text.out).toContain(`wrote 3 rows to ${mdFile}`)
    expect(readFileSync(mdFile, 'utf8')).toContain('| 2026-05-31 | I Tried Sleeping in the Camper for 7 Nights |')
  })

  it('rejects an unknown ledger subcommand', async () => {
    expect((await fails(['ledger', 'bogus'])).message).toContain('usage: booster ledger add|show|baseline|levers|winners|due|export')
  })
})

describe('booster fetch channel', () => {
  it('fails in one line when YOUTUBE_API_KEY is missing and never touches the network or disk', async () => {
    delete process.env.YOUTUBE_API_KEY
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { message, out } = await fails(['fetch', 'channel', '@VanLifeCo', '--out', path.join(tmp, 'inbox', 'VanLifeCo.csv')])
    expect(message).toBe('fetch channel: YOUTUBE_API_KEY is not set. Export a YouTube Data API v3 key (Google Cloud) in the environment; it is never printed or stored.')
    expect(message.split('\n')).toHaveLength(1)
    expect(out).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(path.join(tmp, 'inbox'))).toBe(false)
  })

  it('does not echo a key that is set but blank, and validates usage before the key', async () => {
    process.env.YOUTUBE_API_KEY = '   '
    expect((await fails(['fetch', 'channel', '@VanLifeCo'])).message).toContain('YOUTUBE_API_KEY is not set')
    process.env.YOUTUBE_API_KEY = 'AIza-secret-key-value'
    expect((await fails(['fetch', 'channel'])).message).toContain('usage: booster fetch channel')
    expect((await fails(['fetch', 'videos', '@VanLifeCo'])).message).toContain('usage: booster fetch channel')
    const blank = await fails(['fetch', 'channel', '   '])
    expect(blank.message).toContain('a handle (@name) or a channel id (UC...) is required')
    expect(blank.message).not.toContain('AIza-secret-key-value')
  })

  it('writes to the workspace inbox when a workspace is in use, to --inbox when given, else to <--root or the working directory>/inbox as always', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', 'stub-key')
    vi.stubEnv('BOOSTER_HOME', '')
    vi.stubGlobal('fetch', async (url: string | URL) => ({ ok: true, status: 200, text: async () => JSON.stringify(youtubeStub(String(url))) }))
    const root = realpathSync(tmp)
    const ws = path.join(root, 'ws')
    expect((await run(['init', ws])).code).toBe(0)
    // With a workspace the list is an inbox file, even when --root moves the packages somewhere else.
    const inWorkspace = await json(['fetch', 'channel', '@stubchannel', '--workspace', ws, '--root', path.join(root, 'packages-elsewhere')])
    expect(inWorkspace.out).toBe(path.join(ws, 'inbox', 'stubchannel.csv'))
    expect(readFileSync(inWorkspace.out, 'utf8').split('\n')[0]).toBe(CSV_HEADER.join(','))
    expect(existsSync(path.join(root, 'packages-elsewhere'))).toBe(false)
    expect((await json(['fetch', 'channel', '@stubchannel', '--inbox', path.join(root, 'drop')])).out).toBe(path.join(root, 'drop', 'stubchannel.csv'))
    // No workspace and no --inbox: where fetch has always written.
    expect((await json(['fetch', 'channel', '@stubchannel', '--root', path.join(root, 'old')])).out).toBe(path.join(root, 'old', 'inbox', 'stubchannel.csv'))
    const cwd = process.cwd()
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    process.chdir(plain)
    try {
      expect((await json(['fetch', 'channel', '@stubchannel'])).out).toBe(path.join(plain, 'inbox', 'stubchannel.csv'))
    } finally {
      process.chdir(cwd)
    }
  })

  it('writes the competitor CSV shape the scanner reads', () => {
    expect([...CSV_HEADER]).toEqual(['title', 'views', 'published', 'channel', 'duration', 'url', 'videoId'])
    const csv = toCsv([{ title: 'Van, "Life"', views: 180000, published: '2026-09-10', channel: 'VanLifeCo', durationSec: 720, url: 'https://www.youtube.com/watch?v=aB3dEfGh1jK', videoId: 'aB3dEfGh1jK' }])
    expect(csv.split('\n')[0]).toBe(CSV_HEADER.join(','))
    expect(csv).toBe('title,views,published,channel,duration,url,videoId\n"Van, ""Life""",180000,2026-09-10,VanLifeCo,720,https://www.youtube.com/watch?v=aB3dEfGh1jK,aB3dEfGh1jK\n')
  })
})

/** Canned YouTube Data API bodies for the three calls `fetch channel` makes. */
function youtubeStub(url: string): unknown {
  if (url.includes('/channels')) return { items: [{ id: 'UCstub', snippet: { title: 'Stub' }, contentDetails: { relatedPlaylists: { uploads: 'UUstub' } } }] }
  if (url.includes('/playlistItems')) return { items: [{ contentDetails: { videoId: 'aB3dEfGh1jK' } }] }
  return { items: [{ id: 'aB3dEfGh1jK', snippet: { title: 'Stub video', publishedAt: '2026-07-01T00:00:00Z', channelTitle: 'Stub' }, statistics: { viewCount: '1000' }, contentDetails: { duration: 'PT10M' } }] }
}

describe('booster thresholds', () => {
  it('prints every entry as "key value [evidence] note"', async () => {
    const { code, out } = await run(['thresholds'])
    expect(code).toBe(0)
    const lines = out.trimEnd().split('\n')
    const keys = Object.keys(DEFAULT_THRESHOLDS)
    expect(lines).toHaveLength(keys.length)
    for (const key of keys) {
      const t = DEFAULT_THRESHOLDS[key as keyof typeof DEFAULT_THRESHOLDS]
      const line = lines.find((l) => l.startsWith(`${key} `))
      expect(line, key).toBeDefined()
      expect(line).toContain(` ${t.value} [${t.evidence}] ${t.note}`)
    }
    expect(out).toContain('ownWinnerMultiplier')
    expect(out).toContain('[house]')
    expect(out).toContain('[unverified]')
  })

  it('returns the table as JSON and one entry by key', async () => {
    const table = await json(['thresholds'])
    expect(Object.keys(table).sort()).toEqual(Object.keys(DEFAULT_THRESHOLDS).sort())
    expect(table.bucketTolerance).toEqual(DEFAULT_THRESHOLDS.bucketTolerance)
    const one = await json(['thresholds', 'titleMaxChars'])
    expect(one).toEqual({ titleMaxChars: DEFAULT_THRESHOLDS.titleMaxChars })
    const text = await run(['thresholds', 'titleMaxChars'])
    expect(text.out).toBe('titleMaxChars 55 [house] above this the promise truncates on a phone\n')
    expect((await fails(['thresholds', 'nope'])).message).toContain('unknown threshold "nope"')
  })
})
