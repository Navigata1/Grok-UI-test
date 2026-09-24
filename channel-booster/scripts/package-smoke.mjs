#!/usr/bin/env node
// The packed bin from an empty folder (gate P0-G2).
//
// Builds the bundle, packs channel-booster with npm, installs the tarball into
// an empty project the way a person would, and drives the installed bin with
// HOME pointed at a scratch folder:
//   (a) the bin runs on plain node: help, its #!/usr/bin/env node line, no tsx
//       anywhere in the installed tree;
//   (b) a workspace made by init is found from inside it, and the installed bin
//       ships the same doctrine as this checkout (where --json, ai --dry-run);
//   (c) a first run inside the workspace writes nothing outside it: not in the
//       project, not in node_modules/channel-booster, not in HOME;
//   (d) a store command outside any workspace stops with the init hint.
// Prints PASS or FAIL for every check, exits 1 on any FAIL, and writes the
// whole transcript to ops/mission/evidence/package-smoke.txt at the repository
// root. Run with `npm run smoke` in channel-booster/ or
// `npm run test:booster-package` from the repository root; --keep keeps the
// scratch folder.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const BOOSTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(BOOSTER, '..')
const EVIDENCE = path.join(REPO, 'ops', 'mission', 'evidence', 'package-smoke.txt')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const TSX_CLI = createRequire(path.join(BOOSTER, 'package.json')).resolve('tsx/cli')
const KEEP = process.argv.includes('--keep')

// The first run init prints (cli/commands/workspace.ts), plus the rest of the loop the smoke drives.
const IDEA = 'I lived off a solar generator for 30 days'
const SLUG = 'i-lived-off-a-solar-generator-for-30-days' // slugify(IDEA), src/workflow.ts
const SCORE = 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'
const PROMISE = 'thirty days on a solar generator, every failure shown'
const TITLE = 'Thirty Days on a Solar Generator, Every Failure'

const transcript = []
const results = []

function note(line) {
  transcript.push(line)
}

function say(line) {
  note(line)
  process.stdout.write(`${line}\n`)
}

function clip(text, max = 6000) {
  const t = text.trimEnd()
  return t.length > max ? `${t.slice(0, max)}\n... (${t.length - max} more characters)` : t
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

/** Run a command to completion and keep its command line, exit code and output in the transcript. */
function run(command, args, { cwd, env }) {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const status = r.error ? `failed to start: ${r.error.message}` : `exit ${r.status}`
  note('')
  note(`$ ${[command, ...args].map(quote).join(' ')}`)
  note(`  (cwd ${cwd}; ${status})`)
  if (r.stdout?.trim()) note(`--- stdout\n${clip(r.stdout)}`)
  if (r.stderr?.trim()) note(`--- stderr\n${clip(r.stderr)}`)
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Record one check: fn returns a short detail on PASS and throws with the reason on FAIL. */
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true })
    say(`PASS ${name}${detail ? `: ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, pass: false })
    say(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** A check that cannot run because an earlier step failed. */
function needs(value, what) {
  if (!value) throw new Error(`not run: ${what} failed`)
  return value
}

function exited(r, code, what) {
  assert(r.status === code, `${what} exited ${r.status}, expected ${code}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').slice(-3).join(' / ')}` : ''}`)
}

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} did not print one JSON document: ${JSON.stringify(text.trim().slice(0, 200))}`)
  }
}

/**
 * npm's environment without the npm_config_* settings an enclosing `npm run`
 * exports (a --prefix among them would send the install into this checkout);
 * the proxy, CA, registry and cache settings stay.
 */
function npmEnv() {
  const keep = new Set(['npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_proxy', 'npm_config_noproxy', 'npm_config_cafile', 'npm_config_ca', 'npm_config_registry', 'npm_config_strict_ssl', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache'])
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase()
    if ((lower.startsWith('npm_config_') && !keep.has(lower)) || lower.startsWith('npm_package_') || lower.startsWith('npm_lifecycle_') || key === 'INIT_CWD') delete env[key]
  }
  return env
}

/** The installed bin's environment: a scratch HOME, and nothing that moves the booster's files or reaches the model. */
function binEnv(home) {
  const env = { ...npmEnv(), HOME: home, USERPROFILE: home }
  for (const key of ['BOOSTER_HOME', 'BOOSTER_DATA', 'BOOSTER_PROFILE', 'BOOSTER_NOW', 'BOOSTER_MODEL', 'BOOSTER_STAGE_ISOLATION', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'YOUTUBE_API_KEY', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) delete env[key]
  return env
}

/** Every entry under the roots except `skip`: files by size and mtime, links by target, folders by presence. */
function snapshot(roots, skip) {
  const seen = new Map()
  const walk = (p) => {
    if (skip && (p === skip || p.startsWith(`${skip}${path.sep}`))) return
    let st
    try {
      st = lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) seen.set(p, `link ${readlinkSync(p)}`)
    else if (st.isDirectory()) {
      seen.set(p, 'dir')
      for (const name of readdirSync(p)) walk(path.join(p, name))
    } else seen.set(p, `${st.size} bytes, mtime ${st.mtimeMs}`)
  }
  for (const root of roots) walk(root)
  return seen
}

function differences(before, after) {
  const out = []
  for (const [p, v] of after) {
    if (!before.has(p)) out.push(`new ${p}`)
    else if (before.get(p) !== v) out.push(`changed ${p}`)
  }
  for (const p of before.keys()) if (!after.has(p)) out.push(`removed ${p}`)
  return out.sort()
}

function tarballFiles(report) {
  return (report.files ?? []).map((f) => f.path.replace(/\\/g, '/'))
}

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'channel-booster-smoke-')))
const packDir = path.join(tmp, 'pack')
const project = path.join(tmp, 'project')
const home = path.join(tmp, 'home')
const ws = path.join(project, 'ws')
for (const dir of [packDir, project, home]) mkdirSync(dir)

const head = run('git', ['rev-parse', 'HEAD'], { cwd: REPO, env: process.env }).stdout.trim()
say(`channel-booster package smoke (P0-G2), ${new Date().toISOString()}`)
say(`repo ${REPO} at ${head || 'an unknown commit'}; node ${process.version}; npm ${run(NPM, ['--version'], { cwd: tmp, env: npmEnv() }).stdout.trim()}`)
say(`scratch folder ${tmp}`)
say('')

let status = 1
try {
  // Build and pack.
  const build = run(process.execPath, [TSX_CLI, path.join(BOOSTER, 'scripts', 'build.ts')], { cwd: BOOSTER, env: npmEnv() })
  let built = false
  check('build: scripts/build.ts writes dist/channel-booster.mjs', () => {
    exited(build, 0, 'the build')
    built = existsSync(path.join(BOOSTER, 'dist', 'channel-booster.mjs'))
    assert(built, 'dist/channel-booster.mjs is missing after the build')
    return build.stdout.trim()
  })

  let tarball
  check('pack: npm pack holds the bin, the bundle, the examples and the notices, and no source', () => {
    needs(built, 'the build')
    const pack = run(NPM, ['pack', '--json', '--pack-destination', packDir], { cwd: BOOSTER, env: npmEnv() })
    exited(pack, 0, 'npm pack')
    const report = parseJson(pack.stdout.slice(pack.stdout.indexOf('[')), 'npm pack --json')[0]
    const files = tarballFiles(report)
    const required = ['package.json', 'bin/channel-booster.mjs', 'dist/channel-booster.mjs', 'examples/competitors.csv', 'examples/my-channel.csv', 'examples/studio-content.csv', 'README.md', 'LICENSE', 'NOTICE']
    const missing = required.filter((f) => !files.includes(f))
    assert(missing.length === 0, `the tarball lacks ${missing.join(', ')}`)
    const stray = files.filter((f) => !required.includes(f) && !f.startsWith('examples/'))
    assert(stray.length === 0, `the tarball carries files outside bin/, dist/ and examples/: ${stray.join(', ')}`)
    tarball = path.join(packDir, report.filename)
    assert(existsSync(tarball), `${tarball} was not written`)
    return `${report.filename}, ${files.length} files, ${(report.size / 1024).toFixed(0)} KB packed`
  })

  let installed = false
  check('install: npm install <tarball> into an empty project', () => {
    needs(tarball, 'npm pack')
    writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({ name: 'booster-smoke', version: '0.0.0', private: true }, null, 2)}\n`)
    const install = run(NPM, ['install', tarball, '--no-audit', '--no-fund', '--prefix', project], { cwd: project, env: npmEnv() })
    exited(install, 0, 'npm install')
    installed = existsSync(path.join(project, 'node_modules', '.bin', 'channel-booster'))
    assert(installed, 'node_modules/.bin/channel-booster is missing after the install')
    for (const dep of ['zod', '@anthropic-ai/sdk']) assert(existsSync(path.join(project, 'node_modules', dep, 'package.json')), `the dependency ${dep} was not installed`)
    return install.stdout.trim().split('\n').at(-1)
  })

  const binPath = path.join(project, 'node_modules', '.bin', 'channel-booster')
  const env = binEnv(home)
  const bin = (args, cwd) => run(binPath, args, { cwd, env })

  // (a) A real node bin.
  check('(a) channel-booster help exits 0 with the command list', () => {
    needs(installed, 'the install')
    const help = bin(['help'], project)
    exited(help, 0, 'help')
    for (const want of ['channel-booster 0.1.0: YouTube Channel Booster', '  outliers <csv>', '  workflow run <slug>', '  package build', 'channel-booster init <folder>']) {
      assert(help.stdout.includes(want), `help does not print ${JSON.stringify(want)}`)
    }
    return `${help.stdout.split('\n').filter((l) => l.startsWith('  ')).length} command lines`
  })
  check('(a) the installed bin starts with #!/usr/bin/env node', () => {
    needs(installed, 'the install')
    const first = readFileSync(path.join(project, 'node_modules', 'channel-booster', 'bin', 'channel-booster.mjs'), 'utf8').split('\n')[0]
    assert(first === '#!/usr/bin/env node', `its first line is ${JSON.stringify(first)}`)
  })
  check('(a) npm ls tsx finds nothing in the installed tree', () => {
    needs(installed, 'the install')
    const ls = run(NPM, ['ls', 'tsx', '--all', '--json', '--prefix', project], { cwd: project, env: npmEnv() })
    const tree = parseJson(ls.stdout, 'npm ls tsx --json')
    assert(!JSON.stringify(tree.dependencies ?? {}).includes('"tsx"'), 'tsx is in the installed dependency tree')
    assert(!existsSync(path.join(project, 'node_modules', 'tsx')), 'node_modules/tsx exists')
  })

  // (c) starts here: everything outside the workspace, the installed package and HOME, before init.
  const before = snapshot([project, home], ws)

  // (b) The workspace, and the doctrine the installed bin ships.
  let workspaceMade = false
  check('(b) init ws --channel "Smoke Test" makes the workspace', () => {
    needs(installed, 'the install')
    const init = bin(['init', 'ws', '--channel', 'Smoke Test'], project)
    exited(init, 0, 'init')
    const marker = parseJson(readFileSync(path.join(ws, 'booster-workspace.json'), 'utf8'), 'booster-workspace.json')
    assert(marker.kind === 'channel-booster-workspace' && marker.schemaVersion === 1 && marker.channel === 'Smoke Test', `the marker is ${JSON.stringify(marker)}`)
    for (const entry of ['data', 'packages', 'inbox', 'playbook', 'channel.json']) assert(existsSync(path.join(ws, entry)), `ws/${entry} was not created`)
    workspaceMade = true
  })

  let installedWhere
  check('(b) where --json inside ws: the workspace is discovered and the doctrine is embedded', () => {
    needs(workspaceMade, 'init')
    const where = bin(['where', '--json'], ws)
    exited(where, 0, 'where --json')
    const report = parseJson(where.stdout, 'where --json')
    assert(report.bundled === true, `bundled is ${report.bundled}`)
    assert(report.workspace?.source === 'discovered', `the workspace source is ${JSON.stringify(report.workspace?.source)}, expected "discovered"`)
    assert(report.workspace && realpathSync(report.workspace.root) === ws, `the workspace root is ${report.workspace?.root}, expected ${ws}`)
    assert(report.locations?.data?.path === path.join(ws, 'data') && report.locations.data.source === 'workspace', `the store resolves to ${JSON.stringify(report.locations?.data)}`)
    assert(/^[0-9a-f]{12}$/.test(report.doctrine?.hash ?? '') && report.doctrine.files?.length > 0, `the doctrine is ${JSON.stringify(report.doctrine)}`)
    installedWhere = report
    return `doctrine ${report.doctrine.hash}, ${report.doctrine.files.length} files`
  })

  let sourceDoctrine
  check('(b) the source checkout ships the same doctrine, hash and files', () => {
    // Outside the watched folders: the real HOME, so nothing tsx keeps there can be taken for the bin's.
    const source = run(process.execPath, [TSX_CLI, 'channel-booster/cli/booster.ts', 'where', '--json'], { cwd: REPO, env: binEnv(os.homedir()) })
    exited(source, 0, 'where --json from source')
    sourceDoctrine = parseJson(source.stdout, 'where --json from source').doctrine
    needs(installedWhere, 'where --json in the installed bin')
    assert(isDeepStrictEqual(installedWhere.doctrine, sourceDoctrine), `installed ${JSON.stringify(installedWhere.doctrine)} vs source ${JSON.stringify(sourceDoctrine)}`)
    return sourceDoctrine.hash
  })

  check('(b) ai idea-engine --dry-run --json inside ws: the shipped doctrine and no overlay', () => {
    needs(workspaceMade, 'init')
    const ai = bin(['ai', 'idea-engine', '--niche', 'budget solar power', '--csv', 'example:competitors', '--dry-run', '--json'], ws)
    exited(ai, 0, 'ai idea-engine --dry-run --json')
    const dry = parseJson(ai.stdout, 'ai idea-engine --dry-run --json')
    assert(dry.doctrine && Array.isArray(dry.overlay), 'the dry run has no doctrine and overlay fields (the doctrine lane adds them)')
    needs(sourceDoctrine, 'where --json from source')
    assert(isDeepStrictEqual(dry.doctrine, sourceDoctrine), `the dry run loaded ${JSON.stringify(dry.doctrine)}, the source ships ${JSON.stringify(sourceDoctrine)}`)
    assert(isDeepStrictEqual(dry.overlay, []), `the overlay is ${JSON.stringify(dry.overlay)}, expected [] in a new workspace`)
    return `doctrine ${dry.doctrine.hash}, overlay []`
  })

  // (c) The first run, inside ws. A step that needs an earlier one is still run: its own exit code is the evidence.
  const steps = [
    ['scan: outliers example:competitors --save', ['outliers', 'example:competitors', '--save'], 0],
    ['idea score with demand=auto from example:competitors', ['idea', 'score', IDEA, '--score', SCORE, '--outliers', 'example:competitors'], 0],
    ['bank add with --csv example:competitors', ['bank', 'add', IDEA, '--score', SCORE, '--csv', 'example:competitors', '--promise', PROMISE], 0],
    ['package build <slug> --title .. --offline', ['package', 'build', SLUG, '--title', TITLE, '--offline'], 0],
    ['rules compile', ['rules', 'compile'], 0],
    ['workflow "<idea>" --out packages', ['workflow', IDEA, '--out', 'packages'], 0],
  ]
  for (const [name, args, code] of steps) {
    check(`(c) ${name}`, () => {
      needs(workspaceMade, 'init')
      exited(bin(args, ws), code, args.slice(0, 2).join(' '))
    })
  }
  check('(c) workflow run <slug> --next --agent smoke runs the next stage in this process', () => {
    needs(workspaceMade, 'init')
    const r = bin(['workflow', 'run', SLUG, '--next', '--agent', 'smoke', '--json'], ws)
    const value = parseJson(r.stdout, 'workflow run --json')
    const result = value.result
    assert(result?.stageId, `no stage ran: ${r.stderr.trim().split('\n').at(-1) ?? ''}`)
    // A stage whose gate fails exits 1 by design; the stage having run and recorded is what this checks.
    exited(r, result.status === 'failed' ? 1 : 0, `workflow run (stage ${result.stageId}, ${result.status})`)
    return `stage ${result.stageId}: ${result.status}${result.gate?.detail ? ` (${result.gate.detail})` : ''}`
  })

  // (d) Outside any workspace, a store command stops and names init.
  check('(d) a store command outside any workspace fails with the init hint and exit 1', () => {
    needs(installed, 'the install')
    const r = bin(['bank', 'list'], project)
    exited(r, 1, 'bank list outside a workspace')
    assert(r.stderr.startsWith('channel-booster: ') && r.stderr.includes('channel-booster init <folder>'), `stderr is ${JSON.stringify(r.stderr.trim())}`)
  })

  check('(c) nothing was written outside ws: not the project, not node_modules/channel-booster, not HOME', () => {
    needs(workspaceMade, 'init')
    const changed = differences(before, snapshot([project, home], ws))
    assert(changed.length === 0, `${changed.length} entries outside ws: ${changed.slice(0, 20).join('; ')}`)
    const inside = [...snapshot([ws])].filter(([, v]) => v !== 'dir').map(([p]) => path.relative(ws, p).split(path.sep).join('/'))
    note(`\nFiles inside ws after the run:\n${inside.sort().map((f) => `  ${f}`).join('\n')}`)
    const expected = ['channel.json', 'data/last-scan.json', 'data/ideas.jsonl', `packages/${SLUG}/package.json`, 'playbook/00-learned-rules.md', `packages/${SLUG}.json`]
    const absent = expected.filter((f) => !inside.includes(f))
    assert(absent.length === 0, `the run did not write ${absent.join(', ')} inside ws`)
    return `${inside.length} files written, all inside ws`
  })

  const failed = results.filter((r) => !r.pass)
  say('')
  say(failed.length === 0 ? `PASS package smoke: ${results.length} checks` : `FAIL package smoke: ${failed.length} of ${results.length} checks failed`)
  status = failed.length === 0 ? 0 : 1
} catch (error) {
  say(`FAIL package smoke stopped: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  if (status === 0 && !KEEP) rmSync(tmp, { recursive: true, force: true })
  else say(`scratch folder kept: ${tmp}`)
  mkdirSync(path.dirname(EVIDENCE), { recursive: true })
  writeFileSync(EVIDENCE, `${transcript.join('\n')}\n`)
  process.stdout.write(`transcript: ${path.relative(process.cwd(), EVIDENCE) || EVIDENCE}\n`)
}
process.exit(status)
