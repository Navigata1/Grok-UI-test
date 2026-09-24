import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { main, parseArgs } from '../cli/booster.js'
import { buildInfo } from '../cli/main.js'
import { buildBundle } from '../scripts/build.js'
import { readShippedDoctrine } from './ai/doctrine.js'
import { captureIo } from './io.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const moduleRoot = path.resolve(here, '..')
const repoRoot = path.resolve(moduleRoot, '..')
const examples = path.resolve(here, '..', 'examples')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const entry = path.join(moduleRoot, 'cli', 'booster.ts')

/** This environment without the variables that move the booster's files or reach the network, and a scratch HOME. */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const key of ['BOOSTER_HOME', 'BOOSTER_DATA', 'BOOSTER_PROFILE', 'BOOSTER_NOW', 'BOOSTER_MODEL', 'ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY']) delete env[key]
  return env
}

/** The same without npm's own settings an enclosing `npm test` exports, so a nested npm finds its package.json as a person's shell would. */
function npmEnv(home: string): NodeJS.ProcessEnv {
  const env = cleanEnv(home)
  for (const key of Object.keys(env)) if (/^npm_/i.test(key) || key === 'INIT_CWD') delete env[key]
  return { ...env, npm_config_update_notifier: 'false' }
}

/** git without the GIT_DIR or GIT_INDEX_FILE a git hook exports, so it works on the scratch repository it is run in. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) delete env[key]
  return env
}

function spawnNode(args: string[], cwd: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

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

afterEach(() => vi.restoreAllMocks())

describe('parseArgs', () => {
  it('keeps positionals after boolean flags and supports --key=value', () => {
    const a = parseArgs(['titles', '--json', 'cold showers', '--number=30 days', '--subject', 'Jackery'])
    expect(a.positional).toEqual(['titles', 'cold showers'])
    expect(a.flags).toEqual({ json: true, number: '30 days', subject: 'Jackery' })
  })
  it('treats a trailing value flag as boolean', () => {
    expect(parseArgs(['workflow', 'x', '--out']).flags.out).toBe(true)
  })
})

describe('main', () => {
  it('prints help', async () => {
    const { code, out } = await run(['help'])
    expect(code).toBe(0)
    expect(out).toMatch(/outliers <csv>/)
  })
  it('runs outliers on the example export as JSON', async () => {
    const { code, out } = await run(['outliers', path.join(examples, 'competitors.csv'), '--json', '--top', '3'])
    expect(code).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.ranked).toHaveLength(3)
    expect(parsed.ranked[0].tier).toBe('outlier')
  })
  it('prints title shapes with --json before the positional: a blank, no score, template true', async () => {
    const { code, out } = await run(['titles', '--json', 'cold showers', '--number', '30 days'])
    expect(code).toBe(0)
    const shapes = JSON.parse(out)
    expect(shapes.length).toBeGreaterThanOrEqual(10)
    expect(shapes[0]).toEqual({ title: 'I Tried ___ for 30 days', formula: 'first-person test', example: 'I Tried 30 Days of Cold Showers', template: true, score: null })
    expect(shapes.every((s: { title: string; template: boolean; score: null }) => s.title.includes('___') && s.template === true && s.score === null)).toBe(true)
  })
  it('prints shapes, not a ranked score table, and says to write and score your own', async () => {
    const { code, out } = await run(['titles', 'living off a $300 solar generator', '--number', '30 Days'])
    expect(code).toBe(0)
    const lines = out.trimEnd().split('\n')
    expect(lines[0]).toBe('Title shapes for "living off a $300 solar generator": templates with a blank, not titles, so no scores and no ranking.')
    expect(out).not.toMatch(/^Score\b/m)
    expect(out).not.toContain('solar generator Until It Worked')
    expect(out).toMatch(/^ {2}I Did ___ Until It Worked +until\/stakes, e\.g\. "I Took Cold Showers Until It Worked"$/m)
    expect(lines.at(-1)).toBe('Write your own title in one of these shapes, in your own words, then score it: booster titles score "<your title>".')
  })
  it('holds a pasted-in template fill under the title gate in titles score', async () => {
    const { out } = await run(['titles', 'score', '--json', 'I Did A $300 solar generator Until It Worked'])
    const scored = JSON.parse(out)
    expect(scored.score).toBeLessThan(60)
    expect(scored.notes).toContain('template fill: "Did A" starts the pasted-in topic with its article; no article belongs after "Did" here')
  })
  it('diagnoses and reviews a package', async () => {
    const pm = await run(['postmortem', '--json', '--impressions', '24000', '--ctr', '2.1', '--avp', '44', '--hours', '48', '--baseline-ctr', '4.5', '--baseline-avp', '40', '--baseline-views', '6000'])
    expect(JSON.parse(pm.out).bottleneck).toBe('packaging')
    const pr = await run(['package', 'review', '--json', '--title', 'I Lived Off a $300 Solar Generator for 30 Days', '--thumb-text', 'Day 30'])
    expect(JSON.parse(pr.out).verdict).toBe('pass')
  })
  it('rejects an unknown command', async () => {
    await expect(main(['nope'])).rejects.toThrow(/unknown command/)
  })
})

describe('help and build info from source', () => {
  it('names the workspace: init, --workspace, BOOSTER_HOME and where', async () => {
    const { out } = await run(['help'])
    expect(out.split('\n')[0]).toBe('booster: YouTube Channel Booster')
    expect(out).toContain('Create one with `npm run booster -- init ../<folder>`.')
    expect(out).toContain('name it with --workspace ../<folder> or BOOSTER_HOME=<folder>')
    expect(out).toContain('a source checkout keeps its files in channel-booster/data/ and channel-booster/channel.json')
    expect(out).toContain('`npm run booster -- where` prints the folder each location resolves to')
  })
  it('names a workspace folder outside the checkout, as npm run starts at the repository root', async () => {
    const { out } = await run(['help'])
    const folder = /Create one with `npm run booster -- init (\S+)`/.exec(out)?.[1]
    expect(folder).toBeDefined()
    const created = path.resolve(repoRoot, folder!.replace('<folder>', 'my-channel'))
    expect(path.relative(repoRoot, created).startsWith('..'), `${created} is inside the checkout, where git add finds the channel's files`).toBe(true)
  })
  it('does not warn init or where about the --workspace they are about to create or report', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-startup-'))
    try {
      // where reports a --workspace that is not one itself; init makes it one.
      for (const argv of [['where', '--json', '--workspace', path.join(tmp, 'ch')], ['init', path.join(tmp, 'ch'), '--channel', 'Startup', '--workspace', path.join(tmp, 'ch')]]) {
        const r = await captureIo(() => main(argv))
        expect(r.stderr, argv[0]).not.toContain('is not a booster workspace')
      }
      const other = await captureIo(() => main(['titles', 'cold showers', '--workspace', path.join(tmp, 'elsewhere')]))
      expect(other.stderr).toContain(`booster: ${path.join(tmp, 'elsewhere')} (from --workspace) is not a booster workspace`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  it('reads the doctrine from the checkout', () => {
    const shipped = readShippedDoctrine(moduleRoot)
    expect(buildInfo()).toEqual({ bundled: false, version: 'source', doctrine: { hash: shipped.hash, files: shipped.files.map((f) => f.name) } })
  })
})

describe('the tsx entry runs main only when it is the script tsx runs', () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-entry-'))
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const titles = ['titles', 'cold showers', '--json']

  it('runs by its repo-relative path, as npm run booster names it', () => {
    const repo = path.resolve(moduleRoot, '..')
    const r = spawnNode([tsxCli, path.relative(repo, entry), ...titles], repo, cleanEnv(tmp))
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)[0].formula).toBe('first-person test')
  })
  it('runs through a symlink whatever the link is called', () => {
    const link = path.join(tmp, 'bst.ts')
    symlinkSync(entry, link)
    const r = spawnNode([tsxCli, link, ...titles], tmp, cleanEnv(tmp))
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)[0].formula).toBe('first-person test')
  })
  it('runs through npm run booster from below channel-booster/ too, at the repository root as before', () => {
    // channel-booster/package.json is the nearest one there; its booster script starts at the repository root, like the root's.
    const r = spawnSync('npm', ['run', '-s', 'booster', '--', 'outliers', 'channel-booster/examples/competitors.csv', '--json', '--top', '1'], { cwd: path.join(moduleRoot, 'dashboard'), env: npmEnv(tmp), encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).ranked).toHaveLength(1)
  })
  it('stays quiet when another script imports it, even one named booster.mjs', () => {
    const importer = path.join(tmp, 'booster.mjs')
    writeFileSync(importer, `import { main } from ${JSON.stringify(pathToFileURL(entry).href)}\nif (typeof main !== 'function') process.exit(3)\n`)
    const r = spawnNode([tsxCli, importer, ...titles], tmp, cleanEnv(tmp))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('')
  })
})

/**
 * The packaged bin against a bundle built into a scratch folder laid out like
 * the installed package (bin/, dist/, node_modules/), with no docs/ or
 * playbook/ beside it: whatever doctrine it reports is the one it embedded.
 */
describe('the packaged bundle and bin', () => {
  let pkg: string
  let bin: string
  let cwd: string
  let env: NodeJS.ProcessEnv
  let built: Awaited<ReturnType<typeof buildBundle>>
  beforeAll(async () => {
    pkg = mkdtempSync(path.join(os.tmpdir(), 'booster-bundle-'))
    cwd = mkdtempSync(path.join(os.tmpdir(), 'booster-bundle-cwd-'))
    env = cleanEnv(cwd)
    mkdirSync(path.join(pkg, 'bin'))
    bin = path.join(pkg, 'bin', 'channel-booster.mjs')
    copyFileSync(path.join(moduleRoot, 'bin', 'channel-booster.mjs'), bin)
    // zod and the SDK stay external: resolve them from the node_modules this checkout installed.
    symlinkSync(path.resolve(path.dirname(require.resolve('zod/package.json')), '..'), path.join(pkg, 'node_modules'), 'dir')
    built = await buildBundle({ outfile: path.join(pkg, 'dist', 'channel-booster.mjs') })
  })
  afterAll(() => {
    rmSync(pkg, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const cli = (args: string[], node: string[] = []) => spawnNode([...node, bin, ...args], cwd, env)

  it('embeds the shipped doctrine and the package version, with no shebang in the bundle', () => {
    const shipped = readShippedDoctrine(moduleRoot)
    const version = (JSON.parse(readFileSync(path.join(moduleRoot, 'package.json'), 'utf8')) as { version: string }).version
    expect(built.doctrine).toEqual({ hash: shipped.hash, files: shipped.files.length })
    expect(built.version).toBe(version)
    expect(readFileSync(built.outfile, 'utf8').startsWith('#!')).toBe(false)
    const script = `const m = await import(${JSON.stringify(pathToFileURL(built.outfile).href)}); process.stdout.write(JSON.stringify(m.buildInfo()))`
    const r = spawnNode(['--input-type=module', '-e', script], cwd, env)
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ bundled: true, version, doctrine: { hash: shipped.hash, files: shipped.files.map((f) => f.name) } })
  })
  it('runs main with its own arguments, through a .bin symlink too, and exits with its code', () => {
    const help = cli(['help'])
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout.split('\n')[0]).toBe(`channel-booster ${built.version}: YouTube Channel Booster`)
    expect(help.stdout).toMatch(/^ {2}outliers <csv>/m)
    expect(help.stdout).toContain('Create one with `channel-booster init <folder>`.')
    expect(help.stdout).toContain('Run commands inside it, or name it from anywhere with --workspace <folder> or BOOSTER_HOME=<folder>.')
    mkdirSync(path.join(pkg, '.bin'))
    const link = path.join(pkg, '.bin', 'channel-booster')
    symlinkSync(bin, link)
    const titles = spawnNode([link, 'titles', 'cold showers', '--json'], cwd, env)
    expect(titles.status, titles.stderr).toBe(0)
    expect(JSON.parse(titles.stdout)[0].formula).toBe('first-person test')
    const unknown = cli(['nope'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toBe('channel-booster: unknown command "nope". Run channel-booster help.\n')
  })
  it('says nothing about a missing workspace until a command needs one, then names init and exits 1', () => {
    const offline = cli(['titles', 'cold showers'])
    expect(offline.status).toBe(0)
    expect(offline.stderr).toBe('')
    const store = cli(['bank', 'list'])
    expect(store.status).toBe(1)
    expect(store.stdout).toBe('')
    expect(store.stderr).toMatch(/^channel-booster: No channel workspace for the store\. Create one with `channel-booster init <folder>`/)
  })
  it('still warns about a channel.json that does not parse and a --workspace that is not one', () => {
    const bad = path.join(cwd, 'bad.json')
    writeFileSync(bad, '{not json')
    const profile = cli(['titles', 'cold showers', '--path', bad])
    expect(profile.status).toBe(0)
    expect(profile.stderr).toBe(`channel-booster: ${bad} is not valid JSON\n`)
    const workspace = cli(['titles', 'cold showers', '--workspace', 'not-a-workspace'])
    expect(workspace.status).toBe(0)
    expect(workspace.stderr).toContain(`channel-booster: ${path.join(cwd, 'not-a-workspace')} (from --workspace) is not a booster workspace`)
  })
  it('does not warn init about the BOOSTER_HOME it is about to create', () => {
    const home = path.join(cwd, 'new-channel')
    const r = spawnNode([bin, 'init', home, '--channel', 'Startup'], cwd, { ...env, BOOSTER_HOME: home })
    expect(r.stderr).not.toContain('is not a booster workspace')
  })
  it('refuses an old Node with a sentence, and a copy that was never built with the command that builds it', () => {
    const spoof = `data:text/javascript,Object.defineProperty(process.versions, 'node', { value: '20.11.0' })`
    const old = cli(['help'], ['--import', spoof])
    expect(old.status).toBe(1)
    expect(old.stdout).toBe('')
    expect(old.stderr).toBe('channel-booster: needs Node.js 22 or newer, and this is Node.js 20.11.0. Install Node.js 22 or later from https://nodejs.org and run it again.\n')
    const unbuilt = path.join(cwd, 'unbuilt', 'bin')
    mkdirSync(unbuilt, { recursive: true })
    copyFileSync(bin, path.join(unbuilt, 'channel-booster.mjs'))
    const r = spawnNode([path.join(unbuilt, 'channel-booster.mjs'), 'help'], cwd, env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`${path.join(cwd, 'unbuilt', 'dist', 'channel-booster.mjs')} is missing: this copy was never built. Run \`npm run build\` in the channel-booster folder`)
  })
})

/** The private repository's root files and the rehearsal that checks the split (scripts/standalone-check.mjs). */
describe('the split rehearsal', () => {
  const template = path.join(moduleRoot, 'scripts', 'split-template')

  it("installs, in the split README, with a command the template's files support", () => {
    const readme = readFileSync(path.join(template, 'README.md'), 'utf8')
    expect(readme).toMatch(/^npm (install|ci)\b/m)
    const ci = /^npm ci\b/m.test(readme)
    expect(ci && !existsSync(path.join(template, 'package-lock.json')), 'npm ci needs a package-lock.json, and the template ships none').toBe(false)
  })

  describe('carries the commit at HEAD, not the working tree', () => {
    type Carry = (repo: string, dest: string, options?: { includeUncommitted?: boolean }) => { files: string[]; uncommitted: string[] }
    let carryFiles: Carry
    let tmp: string
    let repo: string
    const git = (args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: gitEnv(), encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout
    }
    const put = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), text)
    }
    beforeAll(async () => {
      // A computed specifier: the rehearsal is plain JavaScript, and importing it runs nothing.
      const script = pathToFileURL(path.join(moduleRoot, 'scripts', 'standalone-check.mjs')).href
      carryFiles = ((await import(script)) as { carryFiles: Carry }).carryFiles
      tmp = mkdtempSync(path.join(os.tmpdir(), 'booster-split-'))
      repo = path.join(tmp, 'repo')
      mkdirSync(repo)
      git(['init', '-q'])
      put('channel-booster/a.txt', 'committed\n')
      put('channel-booster/bin/tool.mjs', '#!/usr/bin/env node\n')
      chmodSync(path.join(repo, 'channel-booster/bin/tool.mjs'), 0o755)
      put('.claude/skills/booster-x/SKILL.md', 'carried\n')
      put('.claude/skills/other/SKILL.md', 'not carried\n')
      put('ops/mission/plan.md', 'carried\n')
      put('outside.txt', 'not carried\n')
      git(['add', '-A'])
      git(['commit', '-q', '-m', 'base'])
      put('channel-booster/a.txt', 'edited\n')
      put('channel-booster/staged.txt', 'staged, not committed\n')
      git(['add', 'channel-booster/staged.txt'])
      put('channel-booster/untracked.txt', 'never added\n')
    })
    afterAll(() => rmSync(tmp, { recursive: true, force: true }))

    it('copies what HEAD holds, with its modes, and names what differs without carrying it', () => {
      const dest = path.join(tmp, 'head')
      const r = carryFiles(repo, dest)
      expect(r.files).toEqual(['.claude/skills/booster-x/SKILL.md', 'channel-booster/a.txt', 'channel-booster/bin/tool.mjs', 'ops/mission/plan.md'])
      expect(readFileSync(path.join(dest, 'channel-booster/a.txt'), 'utf8')).toBe('committed\n')
      expect(existsSync(path.join(dest, 'channel-booster/staged.txt'))).toBe(false)
      expect(existsSync(path.join(dest, 'channel-booster/untracked.txt'))).toBe(false)
      expect(existsSync(path.join(dest, '.claude/skills/other'))).toBe(false)
      expect(statSync(path.join(dest, 'channel-booster/bin/tool.mjs')).mode & 0o111).not.toBe(0)
      expect(r.uncommitted).toEqual(['channel-booster/a.txt', 'channel-booster/staged.txt', 'channel-booster/untracked.txt'])
      // The repository's own index is untouched: the staged file is still staged, and only it.
      expect(git(['diff', '--cached', '--name-only']).trim()).toBe('channel-booster/staged.txt')
    })
    it('copies the working tree, untracked files too, only with includeUncommitted', () => {
      const dest = path.join(tmp, 'worktree')
      const r = carryFiles(repo, dest, { includeUncommitted: true })
      expect(r.files).toContain('channel-booster/untracked.txt')
      expect(readFileSync(path.join(dest, 'channel-booster/a.txt'), 'utf8')).toBe('edited\n')
      expect(readFileSync(path.join(dest, 'channel-booster/staged.txt'), 'utf8')).toBe('staged, not committed\n')
      expect(r.uncommitted).toEqual(['channel-booster/a.txt', 'channel-booster/staged.txt', 'channel-booster/untracked.txt'])
    })
  })
})
