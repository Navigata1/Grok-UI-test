import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../cli/booster.js'
import { addRow, recordRead } from '../src/ledger.js'
import { openStore } from '../src/store.js'
import { resetThresholds } from '../src/thresholds.js'
import type { Baselines } from '../src/schema.js'

const NOW = '2026-09-14T12:00:00Z'
const nowMs = Date.parse(NOW)
const LEVER = 'the payoff in the thumbnail beat the face'
/** The pre-registered lever (hypothesis) the rules compiler counts; the 7-day sentence above is the retro's. */
const HYPOTHESIS = 'payoff-in-thumbnail'

let tmp: string
let data: string
let profile: string
let playbook: string
let inbox: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-learn-'))
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
  playbook = path.join(tmp, 'playbook')
  inbox = path.join(tmp, 'inbox')
  mkdirSync(playbook, { recursive: true })
  mkdirSync(inbox, { recursive: true })
  writeFileSync(path.join(playbook, 'ideation.md'), '# Ideation\n\nBorrow a proven format.\n')
  writeFileSync(profile, JSON.stringify({ positioning: 'Van builds for first-timers' }))
})
afterEach(() => {
  vi.restoreAllMocks()
  resetThresholds()
  rmSync(tmp, { recursive: true, force: true })
})

function scoped(argv: string[]): string[] {
  return [...argv, '--data', data, '--path', profile, '--now', NOW, '--playbook', playbook, '--inbox', inbox, '--root', tmp]
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

async function fails(argv: string[]): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await main(scoped(argv))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    spy.mockRestore()
    errSpy.mockRestore()
  }
  throw new Error(`expected "${argv.join(' ')}" to fail`)
}

function solidBaselines(): Baselines {
  return {
    computedAt: '2026-09-01T00:00:00Z',
    bucket: '48',
    n: 10,
    tier: 'solid',
    ctr: { median: 5, mad: 0.5, n: 10 },
    avpPct: { median: 40, mad: 3, n: 10 },
    retention30sPct: { median: 65, mad: 4, n: 10 },
    returningPct: { median: 40, mad: 5, n: 10 },
    views: { median: 5000, mad: 800, n: 10 },
    impressions: { median: 20000, mad: 3000, n: 10 },
    shift: false,
  }
}

/** Ten older videos with identical reads and one lever; a solid baseline. */
function seedHistory(): void {
  const store = openStore(data)
  for (let i = 0; i < 10; i += 1) {
    const publishedAt = new Date(nowMs - (30 + i * 7) * 86_400_000).toISOString()
    const slug = `old-${i}`
    addRow(store, { slug, title: `Old video ${i}`, publishedAt, hypothesis: { levers: [HYPOTHESIS], predictedCtrMultiple: 1.2 }, now: new Date(NOW) })
    recordRead(store, { slug, bucket: '48', read: { impressions: 20000, ctr: 5, avpPct: 40, retention30sPct: 65, views: 3000, returningPct: 40 }, now: new Date(NOW) })
    recordRead(store, { slug, bucket: '168', read: { impressions: 60000, ctr: 5, avpPct: 40, views: 5000, returningPct: 40 }, lever: LEVER, now: new Date(NOW) })
  }
}

function seedRow(slug: string, hoursAgo: number, read48?: { impressions: number; ctr: number; avpPct: number; retention30sPct?: number }): void {
  const store = openStore(data)
  const publishedAt = new Date(nowMs - hoursAgo * 3_600_000).toISOString()
  addRow(store, { slug, title: `Video ${slug}`, publishedAt, now: new Date(NOW) })
  if (read48) recordRead(store, { slug, bucket: '48', read: { ...read48, at: new Date(nowMs - (hoursAgo - 48) * 3_600_000).toISOString() }, now: new Date(NOW) })
}

describe('booster review', () => {
  it('due lists reads past their hour mark with no numbers, and says so when nothing is due', async () => {
    seedRow('fresh', 50)
    const due = await json(['review', 'due'])
    // Both the 24 h and the 48 h marks have passed with no numbers.
    expect(due.due.map((d: any) => `${d.slug}:${d.bucket}`).sort()).toEqual(['fresh:24', 'fresh:48'])
    expect(due.due.find((d: any) => d.bucket === '48')).toMatchObject({ title: 'Video fresh' })
    expect(due.due.find((d: any) => d.bucket === '48').overdueHours).toBeGreaterThanOrEqual(2)
    const { out } = await run(['review', 'due'])
    expect(out).toMatch(/2 reads due:\n/)
    expect(out).toMatch(/ {2}fresh at 48 h, \d+ h overdue · Video fresh/)
    expect(out).toContain('booster set <slug> --bucket <b>')
    seedRow('typed', 50, { impressions: 20000, ctr: 5, avpPct: 40 })
    const none = await run(['review', 'due', '--now', '2026-09-14T13:00:00Z'])
    expect(none.out).not.toContain('typed at 48 h')
    expect(await fails(['review', 'nope'])).toMatch(/usage: booster review due/)
  })

  it('run diagnoses every ready read, records the decision, writes the day file and the digest', async () => {
    writeFileSync(profile, JSON.stringify({ positioning: 'x', baselines: solidBaselines() }))
    seedHistory()
    seedRow('weak', 50, { impressions: 25000, ctr: 2, avpPct: 42, retention30sPct: 66 })
    const r = await json(['review', 'run'])
    // Every read without a decision is reviewed once: the new video and the seeded history's 48 h and 168 h reads.
    const keys = r.reviews.map((x: any) => `${x.slug}:${x.bucket}`)
    expect(keys).toContain('weak:48')
    expect(keys).toContain('old-0:168')
    const weak = r.reviews.find((x: any) => x.slug === 'weak')
    expect(weak.diagnosis.bottleneck).toBe('packaging')
    expect(weak.decision.decision).toBe('REPACKAGE')
    const second = await json(['review', 'run'])
    expect(second.reviews).toEqual([])
    expect(r.stageFile).toBeNull()
    expect(r.outFile).toBe(path.join(data, 'reviews', '2026-09-14.json'))
    expect(existsSync(r.outFile)).toBe(true)
    expect(openStore(data).get('decisions', 'weak:48')).toMatchObject({ decision: 'REPACKAGE', source: 'cli' })
    expect(r.digest).toContain('# Review digest · 2026-09-14')
    const { out } = await run(['review', 'run'])
    expect(out).toContain('# Review digest')
    expect(out).toContain(`Wrote ${r.outFile}`)
  })

  it('run --slug --bucket is the workflow stage: it writes packages/<slug>/review-<bucket>.json carrying the bucket', async () => {
    writeFileSync(profile, JSON.stringify({ positioning: 'x', baselines: solidBaselines() }))
    seedHistory()
    seedRow('weak', 50, { impressions: 25000, ctr: 2, avpPct: 42, retention30sPct: 66 })
    const r = await json(['review', 'run', '--slug', 'weak', '--bucket', '48', '--agent', 'review-bot'])
    const stageFile = path.join(tmp, 'packages', 'weak', 'review-48.json')
    expect(r.stageFile).toBe(stageFile)
    const stage = JSON.parse(readFileSync(stageFile, 'utf8'))
    expect(stage.bucket).toBe('48')
    expect(stage.slug).toBe('weak')
    expect(stage.review.decision.decision).toBe('REPACKAGE')
    expect(openStore(data).get('decisions', 'weak:48')!.source).toBe('agent:review-bot')
    expect(await fails(['review', 'run', '--bucket', '48'])).toMatch(/--bucket needs --slug/)
    expect(await fails(['review', 'run', '--slug', 'weak', '--bucket', '12'])).toMatch(/--bucket must be one of/)
    expect(await fails(['review', 'run', '--slug', 'weak', '--bucket', '168'])).toMatch(/168-hour read is not due yet/)
    expect(await fails(['review', 'run', '--slug', 'typo'])).toMatch(/no ledger row for "typo"/)
    expect(await fails(['review', 'run', '--agent', 'review bot'])).toMatch(/--agent must be letters, digits/)
  })

  it('run --slug --bucket refuses to pass the stage without numbers or on a WAIT, and passes an applied bucket', async () => {
    writeFileSync(profile, JSON.stringify({ positioning: 'x', baselines: solidBaselines() }))
    seedHistory()
    seedRow('noread', 50)
    const stageFile = path.join(tmp, 'packages', 'noread', 'review-48.json')
    const { code, out } = await run(['review', 'run', '--slug', 'noread', '--bucket', '48'])
    expect(code).toBe(1)
    expect(out).toMatch(/Stage not passed: noread:48: no numbers yet/)
    expect(out).toContain('booster set noread --bucket 48')
    expect(existsSync(stageFile)).toBe(false)
    const { out: jsonOut } = await run(['review', 'run', '--slug', 'noread', '--bucket', '48', '--json'])
    expect(JSON.parse(jsonOut)).toMatchObject({ stageFile: null, blocked: expect.stringMatching(/no numbers yet/) })
    // A person already applied this bucket: the stage is done and the file says so.
    openStore(data).upsert('decisions', { id: 'noread:48', slug: 'noread', bucket: '48', decision: 'REPACKAGE', numbers: {}, approvedBy: 'jony', approvedAt: NOW, appliedAt: NOW, updatedAt: NOW, source: 'cli' })
    const applied = await json(['review', 'run', '--slug', 'noread', '--bucket', '48'])
    expect(applied.stageFile).toBe(stageFile)
    expect(JSON.parse(readFileSync(stageFile, 'utf8'))).toMatchObject({ bucket: '48', pass: true, review: null, decision: { decision: 'REPACKAGE', appliedAt: NOW } })
  })
})

describe('booster brief', () => {
  it('renders the week or the day, refuses both, and writes --out', async () => {
    seedHistory()
    seedRow('fresh', 50)
    const week = await json(['brief', '--week'])
    expect(week.window).toBe('week')
    expect(week.readsDue.map((d: any) => d.slug)).toContain('fresh')
    const today = await json(['brief', '--today'])
    expect(today.window).toBe('today')
    const outFile = path.join(tmp, 'brief.md')
    const { out } = await run(['brief', '--out', outFile])
    expect(existsSync(outFile)).toBe(true)
    expect(out).toContain(`Wrote ${outFile}`)
    expect(readFileSync(outFile, 'utf8')).toMatch(/^# /)
    expect(await fails(['brief', '--week', '--today'])).toMatch(/pick --week or --today/)
    expect(await fails(['brief', 'extra'])).toMatch(/usage: booster brief/)
  })
})

describe('booster retro', () => {
  it('drafts the window, the lever tally, the candidate rule and the next three', async () => {
    seedHistory()
    const r = await json(['retro', '--since', '60d'])
    expect(r.window.days).toBe(60)
    expect(r.published.length).toBe(5)
    expect(r.levers.map((l: any) => l.lever).sort()).toEqual([HYPOTHESIS, LEVER])
    expect(r.levers.every((l: any) => l.count === 5)).toBe(true)
    expect(r.candidateRule.count).toBe(5)
    expect(r.candidateRule.rule).toContain('n=5')
    const dated = await json(['retro', '--since', '2026-08-01'])
    expect(dated.window.since).toBe('2026-08-01T00:00:00.000Z')
    const outFile = path.join(tmp, 'retro.md')
    const { out } = await run(['retro', '--since', '60d', '--out', outFile])
    expect(readFileSync(outFile, 'utf8')).toContain(LEVER)
    expect(out).toContain(`Wrote ${outFile}`)
    expect(await fails(['retro', '--since', 'soon'])).toMatch(/--since must be Nd/)
    expect(await fails(['retro', 'nope'])).toMatch(/usage: booster retro/)
  })

  it('--accept-rule needs --yes, then appends under "## Learned rules" and records a protected rule doc', async () => {
    const rule = 'On this channel, the payoff in the thumbnail beats the face'
    const before = readFileSync(path.join(playbook, 'ideation.md'), 'utf8')
    const refused = await fails(['retro', '--accept-rule', rule, '--into', 'playbook/ideation.md', '--slugs', 'old-1,old-2'])
    expect(refused).toMatch(/nothing written. A person re-runs with --yes/)
    expect(readFileSync(path.join(playbook, 'ideation.md'), 'utf8')).toBe(before)
    expect(openStore(data).read('rules')).toEqual([])

    const r = await json(['retro', '--accept-rule', rule, '--into', 'playbook/ideation.md', '--slugs', 'old-1,old-2', '--by', 'jony', '--yes'])
    expect(r.applied).toBe(true)
    expect(r.written).toBe(path.join(playbook, 'ideation.md'))
    const after = readFileSync(path.join(playbook, 'ideation.md'), 'utf8')
    expect(after).toContain('## Learned rules')
    expect(after).toContain(`- 2026-09-14: ${rule} (old-1, old-2)`)
    const doc = openStore(data).read('rules')[0]
    expect(doc).toMatchObject({ rule, status: 'promoted', acceptedBy: 'jony', slugs: ['old-1', 'old-2'] })
    expect(doc.id).toBe(r.ruleId)

    // Idempotent on the file; the doc keeps its acceptance. A bare file name and an absolute path resolve the same way.
    await json(['retro', '--accept-rule', rule, '--into', 'ideation.md', '--yes'])
    await json(['retro', '--accept-rule', rule, '--into', path.join(playbook, 'ideation.md'), '--yes'])
    expect(readFileSync(path.join(playbook, 'ideation.md'), 'utf8').split(rule).length).toBe(2)
    expect(openStore(data).read('rules').length).toBe(1)

    expect(await fails(['retro', '--accept-rule', rule, '--yes'])).toMatch(/--into is required/)
    // The preview runs the same checks as the --yes run, so it never names a file that would be refused.
    expect(await fails(['retro', '--accept-rule', rule, '--into', 'playbook/00-learned-rules.md'])).toMatch(/compiled by `booster rules compile`/)
    expect(await fails(['retro', '--accept-rule', rule, '--into', 'missing.md'])).toMatch(/no such playbook file/)
    expect(await fails(['retro', '--accept-rule', rule, '--into', 'playbook/00-learned-rules.md', '--yes'])).toMatch(/compiled by `booster rules compile`/)
    expect(await fails(['retro', '--accept-rule', rule, '--into', '../channel.json', '--yes'])).toMatch(/outside the playbook folder|Markdown/)
    expect(await fails(['retro', '--accept-rule', rule, '--into', 'playbook/new-file.md', '--yes'])).toMatch(/no such playbook file/)
    expect(await fails(['retro', '--accept-rule', '   ', '--into', 'ideation.md', '--yes'])).toMatch(/a rule needs text/)
  })
})

describe('booster rules', () => {
  it('compile turns the ledger into 00-learned-rules.md, show lists the store, and an accepted rule survives a compile', async () => {
    seedHistory()
    const r = await json(['rules', 'compile'])
    expect(r.tested).toBe(10)
    expect(r.promoted.map((x: any) => x.lever)).toEqual([HYPOTHESIS])
    expect(r.changes).toEqual([expect.objectContaining({ lever: HYPOTHESIS, from: 'new', to: 'promoted' })])
    const file = path.join(playbook, '00-learned-rules.md')
    expect(r.written).toBe(file)
    const content = readFileSync(file, 'utf8')
    expect(content).toMatch(/^# Learned rules \(compiled\)/)
    expect(content).toContain('## Promoted')
    expect(content).toContain('n=10')
    const { out } = await run(['rules', 'compile'])
    expect(out).toContain('Compiled 1 rule from 10 tested rows: 1 promoted, 0 retired, 0 under test.')
    expect(out).toContain('No status changes since the last compile.')

    await json(['retro', '--accept-rule', 'Never shout in the title', '--into', 'ideation.md', '--yes'])
    const again = await json(['rules', 'compile', '--half-life', '30', '--promote-tests', '5'])
    expect(again.rules.map((x: any) => x.rule)).toContain('Never shout in the title')
    expect(again.rules.find((x: any) => x.rule === 'Never shout in the title').acceptedBy).toBe('human')
    const show = await json(['rules', 'show'])
    expect(show.rules.length).toBe(2)
    expect(show.file).toBe(file)
    const shown = await run(['rules', 'show'])
    expect(shown.out).toContain('[accepted by human]')
    expect(shown.out).toContain(HYPOTHESIS)
    expect(await fails(['rules', 'compile', '--half-life', 'long'])).toMatch(/--half-life must be a number/)
    expect(await fails(['rules', 'nope'])).toMatch(/usage: booster rules compile/)
  })

  it('show says what to do on an empty store', async () => {
    const { out } = await run(['rules', 'show'])
    expect(out).toContain('No rules yet')
  })
})

describe('booster decide approve | apply', () => {
  function seedDecision(decision: 'REPACKAGE' | 'SEQUEL' | 'WAIT' = 'REPACKAGE'): void {
    seedRow('weak', 50, { impressions: 25000, ctr: 2, avpPct: 42 })
    openStore(data).upsert('decisions', { id: 'weak:48', slug: 'weak', bucket: '48', decision, numbers: {}, flipCondition: 'CTR back over 4.5%', updatedAt: NOW, source: 'cli' })
  }

  it('approve needs --by and --yes, then stamps who and when without touching the decision', async () => {
    seedDecision()
    expect(await fails(['decide', 'approve', 'weak', '--bucket', '48', '--yes'])).toMatch(/--by is required/)
    expect(await fails(['decide', 'approve', 'weak', '--by', 'jony', '--yes'])).toMatch(/--bucket is required/)
    expect(await fails(['decide', 'approve', 'weak', '--bucket', '48', '--by', 'jony'])).toMatch(/nothing written. A person re-runs with --yes/)
    expect(openStore(data).get('decisions', 'weak:48')!.approvedBy).toBeUndefined()
    const r = await json(['decide', 'approve', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])
    expect(r.applied).toBe(true)
    expect(openStore(data).get('decisions', 'weak:48')).toMatchObject({ decision: 'REPACKAGE', approvedBy: 'jony', approvedAt: '2026-09-14T12:00:00.000Z' })
    const { out } = await run(['decide', 'approve', 'weak', '--bucket', '48', '--by', 'sam', '--yes'])
    expect(out).toContain('Approved decisions/weak:48: REPACKAGE by sam')
    expect(out).toContain('booster decide apply weak --bucket 48')
    expect(await fails(['decide', 'approve', 'missing', '--bucket', '48', '--by', 'jony', '--yes'])).toMatch(/no recorded decision for "missing" at 48 h/)
    expect(await fails(['decide', 'nope'])).toMatch(/unknown decide command "nope"/)
  })

  it('apply stamps appliedAt, approves when nobody had, marks the ledger row repackaged and flips repackage.json', async () => {
    seedDecision()
    const planFile = path.join(tmp, 'packages', 'weak', 'repackage.json')
    mkdirSync(path.dirname(planFile), { recursive: true })
    writeFileSync(planFile, JSON.stringify({ slug: 'weak', decisionId: 'weak:48', applied: false, swap: 'title' }))
    const refused = await fails(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony'])
    expect(refused).toMatch(/nothing written/)
    expect(openStore(data).get('ledger', 'weak')!.repackagedAt).toBeUndefined()
    const r = await json(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])
    expect(r.applied).toBe(true)
    expect(r.stampsRepackagedAt).toBe(true)
    expect(r.repackageFile).toBe(planFile)
    const doc = openStore(data).get('decisions', 'weak:48')!
    expect(doc).toMatchObject({ approvedBy: 'jony', appliedAt: '2026-09-14T12:00:00.000Z' })
    expect(openStore(data).get('ledger', 'weak')!.repackagedAt).toBe('2026-09-14T12:00:00.000Z')
    expect(JSON.parse(readFileSync(planFile, 'utf8'))).toMatchObject({ applied: true, appliedAt: '2026-09-14T12:00:00.000Z', appliedBy: 'jony', swap: 'title' })
    expect(await fails(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])).toMatch(/already applied/)
    expect(await fails(['decide', 'approve', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])).toMatch(/nothing to approve/)
  })

  it('apply says so when repackage.json belongs to another decision and leaves it untouched', async () => {
    seedDecision()
    const planFile = path.join(tmp, 'packages', 'weak', 'repackage.json')
    mkdirSync(path.dirname(planFile), { recursive: true })
    writeFileSync(planFile, JSON.stringify({ slug: 'weak', decisionId: 'weak:168', applied: false }))
    const { out, err } = await run(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])
    expect(out).toContain(`${planFile}: NOT marked applied (belongs to decisions/weak:168, not weak:48`)
    expect(out).not.toContain(`${planFile}: applied.`)
    expect(err).toMatch(/belongs to decisions\/weak:168/)
    expect(JSON.parse(readFileSync(planFile, 'utf8')).applied).toBe(false)
    const doc = openStore(data).get('decisions', 'weak:48')!
    expect(doc.appliedAt).toBe('2026-09-14T12:00:00.000Z')
    // The JSON result reports the file as not applied too.
    openStore(data).upsert('decisions', { ...doc, appliedAt: undefined })
    const r = await json(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])
    expect(r.repackageFile).toBeNull()
    expect(r.repackageFileSkipped).toMatch(/belongs to decisions\/weak:168/)
  })

  it('apply leaves the ledger row alone for a sequel and refuses WAIT', async () => {
    seedDecision('SEQUEL')
    const { out } = await run(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])
    expect(out).toContain('Applied decisions/weak:48: SEQUEL by jony')
    expect(out).toContain('booster bank sequels')
    expect(openStore(data).get('ledger', 'weak')!.repackagedAt).toBeUndefined()
    openStore(data).upsert('decisions', { id: 'weak:48', slug: 'weak', bucket: '48', decision: 'WAIT', numbers: {}, updatedAt: NOW, source: 'cli' })
    expect(await fails(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])).toMatch(/is WAIT/)
    // HOLD is a flip condition waiting for the next read: applying it would close the bucket for good.
    openStore(data).upsert('decisions', { id: 'weak:48', slug: 'weak', bucket: '48', decision: 'HOLD', numbers: {}, flipCondition: 'CTR still under 4% at 168 h', updatedAt: NOW, source: 'cli' })
    expect(await fails(['decide', 'apply', 'weak', '--bucket', '48', '--by', 'jony', '--yes'])).toMatch(/is HOLD: there is nothing to apply; the flip condition \(CTR still under 4% at 168 h\)/)
    expect(openStore(data).get('decisions', 'weak:48')!.appliedAt).toBeUndefined()
  })
})
