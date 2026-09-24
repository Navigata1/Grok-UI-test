import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addIdea, setStatus } from './bank.js'
import { addRow, recordRead } from './ledger.js'
import { LEARNED_RULES_HEADING, acceptRule, buildRetro, channelFileHeader, draftRule, formatRuleLine, planPlaybookWrite, renderRetroMarkdown, resolvePlaybookFile } from './retro.js'
import { LEARNED_RULES_FILE } from './rules.js'
import { ProfileDoc, WorkflowStatusDoc } from './schema.js'
import { openStore, type Store } from './store.js'

let root: string
let store: Store
let playbook: string
const now = new Date('2026-09-14T12:00:00Z')
const DAY = 86_400_000
const since = new Date(now.getTime() - 7 * DAY)
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString()

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'booster-retro-'))
  store = openStore(path.join(root, 'data'))
  playbook = path.join(root, 'playbook')
  mkdirSync(playbook)
  writeFileSync(path.join(playbook, 'title-formulas.md'), '# Title formulas\n\nNumbers beat adjectives.\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Eight older rows at 1000 views (the median), then the week under review. */
function seedChannel(): void {
  for (let i = 0; i < 8; i += 1) {
    addRow(store, { slug: `old${i}`, title: `Old ${i}`, publishedAt: ago(14 + i * 7), now })
    recordRead(store, { slug: `old${i}`, bucket: '168', read: { views: 1000, at: ago(7 + i * 7) }, lever: 'stakes concept won', now })
  }
  // In the window: a winner, a loser, a row with no verdict yet, and one with the levers registered up front.
  addRow(store, { slug: 'win', title: 'The win', publishedAt: ago(6), hypothesis: { levers: ['number-in-title'], predictedCtrMultiple: 1.2 }, now })
  recordRead(store, { slug: 'win', bucket: '168', read: { views: 9000, at: ago(0) }, lever: 'Number-in-title', bottleneck: 'none', decision: 'SEQUEL', now })
  addRow(store, { slug: 'lose', title: 'The loss', publishedAt: ago(5), now })
  recordRead(store, { slug: 'lose', bucket: '48', read: { impressions: 800, ctr: 1.5 }, bottleneck: 'packaging', decision: 'REPACKAGE', now })
  addRow(store, { slug: 'fresh', title: 'Too fresh', publishedAt: ago(1), hypothesis: { levers: ['number-in-title', 'face-thumb'], predictedCtrMultiple: 1 }, now })
  addRow(store, { slug: 'edge', title: 'On the edge', publishedAt: since.toISOString(), now })
  recordRead(store, { slug: 'edge', bucket: '48', read: { impressions: 5000 }, bottleneck: '', now })
}

function seedWorkflows(): void {
  const stage = (id: string, status: 'passed' | 'overridden' | 'pending', finishedAt?: string, reason?: string, agent?: string) => ({ id, status, finishedAt, overrideReason: reason, agent })
  store.upsert('workflows', WorkflowStatusDoc.parse({
    id: 'win', slug: 'win', idea: 'The win', format: 'tutorial', updatedAt: now.toISOString(),
    stages: [stage('demand', 'passed', ago(10)), stage('package', 'overridden', ago(4), 'second reviewer away; pair picked solo', 'jony'), stage('story', 'overridden', ago(2), 'hook scored 66; the cold read was strong'), stage('plan', 'pending')],
  }))
  store.upsert('workflows', WorkflowStatusDoc.parse({
    id: 'old0', slug: 'old0', idea: 'Old 0', format: 'vlog', updatedAt: now.toISOString(),
    stages: [stage('demand', 'overridden', ago(30), 'ancient override'), stage('package', 'overridden', undefined, 'no timestamp at all')],
  }))
}

function seedBank(): void {
  const scores = (n: number) => ({ demand: n, packaging: n, fit: n, angle: n, payoff: n, feasibility: n })
  addIdea(store, { idea: 'Top banked idea', scores: scores(5), now })
  addIdea(store, { idea: 'Middle banked idea', scores: scores(4), now })
  addIdea(store, { idea: 'Low banked idea', scores: scores(3), now })
  addIdea(store, { idea: 'Weak banked idea', scores: scores(2), now })
  const green = addIdea(store, { idea: 'Approved green idea', scores: scores(3), now })
  setStatus(store, green.id, 'green', { now })
  const parked = addIdea(store, { idea: 'Parked idea', scores: scores(5), now })
  setStatus(store, parked.id, 'parked', { now, reason: 'weak angle' })
}

describe('buildRetro', () => {
  it('scopes rows, levers, winners and losers to the window', () => {
    seedChannel()
    const retro = buildRetro(store, { since, now })
    expect(retro.window).toEqual({ since: since.toISOString(), until: now.toISOString(), days: 7 })
    expect(retro.published.map((r) => r.slug)).toEqual(['fresh', 'lose', 'win', 'edge'])
    expect(retro.levers).toEqual([
      { lever: 'number-in-title', count: 2, slugs: ['fresh', 'win'] },
      { lever: 'face-thumb', count: 1, slugs: ['fresh'] },
    ])
    expect(retro.winners).toHaveLength(1)
    expect(retro.winners[0].row.slug).toBe('win')
    expect(retro.winners[0].multiple).toBeCloseTo(9)
    expect(retro.losers.map((r) => r.slug)).toEqual(['lose'])
    expect(retro.candidateRule).toEqual({ rule: 'On this channel, number-in-title (n=2, slugs fresh, win)', lever: 'number-in-title', count: 2, slugs: ['fresh', 'win'] })
    expect(retro.overrides).toEqual([])
    expect(retro.baselineShift).toBe(false)
    expect(retro.nextThree).toEqual([])
  })

  it('drafts the candidate rule from the most frequent lever', () => {
    expect(draftRule('stakes concept won', ['a', 'b', 'c'])).toBe('On this channel, stakes concept won (n=3, slugs a, b, c)')
  })

  it('lists the stages a person overrode inside the window, newest first', () => {
    seedChannel()
    seedWorkflows()
    const retro = buildRetro(store, { since, now })
    expect(retro.overrides).toEqual([
      { slug: 'win', stageId: 'story', at: ago(2), reason: 'hook scored 66; the cold read was strong', agent: undefined },
      { slug: 'win', stageId: 'package', at: ago(4), reason: 'second reviewer away; pair picked solo', agent: 'jony' },
    ])
    expect(buildRetro(store, { since: new Date(now.getTime() - 40 * DAY), now }).overrides).toHaveLength(3)
  })

  it('reads the baseline shift from the profile and locks the next three ideas, green first', () => {
    seedChannel()
    seedBank()
    const profile = ProfileDoc.parse({ baselines: { computedAt: now.toISOString(), bucket: '48', n: 8, tier: 'thin', shift: true } })
    const retro = buildRetro(store, { since, now, profile })
    expect(retro.baselineShift).toBe(true)
    expect(retro.nextThree.map((i) => i.idea)).toEqual(['Approved green idea', 'Top banked idea', 'Middle banked idea'])
    expect(buildRetro(store, { since, now, profile: ProfileDoc.parse({}) }).baselineShift).toBe(false)
  })

  it('handles an empty store and refuses a window that starts after now', () => {
    const retro = buildRetro(store, { since, now })
    expect(retro.published).toEqual([])
    expect(retro.levers).toEqual([])
    expect(retro.winners).toEqual([])
    expect(retro.candidateRule).toBeUndefined()
    expect(() => buildRetro(store, { since: new Date(now.getTime() + DAY), now })).toThrow(/after now/)
    expect(() => buildRetro(store, { since: new Date('not a date'), now })).toThrow(/must be a date/)
  })
})

describe('renderRetroMarkdown', () => {
  it('renders every section with the numbers behind it', () => {
    seedChannel()
    seedWorkflows()
    seedBank()
    const md = renderRetroMarkdown(buildRetro(store, { since, now, profile: ProfileDoc.parse({ baselines: { computedAt: now.toISOString(), bucket: '48', n: 8, tier: 'thin', shift: true } }) }))
    expect(md.startsWith('# Retro 2026-09-07 to 2026-09-14 (7 days)')).toBe(true)
    expect(md).toContain('## Published (4)')
    expect(md).toContain('- 2026-09-08 The win (win): 9000 views at 7 d; bottleneck none; decision SEQUEL; lever: Number-in-title')
    expect(md).toContain('- 2026-09-13 Too fresh (fresh): no 7-day read')
    expect(md).toContain('## Levers\n- number-in-title: 2 (fresh, win)\n- face-thumb: 1 (fresh)')
    expect(md).toContain('- The win (win): 9.0x the channel median at 7 d; brief the sequel')
    expect(md).toContain('## Losers\n- The loss (lose): packaging, REPACKAGE')
    expect(md).toContain('## Candidate rule\n- On this channel, number-in-title (n=2, slugs fresh, win)')
    expect(md).toContain('--accept-rule')
    expect(md).toContain('- 2026-09-12 win / story: hook scored 66; the cold read was strong')
    expect(md).toContain('- 2026-09-10 win / package by jony: second reviewer away; pair picked solo')
    expect(md).toContain('more than one MAD')
    expect(md).toContain('## Next three\n- [green] Approved green idea (')
    expect(md).toContain('- [banked] Top banked idea (100/100, weakest demand)')
  })

  it('says what is missing when the window is empty', () => {
    const md = renderRetroMarkdown(buildRetro(store, { since, now }))
    expect(md).toContain('- nothing published in this window')
    expect(md).toContain('- no lever recorded')
    expect(md).toContain('- none reached the own-winner multiple')
    expect(md).toContain('- none with a named bottleneck')
    expect(md).toContain('- none: no lever in this window')
    expect(md).toContain('- no gate was overridden')
    expect(md).toContain('- no baseline shift')
    expect(md).toContain('- no idea is banked or green (ideas in packaging or production do not count); run the outlier scan and bank ideas')
    expect(md).not.toContain('the bank is empty')
  })

  it('prints the accept-rule line with the --yes that gate needs', () => {
    addRow(store, { slug: 'win', title: 'The win', publishedAt: new Date(now.getTime() - 6 * 86_400_000).toISOString(), now })
    recordRead(store, { slug: 'win', bucket: '168', read: { views: 9_000 }, lever: 'Number-in-title', now })
    const md = renderRetroMarkdown(buildRetro(store, { since, now }))
    const line = md.split('\n').find((l) => l.includes('--accept-rule')) as string
    expect(line).toBe('- accept it with `booster retro --accept-rule "..." --into playbook/<file>.md --yes`, or rewrite it first')
  })
})

describe('acceptRule', () => {
  const rule = 'Numbers in the title beat adjectives'

  it('creates the Learned rules heading once and appends dated lines with slug refs', () => {
    const file = path.join(playbook, 'title-formulas.md')
    const written = acceptRule(playbook, 'title-formulas.md', rule, { slugs: ['win', 'fresh'], now })
    expect(written).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe(`# Title formulas\n\nNumbers beat adjectives.\n\n${LEARNED_RULES_HEADING}\n\n- 2026-09-14: ${rule} (win, fresh)\n`)
    acceptRule(playbook, 'title-formulas.md', 'Face in the thumbnail on every how-to', { now: new Date(now.getTime() + 7 * DAY) })
    const text = readFileSync(file, 'utf8')
    expect(text.match(new RegExp(LEARNED_RULES_HEADING, 'g'))).toHaveLength(1)
    expect(text).toBe(`# Title formulas\n\nNumbers beat adjectives.\n\n${LEARNED_RULES_HEADING}\n\n- 2026-09-14: ${rule} (win, fresh)\n- 2026-09-21: Face in the thumbnail on every how-to\n`)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('appends inside an existing section that is followed by another heading', () => {
    const file = path.join(playbook, 'mid.md')
    writeFileSync(file, `# Mid\n\n${LEARNED_RULES_HEADING}\n\n- 2026-08-01: Old rule (a)\n\n\n## Checklist\n\n- item\n`)
    acceptRule(playbook, 'mid.md', rule, { now })
    expect(readFileSync(file, 'utf8')).toBe(`# Mid\n\n${LEARNED_RULES_HEADING}\n\n- 2026-08-01: Old rule (a)\n- 2026-09-14: ${rule}\n\n## Checklist\n\n- item\n`)
  })

  it('handles a file without a trailing newline and an empty section', () => {
    const file = path.join(playbook, 'bare.md')
    writeFileSync(file, `# Bare\n${LEARNED_RULES_HEADING}\n## Next`)
    acceptRule(playbook, 'bare.md', rule, { now })
    expect(readFileSync(file, 'utf8')).toBe(`# Bare\n${LEARNED_RULES_HEADING}\n\n- 2026-09-14: ${rule}\n\n## Next\n`)
    const file2 = path.join(playbook, 'noeol.md')
    writeFileSync(file2, '# No EOL\n\nBody')
    acceptRule(playbook, 'noeol.md', rule, { now })
    expect(readFileSync(file2, 'utf8')).toBe(`# No EOL\n\nBody\n\n${LEARNED_RULES_HEADING}\n\n- 2026-09-14: ${rule}\n`)
  })

  it('does not append the same rule twice and normalises whitespace', () => {
    const file = path.join(playbook, 'title-formulas.md')
    acceptRule(playbook, 'title-formulas.md', rule, { slugs: ['win'], now })
    acceptRule(playbook, 'title-formulas.md', `  Numbers in the title\n  beat adjectives  `, { slugs: ['fresh'], now: new Date(now.getTime() + DAY) })
    const text = readFileSync(file, 'utf8')
    expect(text.split('\n').filter((l) => l.includes(rule))).toHaveLength(1)
    expect(text).toContain(`- 2026-09-14: ${rule} (win)`)
    expect(formatRuleLine(rule, [' a ', '', 'b', 'a'], now)).toBe(`- 2026-09-14: ${rule} (a, b)`)
    expect(formatRuleLine(rule, [], now)).toBe(`- 2026-09-14: ${rule}`)
  })

  it('does not repeat slugs the drafted candidate already names', () => {
    const drafted = draftRule('number-in-title', ['win', 'fresh'])
    expect(formatRuleLine(drafted, ['win', 'fresh', 'other'], now)).toBe(`- 2026-09-14: ${drafted} (other)`)
    expect(formatRuleLine(drafted, ['win', 'fresh'], now)).toBe(`- 2026-09-14: ${drafted}`)
    acceptRule(playbook, 'title-formulas.md', drafted, { slugs: ['win', 'fresh'], now })
    expect(readFileSync(path.join(playbook, 'title-formulas.md'), 'utf8')).toContain(`- 2026-09-14: ${drafted}\n`)
  })

  it('refuses files outside the playbook, the compiled rules file, non-Markdown, missing files and empty rules', () => {
    const before = readFileSync(path.join(playbook, 'title-formulas.md'), 'utf8')
    expect(() => acceptRule(playbook, '../title-formulas.md', rule, { now })).toThrow(/outside the playbook/)
    expect(() => acceptRule(playbook, path.join(root, 'elsewhere.md'), rule, { now })).toThrow(/outside the playbook/)
    expect(() => acceptRule(playbook, '.', rule, { now })).toThrow(/outside the playbook/)
    expect(() => acceptRule(playbook, LEARNED_RULES_FILE, rule, { now })).toThrow(/compiled/)
    expect(() => acceptRule(playbook, `sub/${LEARNED_RULES_FILE}`, rule, { now })).toThrow(/compiled/)
    expect(() => acceptRule(playbook, 'notes.txt', rule, { now })).toThrow(/Markdown/)
    expect(() => acceptRule(playbook, 'missing.md', rule, { now })).toThrow(/no such playbook file/)
    expect(() => acceptRule(playbook, 'title-formulas.md', '   ', { now })).toThrow(/needs text/)
    expect(readFileSync(path.join(playbook, 'title-formulas.md'), 'utf8')).toBe(before)
    expect(existsSync(path.join(playbook, 'missing.md'))).toBe(false)
    expect(resolvePlaybookFile(playbook, 'title-formulas.md')).toBe(path.join(playbook, 'title-formulas.md'))
    expect(resolvePlaybookFile(playbook, path.join(playbook, 'title-formulas.md'))).toBe(path.join(playbook, 'title-formulas.md'))
  })
})

describe('accepting into a channel playbook folder', () => {
  const rule = 'Numbers in the title beat adjectives'
  const shippedFiles = ['title-formulas.md', 'first-30-seconds.md']

  it('starts this channel\'s copy of a shipped file with one header line naming it, then appends to it', () => {
    const file = path.join(playbook, 'first-30-seconds.md')
    expect(planPlaybookWrite(playbook, 'first-30-seconds.md', { shippedFiles })).toEqual({ file, extends: 'playbook/first-30-seconds.md' })
    expect(existsSync(file)).toBe(false)
    expect(acceptRule(playbook, 'first-30-seconds.md', rule, { slugs: ['win'], now, shippedFiles })).toBe(file)
    expect(channelFileHeader('playbook/first-30-seconds.md')).toBe('# Accepted rules for this channel, extending the shipped playbook/first-30-seconds.md')
    expect(readFileSync(file, 'utf8')).toBe(`${channelFileHeader('playbook/first-30-seconds.md')}\n\n${LEARNED_RULES_HEADING}\n\n- 2026-09-14: ${rule} (win)\n`)
    expect(planPlaybookWrite(playbook, 'first-30-seconds.md', { shippedFiles })).toEqual({ file })
    acceptRule(playbook, 'first-30-seconds.md', 'Promise inside ten seconds', { now, shippedFiles })
    const text = readFileSync(file, 'utf8')
    expect(text.match(/^# /gm)).toHaveLength(1)
    expect(text.endsWith(`- 2026-09-14: ${rule} (win)\n- 2026-09-14: Promise inside ten seconds\n`)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('creates a missing channel folder, and knows the shipped file names from the shipped doctrine', () => {
    const fresh = path.join(root, 'fresh', 'playbook')
    const written = acceptRule(fresh, 'title-formulas.md', rule, { now })
    expect(written).toBe(path.join(fresh, 'title-formulas.md'))
    expect(readFileSync(written, 'utf8').split('\n')[0]).toBe(channelFileHeader('playbook/title-formulas.md'))
  })

  it('refuses a new file the build does not ship, and any missing file in the legacy layout', () => {
    expect(() => planPlaybookWrite(playbook, 'brand-new.md', { shippedFiles })).toThrow(/no such playbook file: .*brand-new\.md\. Accept the rule into a file this channel's playbook already has, or into a shipped playbook file to start this channel's copy of it: title-formulas.md, first-30-seconds.md$/)
    // The legacy source layout: the folder is the shipped playbook itself, written in place as before and never extended.
    const legacy = { shippedFiles, shippedDir: playbook, bundled: false }
    expect(() => planPlaybookWrite(playbook, 'first-30-seconds.md', legacy)).toThrow(/^no such playbook file: .*first-30-seconds\.md$/)
    expect(planPlaybookWrite(playbook, 'title-formulas.md', legacy)).toEqual({ file: path.join(playbook, 'title-formulas.md') })
    const written = acceptRule(playbook, 'title-formulas.md', rule, { now, ...legacy })
    expect(readFileSync(written, 'utf8')).toBe(`# Title formulas\n\nNumbers beat adjectives.\n\n${LEARNED_RULES_HEADING}\n\n- 2026-09-14: ${rule}\n`)
    expect(existsSync(path.join(playbook, 'first-30-seconds.md'))).toBe(false)
  })

  it('treats a symlink to the shipped folder as the legacy layout', () => {
    const link = path.join(root, 'pb-link')
    symlinkSync(playbook, link, 'dir')
    const legacy = { shippedFiles, shippedDir: playbook, bundled: false }
    expect(() => planPlaybookWrite(link, 'first-30-seconds.md', legacy)).toThrow(/^no such playbook file: .*first-30-seconds\.md$/)
    expect(planPlaybookWrite(link, 'title-formulas.md', legacy)).toEqual({ file: path.join(link, 'title-formulas.md') })
    expect(existsSync(path.join(playbook, 'first-30-seconds.md'))).toBe(false)
  })

  it('never writes into the playbook inside the installed package', () => {
    const before = readFileSync(path.join(playbook, 'title-formulas.md'), 'utf8')
    const refused = /^refusing to write into the installed package's playbook \(.+\): keep this channel's rules in a channel workspace \(channel-booster init <folder>\) or pass --playbook with a folder outside the installed package$/
    expect(() => acceptRule(playbook, 'title-formulas.md', rule, { now, shippedDir: playbook, bundled: true })).toThrow(refused)
    // A symlink to the package's folder (a linked install, or one typed by hand) is the same folder.
    const link = path.join(root, 'pkgpb-link')
    symlinkSync(playbook, link, 'dir')
    expect(() => acceptRule(link, 'title-formulas.md', rule, { now, shippedDir: playbook, bundled: true })).toThrow(refused)
    expect(readFileSync(path.join(playbook, 'title-formulas.md'), 'utf8')).toBe(before)
    // The packaged bin writes a channel folder anywhere else.
    expect(planPlaybookWrite(playbook, 'title-formulas.md', { bundled: true })).toEqual({ file: path.join(playbook, 'title-formulas.md') })
  })
})
