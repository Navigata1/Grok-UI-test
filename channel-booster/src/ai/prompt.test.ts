import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { assemblePrompt, formatDryRun, loadPlaybook, parseEffort, outlierContext, renderPackageFixUser, DOCTRINE_FILE, LEARNED_RULES_FILE, PACKAGE_FIX_TEMPLATE_PATH, SYSTEM_PREAMBLE, type PlaybookFs } from './prompt.js'
import { ENGINE_NAMES, isEngineName } from './schemas.js'

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
