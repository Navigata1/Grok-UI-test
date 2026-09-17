import { afterEach, describe, expect, it } from 'vitest'
import {
  BET_COUNT,
  GENERIC_TITLE_WORDS,
  NEVER_AGAIN_MIN_ROWS,
  SHOT_FORMAT_NOTES,
  buildDirection,
  framingFor,
  hasGenericWord,
  neverAgainFrom,
  renderDirectionMarkdown,
  renderShotListMarkdown,
  returningTrendOf,
  shotList,
  type ScanRowLike,
  type ShotListInput,
} from './direction.js'
import { IdeaDoc, ProfileDoc, type LedgerRow } from './schema.js'
import { applyOverrides, resetThresholds } from './thresholds.js'
import type { OutlierRow } from './types.js'
import { WORKFLOW_FORMATS } from './workflow.js'

afterEach(() => resetThresholds())

const T0 = Date.parse('2026-01-01T00:00:00Z')

/** A ledger row published `day` days after T0 with a 168-hour read. */
function row(slug: string, title: string, day: number, views: number, extra: { returningPct?: number; sequelOf?: string; noRead?: boolean } = {}): LedgerRow {
  const publishedAt = new Date(T0 + day * 86_400_000).toISOString()
  const at = new Date(T0 + (day + 7) * 86_400_000).toISOString()
  return {
    id: slug,
    slug,
    title,
    publishedAt,
    reads: extra.noRead ? {} : { '168': { at, views, ...(extra.returningPct !== undefined ? { returningPct: extra.returningPct } : {}) } },
    ...(extra.sequelOf ? { sequelOf: extra.sequelOf } : {}),
    updatedAt: at,
    source: 'cli',
  }
}

function idea(text: string, extra: Partial<IdeaDoc> = {}): IdeaDoc {
  return IdeaDoc.parse({
    id: `idea:${text.toLowerCase().replace(/\W+/g, '-')}`,
    idea: text,
    scores: { demand: 3, packaging: 3, fit: 3, angle: 3, payoff: 3, feasibility: 3 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  })
}

function profile(overrides: Record<string, unknown> = {}): ProfileDoc {
  return ProfileDoc.parse(overrides)
}

function scanRow(title: string, tier: ScanRowLike['tier'], formats: string[]): ScanRowLike {
  return { title, tier, formats, multiplier: tier === 'outlier' ? 12 : tier === 'strong' ? 6 : 1 }
}

/** Ten normal rows around 1 000 views plus whatever the test adds. */
function baseLedger(): LedgerRow[] {
  return Array.from({ length: 10 }, (_, i) => row(`plain-${i}`, `Plain video number ${i + 1} about solar batteries`, i, 1_000 + i * 10, { returningPct: 30 }))
}

describe('buildDirection', () => {
  it('passes positioning and persona through and leaves them out when the profile has none', () => {
    const p = profile({ positioning: 'Off-grid builders get one tested build a week', persona: 'A weekend builder with a van' })
    const d = buildDirection({ profile: p, ledgerRows: [] })
    expect(d.positioning).toBe('Off-grid builders get one tested build a week')
    expect(d.persona).toBe('A weekend builder with a van')
    const empty = buildDirection({ profile: profile(), ledgerRows: [] })
    expect(empty.positioning).toBeUndefined()
    expect(empty.persona).toBeUndefined()
    expect(empty.provenFormats).toEqual([])
    expect(empty.series).toEqual([])
    expect(empty.neverAgain).toEqual([])
    expect(empty.bets).toEqual([])
    expect(empty.sampleSize).toBe(0)
  })

  it('finds proven formats in the ledger own outliers with the slugs as evidence', () => {
    const rows = [...baseLedger(), row('i-tried-30-days', 'I Tried Living Off One Battery for 30 Days', 20, 12_000, { returningPct: 30 })]
    const d = buildDirection({ profile: profile(), ledgerRows: rows })
    const challenge = d.provenFormats.find((f) => f.format === 'challenge')
    expect(challenge).toBeDefined()
    expect(challenge!.evidence).toEqual(['i-tried-30-days'])
    expect(challenge!.ledgerWins).toBe(1)
    expect(challenge!.source).toBe('ledger')
    expect(challenge!.lift).toBeUndefined()
    expect(d.provenFormats.map((f) => f.format)).toContain('first-person')
    expect(d.thresholdsUsed.some((t) => t.startsWith('ownWinnerMultiplier=5'))).toBe(true)
  })

  it('adds formats that over-index in the audit scan, with winning titles as evidence, and skips thin ones', () => {
    const scan: ScanRowLike[] = [
      scanRow('Top 5 Batteries Tested', 'outlier', ['list', 'test']),
      scanRow('7 Ways To Kill A Battery', 'strong', ['list', 'negative']),
      scanRow('Best 3 Chargers', 'outlier', ['list']),
      scanRow('Battery Basics', 'normal', []),
      scanRow('Charging Explained', 'normal', []),
      scanRow('Why Did It Die?', 'normal', ['question']),
      scanRow('Shop Tour', 'normal', ['story']),
    ]
    const d = buildDirection({ profile: profile(), ledgerRows: [], ownScan: scan })
    const list = d.provenFormats.find((f) => f.format === 'list')
    expect(list).toBeDefined()
    expect(list!.source).toBe('scan')
    expect(list!.lift).toBeGreaterThan(1)
    expect(list!.evidence).toEqual(['Top 5 Batteries Tested', '7 Ways To Kill A Battery', 'Best 3 Chargers'])
    // 'test' and 'negative' are carried by one title: thin, not reported. 'question' has no winner.
    expect(d.provenFormats.map((f) => f.format)).not.toContain('test')
    expect(d.provenFormats.map((f) => f.format)).not.toContain('negative')
    expect(d.provenFormats.map((f) => f.format)).not.toContain('question')
  })

  it('accepts the audit OutlierRow type as the own scan without conversion', () => {
    const audit: OutlierRow[] = [
      { title: 'Top 5 Batteries Tested', views: 12_000, multiplier: 12, baseline: 1_000, tier: 'outlier', formats: ['list', 'test'] },
      { title: '7 Ways To Kill A Battery', views: 6_000, multiplier: 6, baseline: 1_000, tier: 'strong', formats: ['list', 'negative'] },
      { title: 'Best 3 Chargers', views: 11_000, multiplier: 11, baseline: 1_000, tier: 'outlier', formats: ['list'] },
      { title: 'Battery Basics', views: 1_000, multiplier: 1, baseline: 1_000, tier: 'normal', formats: [] },
      { title: 'Charging Explained', views: 900, multiplier: 0.9, baseline: 1_000, tier: 'normal', formats: [] },
    ]
    const d = buildDirection({ profile: profile(), ledgerRows: [], ownScan: audit })
    expect(d.provenFormats.map((f) => f.format)).toEqual(['list'])
    expect(d.bets[0]).toMatchObject({ kind: 'format', name: 'list' })
    expect(d.bets[0].reason).toMatch(/^lift \d+\.\dx among winners$/)
  })

  it('merges ledger and scan evidence for the same format and ranks ledger wins first', () => {
    const rows = [...baseLedger(), row('top-5-batteries', 'Top 5 Batteries I Trust', 20, 12_000)]
    const scan: ScanRowLike[] = [
      scanRow('Top 5 Batteries I Trust', 'outlier', ['list']),
      scanRow('Best 7 Chargers', 'strong', ['list']),
      scanRow('3 Mistakes With Solar', 'outlier', ['list', 'negative']),
      scanRow('Battery Basics', 'normal', []),
      scanRow('Charging Explained', 'normal', []),
    ]
    const d = buildDirection({ profile: profile(), ledgerRows: rows, ownScan: scan })
    const list = d.provenFormats.find((f) => f.format === 'list')!
    expect(list.source).toBe('both')
    expect(list.ledgerWins).toBe(1)
    expect(list.lift).toBeGreaterThan(1)
    expect(list.evidence[0]).toBe('top-5-batteries')
    expect(list.evidence).toContain('Best 7 Chargers')
    expect(d.provenFormats[0].format).toBe('list')
  })

  it('attaches videos to a series by parent slug, sequel chain, slug prefix, title mention and bank package id', () => {
    const rows = [
      row('generator-build', 'Building a generator from scrap', 0, 1_000),
      row('generator-part-2', 'Round two', 5, 1_100, { sequelOf: 'generator-build' }),
      row('generator-part-3', 'Round three', 10, 1_200, { sequelOf: 'generator-part-2' }),
      row('scrap-lab-ep-4', 'Fourth one', 15, 900),
      row('unrelated-slug', 'The Scrap Lab returns', 20, 800),
      row('by-idea', 'Something else', 25, 700),
      row('nothing', 'A van tour', 30, 600),
    ]
    const p = profile({ series: [{ name: 'Scrap Lab', promise: 'one build from junk', cadence: 'monthly', parentSlug: 'generator-build' }] })
    const ideas = [idea('Build a welder from microwaves', { series: 'Scrap Lab', packageId: 'by-idea' })]
    const d = buildDirection({ profile: p, ledgerRows: rows, ideas })
    expect(d.series).toHaveLength(1)
    const s = d.series[0]
    expect(s.name).toBe('Scrap Lab')
    expect(s.cadence).toBe('monthly')
    expect(s.parentSlug).toBe('generator-build')
    expect(s.videos).toEqual(['generator-build', 'generator-part-2', 'generator-part-3', 'scrap-lab-ep-4', 'unrelated-slug', 'by-idea'])
    expect(s.ideas).toBe(1)
  })

  it('calls the returning trend from the 168-hour returning shares in publish order', () => {
    const mk = (pcts: number[]) => pcts.map((pct, i) => row(`lab-${i}`, `Lab episode ${i}`, i * 7, 1_000, { returningPct: pct }))
    const p = profile({ series: [{ name: 'Lab', promise: 'x' }] })
    expect(buildDirection({ profile: p, ledgerRows: mk([20, 25, 30, 36]) }).series[0].returningTrend).toBe('up')
    expect(buildDirection({ profile: p, ledgerRows: mk([40, 38, 30, 28]) }).series[0].returningTrend).toBe('down')
    expect(buildDirection({ profile: p, ledgerRows: mk([30, 31, 29, 32]) }).series[0].returningTrend).toBe('flat')
    expect(buildDirection({ profile: p, ledgerRows: mk([30]) }).series[0].returningTrend).toBe('unknown')
    expect(buildDirection({ profile: p, ledgerRows: [] }).series[0].returningTrend).toBe('unknown')
    // A video without a returning read is listed but does not vote.
    const rows = [...mk([20, 30]), row('lab-9', 'Lab episode 9', 100, 1_000)]
    const d = buildDirection({ profile: p, ledgerRows: rows })
    expect(d.series[0].videos).toHaveLength(3)
    expect(d.series[0].returningPcts).toEqual([20, 30])
    expect(d.series[0].returningTrend).toBe('up')
  })

  it('builds the never-again list from the bottom quartile and keeps the profile entries first', () => {
    const rows = [
      row('weekly-update', 'Weekly update and some thoughts', 0, 100),
      row('channel-chat', 'Channel chat about random stuff', 1, 120),
      row('life-vlog', 'Life vlog', 2, 150),
      row('win-1', '5 Batteries That Never Die', 3, 5_000),
      row('win-2', 'I Tested 3 Chargers for 30 Days', 4, 4_000),
      row('win-3', 'Why 2 Panels Beat 4', 5, 3_500),
      row('win-4', '7 Mistakes That Killed My $500 Battery', 6, 3_000),
      row('win-5', 'Is 1 Battery Enough? The $200 Test', 7, 2_800),
      row('mid-1', '10 Cheap Tools That Actually Work', 8, 2_000),
      row('mid-2', 'How To Wire 2 Panels in 10 Minutes', 9, 1_800),
      row('mid-3', 'Top 3 Inverters Under $300', 10, 1_500),
      row('mid-4', '4 Signs Your Charger Is Dying', 11, 1_400),
    ]
    const p = profile({ neverAgain: ['no face on the thumbnail'] })
    const d = buildDirection({ profile: p, ledgerRows: rows })
    expect(d.sampleSize).toBe(12)
    expect(d.neverAgainFindings.map((f) => f.pattern)).toEqual(['no number in the title', 'generic words in the title', 'no stake or question in the title'])
    const noNumber = d.neverAgainFindings[0]
    expect(noNumber.slugs).toEqual(['weekly-update', 'channel-chat', 'life-vlog'])
    expect(noNumber.bottomCount).toBe(3)
    expect(noNumber.share).toBe(1)
    expect(noNumber.restShare).toBe(0)
    expect(d.neverAgain[0]).toBe('no face on the thumbnail')
    expect(d.neverAgain[1]).toBe('no number in the title (3 of the bottom 3 by 7-day views: weekly-update, channel-chat, life-vlog)')
    expect(d.neverAgain).toHaveLength(4)
  })

  it('does not report a pattern the rest of the ledger shares just as much', () => {
    // Every title lacks a number: "no number" is not what separates the bottom quartile.
    const rows = Array.from({ length: 8 }, (_, i) => row(`v-${i}`, `Why my battery died again`, i, 100 * (i + 1)))
    expect(neverAgainFrom(rows)).toEqual([])
  })

  it('needs enough rows with a 7-day read before it computes a quartile', () => {
    const few = Array.from({ length: NEVER_AGAIN_MIN_ROWS - 1 }, (_, i) => row(`v-${i}`, 'Weekly update', i, 100 * (i + 1)))
    expect(neverAgainFrom(few)).toEqual([])
    const withoutReads = [...few, row('no-read', 'Weekly update', 9, 0, { noRead: true })]
    expect(neverAgainFrom(withoutReads)).toEqual([])
  })

  it('flags long titles using the live titleMaxChars threshold', () => {
    const long = 'A'.repeat(50) + ' 1'
    const rows = [
      row('long-1', long, 0, 100),
      row('short-1', 'Short 1', 1, 1_000),
      row('short-2', 'Short 2', 2, 1_100),
      row('short-3', 'Short 3', 3, 1_200),
    ]
    expect(neverAgainFrom(rows).map((f) => f.pattern)).not.toContain('title over 55 characters')
    applyOverrides({ titleMaxChars: 40 })
    expect(neverAgainFrom(rows).map((f) => f.pattern)).toContain('title over 40 characters')
  })

  it('names at most three bets, rising series first, then formats, then holding series, never a falling one', () => {
    const rows = [
      ...baseLedger(),
      row('i-tried-30-days', 'I Tried Living Off One Battery for 30 Days', 20, 12_000),
      row('up-1', 'Up series 1', 30, 1_000, { returningPct: 20 }),
      row('up-2', 'Up series 2', 37, 1_000, { returningPct: 30 }),
      row('down-1', 'Down series 1', 40, 1_000, { returningPct: 40 }),
      row('down-2', 'Down series 2', 47, 1_000, { returningPct: 20 }),
      row('flat-1', 'Flat series 1', 50, 1_000, { returningPct: 30 }),
      row('flat-2', 'Flat series 2', 57, 1_000, { returningPct: 31 }),
    ]
    const p = profile({
      series: [
        { name: 'Down series', promise: 'd' },
        { name: 'Flat series', promise: 'f' },
        { name: 'Up series', promise: 'u' },
      ],
    })
    const d = buildDirection({ profile: p, ledgerRows: rows })
    expect(d.bets).toHaveLength(BET_COUNT)
    expect(d.bets[0]).toMatchObject({ kind: 'series', name: 'Up series' })
    expect(d.bets[0].reason).toContain('rising')
    expect(d.bets[0].reason).toContain('20% → 30%')
    expect(d.bets[1].kind).toBe('format')
    expect(d.bets[2].kind).toBe('format')
    expect(d.bets.map((b) => b.name)).not.toContain('Down series')

    const noFormats = buildDirection({ profile: p, ledgerRows: rows.filter((r) => r.slug !== 'i-tried-30-days') })
    expect(noFormats.bets.map((b) => b.name)).toEqual(['Up series', 'Flat series'])
    expect(noFormats.bets[1].reason).toContain('holding')
  })

  it('groups the bank by series, including series the profile does not know, and lists unassigned ideas', () => {
    const p = profile({ series: [{ name: 'Scrap Lab', promise: 'x' }, { name: 'Empty', promise: 'y' }] })
    const ideas = [
      idea('Welder from microwaves', { series: 'Scrap Lab' }),
      idea('Fridge from a car radiator', { series: 'Scrap Lab', status: 'green' }),
      idea('Van tour', { series: 'Vanlife' }),
      idea('Battery myths'),
    ]
    const d = buildDirection({ profile: p, ledgerRows: [], ideas })
    expect(Object.keys(d.ideasBySeries)).toEqual(['Scrap Lab', 'Empty', 'Vanlife'])
    expect(d.ideasBySeries['Scrap Lab'].map((i) => i.idea)).toEqual(['Welder from microwaves', 'Fridge from a car radiator'])
    expect(d.ideasBySeries.Empty).toEqual([])
    expect(d.ideasBySeries.Vanlife).toHaveLength(1)
    expect(d.unassignedIdeas.map((i) => i.idea)).toEqual(['Battery myths'])
    expect(d.series.find((s) => s.name === 'Scrap Lab')!.ideas).toBe(2)
  })

  it('is deterministic and does not mutate its inputs', () => {
    const rows = [...baseLedger(), row('i-tried-30-days', 'I Tried Living Off One Battery for 30 Days', 20, 12_000)]
    const snapshot = JSON.stringify(rows)
    const p = profile({ series: [{ name: 'Plain video', promise: 'p' }], neverAgain: ['x'] })
    const a = buildDirection({ profile: p, ledgerRows: rows, ideas: [idea('one', { series: 'Plain video' })] })
    const b = buildDirection({ profile: p, ledgerRows: rows, ideas: [idea('one', { series: 'Plain video' })] })
    expect(a).toEqual(b)
    expect(JSON.stringify(rows)).toBe(snapshot)
  })
})

describe('returningTrendOf and hasGenericWord', () => {
  it('uses the median of each half and the delta band', () => {
    expect(returningTrendOf([])).toBe('unknown')
    expect(returningTrendOf([30])).toBe('unknown')
    expect(returningTrendOf([30, 33])).toBe('up')
    expect(returningTrendOf([30, 32.9])).toBe('flat')
    expect(returningTrendOf([33, 30])).toBe('down')
    // Three readings per half: the median ignores the one 90% spike, so the series is flat, not down.
    expect(returningTrendOf([30, 90, 31, 32, 31, 33])).toBe('flat')
    // Two per half, the median of two is their mean, so the spike does move it.
    expect(returningTrendOf([30, 90, 31, 32])).toBe('down')
    expect(returningTrendOf([30, 32, 35, 36], 1)).toBe('up')
  })

  it('matches generic words as whole words only', () => {
    expect(hasGenericWord('Weekly update')).toBe(true)
    expect(hasGenericWord('Q&A with the crew')).toBe(true)
    expect(hasGenericWord('Updated wiring for 2 panels')).toBe(false)
    expect(hasGenericWord('The Chatter of a Dying Inverter')).toBe(false)
    expect(GENERIC_TITLE_WORDS).toContain('vlog')
  })
})

describe('renderDirectionMarkdown', () => {
  it('renders every section with the empty states', () => {
    const md = renderDirectionMarkdown(buildDirection({ profile: profile(), ledgerRows: [] }))
    expect(md).toContain('# Direction')
    expect(md).toContain('Positioning: — (run booster profile init)')
    expect(md).toContain('## Bets')
    expect(md).toContain('No bets yet')
    expect(md).toContain('## Proven formats')
    expect(md).toContain('None yet')
    expect(md).toContain('## Series')
    expect(md).toContain('No series in channel.json')
    expect(md).toContain('## Never again')
    expect(md).toContain(`needs ${NEVER_AGAIN_MIN_ROWS} ledger rows`)
    expect(md).toContain('The bank is empty.')
    expect(md).toContain('Thresholds: ownWinnerMultiplier=5 [house]')
  })

  it('renders tables for formats and series, the never-again list, and the bank by series', () => {
    const rows = [
      ...baseLedger(),
      row('i-tried-30-days', 'I Tried Living Off One Battery for 30 Days', 20, 12_000),
      row('lab-1', 'Lab 1', 30, 1_000, { returningPct: 20 }),
      row('lab-2', 'Lab 2', 37, 1_000, { returningPct: 30 }),
    ]
    const p = profile({ positioning: 'Builders get one tested build a week', persona: 'A weekend builder', series: [{ name: 'Lab', promise: 'one build', cadence: 'monthly' }], neverAgain: ['no face'] })
    const ideas = [idea('Welder', { series: 'Lab' }), idea('Van tour', { series: 'Vanlife' }), idea('Loose one')]
    const md = renderDirectionMarkdown(buildDirection({ profile: p, ledgerRows: rows, ideas }))
    expect(md).toContain('Positioning: Builders get one tested build a week')
    expect(md).toContain('Returning viewer: A weekend builder')
    expect(md).toContain('- Series **Lab**:')
    expect(md).toContain('- Format **challenge**:')
    expect(md).toContain('| challenge | 1 | — | i-tried-30-days |')
    expect(md).toContain('| Lab | one build (monthly) | lab-1, lab-2 | up (20% → 30%) | 1 |')
    expect(md).toContain('- no face')
    expect(md).toContain('- Lab: Welder [banked]')
    expect(md).toContain('- Vanlife (not in channel.json): Van tour [banked]')
    expect(md).toContain('- No series: Loose one [banked]')
  })
})

function shotInput(overrides: Partial<ShotListInput> = {}): ShotListInput {
  return {
    pkg: {
      chosenTitle: 'I Ran My Fridge on a Scrap Generator for 7 Days',
      promise: 'A generator built from scrap keeps a fridge cold for a week',
      thumbnails: [
        { name: 'stakes', focalSubject: 'me', emotion: 'worried', elements: ['me', 'sparking generator', '7 DAYS'], text: '7 DAYS', background: 'dark workshop', colors: ['yellow', 'black'] },
        { name: 'result', focalSubject: 'the fridge', emotion: 'none', elements: ['the fridge', 'generator'], composition: 'fridge left, generator right, thermometer insert' },
        { name: 'curiosity', focalSubject: 'a pile of scrap', elements: ['a pile of scrap'] },
      ],
      abPick: { a: 'stakes', b: 'result' },
    },
    story: {
      payoffLadder: [
        { atSec: 300, moment: 'the fridge finally works' },
        { atSec: 90, moment: 'first attempt fails' },
      ],
      rehooks: [
        { atSec: 60, line: 'But what happens at night?', device: 'question' },
        { atSec: 150, line: 'Then the belt snapped.', device: 'escalation' },
        { atSec: 240, line: 'Here is what it actually cost.' },
      ],
      thumbnailMomentPosition: 'final-third',
      thumbnailMomentAtSec: 300,
    },
    ...overrides,
  }
}

describe('shotList', () => {
  it('opens with one Thumbnail moment setup per A/B concept carrying expression, props, background and colours', () => {
    const list = shotList(shotInput())
    expect(list.title).toBe('I Ran My Fridge on a Scrap Generator for 7 Days')
    expect(list.setups.map((s) => s.name)).toEqual(['Thumbnail moment (A: stakes)', 'Thumbnail moment (B: result)', 'Payoff ladder', 'B-roll for rehooks', 'First 30 seconds'])
    const a = list.setups[0]
    expect(a.shots[0].shot).toBe('Hero frame: me, worried')
    expect(a.shots[0].framing).toBe('tight on me, sparking generator in frame')
    expect(a.shots[0].notes).toContain('Hold the worried expression')
    expect(a.shots[0].notes).toContain('at 5:00 in the script')
    expect(a.shots.map((s) => s.shot)).toEqual(['Hero frame: me, worried', 'Props: sparking generator', 'Background: dark workshop', 'Colours: yellow/black', 'Leave room for text "7 DAYS"'])
    const b = list.setups[1]
    expect(b.shots[0].shot).toBe('Hero frame: the fridge')
    expect(b.shots[0].framing).toBe('fridge left, generator right, thermometer insert')
    expect(b.shots.map((s) => s.shot)).toEqual(['Hero frame: the fridge', 'Props: generator'])
  })

  it('uses every concept when there is no A/B pick and falls back when the pick names no concept', () => {
    const input = shotInput()
    delete input.pkg.abPick
    const all = shotList(input)
    expect(all.setups.slice(0, 3).map((s) => s.name)).toEqual(['Thumbnail moment (A: stakes)', 'Thumbnail moment (B: result)', 'Thumbnail moment (C: curiosity)'])
    const partial = shotList(shotInput({ pkg: { ...shotInput().pkg, abPick: { a: 'stakes', b: 'missing' } } }))
    expect(partial.setups.filter((s) => s.name.startsWith('Thumbnail moment')).map((s) => s.name)).toEqual(['Thumbnail moment (A: stakes)'])
    const none = shotList(shotInput({ pkg: { ...shotInput().pkg, abPick: { a: 'x', b: 'y' } } }))
    expect(none.setups.slice(0, 3).map((s) => s.name)).toEqual(['Thumbnail moment (A: stakes)', 'Thumbnail moment (B: result)', 'Thumbnail moment (C: curiosity)'])
  })

  it('says so when the package has no thumbnail concept and when the story has no thumbnail moment', () => {
    const list = shotList({ pkg: { promise: 'p', thumbnails: [] }, story: { payoffLadder: [], rehooks: [] } })
    expect(list.title).toBe('p')
    expect(list.setups[0].name).toBe('Thumbnail moment')
    expect(list.setups[0].shots[0].notes).toContain('Build the package first')
    const missing = shotList({ pkg: { promise: 'p', thumbnails: [{ name: 'a', focalSubject: 'me', elements: ['me'] }] }, story: { payoffLadder: [], rehooks: [], thumbnailMomentPosition: 'missing' } })
    expect(missing.setups[0].shots[0].notes).toContain('not in the script yet: stage it and write it in')
    const early = shotList({ pkg: { promise: 'p', thumbnails: [{ name: 'a', focalSubject: 'me', elements: ['me'] }] }, story: { payoffLadder: [], rehooks: [], thumbnailMomentPosition: 'first-third' } })
    expect(early.setups[0].shots[0].notes).toContain('in the first third of the script')
  })

  it('gives every payoff-ladder moment a shot in story order and marks the biggest payoff', () => {
    const ladder = shotList(shotInput()).setups.find((s) => s.name === 'Payoff ladder')!
    expect(ladder.shots.map((s) => s.shot)).toEqual(['1:30 first attempt fails', '5:00 the fridge finally works'])
    expect(ladder.shots[0].framing).toBe('wide so the failure reads, then close on the face')
    expect(ladder.shots[1].framing).toBe('medium to close, push in on the result')
    expect(ladder.shots[1].notes).toContain('shoot it first')
    const empty = shotList(shotInput({ story: { payoffLadder: [], rehooks: [] } })).setups.find((s) => s.name === 'Payoff ladder')!
    expect(empty.shots[0].notes).toContain('booster hook score')
  })

  it('frames a payoff by its wording, inflections included', () => {
    expect(framingFor('first attempt fails')).toBe('wide so the failure reads, then close on the face')
    expect(framingFor('the belt breaks')).toBe('wide so the failure reads, then close on the face')
    expect(framingFor('total failure at night')).toBe('wide so the failure reads, then close on the face')
    expect(framingFor('the fridge finally works')).toBe('medium to close, push in on the result')
    expect(framingFor('It succeeds on the third try')).toBe('medium to close, push in on the result')
    expect(framingFor('the big reveal')).toBe('medium to close, push in on the result')
    expect(framingFor('before the build starts')).toBe('wide establishing, then medium')
    expect(framingFor('we compare the two')).toBe('medium, cover with a wide and an insert')
    // A result verb beats a failure verb when both appear: the payoff is what the shot sells.
    expect(framingFor('it failed twice, then finally works')).toBe('medium to close, push in on the result')
  })

  it('gives every rehook its B-roll, framed by device', () => {
    const broll = shotList(shotInput()).setups.find((s) => s.name === 'B-roll for rehooks')!
    expect(broll.purpose).toContain('max gap 90 s')
    expect(broll.shots).toHaveLength(3)
    expect(broll.shots[0].shot).toBe('B-roll under "But what happens at night?" (1:00)')
    expect(broll.shots[0].framing).toContain('insert of the thing being asked about')
    expect(broll.shots[1].framing).toContain('wide on the stake')
    expect(broll.shots[2].framing).toBe('insert that shows the thing the line is about')
    expect(broll.shots[2].notes.startsWith('rehook:')).toBe(true)
    const empty = shotList(shotInput({ story: { payoffLadder: [], rehooks: [] } })).setups.find((s) => s.name === 'B-roll for rehooks')!
    expect(empty.shots[0].shot).toBe('No rehooks in the story')
  })

  it('ends with the first 30 seconds: promise, stake, roadmap', () => {
    const first = shotList(shotInput()).setups.at(-1)!
    expect(first.name).toBe('First 30 seconds')
    expect(first.shots.map((s) => s.shot)).toEqual([
      '0-5 s: show or state the promise "A generator built from scrap keeps a fridge cold for a week"',
      '5-15 s: the stake or the question',
      '15-30 s: the roadmap in one line, then start',
    ])
    expect(first.shots[0].notes).toContain('I Ran My Fridge on a Scrap Generator for 7 Days')
    expect(first.shots[1].notes).toContain('it lands at 5:00')
    expect(first.shots[2].notes).toContain('First payoff lands at 1:30')
  })

  it('adds the format note for challenge, tutorial and documentary and none without a format', () => {
    expect(shotList(shotInput()).formatNotes).toEqual([])
    expect(shotList(shotInput({ format: 'challenge' })).formatNotes).toEqual(SHOT_FORMAT_NOTES.challenge)
    expect(shotList(shotInput({ format: 'challenge' })).formatNotes.join(' ')).toContain('Film every failure')
    expect(shotList(shotInput({ format: 'tutorial' })).formatNotes.join(' ')).toContain('finished result before step one')
    expect(shotList(shotInput({ format: 'documentary' })).formatNotes.join(' ')).toContain('Shoot the ending first')
    for (const format of Object.keys(SHOT_FORMAT_NOTES) as Array<keyof typeof SHOT_FORMAT_NOTES>) expect(SHOT_FORMAT_NOTES[format].length).toBeGreaterThan(0)
    // Every workflow format has a shoot-side note and nothing else is listed.
    expect(Object.keys(SHOT_FORMAT_NOTES).sort()).toEqual([...WORKFLOW_FORMATS].sort())
  })

  it('does not mutate the package or story', () => {
    const input = shotInput()
    const before = JSON.stringify(input)
    shotList(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('renderShotListMarkdown', () => {
  it('renders one numbered section per setup with a table, then the format notes', () => {
    const md = renderShotListMarkdown(shotList(shotInput({ format: 'challenge' })))
    expect(md.startsWith('# Shot list: I Ran My Fridge on a Scrap Generator for 7 Days')).toBe(true)
    expect(md).toContain('Promise: A generator built from scrap keeps a fridge cold for a week')
    expect(md).toContain('## 1. Thumbnail moment (A: stakes)')
    expect(md).toContain('## 3. Payoff ladder')
    expect(md).toContain('## 5. First 30 seconds')
    expect(md).toContain('| Shot | Framing | Notes |')
    expect(md).toContain('| Hero frame: me, worried | tight on me, sparking generator in frame |')
    expect(md).toContain('## Format notes')
    expect(md).toContain('- Film every failure')
    expect(renderShotListMarkdown(shotList(shotInput()))).not.toContain('## Format notes')
  })
})
