/**
 * One folder per channel: `booster init` makes a workspace, and every command
 * of the first run, run from inside it or pointed at it with --workspace,
 * writes there and nowhere else: not channel-booster/data or channel.json,
 * not the directory the run started in. Without a workspace the old --data,
 * --path and --root still land where they always did. `booster where` says
 * which folder each location resolved to and why.
 *
 * Every command runs in-process through main(), with its output captured by
 * src/io.ts, in a fresh temp folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shippedDoctrine } from '../src/ai/doctrine.js'
import { cliName } from '../src/build-info.js'
import { captureIo } from '../src/io.js'
import { defaultProfile } from '../src/profile.js'
import { resetThresholds } from '../src/thresholds.js'
import { CODE_ROOT, WORKSPACE_MARKER } from '../src/workspace.js'
import { nextCommands, renderWhere, whereReport } from './commands/workspace.js'
import { main } from './main.js'

const IDEA = 'I lived off a solar generator for 30 days'
const SLUG = 'i-lived-off-a-solar-generator-for-30-days'
/** The title a person writes; offline it is the only way the package gets one. */
const TITLE = 'Thirty Days on a Solar Generator, Every Failure'
const NOW = '2026-09-14T12:00:00Z'

let startCwd: string
/** A fresh parent folder: the workspace and an unrelated folder to run from both live in it, so a stray write shows up. */
let tmp: string
let ws: string
let elsewhere: string

beforeEach(() => {
  startCwd = process.cwd()
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'booster-workspace-')))
  ws = path.join(tmp, 'solar-van')
  elsewhere = path.join(tmp, 'elsewhere')
  mkdirSync(elsewhere)
  // Nothing from the shell running the tests may move a location; the build never reaches the network.
  for (const key of ['BOOSTER_HOME', 'BOOSTER_DATA', 'BOOSTER_PROFILE', 'BOOSTER_NOW', 'ANTHROPIC_API_KEY']) vi.stubEnv(key, '')
})
afterEach(() => {
  process.chdir(startCwd)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetThresholds()
  rmSync(tmp, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await captureIo(() => main(argv))
  if (r.threw) throw new Error(`"${argv.join(' ')}" threw: ${r.error instanceof Error ? r.error.message : String(r.error)}\n${r.stderr}`)
  return { code: r.value as number, out: r.stdout, err: r.stderr }
}

async function json(argv: string[]): Promise<{ code: number; value: any }> {
  const { code, out } = await run([...argv, '--json'])
  return { code, value: JSON.parse(out) }
}

async function fails(argv: string[]): Promise<string> {
  const r = await captureIo(() => main(argv))
  expect(r.threw, `expected "${argv.join(' ')}" to fail`).toBe(true)
  return r.error instanceof Error ? r.error.message : String(r.error)
}

/** A printed command line as argv: the CLI name dropped, double-quoted words read as the JSON strings the CLI prints. */
function argvOf(line: string): string[] {
  expect(line.startsWith(`${cliName()} `)).toBe(true)
  const words = line.slice(cliName().length).match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []
  return words.map((w) => (w.startsWith('"') ? (JSON.parse(w) as string) : w))
}

/** Every file under each path with its size and modification time; a missing path contributes nothing. */
function snapshot(...roots: string[]): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (p: string): void => {
    if (!existsSync(p)) return
    const st = statSync(p)
    if (st.isDirectory()) for (const name of readdirSync(p)) visit(path.join(p, name))
    else files.set(p, `${st.size}:${st.mtimeMs}`)
  }
  for (const root of roots) visit(root)
  return files
}

/** The files added or changed between two snapshots. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file).sort()
}

/** Where a write that ignored the workspace would land: the legacy code-relative defaults, and the folders under the directory the run started in. */
function strayTargets(): string[] {
  return [
    ...['data', 'channel.json', 'packages', 'inbox', 'playbook'].map((name) => path.join(CODE_ROOT, name)),
    ...['data', 'channel.json', 'packages', 'inbox'].map((name) => path.join(startCwd, name)),
  ]
}

/** Canned YouTube Data API bodies for the three calls `fetch channel` makes. */
function stubYouTube(): void {
  vi.stubEnv('YOUTUBE_API_KEY', 'stub-key')
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const u = String(url)
    const body = u.includes('/channels')
      ? { items: [{ id: 'UCstub', snippet: { title: 'Stub' }, contentDetails: { relatedPlaylists: { uploads: 'UUstub' } } }] }
      : u.includes('/playlistItems')
        ? { items: [{ contentDetails: { videoId: 'aB3dEfGh1jK' } }] }
        : { items: [{ id: 'aB3dEfGh1jK', snippet: { title: 'Stub video', publishedAt: '2026-07-01T00:00:00Z', channelTitle: 'Stub' }, statistics: { viewCount: '1000' }, contentDetails: { duration: 'PT10M' } }] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

/**
 * The first run: the three commands `init` prints (scan the bundled
 * competitor export, bank an idea from it, build its package offline), the
 * demand read on its own, the person's title by slug, the rest of the loop
 * that writes under packages/<slug>/, the profile, the ledger and a decision,
 * and a fetched upload list. `extra` points the commands at their folders.
 * Returns the rebuild line the title-less build printed.
 */
async function firstRun(root: string, extra: string[]): Promise<string> {
  stubYouTube()
  const [scanLine, bankLine, buildLine] = nextCommands(root).map(argvOf)
  // From source every printed command carries --workspace; the run under test supplies its own.
  const own = (argv: string[]): string[] => {
    const i = argv.indexOf('--workspace')
    return [...(i >= 0 ? argv.slice(0, i) : argv), ...extra]
  }
  const scan = await json(own(scanLine))
  expect(scan.code).toBe(0)
  expect(scan.value.exampleAsOf).toBe('2026-07-10T00:00:00Z')
  const scored = await json(['idea', 'score', IDEA, '--score', 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4', '--outliers', 'example:competitors', ...extra])
  expect(scored.value.demand).toMatchObject({ score: 3, exampleAsOf: '2026-07-10T00:00:00Z' })
  expect((await json(own(bankLine))).value.scores.demand).toBe(3)
  const bare = await run(own(buildLine))
  expect(bare.code).toBe(1)
  const titled = await json(['package', 'build', SLUG, '--title', TITLE, '--offline', ...extra])
  expect(titled.code).toBe(0)
  expect(titled.value.promise).toBe('thirty days on a solar generator, every failure shown')

  for (const argv of [
    ['plan', 'shots', SLUG],
    ['thumbnail', 'proof', SLUG],
    ['publish', 'pack', SLUG],
    ['profile', 'init', '--positioning', 'Solar for renters', '--force', '--now', NOW],
    ['signature', 'set', '--colors', 'yellow,black', '--now', NOW],
    ['ledger', 'add', '--slug', SLUG, '--title', TITLE, '--published-at', '2026-09-12T12:00:00Z', '--now', NOW],
    ['decide', '--slug', SLUG, '--bucket', '48', '--record', '--now', NOW],
    ['repackage', 'prepare', SLUG, '--now', NOW],
    ['fetch', 'channel', '@stubchannel'],
  ]) expect((await run([...argv, ...extra])).code, argv.join(' ')).toBe(0)
  // publish check fails on the missing thumb-A.png and thumb-B.png, and still writes its report.
  expect((await run(['publish', 'check', SLUG, ...extra])).code).toBe(1)

  const shown = await run(['profile', 'show', ...extra])
  expect(shown.out).toContain(path.join(root, 'channel.json'))
  expect(shown.out).toContain('Solar for renters')
  const rebuild = new RegExp(`No title yet for ${SLUG}: a person writes it, then (.*)`).exec(bare.err)?.[1]
  expect(rebuild, bare.err).toBeDefined()
  return rebuild as string
}

/** What the first run writes, relative to the folder that holds the channel's files. */
const FIRST_RUN_FILES = [
  'channel.json',
  'data/decisions.jsonl',
  'data/ideas.jsonl',
  'data/last-scan.json',
  'data/ledger.jsonl',
  'inbox/stubchannel.csv',
  `packages/${SLUG}/package.json`,
  `packages/${SLUG}/package.md`,
  `packages/${SLUG}/proof-sheet.html`,
  `packages/${SLUG}/publish-check.json`,
  `packages/${SLUG}/publish.json`,
  `packages/${SLUG}/publish.md`,
  `packages/${SLUG}/repackage.json`,
  `packages/${SLUG}/shots.md`,
]

/** Run the first run and assert that every file it wrote is inside `home` and nothing reached a stray target or the start directory. */
async function expectContained(home: string, extra: string[]): Promise<string> {
  const topLevel = readdirSync(startCwd).sort()
  const strayBefore = snapshot(...strayTargets())
  const before = snapshot(tmp)
  const rebuild = await firstRun(home, extra)
  const written = changed(before, snapshot(tmp))
  expect(written.filter((file) => !file.startsWith(`${home}${path.sep}`))).toEqual([])
  expect(written).toEqual(expect.arrayContaining(FIRST_RUN_FILES.map((rel) => path.join(home, rel))))
  expect(changed(strayBefore, snapshot(...strayTargets()))).toEqual([])
  expect(snapshot(...strayTargets()).size).toBe(strayBefore.size)
  expect(readdirSync(startCwd).sort()).toEqual(topLevel)
  expect(readdirSync(elsewhere)).toEqual([])
  return rebuild
}

describe('booster init', () => {
  it('creates the marker, the four folders and the default channel.json, and prints them with the next three commands', async () => {
    const { code, value } = await json(['init', ws, '--channel', 'Solar Van', '--now', NOW])
    expect(code).toBe(0)
    expect(value.root).toBe(ws)
    const marker = JSON.parse(readFileSync(path.join(ws, WORKSPACE_MARKER), 'utf8'))
    expect(marker).toEqual({ schemaVersion: 1, kind: 'channel-booster-workspace', channel: 'Solar Van', createdAt: '2026-09-14T12:00:00.000Z' })
    expect(value.marker).toEqual(marker)
    for (const folder of ['data', 'packages', 'inbox', 'playbook']) expect(statSync(path.join(ws, folder)).isDirectory(), folder).toBe(true)
    expect(JSON.parse(readFileSync(path.join(ws, 'channel.json'), 'utf8'))).toEqual({ ...defaultProfile(), updatedAt: '2026-09-14T12:00:00.000Z' })
    expect(value.paths).toEqual([WORKSPACE_MARKER, 'data', 'packages', 'inbox', 'playbook', 'channel.json'].map((rel) => ({ path: path.join(ws, rel), status: 'created' })))
    expect(value.next).toEqual(nextCommands(ws))

    rmSync(ws, { recursive: true })
    const text = await run(['init', ws])
    expect(JSON.parse(readFileSync(path.join(ws, WORKSPACE_MARKER), 'utf8')).channel).toBeNull()
    expect(text.out).toContain(`Created a booster workspace at ${ws}\n  created   ${path.join(ws, WORKSPACE_MARKER)}\n`)
    expect(text.out).toContain(`  created   ${path.join(ws, 'channel.json')}\n`)
    for (const line of nextCommands(ws)) expect(text.out).toContain(`\n  ${line}`)
    expect(text.out).toContain(`${cliName()} outliers example:competitors --save`)
  })

  it('prints commands that run from inside the folder for the packaged bin, and name the workspace from source', () => {
    expect(nextCommands(ws, true)).toEqual([
      'channel-booster outliers example:competitors --save',
      'channel-booster bank add "I lived off a solar generator for 30 days" --score "demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4" --csv example:competitors --promise "thirty days on a solar generator, every failure shown"',
      'channel-booster package build "I lived off a solar generator for 30 days" --offline',
    ])
    // npm run always starts at the repository root, so a command from source could never find the workspace from its folder.
    for (const line of nextCommands(ws, false)) {
      expect(line.startsWith('npm run booster -- ')).toBe(true)
      expect(line.endsWith(` --workspace ${JSON.stringify(ws)}`)).toBe(true)
    }
  })

  it('refuses an existing workspace; --force creates what is missing and never overwrites channel.json or the data', async () => {
    await run(['init', ws, '--channel', 'Solar Van', '--now', NOW])
    const markerFile = path.join(ws, WORKSPACE_MARKER)
    const marker = readFileSync(markerFile, 'utf8')
    const profileFile = path.join(ws, 'channel.json')
    writeFileSync(profileFile, `${JSON.stringify({ positioning: 'Solar for renters' }, null, 2)}\n`)
    writeFileSync(path.join(ws, 'data', 'ideas.jsonl'), '{"kept":true}\n')
    rmSync(path.join(ws, 'inbox'), { recursive: true })

    expect(await fails(['init', ws])).toBe(`${ws} is already a booster workspace (it has ${WORKSPACE_MARKER}): run commands inside it, or pass --force to create whatever is missing (channel.json and the data are never overwritten)`)
    expect(readFileSync(markerFile, 'utf8')).toBe(marker)
    expect(existsSync(path.join(ws, 'inbox'))).toBe(false)

    const forced = await json(['init', ws, '--force', '--now', '2026-09-20T00:00:00Z'])
    expect(forced.value.reinitialised).toBe(true)
    expect(readFileSync(profileFile, 'utf8')).toBe(`${JSON.stringify({ positioning: 'Solar for renters' }, null, 2)}\n`)
    expect(readFileSync(path.join(ws, 'data', 'ideas.jsonl'), 'utf8')).toBe('{"kept":true}\n')
    expect(statSync(path.join(ws, 'inbox')).isDirectory()).toBe(true)
    expect(forced.value.paths).toEqual(expect.arrayContaining([
      { path: markerFile, status: 'rewritten' },
      { path: path.join(ws, 'data'), status: 'kept' },
      { path: path.join(ws, 'inbox'), status: 'created' },
      { path: profileFile, status: 'kept' },
    ]))
    // The rewritten marker keeps the name and the date it was created with, unless --channel renames it.
    expect(JSON.parse(readFileSync(markerFile, 'utf8'))).toMatchObject({ channel: 'Solar Van', createdAt: '2026-09-14T12:00:00.000Z' })
    await run(['init', ws, '--force', '--channel', 'Solar Van Life'])
    expect(JSON.parse(readFileSync(markerFile, 'utf8'))).toMatchObject({ channel: 'Solar Van Life', createdAt: '2026-09-14T12:00:00.000Z' })
    expect(readFileSync(profileFile, 'utf8')).toBe(`${JSON.stringify({ positioning: 'Solar for renters' }, null, 2)}\n`)
  })

  it('--force repairs a marker that is not valid JSON', async () => {
    await run(['init', ws, '--channel', 'Solar Van'])
    writeFileSync(path.join(ws, WORKSPACE_MARKER), '{not json')
    await run(['init', ws, '--force', '--now', NOW])
    expect(JSON.parse(readFileSync(path.join(ws, WORKSPACE_MARKER), 'utf8'))).toEqual({ schemaVersion: 1, kind: 'channel-booster-workspace', channel: null, createdAt: '2026-09-14T12:00:00.000Z' })
  })

  it('adopts a folder that already holds a channel.json without overwriting it', async () => {
    mkdirSync(ws)
    writeFileSync(path.join(ws, 'channel.json'), '{"positioning":"mine"}\n')
    const { value } = await json(['init', ws])
    expect(readFileSync(path.join(ws, 'channel.json'), 'utf8')).toBe('{"positioning":"mine"}\n')
    expect(value.paths).toContainEqual({ path: path.join(ws, 'channel.json'), status: 'kept' })
    expect(value.reinitialised).toBe(false)
  })

  it('says what is wrong with a missing folder, a file, two folders and a bare --channel', async () => {
    expect(await fails(['init'])).toMatch(/^usage: booster init <dir>/)
    expect(await fails(['init', ws, 'extra'])).toMatch(/^usage: booster init <dir> .*one folder/)
    const file = path.join(tmp, 'a-file')
    writeFileSync(file, 'x')
    expect(await fails(['init', file])).toContain(`${file} is a file, not a folder`)
    expect(await fails(['init', ws, '--channel'])).toContain('--channel needs the channel\'s name')
    expect(existsSync(ws)).toBe(false)
  })

  it('is listed in help with where', async () => {
    const { out } = await run(['help'])
    expect(out).toContain('  init <dir> [--channel "<name>"] [--force]')
    expect(out).toContain('  where [--json]')
  })
})

describe('booster where', () => {
  it('prints the build, the workspace, every location with its source, and the shipped doctrine', async () => {
    await run(['init', ws])
    const { code, value } = await json(['where', '--workspace', ws])
    expect(code).toBe(0)
    expect(Object.keys(value).sort()).toEqual(['bundled', 'doctrine', 'locations', 'version', 'workspace'])
    expect(value.bundled).toBe(false)
    expect(value.version).toBe('source')
    expect(value.workspace).toEqual({ root: ws, source: 'flag' })
    expect(value.locations).toEqual({
      data: { path: path.join(ws, 'data'), source: 'workspace' },
      profile: { path: path.join(ws, 'channel.json'), source: 'workspace' },
      packagesRoot: { path: ws, source: 'workspace' },
      inbox: { path: path.join(ws, 'inbox'), source: 'workspace' },
      playbook: { path: path.join(ws, 'playbook'), source: 'workspace' },
    })
    const doctrine = shippedDoctrine()
    expect(value.doctrine).toEqual({ hash: doctrine.hash, files: doctrine.files.map((f) => f.name) })
    expect(value.doctrine.files[0]).toBe('docs/02-strategist-playbook.md')
    expect(value.doctrine.files).not.toContain('playbook/00-learned-rules.md')

    const text = await run(['where', '--workspace', ws])
    expect(text.out).toContain(`Workspace: ${ws} (from --workspace)\n`)
    expect(text.out).toContain('  Location       From       Path\n')
    expect(text.out).toContain(`  data           workspace  ${path.join(ws, 'data')}\n`)
    expect(text.out).toContain(`  packages root  workspace  ${ws}\n`)
    expect(text.out).toContain(`Doctrine ${doctrine.hash}: ${doctrine.files.length} files shipped with this build`)
  })

  it('shows a flag and an environment variable winning over the workspace, and a workspace found from a folder inside it', async () => {
    await run(['init', ws])
    const moved = path.join(tmp, 'moved-data')
    vi.stubEnv('BOOSTER_PROFILE', path.join(tmp, 'profile.json'))
    const { value } = await json(['where', '--workspace', ws, '--data', moved])
    expect(value.locations.data).toEqual({ path: moved, source: 'flag' })
    expect(value.locations.profile).toEqual({ path: path.join(tmp, 'profile.json'), source: 'env' })
    expect(value.locations.inbox).toEqual({ path: path.join(ws, 'inbox'), source: 'workspace' })

    vi.stubEnv('BOOSTER_PROFILE', '')
    process.chdir(path.join(ws, 'inbox'))
    const found = await json(['where'])
    expect(found.value.workspace).toEqual({ root: ws, source: 'discovered' })
    expect((await run(['where'])).out).toContain(`Workspace: ${ws} (found at or above the working directory)`)
    vi.stubEnv('BOOSTER_HOME', ws)
    process.chdir(elsewhere)
    expect((await json(['where'])).value.workspace).toEqual({ root: ws, source: 'env' })
  })

  it('without a workspace, shows the legacy defaults a source checkout has always used', async () => {
    process.chdir(elsewhere)
    const { code, value } = await json(['where'])
    expect(code).toBe(0)
    expect(value.workspace).toBeNull()
    expect(value).not.toHaveProperty('workspaceError')
    expect(value.locations).toEqual({
      data: { path: path.join(CODE_ROOT, 'data'), source: 'legacy' },
      profile: { path: path.join(CODE_ROOT, 'channel.json'), source: 'legacy' },
      packagesRoot: { path: elsewhere, source: 'cwd' },
      inbox: { path: path.join(CODE_ROOT, 'inbox'), source: 'legacy' },
      playbook: { path: path.join(CODE_ROOT, 'playbook'), source: 'legacy' },
    })
    expect((await run(['where'])).out).toContain(`Workspace: none at or above ${elsewhere}; create one with ${cliName()} init <folder>`)
  })

  it('in the packaged bin with no workspace, reports what each location needs instead of stopping', () => {
    const report = whereReport({}, { bundled: true, cwd: elsewhere, env: {} })
    expect(report.bundled).toBe(true)
    expect(report.workspace).toBeNull()
    expect(report.locations.packagesRoot).toEqual({ path: elsewhere, source: 'cwd' })
    for (const key of ['data', 'profile', 'inbox', 'playbook'] as const) {
      expect(report.locations[key]).toEqual({ error: expect.stringMatching(/^No channel workspace for the .*channel-booster init <folder>/) })
    }
    const text = renderWhere(report)
    expect(text).toMatch(/^channel-booster source\n/)
    expect(text).toContain('Workspace: none at or above')
    expect(text).toMatch(/\n {2}data {11}- {10}No channel workspace for the store\. .*--data\.\n/)
    // --data alone still names the store in the bundle.
    expect(whereReport({ data: path.join(tmp, 'd') }, { bundled: true, cwd: elsewhere, env: {} }).locations.data).toEqual({ path: path.join(tmp, 'd'), source: 'flag' })
  })

  it('exits 1 with the reason when --workspace names a folder that is not a workspace', async () => {
    const r = await captureIo(() => main(['where', '--workspace', elsewhere, '--json']))
    expect(r.value).toBe(1)
    const value = JSON.parse(r.stdout)
    expect(value.workspace).toBeNull()
    expect(value.workspaceError).toBe(`${elsewhere} (from --workspace) is not a booster workspace: it has no ${WORKSPACE_MARKER}. Create it with: ${cliName()} init ${elsewhere}`)
    expect(value.locations.data).toEqual({ error: value.workspaceError })
    const text = await captureIo(() => main(['where', '--workspace', elsewhere]))
    expect(text.stdout).toContain(`Workspace: ${value.workspaceError}\n`)
    expect(text.stdout).toContain('  data           -          not resolved (see Workspace above)\n')
    expect(await fails(['where', 'extra'])).toBe('usage: booster where [--json]')
  })
})

describe('a channel workspace keeps every file of the first run', () => {
  it('run from inside the folder', async () => {
    await run(['init', ws])
    process.chdir(ws)
    const rebuild = await expectContained(ws, [])
    // A workspace found from the working directory is found again from there: the rebuild line needs no --workspace.
    expect(rebuild).toBe(`${cliName()} package build ${SLUG} --title "<your title>" --offline`)
  })

  it('run from another folder with --workspace, which the printed rebuild line repeats', async () => {
    await run(['init', ws])
    process.chdir(elsewhere)
    const rebuild = await expectContained(ws, ['--workspace', ws])
    expect(rebuild).toBe(`${cliName()} package build ${SLUG} --title "<your title>" --workspace ${JSON.stringify(ws)} --offline`)
  })

  it('named by BOOSTER_HOME, which the rebuild line also repeats as --workspace', async () => {
    await run(['init', ws])
    process.chdir(elsewhere)
    vi.stubEnv('BOOSTER_HOME', ws)
    const bare = await run(['package', 'build', IDEA, '--promise', 'thirty days on a solar generator, every failure shown', '--offline'])
    expect(bare.err).toContain(`then ${cliName()} package build ${SLUG} --title "<your title>" --workspace ${JSON.stringify(ws)} --offline\n`)
    expect(existsSync(path.join(ws, 'packages', SLUG, 'package.json'))).toBe(true)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('and without a workspace, --data, --path and --root land where they always did', async () => {
    const legacy = path.join(tmp, 'legacy')
    process.chdir(elsewhere)
    const rebuild = await expectContained(legacy, ['--data', path.join(legacy, 'data'), '--path', path.join(legacy, 'channel.json'), '--root', legacy])
    expect(rebuild).toBe(`${cliName()} package build ${SLUG} --title "<your title>" --root ${JSON.stringify(legacy)} --data ${JSON.stringify(path.join(legacy, 'data'))} --path ${JSON.stringify(path.join(legacy, 'channel.json'))} --offline`)
    expect(existsSync(ws)).toBe(false)
  })
})
