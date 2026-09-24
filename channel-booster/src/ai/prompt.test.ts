import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { assemblePrompt, formatDryRun, loadPlaybook, parseEffort, outlierContext, renderPackageFixUser, DOCTRINE_FILE, LEARNED_RULES_FILE, PACKAGE_FIX_TEMPLATE_PATH, SYSTEM_PREAMBLE, type PlaybookFs } from './prompt.js'
import { ENGINE_NAMES, isEngineName } from './schemas.js'
import { renderLearnedRules } from '../rules.js'
import { RuleDoc } from '../schema.js'

/** An in-memory doctrine tree: docs/02, the compiled rules, two playbook files and two files that must never load. */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]>): PlaybookFs {
  return {
    exists: (file) => file in files || file in dirs,
    readdir: (dir) => dirs[dir] ?? [],
    readFile: (file) => {
      if (!(file in files)) throw new Error(`no such file ${file}`)
      return files[file]
    },
  }
}

const ROOT = '/r'
const P = (rel: string) => path.join(ROOT, rel)

describe('loadPlaybook', () => {
  const files = {
    [P(DOCTRINE_FILE)]: '# Doctrine\nR1 packaging first',
    [P(LEARNED_RULES_FILE)]: '# Learned rules (compiled)\n- rule',
    [P('playbook/README.md')]: '# Index',
    [P('playbook/ideation.md')]: '# Ideation',
    [P('docs/01-video-analysis.md')]: 'evidence notes',
    [P('docs/03-system-architecture.md')]: 'design',
  }
  const dirs = { [P('playbook')]: ['ideation.md', 'README.md', '00-learned-rules.md', 'notes.txt'], [P('docs')]: ['01-video-analysis.md', '02-strategist-playbook.md', '03-system-architecture.md'] }

  it('loads docs/02 first, the compiled rules second, then playbook/*.md alphabetically, and nothing else', () => {
    const loaded = loadPlaybook(ROOT, { fs: fakeFs(files, dirs) })
    expect(loaded.files).toEqual([DOCTRINE_FILE, LEARNED_RULES_FILE, 'playbook/README.md', 'playbook/ideation.md'])
    expect(loaded.text.indexOf('<!-- docs/02-strategist-playbook.md -->')).toBe(0)
    expect(loaded.text.indexOf('R1 packaging first')).toBeLessThan(loaded.text.indexOf('# Learned rules'))
    expect(loaded.text).not.toContain('evidence notes')
    expect(loaded.text).not.toContain('design')
  })

  it('skips the compiled rules when the file is absent and stops before the cap', () => {
    const without = { ...files }
    delete without[P(LEARNED_RULES_FILE)]
    const loaded = loadPlaybook(ROOT, { fs: fakeFs(without, { ...dirs, [P('playbook')]: ['ideation.md', 'README.md'] }) })
    expect(loaded.files).toEqual([DOCTRINE_FILE, 'playbook/README.md', 'playbook/ideation.md'])
    const capped = loadPlaybook(ROOT, { fs: fakeFs(files, dirs), maxChars: 160 })
    expect(capped.files).toEqual([DOCTRINE_FILE, LEARNED_RULES_FILE])
    expect(capped.text.length).toBeLessThanOrEqual(160)
  })

  it('returns nothing when the root has no doctrine', () => {
    expect(loadPlaybook(ROOT, { fs: fakeFs({}, {}) })).toEqual({ text: '', files: [] })
  })
})

describe('parseEffort', () => {
  it('defaults to high and accepts the five levels', () => {
    expect(parseEffort({})).toBe('high')
    expect(parseEffort({ effort: 'max' })).toBe('max')
    expect(() => parseEffort({ effort: 'ultra' })).toThrow(/--effort must be one of/)
    expect(() => parseEffort({ effort: true })).toThrow(/--effort must be one of/)
  })
})

describe('assemblePrompt', () => {
  const read = (file: string): string => {
    if (file.endsWith('package-fix.md')) return 'Fixes:\n{{fixes}}\nPrevious:\n{{previous}}'
    if (file.endsWith('script.txt')) return 'Line one of the script.\nLine two.'
    if (file.endsWith('.csv')) return 'title,views,published,channel\nA,1000,2026-01-01,C\nB,100,2026-01-01,C\nC,100,2026-01-01,C\n'
    throw new Error(`unexpected read ${file}`)
  }

  it('refuses an unknown engine and names the required flag', () => {
    expect(() => assemblePrompt('nope', {})).toThrow(/unknown ai engine "nope"/)
    expect(() => assemblePrompt('title-lab', {})).toThrow(/--idea is required/)
    expect(() => assemblePrompt('thumbnail-factory', { idea: 'x' })).toThrow(/--title is required/)
    expect(() => assemblePrompt('retention-map', { idea: 'x', title: 'y' })).toThrow(/--script file.txt or --outline/)
    expect(() => assemblePrompt('package-fix', { idea: 'x', title: 'y' })).toThrow(/--fixes "a; b" or --fixes-file/)
  })

  it('builds the two system blocks with the doctrine cached and the channel from --channel, the profile, or "not described"', () => {
    const a = assemblePrompt('title-lab', { idea: 'Van build', channel: 'Van builds for first-timers' }, { playbookText: 'DOCTRINE', playbookFiles: ['docs/02-strategist-playbook.md'] })
    expect(a.engine).toBe('title-lab')
    expect(a.system).toEqual([{ text: SYSTEM_PREAMBLE, cache: false }, { text: 'DOCTRINE', cache: true }])
    expect(a.user).toContain('Channel: Van builds for first-timers')
    expect(a.user).toContain('Idea: Van build')
    expect(a.playbookFiles).toEqual(['docs/02-strategist-playbook.md'])
    expect(assemblePrompt('title-lab', { idea: 'x' }, { profileText: 'Positioning: solar for renters.' }).user).toContain('Channel: Positioning: solar for renters.')
    expect(assemblePrompt('title-lab', { idea: 'x' }).user).toContain('Channel: not described')
    expect(assemblePrompt('title-lab', { idea: 'x' }).system[1]).toEqual({ text: '', cache: true })
  })

  it('reads the CSV, the script and the fix template only through the injected reader', () => {
    const idea = assemblePrompt('idea-engine', { niche: 'vans', csv: 'competitors.csv', count: '4' }, { readFile: read })
    expect(idea.user).toContain('Outlier scan of 3 videos')
    expect(idea.user).toContain('Produce 4 ideas')
    expect(assemblePrompt('idea-engine', { niche: 'vans' }).user).toContain('No competitor CSV supplied')
    const map = assemblePrompt('retention-map', { idea: 'x', title: 'y', script: 'script.txt' }, { readFile: read })
    expect(map.user).toContain('Line one of the script.')
    const fix = assemblePrompt('package-fix', { idea: 'x', title: 'y', fixes: 'text repeats the title; two elements too many' }, { readFile: read, previous: { concepts: [] } })
    expect(fix.user).toContain('- text repeats the title')
    expect(fix.user).toContain('- two elements too many')
    expect(fix.user).toContain('"concepts": []')
    const fromContext = assemblePrompt('package-fix', { idea: 'x', title: 'y' }, { readFile: read, fixes: ['one'], previous: 'raw text' })
    expect(fromContext.user).toContain('- one')
    expect(fromContext.user).toContain('raw text')
    expect(PACKAGE_FIX_TEMPLATE_PATH.endsWith(path.join('prompts', 'package-fix.md'))).toBe(true)
  })

  it('runs the deterministic diagnosis for the postmortem with typed baselines beating the profile baseline', () => {
    const typed = assemblePrompt('postmortem', { title: 'x', ctr: '2', impressions: '30000', 'baseline-ctr': '5' }, { baseline: { ctr: 9 } })
    expect(typed.user).toContain('Deterministic diagnosis:')
    expect(typed.user).toContain('"bottleneck":"packaging"')
    const fromProfile = assemblePrompt('postmortem', { title: 'x', ctr: '5', impressions: '30000' }, { baseline: { ctr: 5, avpPct: 40 } })
    expect(fromProfile.user).toContain('"bottleneck":')
  })

  it('is pure: the same input gives the same prompt twice', () => {
    const flags = { idea: 'x', title: 'y' }
    expect(assemblePrompt('thumbnail-factory', flags)).toEqual(assemblePrompt('thumbnail-factory', flags))
  })
})

/** Wording that would let a compiled rule outrank the doctrine (EFF-1). */
const OUTRANKS_DOCTRINE = [/prefer/i, /takes? precedence/i, /\bbeats? (the )?(generic )?doctrine/i, /\bover (the )?(generic )?doctrine/i, /\bavoid "/i]

describe('learned rules in the prompt (EFF-1)', () => {
  const at = '2026-09-24T00:00:00Z'
  // A three-video channel: one lever won two of three 7-day reads, one lost three of four, and a person accepted one rule.
  const rules = [
    RuleDoc.parse({ id: 'rule:a', rule: 'x', lever: 'number-in-title', tests: 3, wins: 2, confidence: 0.57, status: 'promoted', slugs: ['v1', 'v2', 'v3'], updatedAt: at }),
    RuleDoc.parse({ id: 'rule:b', rule: 'x', lever: 'stakes-thumb', tests: 4, wins: 1, confidence: 0.33, status: 'retired', updatedAt: at }),
    RuleDoc.parse({ id: 'rule:c', rule: 'Face on every thumbnail', status: 'promoted', acceptedBy: 'jony', confidence: 1, updatedAt: at }),
  ]

  it('tells the model learned rules are observations under test that never override the doctrine', () => {
    expect(SYSTEM_PREAMBLE).toContain("are observations under test from this channel's own small sample, not doctrine")
    expect(SYSTEM_PREAMBLE).toContain('They never override the doctrine: where one disagrees with it, follow the doctrine.')
    expect(SYSTEM_PREAMBLE).toContain('Mention a learned rule only as a hypothesis worth testing, with its evidence count.')
    for (const pattern of OUTRANKS_DOCTRINE) expect(SYSTEM_PREAMBLE).not.toMatch(pattern)
  })

  it('assembles a prompt in which no learned rule is ever preferred over the doctrine', () => {
    const learned = renderLearnedRules(rules, { now: new Date(at) })
    const assembled = assemblePrompt('title-lab', { idea: 'Van build' }, { playbookText: `<!-- playbook/00-learned-rules.md -->\n${learned}`, playbookFiles: [LEARNED_RULES_FILE] })
    const sent = assembled.system.map((b) => b.text).join('\n')
    for (const pattern of OUTRANKS_DOCTRINE) expect(sent).not.toMatch(pattern)
    expect(sent).toContain('- Hypothesis under observation: "number-in-title" may help on this channel (3 tests, 2 wins, smoothed win rate 60%, confidence 57%; v1, v2, v3)')
    expect(sent).toContain('- Hypothesis under observation: "stakes-thumb" may not help on this channel (4 tests, 1 win,')
    expect(sent).toContain('- Face on every thumbnail [accepted by jony]')
    const dry = formatDryRun(assembled)
    for (const pattern of OUTRANKS_DOCTRINE) expect(dry).not.toMatch(pattern)
  })

  it('ships a doctrine that never ranks learned rules above itself', () => {
    // The real docs/02 and playbook/*.md, minus any compiled file a local run left behind. The doctrine
    // legitimately says "Preferred" (a Test & Compare label), so this checks learned-rule wording only.
    const shipped: PlaybookFs = { exists: existsSync, readdir: (dir) => readdirSync(dir).filter((f) => f !== path.basename(LEARNED_RULES_FILE)), readFile: (file) => readFileSync(file, 'utf8') }
    const loaded = loadPlaybook(undefined, { fs: shipped })
    expect(loaded.files).toContain(DOCTRINE_FILE)
    const sent = [SYSTEM_PREAMBLE, loaded.text].join('\n')
    expect(sent).not.toMatch(/prefer (the |a )?learned rules?/i)
    expect(sent).not.toMatch(/learned rules? (beats?|outranks?|takes? precedence|wins? over)/i)
    expect(sent).not.toMatch(/\bloaded ahead of (the )?generic doctrine/i)
    expect(loaded.text).toContain('hypothesis under observation from the channel\'s own small sample, not doctrine')
  })
})

describe('helpers', () => {
  it('renders the fix template and the outlier block', () => {
    expect(renderPackageFixUser([], null, 'F:{{fixes}} P:{{previous}} {{other}}')).toBe('F:- (none) P:null {{other}}')
    expect(outlierContext(undefined)).toMatch(/No competitor CSV/)
  })

  it('formats the dry run with every block in send order', () => {
    const text = formatDryRun(assemblePrompt('title-lab', { idea: 'x' }, { playbookText: 'DOC', playbookFiles: ['a.md'] }))
    expect(text.indexOf('engine: title-lab')).toBe(0)
    expect(text).toContain('playbook files (1): a.md')
    expect(text.indexOf('--- system[0] ---')).toBeLessThan(text.indexOf('--- system[1] (cached) ---'))
    expect(text.indexOf('--- system[1] (cached) ---')).toBeLessThan(text.indexOf('--- user ---'))
  })

  it('knows its engines', () => {
    expect(ENGINE_NAMES).toContain('package-fix')
    expect(isEngineName('title-lab')).toBe(true)
    expect(isEngineName('toString')).toBe(false)
  })
})
