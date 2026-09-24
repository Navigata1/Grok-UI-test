#!/usr/bin/env node
// The split rehearsal (gate P0-G3): does the booster install and verify on
// its own, in the private repository's layout, with nothing of Grok UI around it?
//
// Copies what the private repository will hold into an empty scratch folder:
// channel-booster/**, .claude/skills/booster*/** and ops/mission/**, as the
// commit at HEAD holds them (the private repository is built from git
// history, so an edit or a file not yet committed is left out, as are the
// ignored node_modules/, data/ and dist/), and the root files from
// scripts/split-template/ (package.json with the channel-booster workspace,
// .gitignore, README.md, LICENSE, NOTICE). Commits it as a fresh repository,
// so tests that ask git behave as in a clone, and checks that the commit holds
// every carried file (a .gitignore could keep one out). Then runs `npm install`,
// checks that every package the gate scripts import resolves there, and runs
// `npm run verify`, with their output streamed. Prints PASS or FAIL for
// every step, exits 1 on any FAIL, and writes the transcript to
// ops/mission/evidence/standalone-check.txt at the repository root. --keep
// keeps the scratch folder. --include-uncommitted rehearses the working tree
// instead (tracked and untracked files, never ignored ones), to try work out
// before committing it: such a run is not gate evidence, says so, and writes
// its transcript to standalone-check-uncommitted.txt.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BOOSTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(BOOSTER, '..')
/** The private repository's root files, relative to channel-booster/. */
const TEMPLATE = 'scripts/split-template'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const KEEP = process.argv.includes('--keep')
const INCLUDE_UNCOMMITTED = process.argv.includes('--include-uncommitted')
const EVIDENCE = path.join(REPO, 'ops', 'mission', 'evidence', INCLUDE_UNCOMMITTED ? 'standalone-check-uncommitted.txt' : 'standalone-check.txt')

/** The folders the carried files come from, as git pathspecs. */
const CARRIED_FOLDERS = ['channel-booster', '.claude/skills', 'ops/mission']

/** What the private repository holds, as paths relative to this repository's root. */
const CARRIED = [/^channel-booster\//, /^\.claude\/skills\/booster[^/]*\//, /^ops\/mission\//]

/** The root of the private repository: the carried folders and the template's files, nothing else. */
const EXPECTED_ROOT = ['.claude', '.git', '.gitignore', 'LICENSE', 'NOTICE', 'README.md', 'channel-booster', 'ops', 'package.json']

const transcript = []
const results = []

function note(line) {
  transcript.push(line)
}

function say(line) {
  note(line)
  process.stdout.write(`${line}\n`)
}

function pass(name, detail) {
  results.push({ name, pass: true })
  say(`PASS ${name}${detail ? `: ${detail}` : ''}`)
}

function fail(name, detail) {
  results.push({ name, pass: false })
  say(`FAIL ${name}: ${detail}`)
}

/**
 * npm's environment without the npm_config_* settings an enclosing `npm run` exports; proxy, CA, registry and cache stay.
 * Nothing moves the booster's files, and no GIT_DIR or GIT_INDEX_FILE a git hook exports points git at another repository.
 */
function cleanEnv() {
  const keep = new Set(['npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_proxy', 'npm_config_noproxy', 'npm_config_cafile', 'npm_config_ca', 'npm_config_registry', 'npm_config_strict_ssl', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache'])
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase()
    if ((lower.startsWith('npm_config_') && !keep.has(lower)) || lower.startsWith('npm_package_') || lower.startsWith('npm_lifecycle_') || key === 'INIT_CWD') delete env[key]
  }
  for (const key of ['BOOSTER_HOME', 'BOOSTER_DATA', 'BOOSTER_PROFILE', 'BOOSTER_NOW', 'BOOSTER_MODEL', 'BOOSTER_STAGE_ISOLATION']) delete env[key]
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) delete env[key]
  return env
}

function quiet(command, args, cwd, { env = cleanEnv(), input } = {}) {
  const r = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  note(`$ ${[command, ...args].join(' ')}  (cwd ${cwd}; exit ${r.status})`)
  if (r.stderr?.trim()) note(r.stderr.trimEnd())
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Run a command with its output streamed to this terminal and kept in the transcript. */
function streamed(command, args, cwd) {
  say('')
  say(`$ ${[command, ...args].join(' ')}  (in ${cwd})`)
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let pending = ''
    const take = (chunk, sink) => {
      sink.write(chunk)
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) note(line)
    }
    child.stdout.on('data', (c) => take(c, process.stdout))
    child.stderr.on('data', (c) => take(c, process.stderr))
    child.on('error', (error) => {
      note(`failed to start: ${error.message}`)
      resolve(null)
    })
    child.on('close', (code) => {
      if (pending) note(pending)
      resolve(code)
    })
  })
}

/** Copy one file, keeping its mode (the bin stays executable) or its link. */
function copyEntry(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  const st = lstatSync(from)
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
  else {
    copyFileSync(from, to)
    chmodSync(to, st.mode & 0o777)
  }
}

/** git in repo, stopping with what went wrong when it fails. */
function gitIn(repo, args, options) {
  const r = quiet('git', args, repo, options)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo} (exit ${r.status}): ${r.stderr.trim() || 'no output'}. Run this from a git checkout.`)
  return r.stdout
}

const paths = (stdout) => stdout.split('\0').filter(Boolean)
const carried = (files) => [...new Set(files)].filter((f) => CARRIED.some((re) => re.test(f))).sort()

/**
 * Copy the files the private repository holds from repo into dest, and return
 * them. By default they come from the commit at HEAD, with their modes and
 * links, through a scratch index so repo's own index is never touched.
 * includeUncommitted copies the working tree instead: tracked files as edited
 * and untracked ones, never ignored ones. uncommitted lists the carried paths
 * whose working-tree state differs from HEAD (edited, added or untracked):
 * left out by default, carried with includeUncommitted.
 */
export function carryFiles(repo, dest, { includeUncommitted = false } = {}) {
  const changed = new Set([
    ...paths(gitIn(repo, ['diff', '--name-only', '-z', 'HEAD', '--', ...CARRIED_FOLDERS])),
    ...paths(gitIn(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...CARRIED_FOLDERS])),
  ])
  if (includeUncommitted) {
    const files = carried(paths(gitIn(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...CARRIED_FOLDERS]))).filter((f) => existsSync(path.join(repo, f)))
    for (const f of files) copyEntry(path.join(repo, f), path.join(dest, f))
    return { files, uncommitted: files.filter((f) => changed.has(f)) }
  }
  const files = carried(paths(gitIn(repo, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...CARRIED_FOLDERS])))
  if (files.length) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'channel-booster-split-index-'))
    try {
      const env = { ...cleanEnv(), GIT_INDEX_FILE: path.join(scratch, 'index') }
      gitIn(repo, ['read-tree', 'HEAD'], { env })
      gitIn(repo, ['checkout-index', '-z', '--stdin', `--prefix=${dest}${path.sep}`], { env, input: `${files.join('\0')}\0` })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return { files, uncommitted: carried([...changed]) }
}

/**
 * The expected paths the split repository's commit left out. `git add -A`
 * never stages a file its .gitignore matches, so a carried file the template
 * .gitignore hides would be missing from every clone while the rehearsal,
 * which still has it on disk, passes.
 */
export function droppedFiles(repo, expected) {
  const tracked = new Set(paths(gitIn(repo, ['ls-files', '-z'])))
  return [...new Set(expected)].filter((f) => !tracked.has(f)).sort()
}

/**
 * The packages the booster's gate scripts (channel-booster/scripts/*.mjs under
 * root) import that do not resolve from where each script sits: a package the
 * booster uses but does not declare is not installed in the private
 * repository, so a gate that imports it cannot run there.
 */
export function unresolvedImports(root) {
  const scripts = path.join(root, 'channel-booster', 'scripts')
  const missing = []
  for (const name of existsSync(scripts) ? readdirSync(scripts).filter((f) => f.endsWith('.mjs')).sort() : []) {
    const file = path.join(scripts, name)
    const text = readFileSync(file, 'utf8')
    const specifiers = new Set([...text.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3]))
    const require = createRequire(file)
    for (const specifier of specifiers) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
      try {
        require.resolve(specifier)
      } catch {
        missing.push(`${specifier} (imported by channel-booster/scripts/${name})`)
      }
    }
  }
  return missing
}

async function rehearse() {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'channel-booster-split-')))
  const split = path.join(tmp, 'channel-booster-repo')
  mkdirSync(split)

  const head = quiet('git', ['rev-parse', 'HEAD'], REPO).stdout.trim()
  say(`channel-booster split rehearsal (P0-G3), ${new Date().toISOString()}`)
  say(`from ${REPO} at ${head || 'an unknown commit'}; node ${process.version}`)
  if (INCLUDE_UNCOMMITTED) say('--include-uncommitted: this rehearses the working tree, not the commit, so it is not gate evidence.')
  say(`into ${split}`)
  say('')

  let status = 1
  try {
    // 1. The carried files, from the commit (or the working tree with --include-uncommitted).
    const { files, uncommitted } = carryFiles(REPO, split, { includeUncommitted: INCLUDE_UNCOMMITTED })
    if (files.length === 0) {
      fail('copy the carried files', `HEAD holds nothing under ${CARRIED_FOLDERS.join(', ')}: run this from the repository that holds channel-booster/`)
    } else {
      const groups = CARRIED.map((re) => files.filter((f) => re.test(f)).length)
      const from = INCLUDE_UNCOMMITTED ? 'the working tree' : `HEAD ${head.slice(0, 7)}`
      pass('copy the carried files', `${files.length} files from ${from} (channel-booster ${groups[0]}, skills ${groups[1]}, ops/mission ${groups[2]})`)
    }
    if (uncommitted.length) {
      say(
        INCLUDE_UNCOMMITTED
          ? 'Not yet committed, carried as the working tree has them:'
          : 'Not yet committed, so rehearsed as HEAD has them (or left out, when HEAD has none); commit them, or pass --include-uncommitted to try them out:',
      )
      say(uncommitted.map((f) => `  ${f}`).join('\n'))
    }

    // 2. The root files, from the template the carried files hold (so from the same commit).
    const booster = path.join(split, 'channel-booster')
    const templateDir = path.join(booster, TEMPLATE)
    const template = existsSync(templateDir) ? readdirSync(templateDir).sort() : []
    for (const name of template) copyEntry(path.join(templateDir, name), path.join(split, name))
    const drifted = ['LICENSE', 'NOTICE'].filter((name) => !template.includes(name) || readFileSync(path.join(templateDir, name), 'utf8') !== readFileSync(path.join(booster, name), 'utf8'))
    if (template.length === 0) fail('root files from scripts/split-template/', `the carried files have no channel-booster/${TEMPLATE}/: commit it`)
    else if (drifted.length) fail('root files from scripts/split-template/', `${drifted.join(' and ')} differ from channel-booster's own: copy channel-booster/${drifted[0]} over channel-booster/${TEMPLATE}/${drifted[0]}`)
    else pass('root files from scripts/split-template/', template.join(', '))

    // 3. A fresh repository, committed, holding nothing of Grok UI.
    const git = (args) => quiet('git', ['-c', 'user.name=split-rehearsal', '-c', 'user.email=split-rehearsal@localhost', '-c', 'commit.gpgsign=false', ...args], split)
    const committed = git(['init', '-q']).status === 0 && git(['add', '-A']).status === 0 && git(['commit', '-q', '-m', 'split rehearsal']).status === 0
    const root = readdirSync(split).sort()
    const strays = root.filter((name) => !EXPECTED_ROOT.includes(name))
    const dropped = committed ? droppedFiles(split, [...files, ...template]) : []
    if (!committed) fail('a fresh repository', 'git init, add or commit failed (see the transcript)')
    else if (strays.length) fail('a fresh repository', `the root holds ${strays.join(', ')}, which the private repository does not`)
    else if (dropped.length) fail('a fresh repository', `the root .gitignore keeps ${dropped.length} carried file${dropped.length === 1 ? '' : 's'} out of the commit, so a clone would lack ${dropped.length === 1 ? 'it' : 'them'}: ${dropped.slice(0, 5).join(', ')}`)
    else pass('a fresh repository', `root: ${root.join(' ')}; all ${files.length + template.length} files committed`)

    // 4. Install and verify there.
    const install = await streamed(NPM, ['install', '--no-audit', '--no-fund'], split)
    if (install === 0) pass('npm install in the split repository')
    else fail('npm install in the split repository', `exit ${install}`)
    if (install === 0) {
      // The gates run there too: every package a gate script imports must be one npm install put in place.
      const unresolved = unresolvedImports(split)
      if (unresolved.length) fail('the gate scripts\' imports resolve in the split repository', `not installed, so not declared in channel-booster/package.json: ${unresolved.join(', ')}`)
      else pass('the gate scripts\' imports resolve in the split repository')
    }
    if (install === 0) {
      const verify = await streamed(NPM, ['run', 'verify'], split)
      say('')
      if (verify === 0) pass('npm run verify in the split repository', 'check, test and build pass with no Grok UI files present')
      else fail('npm run verify in the split repository', `exit ${verify}; the output above names the failing step`)
    } else {
      fail('npm run verify in the split repository', 'not run: npm install failed')
    }

    const failed = results.filter((r) => !r.pass)
    const what = INCLUDE_UNCOMMITTED ? 'split rehearsal of the working tree (not gate evidence)' : 'split rehearsal'
    say('')
    say(failed.length === 0 ? `PASS ${what}: ${results.length} steps` : `FAIL ${what}: ${failed.length} of ${results.length} steps failed`)
    status = failed.length === 0 ? 0 : 1
  } catch (error) {
    say(`FAIL split rehearsal stopped: ${error instanceof Error ? error.stack : String(error)}`)
  } finally {
    if (status === 0 && !KEEP) rmSync(tmp, { recursive: true, force: true })
    else say(`scratch folder kept: ${split}`)
    mkdirSync(path.dirname(EVIDENCE), { recursive: true })
    writeFileSync(EVIDENCE, `${transcript.join('\n')}\n`)
    process.stdout.write(`transcript: ${path.relative(process.cwd(), EVIDENCE) || EVIDENCE}\n`)
  }
  return status
}

/** True when node was asked to run this file, not when a test imports carryFiles from it. */
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exit(await rehearse())
