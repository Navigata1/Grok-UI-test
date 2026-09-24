import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assemblePrompt, describeDoctrine, describeOverlay, formatDryRun, loadPlaybook, parseEffort, outlierContext, renderPackageFixUser,
  DOCTRINE_FILE, LEARNED_RULES_FILE, NO_DOCTRINE_HASH, NO_DOCTRINE_NOTE, PLAYBOOK_MAX_CHARS, SYSTEM_PREAMBLE, type PlaybookFs,
} from './prompt.js'
import { doctrineHash, doctrineVersion, shippedDoctrine, type ShippedDoctrine } from './doctrine.js'
import { ENGINE_NAMES, isEngineName } from './schemas.js'
import { renderLearnedRules } from '../rules.js'
import { RuleDoc } from '../schema.js'
import { CODE_ROOT } from '../workspace.js'

/** An in-memory channel playbook folder. */
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

/** A shipped doctrine as the bundle embeds it. */
function doctrineOf(files: Record<string, string>): ShippedDoctrine {
  const list = Object.entries(files).map(([name, text]) => ({ name, text }))
  return { files: list, hash: doctrineHash(list), packageFixTemplate: 'Fixes:\n{{fixes}}\nPrevious:\n{{previous}}' }
}

const SHIPPED = doctrineOf({
  [DOCTRINE_FILE]: '# Doctrine\nR1 packaging first',
  'playbook/README.md': '# Index',
  'playbook/ideation.md': '# Ideation',
})

/** A channel workspace's playbook folder: the compiled rules, a copy of a shipped file with an accepted rule, one of its own, and a file that must never load. */
const CHANNEL = '/ws/playbook'
const C = (name: string) => path.join(CHANNEL, name)
const channelFs = fakeFs(
  {
    [C('00-learned-rules.md')]: '# Learned rules (compiled)\n- rule',
    [C('ideation.md')]: '# Accepted rules for this channel, extending the shipped playbook/ideation.md\n\n## Learned rules\n\n- 2026-09-14: Face left',
    [C('zz-own.md')]: '# Own',
    [C('notes.txt')]: 'never loaded',
  },
  { [CHANNEL]: ['zz-own.md', 'ideation.md', '00-learned-rules.md', 'notes.txt'] },
)

describe('loadPlaybook', () => {
  it('lays the channel playbook over the shipped doctrine: docs/02, compiled rules, shipped playbook, then the channel\'s other files', () => {
    const loaded = loadPlaybook(CHANNEL, { fs: channelFs, doctrine: SHIPPED })
    expect(loaded.files).toEqual([
      DOCTRINE_FILE,
      'channel playbook/00-learned-rules.md',
      'playbook/README.md',
      'playbook/ideation.md',
      'channel playbook/ideation.md',
      'channel playbook/zz-own.md',
    ])
    expect(loaded.overlay).toEqual(['playbook/00-learned-rules.md', 'playbook/ideation.md', 'playbook/zz-own.md'])
    expect(loaded.doctrine).toEqual({ hash: SHIPPED.hash, files: [DOCTRINE_FILE, 'playbook/README.md', 'playbook/ideation.md'] })
    expect(loaded.overlayDir).toBe(CHANNEL)
    // Every chunk keeps its header, in load order, and the channel's copy never replaces the shipped file.
    expect([...loaded.text.matchAll(/<!-- (.+?) -->/g)].map((m) => m[1])).toEqual(loaded.files)
    expect(loaded.text).toContain('<!-- playbook/ideation.md -->\n# Ideation')
    expect(loaded.text).toContain('<!-- channel playbook/ideation.md -->\n# Accepted rules for this channel')
    expect(loaded.text).not.toContain('never loaded')
  })

  it('tells the model where the channel playbook files sit in the order it loads them', () => {
    expect(SYSTEM_PREAMBLE).toContain('A file named "channel playbook/<file>" comes from this channel\'s own playbook folder: its compiled 00-learned-rules.md follows docs/02, and its other files follow the shipped playbook.')
    const { files } = loadPlaybook(CHANNEL, { fs: channelFs, doctrine: SHIPPED })
    expect(files.indexOf('channel playbook/00-learned-rules.md')).toBe(files.indexOf(DOCTRINE_FILE) + 1)
    const lastShipped = Math.max(...SHIPPED.files.map((f) => files.indexOf(f.name)))
    const others = files.filter((f) => f.startsWith('channel playbook/') && !f.endsWith('/00-learned-rules.md'))
    for (const f of others) expect(files.indexOf(f)).toBeGreaterThan(lastShipped)
  })

  it('takes only the compiled rules from the shipped folder itself (the legacy source layout)', () => {
    const shippedDir = '/r/playbook'
    const fs = fakeFs(
      { [path.join(shippedDir, '00-learned-rules.md')]: '# Learned', [path.join(shippedDir, 'ideation.md')]: 'THE COPY ON DISK' },
      { [shippedDir]: ['ideation.md', 'README.md', '00-learned-rules.md'] },
    )
    const loaded = loadPlaybook(shippedDir, { fs, doctrine: SHIPPED, shippedDir })
    expect(loaded.files).toEqual([DOCTRINE_FILE, LEARNED_RULES_FILE, 'playbook/README.md', 'playbook/ideation.md'])
    expect(loaded.overlay).toEqual([LEARNED_RULES_FILE])
    expect(loaded.text).not.toContain('THE COPY ON DISK')
  })

  it('treats a symlink to the shipped folder as the shipped folder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'booster-prompt-'))
    try {
      const shippedDir = path.join(dir, 'playbook')
      mkdirSync(shippedDir)
      writeFileSync(path.join(shippedDir, '00-learned-rules.md'), '# Learned')
      writeFileSync(path.join(shippedDir, 'ideation.md'), 'THE COPY ON DISK')
      const link = path.join(dir, 'pb-link')
      symlinkSync(shippedDir, link, 'dir')
      const viaLink = loadPlaybook(link, { doctrine: SHIPPED, shippedDir })
      expect(viaLink.files).toEqual([DOCTRINE_FILE, LEARNED_RULES_FILE, 'playbook/README.md', 'playbook/ideation.md'])
      expect(viaLink.overlay).toEqual([LEARNED_RULES_FILE])
      expect(viaLink.text).toBe(loadPlaybook(shippedDir, { doctrine: SHIPPED, shippedDir }).text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the doctrine from shippedDoctrine(), never from a folder on disk', () => {
    const loaded = loadPlaybook(undefined, { fs: fakeFs({}, {}), doctrine: SHIPPED })
    expect(loaded).toEqual({ text: '<!-- docs/02-strategist-playbook.md -->\n# Doctrine\nR1 packaging first\n\n<!-- playbook/README.md -->\n# Index\n\n<!-- playbook/ideation.md -->\n# Ideation', files: [DOCTRINE_FILE, 'playbook/README.md', 'playbook/ideation.md'], doctrine: { hash: SHIPPED.hash, files: [DOCTRINE_FILE, 'playbook/README.md', 'playbook/ideation.md'] }, overlay: [] })
  })

  it('skips an absent folder or compiled rules file and stops before the cap, hashing only the doctrine it kept', () => {
    const missing = loadPlaybook('/nowhere', { fs: fakeFs({}, {}), doctrine: SHIPPED })
    expect(missing.files).toEqual([DOCTRINE_FILE, 'playbook/README.md', 'playbook/ideation.md'])
    expect(missing.overlay).toEqual([])
    expect(missing.overlayDir).toBe('/nowhere')
    const capped = loadPlaybook(CHANNEL, { fs: channelFs, doctrine: SHIPPED, maxChars: 160 })
    expect(capped.files).toEqual([DOCTRINE_FILE, 'channel playbook/00-learned-rules.md'])
    expect(capped.text.length).toBeLessThanOrEqual(160)
    expect(capped.doctrine).toEqual({ hash: doctrineVersion([SHIPPED.files[0]], SHIPPED.packageFixTemplate), files: [DOCTRINE_FILE] })
    expect(capped.doctrine.hash).not.toBe(SHIPPED.hash)
  })

  it('refuses a build that ships no doctrine unless --no-doctrine, and then says the run has none', () => {
    const empty: ShippedDoctrine = { files: [], hash: doctrineHash([]), packageFixTemplate: '' }
    expect(() => loadPlaybook(CHANNEL, { fs: channelFs, doctrine: empty })).toThrow(/This build ships no doctrine: docs\/02-strategist-playbook.md and playbook\/\*.md are missing/)
    expect(() => loadPlaybook(CHANNEL, { fs: channelFs, doctrine: empty })).toThrow(/or pass --no-doctrine to run without doctrine on purpose/)
    const without = loadPlaybook(CHANNEL, { fs: channelFs, doctrine: empty, noDoctrine: true })
    expect(without.text.startsWith(`<!-- no doctrine -->\n${NO_DOCTRINE_NOTE}\n\n<!-- channel playbook/00-learned-rules.md -->`)).toBe(true)
    expect(without.doctrine).toEqual({ hash: NO_DOCTRINE_HASH, files: [] })
    expect(without.files).toEqual(['channel playbook/00-learned-rules.md', 'channel playbook/ideation.md', 'channel playbook/zz-own.md'])
    // --no-doctrine leaves a shipped doctrine out too.
    const skipped = loadPlaybook(undefined, { doctrine: SHIPPED, noDoctrine: true })
    expect(skipped.text).not.toContain('R1 packaging first')
    expect(skipped.files).toEqual([])
    expect(describeDoctrine(skipped.doctrine)).toBe('doctrine none (--no-doctrine)')
  })
})

/** The loader as it stood before the doctrine was built in (d13d33a): docs/02, playbook/00-learned-rules.md, then playbook/*.md, all from a root on disk. */
function loadPlaybookBefore(rootDir: string, fs: PlaybookFs): { text: string; files: string[] } {
  const wanted: string[] = []
  if (fs.exists(path.join(rootDir, DOCTRINE_FILE))) wanted.push(DOCTRINE_FILE)
  if (fs.exists(path.join(rootDir, LEARNED_RULES_FILE))) wanted.push(LEARNED_RULES_FILE)
  const playbookDir = path.join(rootDir, 'playbook')
  if (fs.exists(playbookDir)) {
    for (const name of [...fs.readdir(playbookDir)].sort()) {
      if (!name.endsWith('.md')) continue
      const rel = path.posix.join('playbook', name)
      if (rel === LEARNED_RULES_FILE) continue
      wanted.push(rel)
    }
  }
  const chunks: string[] = []
  const files: string[] = []
  let length = 0
  for (const rel of wanted) {
    const chunk = `<!-- ${rel} -->\n${fs.readFile(path.join(rootDir, rel)).trim()}`
    const cost = chunk.length + (chunks.length ? 2 : 0)
    if (length + cost > PLAYBOOK_MAX_CHARS) break
    chunks.push(chunk)
    files.push(rel)
    length += cost
  }
  return { text: chunks.join('\n\n'), files }
}

describe('the legacy source layout', () => {
  const shippedDir = path.join(CODE_ROOT, 'playbook')
  const learnedPath = path.join(shippedDir, '00-learned-rules.md')
  const learned = renderLearnedRules([RuleDoc.parse({ id: 'rule:a', rule: 'x', lever: 'number-in-title', tests: 3, wins: 2, confidence: 0.57, status: 'promoted', updatedAt: '2026-09-24T00:00:00Z' })], { now: new Date('2026-09-24T00:00:00Z') })
  /** The real checkout, with or without a compiled rules file that only this test sees: the real folder is never written. */
  const checkout = (withLearned: boolean): PlaybookFs => ({
    exists: (file) => (file === learnedPath ? withLearned : existsSync(file)),
    readdir: (dir) => {
      const names = readdirSync(dir).filter((n) => n !== '00-learned-rules.md')
      return dir === shippedDir && withLearned ? [...names, '00-learned-rules.md'] : names
    },
    readFile: (file) => (file === learnedPath ? learned : readFileSync(file, 'utf8')),
  })

  it('builds byte for byte the prompt the old loader built from the checkout: same files, same order, same text', () => {
    for (const withLearned of [true, false]) {
      const before = loadPlaybookBefore(CODE_ROOT, checkout(withLearned))
      const after = loadPlaybook(shippedDir, { fs: checkout(withLearned) })
      expect(after.files).toEqual(before.files)
      expect(after.text).toBe(before.text)
      expect(after.files.length).toBeGreaterThanOrEqual(withLearned ? 12 : 11)
      expect(after.overlay).toEqual(withLearned ? [LEARNED_RULES_FILE] : [])
      expect(after.doctrine).toEqual({ hash: shippedDoctrine().hash, files: shippedDoctrine().files.map((f) => f.name) })
    }
  })

  it('builds the same prompt through a symlink to the checkout\'s playbook folder, never loading the shipped files twice', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'booster-prompt-'))
    try {
      const link = path.join(dir, 'pb-link')
      symlinkSync(shippedDir, link, 'dir')
      const direct = loadPlaybook(shippedDir, { fs: checkout(false) })
      const viaLink = loadPlaybook(link, { fs: checkout(false) })
      expect(viaLink.files).toEqual(direct.files)
      expect(viaLink.text).toBe(direct.text)
      expect(viaLink.overlay).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    if (file.endsWith('script.txt')) return 'Line one of the script.\nLine two.'
    if (file.endsWith('.csv')) return 'title,views,published,channel\nA,1000,2026-01-01,C\nB,100,2026-01-01,C\nC,100,2026-01-01,C\n'
    throw new Error(`unexpected read ${file}`)
  }
  const packageFixTemplate = 'Fixes:\n{{fixes}}\nPrevious:\n{{previous}}'

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

  it('reads the CSV and the script only through the injected reader, and takes the fix template from the context', () => {
    const idea = assemblePrompt('idea-engine', { niche: 'vans', csv: 'competitors.csv', count: '4' }, { readFile: read })
    expect(idea.user).toContain('Outlier scan of 3 videos')
    expect(idea.user).toContain('Produce 4 ideas')
    expect(assemblePrompt('idea-engine', { niche: 'vans' }).user).toContain('No competitor CSV supplied')
    const map = assemblePrompt('retention-map', { idea: 'x', title: 'y', script: 'script.txt' }, { readFile: read })
    expect(map.user).toContain('Line one of the script.')
    // `read` throws on anything else, so the template never comes from prompts/ on disk.
    const fix = assemblePrompt('package-fix', { idea: 'x', title: 'y', fixes: 'text repeats the title; two elements too many' }, { readFile: read, previous: { concepts: [] }, packageFixTemplate })
    expect(fix.user).toContain('Fixes:\n- text repeats the title\n- two elements too many')
    expect(fix.user).toContain('"concepts": []')
    const fromContext = assemblePrompt('package-fix', { idea: 'x', title: 'y' }, { readFile: read, fixes: ['one'], previous: 'raw text', packageFixTemplate })
    expect(fromContext.user).toContain('- one')
    expect(fromContext.user).toContain('raw text')
    expect(() => assemblePrompt('package-fix', { idea: 'x', title: 'y', fixes: 'a' }, { readFile: read })).toThrow(/package-fix needs the fix-round template \(prompts\/package-fix.md\), and this build ships none/)
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

  it('echoes the doctrine and the channel playbook files it was given, for the provenance line', () => {
    const loaded = loadPlaybook(CHANNEL, { fs: channelFs, doctrine: SHIPPED })
    const a = assemblePrompt('title-lab', { idea: 'x' }, { playbookText: loaded.text, playbookFiles: loaded.files, doctrine: loaded.doctrine, overlay: loaded.overlay, overlayDir: loaded.overlayDir })
    expect(a.doctrine).toEqual(loaded.doctrine)
    expect(a.overlay).toEqual(['playbook/00-learned-rules.md', 'playbook/ideation.md', 'playbook/zz-own.md'])
    expect(a.overlayDir).toBe(CHANNEL)
    expect(assemblePrompt('title-lab', { idea: 'x' }).overlay).toEqual([])
    expect(assemblePrompt('title-lab', { idea: 'x' }).doctrine).toBeUndefined()
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
    // The shipped docs/02 and playbook/*.md: the shipped doctrine never includes a compiled file a local run left behind.
    // The doctrine legitimately says "Preferred" (a Test & Compare label), so this checks learned-rule wording only.
    const loaded = loadPlaybook()
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
    // No doctrine was loaded here, so no doctrine or overlay line: the playbook files follow the schema.
    expect(text.split('\n')[2]).toBe('playbook files (1): a.md')
    expect(text.indexOf('--- system[0] ---')).toBeLessThan(text.indexOf('--- system[1] (cached) ---'))
    expect(text.indexOf('--- system[1] (cached) ---')).toBeLessThan(text.indexOf('--- user ---'))
  })

  it('names the doctrine hash, its file count and the channel playbook files in the dry run', () => {
    const loaded = loadPlaybook(CHANNEL, { fs: channelFs, doctrine: SHIPPED })
    const text = formatDryRun(assemblePrompt('title-lab', { idea: 'x' }, { playbookText: loaded.text, playbookFiles: loaded.files, doctrine: loaded.doctrine, overlay: loaded.overlay, overlayDir: loaded.overlayDir }))
    const lines = text.split('\n')
    expect(lines[2]).toBe(`doctrine ${SHIPPED.hash} (3 files)`)
    expect(lines[3]).toBe(`overlay ${CHANNEL}: playbook/00-learned-rules.md, playbook/ideation.md, playbook/zz-own.md`)
    expect(lines[4]).toBe('playbook files (6): docs/02-strategist-playbook.md, channel playbook/00-learned-rules.md, playbook/README.md, playbook/ideation.md, channel playbook/ideation.md, channel playbook/zz-own.md')
    expect(describeOverlay([], CHANNEL)).toBe(`overlay ${CHANNEL}: (none)`)
    expect(describeOverlay([], undefined)).toBe('overlay: none (no channel workspace)')
    expect(describeDoctrine({ hash: 'abc', files: ['one.md'] })).toBe('doctrine abc (1 file)')
  })

  it('knows its engines', () => {
    expect(ENGINE_NAMES).toContain('package-fix')
    expect(isEngineName('title-lab')).toBe(true)
    expect(isEngineName('toString')).toBe(false)
  })
})
