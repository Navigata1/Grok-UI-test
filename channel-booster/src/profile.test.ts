import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diagnose } from './postmortem.js'
import {
  applyProfileThresholds,
  baselineInputFrom,
  defaultProfile,
  describeBaselineInput,
  describeProfile,
  describeSignatureText,
  diagnoseBaseline,
  initProfile,
  loadProfile,
  parseColors,
  parseProfile,
  profileExists,
  refreshBaselines,
  renderProfileText,
  resolveProfilePath,
  saveProfile,
  shiftedMetrics,
} from './profile.js'
import { LedgerRow, ProfileDoc, type Baselines } from './schema.js'
import { resetThresholds, thresholds } from './thresholds.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const now = new Date('2026-09-14T12:00:00Z')
let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'booster-profile-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); resetThresholds() })

/** A ledger row published `weeksAgo` weeks before `now` with 48 h and 168 h reads. */
function row(i: number, overrides: { ctr?: number; avpPct?: number; retention30sPct?: number; views48?: number; views168?: number; returningPct?: number; weeksAgo?: number; repackagedAt?: string; skip48?: boolean } = {}): LedgerRow {
  const publishedAt = new Date(now.getTime() - (overrides.weeksAgo ?? i + 2) * 7 * 86_400_000).toISOString()
  return LedgerRow.parse({
    id: `v${i}`,
    slug: `v${i}`,
    title: `Video ${i}`,
    publishedAt,
    reads: {
      ...(overrides.skip48 ? {} : { '48': { at: publishedAt, impressions: 10_000 + i * 500, ctr: overrides.ctr ?? 4 + (i % 3), avpPct: overrides.avpPct ?? 40 + i, retention30sPct: overrides.retention30sPct, views: overrides.views48 ?? 2_000 + i * 100 } }),
      '168': { at: publishedAt, views: overrides.views168 ?? 5_000 + i * 100, returningPct: overrides.returningPct ?? 35 },
    },
    lever: 'stakes concept won',
    repackagedAt: overrides.repackagedAt,
    updatedAt: publishedAt,
  })
}

const rows = (n: number, overrides?: Parameters<typeof row>[1]) => Array.from({ length: n }, (_, i) => row(i, overrides))

describe('profile paths', () => {
  it('resolves an explicit path, then BOOSTER_PROFILE, then channel-booster/channel.json', () => {
    vi.stubEnv('BOOSTER_PROFILE', '')
    expect(resolveProfilePath()).toBe(path.resolve(here, '..', 'channel.json'))
    vi.stubEnv('BOOSTER_PROFILE', path.join(root, 'env.json'))
    expect(resolveProfilePath()).toBe(path.join(root, 'env.json'))
    expect(resolveProfilePath(path.join(root, 'explicit.json'))).toBe(path.join(root, 'explicit.json'))
    expect(resolveProfilePath('relative.json')).toBe(path.resolve('relative.json'))
  })
})

describe('loadProfile / saveProfile', () => {
  it('returns defaults when the file is missing and reports that it does not exist', () => {
    const file = path.join(root, 'missing.json')
    expect(profileExists(file)).toBe(false)
    const p = loadProfile(file)
    expect(p).toEqual(defaultProfile())
    expect(p.maxPerWeek).toBe(1)
    expect(p.publishDay).toBe('thu')
    expect(p.store).toBe('local')
    expect(p.series).toEqual([])
    expect(p.thresholds).toEqual({})
    expect(p.baselines).toBeUndefined()
  })

  it('round-trips through disk with a stamped updatedAt and pretty JSON', () => {
    const file = path.join(root, 'nested', 'channel.json')
    const profile = initProfile({ positioning: 'Vans for first-timers', colors: 'yellow,black', now })
    const saved = saveProfile(profile, file, { now: new Date('2026-09-15T00:00:00Z') })
    expect(saved.updatedAt).toBe('2026-09-15T00:00:00.000Z')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "positioning"')
    expect(profileExists(file)).toBe(true)
    expect(loadProfile(file)).toEqual(saved)
  })

  it('reads the path from BOOSTER_PROFILE when no path is given', () => {
    const file = path.join(root, 'env.json')
    vi.stubEnv('BOOSTER_PROFILE', file)
    saveProfile(initProfile({ persona: 'Sam', now }), undefined, { now })
    expect(loadProfile().persona).toBe('Sam')
    expect(profileExists()).toBe(true)
  })

  it('names the file on invalid JSON and the field on a schema mismatch', () => {
    const bad = path.join(root, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(() => loadProfile(bad)).toThrow(/bad\.json is not valid JSON/)
    writeFileSync(bad, JSON.stringify({ maxPerWeek: 'two', signature: { colors: [] } }))
    expect(() => loadProfile(bad)).toThrow(/bad\.json does not match the profile schema: .*maxPerWeek/)
    expect(() => loadProfile(bad)).toThrow(/signature\.colors/)
    expect(() => parseProfile({ publishDay: 'someday' })).toThrow(/channel\.json does not match.*publishDay/)
    expect(() => saveProfile({ ...defaultProfile(), store: 'cloud' as never }, path.join(root, 'x.json'), { now })).toThrow(/store/)
  })

  it('applies schema defaults to a partial file', () => {
    const file = path.join(root, 'partial.json')
    writeFileSync(file, JSON.stringify({ positioning: 'Only this' }))
    const p = loadProfile(file)
    expect(p.positioning).toBe('Only this')
    expect(p.competitors).toEqual([])
    expect(p.solo).toBe(true)
  })
})

describe('initProfile', () => {
  it('builds a validated first profile from trimmed answers', () => {
    const p = initProfile({
      positioning: '  Couples building a first van  ',
      persona: 'Sam with a Sprinter',
      colors: 'Yellow / black',
      facePolicy: 'either',
      maxWords: 3,
      framing: 'van interior',
      competitors: 'Van Life Builds, The Indie Projects,, van life builds',
      series: [{ name: ' Build Diaries ', promise: 'one system per episode', cadence: 'fortnightly' }, { name: '', promise: 'dropped' }],
      maxPerWeek: 1,
      publishDay: 'thu',
      solo: true,
      store: 'db',
      thresholds: { ctrHealthyAbs: 3.5 },
      neverAgain: 'vlog numbers in titles; whole-van exteriors',
      now,
    })
    expect(p.positioning).toBe('Couples building a first van')
    expect(p.signature).toEqual({ colors: ['yellow', 'black'], facePolicy: 'either', maxWords: 3, framing: 'van interior' })
    expect(p.competitors).toEqual(['Van Life Builds', 'The Indie Projects'])
    expect(p.series).toEqual([{ name: 'Build Diaries', promise: 'one system per episode', cadence: 'fortnightly' }])
    expect(p.store).toBe('db')
    expect(p.thresholds).toEqual({ ctrHealthyAbs: 3.5 })
    expect(p.neverAgain).toEqual(['vlog numbers in titles', 'whole-van exteriors'])
    expect(p.updatedAt).toBe(now.toISOString())
    expect(ProfileDoc.safeParse(p).success).toBe(true)
  })

  it('leaves the signature out without colours, and refuses half a signature', () => {
    expect(initProfile({ positioning: 'x', now }).signature).toBeUndefined()
    expect(initProfile({ colors: ['yellow'], now }).signature).toEqual({ colors: ['yellow'], facePolicy: 'either', maxWords: 3 })
    expect(() => initProfile({ facePolicy: 'never', now })).toThrow(/needs at least one colour/)
    expect(() => initProfile({ colors: 'yellow,black', maxWords: 9, now })).toThrow(/maxWords/)
  })

  it('parses colour lists on comma, slash and pipe', () => {
    expect(parseColors('Yellow/Black')).toEqual(['yellow', 'black'])
    expect(parseColors(['white', ' Red ', 'white'])).toEqual(['white', 'red'])
    expect(parseColors(undefined)).toEqual([])
  })
})

describe('refreshBaselines', () => {
  it('stores the 48-hour baselines, returns the 7-day ones, and keeps the previous computation', () => {
    const first = refreshBaselines(defaultProfile(), rows(12), { now })
    expect(first.profile.baselines?.bucket).toBe('48')
    expect(first.profile.baselines?.n).toBe(10)
    expect(first.profile.baselines?.tier).toBe('solid')
    expect(first.profile.baselines?.ctr?.median).toBeGreaterThan(3)
    expect(first.profile.baselines?.views?.n).toBe(10)
    expect(first.profile.previousBaselines).toBeUndefined()
    expect(first.previous).toBeUndefined()
    expect(first.shift).toBe(false)
    expect(first.shifted).toEqual([])
    expect(first.profile.updatedAt).toBe(now.toISOString())
    expect(first.baselines168.bucket).toBe('168')
    expect(first.baselines168.views?.n).toBe(10)
    expect(first.baselines168.returningPct?.median).toBe(35)
    expect(first.baselines168.ctr).toBeUndefined()

    const second = refreshBaselines(first.profile, rows(12), { now })
    expect(second.profile.previousBaselines).toEqual(first.profile.baselines)
    expect(second.previous).toEqual(first.profile.baselines)
    expect(second.shift).toBe(false)
  })

  it('flags a shift when a median moves more than one MAD and names the metric', () => {
    const first = refreshBaselines(defaultProfile(), rows(8), { now })
    const doubled = rows(8).map((r) => LedgerRow.parse({ ...r, reads: { ...r.reads, '48': { ...r.reads['48'], ctr: (r.reads['48']!.ctr ?? 0) * 3 } } }))
    const second = refreshBaselines(first.profile, doubled, { now })
    expect(second.shift).toBe(true)
    expect(second.shifted).toEqual(['ctr'])
    expect(second.profile.baselines?.shift).toBe(true)
    expect(second.profile.previousBaselines?.shift).toBe(false)
  })

  it('excludes young and repackaged rows and respects window and minAgeDays', () => {
    const mixed = [...rows(6), row(6, { weeksAgo: 0.3, ctr: 50 }), row(7, { weeksAgo: 4, repackagedAt: now.toISOString(), ctr: 50 })]
    const r = refreshBaselines(defaultProfile(), mixed, { now })
    expect(r.profile.baselines?.n).toBe(6)
    expect(r.profile.baselines?.tier).toBe('thin')
    expect(r.profile.baselines?.ctr?.median).toBeLessThan(10)
    const windowed = refreshBaselines(defaultProfile(), rows(12), { now, window: 4 })
    expect(windowed.profile.baselines?.n).toBe(4)
    expect(windowed.profile.baselines?.tier).toBe('prior')
    const relaxed = refreshBaselines(defaultProfile(), mixed, { now, minAgeDays: 1 })
    expect(relaxed.profile.baselines?.n).toBe(7)
  })

  it('does not mutate the input profile', () => {
    const profile = defaultProfile()
    refreshBaselines(profile, rows(6), { now })
    expect(profile.baselines).toBeUndefined()
    expect(profile.updatedAt).toBeUndefined()
  })

  it('shiftedMetrics compares every stat and ignores a zero MAD', () => {
    const stat = (median: number, mad: number) => ({ median, mad, n: 6 })
    const base: Baselines = { computedAt: now.toISOString(), bucket: '48', n: 6, tier: 'thin', shift: false }
    const prev: Baselines = { ...base, ctr: stat(4, 0.5), avpPct: stat(40, 2), views: stat(1000, 0) }
    const next: Baselines = { ...base, ctr: stat(4.4, 0.5), avpPct: stat(45, 2), views: stat(9000, 0), impressions: stat(500, 10) }
    expect(shiftedMetrics(next, prev)).toEqual(['avpPct'])
    expect(shiftedMetrics(next, undefined)).toEqual([])
  })
})

describe('applyProfileThresholds', () => {
  it('applies overrides atomically and retags them as house', () => {
    expect(applyProfileThresholds(defaultProfile())).toEqual([])
    const keys = applyProfileThresholds({ ...defaultProfile(), thresholds: { ctrHealthyAbs: 3.5, hookGateScore: 75 } })
    expect(keys).toEqual(['ctrHealthyAbs', 'hookGateScore'])
    expect(thresholds.ctrHealthyAbs.value).toBe(3.5)
    expect(thresholds.hookGateScore.value).toBe(75)
    expect(thresholds.hookGateScore.evidence).toBe('house')
    resetThresholds()
    expect(() => applyProfileThresholds({ ...defaultProfile(), thresholds: { ctrHealthyAbs: 3.5, nope: 1 } })).toThrow(/channel\.json thresholds: unknown threshold "nope"/)
    expect(thresholds.ctrHealthyAbs.value).toBe(3)
    expect(() => applyProfileThresholds({ ...defaultProfile(), thresholds: { ctrLowAbs: Number.NaN } })).toThrow(/must be a number/)
  })
})

describe('baselineInputFrom', () => {
  it('borrows the cold-start priors with source default when there are no baselines', () => {
    const input = baselineInputFrom(defaultProfile())
    expect(input).toMatchObject({ ctr: 4, avpPct: 40, retention30sPct: 60, source: 'default', tier: 'prior', n: 0, shift: false })
    expect(input.views).toBeUndefined()
    expect(input.borrowed).toEqual(['ctr', 'avpPct', 'retention30sPct'])
    expect(diagnoseBaseline(defaultProfile())).toBeUndefined()
    expect(describeBaselineInput(input)).toBe('baseline CTR 4% / AVP 40% / 30 s 60% [default, prior, n=0]')
  })

  it('still borrows the priors when the tier is prior even though stats exist', () => {
    const { profile } = refreshBaselines(defaultProfile(), rows(3), { now })
    expect(profile.baselines?.tier).toBe('prior')
    expect(profile.baselines?.ctr).toBeDefined()
    const input = baselineInputFrom(profile)
    expect(input.source).toBe('default')
    expect(input.tier).toBe('prior')
    expect(input.n).toBe(3)
    expect(input.ctr).toBe(thresholds.priorCtr.value)
    expect(diagnoseBaseline(profile)).toBeUndefined()
  })

  it('returns computed medians with the tier, and borrows only the fields the ledger lacks', () => {
    const { profile } = refreshBaselines(defaultProfile(), rows(10, { ctr: 4.5, avpPct: 41, views48: 1500 }), { now })
    const input = baselineInputFrom(profile)
    expect(input).toMatchObject({ ctr: 4.5, avpPct: 41, views: 1500, retention30sPct: 60, source: 'computed', tier: 'solid', n: 10, bucket: '48' })
    expect(input.borrowed).toEqual(['retention30sPct'])
    expect(input.computedAt).toBe(now.toISOString())
    expect(describeBaselineInput(input)).toBe('baseline CTR 4.5% / AVP 41% / 30 s 60% / views 1500 [computed, solid, n=10, 48 h; borrowed: retention30sPct]')
    expect(diagnoseBaseline(profile)).toEqual({ ctr: 4.5, avpPct: 41, views: 1500 })
    const full = baselineInputFrom(refreshBaselines(defaultProfile(), rows(6, { retention30sPct: 62 }), { now }).profile)
    expect(full.retention30sPct).toBe(62)
    expect(full.borrowed).toEqual([])
    expect(full.tier).toBe('thin')
  })

  it('feeds diagnose() so the verdict compares against the channel, not the priors', () => {
    const { profile } = refreshBaselines(defaultProfile(), rows(10, { ctr: 6, avpPct: 40, views48: 5_000 }), { now })
    const d = diagnose({ impressions: 20_000, ctr: 3, avpPct: 42, hoursSincePublish: 48, baseline: diagnoseBaseline(profile) })
    expect(d.baselineSource).toBe('provided')
    expect(d.bottleneck).toBe('packaging')
    expect(d.evidence[0]).toContain('vs baseline 6%')
    const cold = diagnose({ impressions: 20_000, ctr: 3, avpPct: 42, hoursSincePublish: 48, baseline: diagnoseBaseline(defaultProfile()) })
    expect(cold.baselineSource).toBe('default')
    expect(cold.evidence[0]).toMatch(/baseline is borrowed/)
  })

  it('reads overridden priors from the live threshold table', () => {
    applyProfileThresholds({ ...defaultProfile(), thresholds: { priorCtr: 5 } })
    expect(baselineInputFrom(defaultProfile()).ctr).toBe(5)
  })
})

describe('describeProfile', () => {
  it('says so when nothing is described', () => {
    expect(describeProfile(defaultProfile())).toBe('Channel not described yet: run booster profile init.')
  })

  it('writes one paragraph covering positioning, persona, series, signature, competitors and cadence', () => {
    const profile = initProfile({
      positioning: 'Couples building a first van',
      persona: 'Sam with a Sprinter and a spreadsheet.',
      colors: 'yellow,black',
      facePolicy: 'either',
      maxWords: 3,
      framing: 'subject in the lower third',
      typeface: 'condensed caps',
      competitors: ['Van Life Builds', 'Nate Murphy'],
      series: [{ name: 'Build Diaries', promise: 'one system per episode', cadence: 'fortnightly' }],
      maxPerWeek: 1,
      publishDay: 'thu',
      solo: true,
      neverAgain: ['vlog numbers in titles'],
      now,
    })
    const text = describeProfile(profile)
    expect(text).not.toContain('\n')
    expect(text).toContain('Positioning: Couples building a first van.')
    expect(text).toContain('Returning viewer: Sam with a Sprinter and a spreadsheet.')
    expect(text).toContain('Series: Build Diaries (one system per episode, fortnightly).')
    expect(text).toContain('Visual signature: yellow/black, face either, at most 3 words of text, framing subject in the lower third, typeface condensed caps.')
    expect(text).toContain('Competitor set: Van Life Builds, Nate Murphy.')
    expect(text).toContain('Cadence: at most 1 upload per week, publish day Thursday, solo creator.')
    expect(text).toContain('Never again: vlog numbers in titles.')
    expect(text).not.toContain('Own baselines')
  })

  it('adds the baseline tier and phrases fractional cadence', () => {
    const { profile } = refreshBaselines(initProfile({ positioning: 'x', maxPerWeek: 0.5, solo: false, publishDay: 'sat', now }), rows(6, { ctr: 4.5, avpPct: 41, views48: 1500 }), { now })
    const text = describeProfile(profile)
    expect(text).toContain('Cadence: one upload every 2 weeks, publish day Saturday, with a team.')
    expect(text).toContain('Own baselines at 48 h (thin, n=6): CTR 4.5%, AVP 41%, views 1500.')
    expect(describeSignatureText({ colors: ['white', 'red'], facePolicy: 'always', maxWords: 1, notes: 'red arrow' })).toBe('white/red, face always, at most 1 word of text, red arrow')
  })
})

describe('renderProfileText', () => {
  it('prints every field for profile show, with placeholders and the verdict baseline line', () => {
    const text = renderProfileText(defaultProfile(), { path: '/tmp/channel.json', exists: false })
    expect(text).toContain('Profile: /tmp/channel.json (not created yet')
    expect(text).toContain('Positioning: —')
    expect(text).toContain('Threshold overrides: none')
    expect(text).toContain('Baselines: none computed')
    expect(text).toContain('For verdicts: baseline CTR 4% / AVP 40% / 30 s 60% [default, prior, n=0]')
    const { profile } = refreshBaselines(initProfile({ positioning: 'x', colors: 'yellow,black', thresholds: { hookGateScore: 75 }, now }), rows(10), { now })
    const full = renderProfileText(profile)
    expect(full).toContain('Signature: yellow/black, face either, at most 3 words of text')
    expect(full).toContain('Threshold overrides: hookGateScore=75')
    expect(full).toContain('Baselines (48 h, solid, n=10, computed 2026-09-14):')
    expect(full).toMatch(/CTR: median [\d.]+%, MAD [\d.]+, n=10/)
    expect(full).toContain('30 s retention: not in the ledger')
    expect(full).toContain(`Updated: ${now.toISOString()}`)
  })
})

describe('channel.example.json', () => {
  it('is a complete, valid van-life profile with the yellow/black signature', () => {
    const file = path.resolve(here, '..', 'channel.example.json')
    const profile = loadProfile(file)
    expect(profile.signature).toMatchObject({ colors: ['yellow', 'black'], facePolicy: 'either', maxWords: 3 })
    expect(profile.positioning).toMatch(/van/i)
    expect(profile.persona).toBeTruthy()
    expect(profile.series.length).toBeGreaterThanOrEqual(2)
    expect(profile.competitors.length).toBeGreaterThanOrEqual(3)
    expect(profile.neverAgain.length).toBeGreaterThanOrEqual(1)
    expect(profile.maxPerWeek).toBe(1)
    expect(profile.store).toBe('local')
    expect(profile.baselines).toBeUndefined()
    expect(baselineInputFrom(profile).source).toBe('default')
    expect(describeProfile(profile)).toContain('Visual signature: yellow/black, face either, at most 3 words of text')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const key of ['positioning', 'persona', 'series', 'signature', 'competitors', 'maxPerWeek', 'publishDay', 'solo', 'store', 'thresholds', 'neverAgain', 'updatedAt']) expect(raw, key).toHaveProperty(key)
  })
})
