#!/usr/bin/env node
// The split rehearsal (gate P0-G3): does the booster install and verify on
// its own, in the private repository's layout, with nothing of Grok UI around it?
//
// Copies what the private repository will hold into an empty scratch folder:
// channel-booster/**, .claude/skills/booster*/** and ops/mission/**, as git
// lists them (tracked files plus files not yet committed, never an ignored
// node_modules/, data/ or dist/), and the root files from
// scripts/split-template/ (package.json with the channel-booster workspace,
// .gitignore, README.md, LICENSE, NOTICE). Commits it as a fresh repository,
// so tests that ask git behave as in a clone, then runs `npm install` and
// `npm run verify` there with their output streamed. Prints PASS or FAIL for
// every step, exits 1 on any FAIL, and writes the transcript to
// ops/mission/evidence/standalone-check.txt at the repository root. --keep
// keeps the scratch folder.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BOOSTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(BOOSTER, '..')
const TEMPLATE = path.join(BOOSTER, 'scripts', 'split-template')
const EVIDENCE = path.join(REPO, 'ops', 'mission', 'evidence', 'standalone-check.txt')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const KEEP = process.argv.includes('--keep')

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

/** npm's environment without the npm_config_* settings an enclosing `npm run` exports; proxy, CA, registry and cache stay. Nothing moves the booster's files. */
function cleanEnv() {
  const keep = new Set(['npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_proxy', 'npm_config_noproxy', 'npm_config_cafile', 'npm_config_ca', 'npm_config_registry', 'npm_config_strict_ssl', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache'])
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase()
    if ((lower.startsWith('npm_config_') && !keep.has(lower)) || lower.startsWith('npm_package_') || lower.startsWith('npm_lifecycle_') || key === 'INIT_CWD') delete env[key]
  }
  for (const key of ['BOOSTER_HOME', 'BOOSTER_DATA', 'BOOSTER_PROFILE', 'BOOSTER_NOW', 'BOOSTER_MODEL', 'BOOSTER_STAGE_ISOLATION']) delete env[key]
  return env
}

function quiet(command, args, cwd, env = cleanEnv()) {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
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

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'channel-booster-split-')))
const split = path.join(tmp, 'channel-booster-repo')
mkdirSync(split)

const head = quiet('git', ['rev-parse', 'HEAD'], REPO).stdout.trim()
say(`channel-booster split rehearsal (P0-G3), ${new Date().toISOString()}`)
say(`from ${REPO} at ${head || 'an unknown commit'}; node ${process.version}`)
say(`into ${split}`)
say('')

let status = 1
try {
  // 1. The carried files, as git lists them.
  const listed = quiet('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'channel-booster', '.claude/skills', 'ops/mission'], REPO)
  const tracked = new Set(quiet('git', ['ls-files', '-z', '--cached', '--', 'channel-booster', '.claude/skills', 'ops/mission'], REPO).stdout.split('\0').filter(Boolean))
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter((f) => CARRIED.some((re) => re.test(f)) && existsSync(path.join(REPO, f)))
  if (listed.status !== 0 || files.length === 0) {
    fail('copy the carried files', `git ls-files found nothing to carry (exit ${listed.status}): run this from a git checkout`)
  } else {
    for (const f of files) copyEntry(path.join(REPO, f), path.join(split, f))
    const uncommitted = files.filter((f) => !tracked.has(f))
    const groups = CARRIED.map((re) => files.filter((f) => re.test(f)).length)
    pass('copy the carried files', `${files.length} files (channel-booster ${groups[0]}, skills ${groups[1]}, ops/mission ${groups[2]})${uncommitted.length ? `, ${uncommitted.length} not yet committed` : ''}`)
    if (uncommitted.length) note(`Not yet committed, carried anyway:\n${uncommitted.map((f) => `  ${f}`).join('\n')}`)
  }

  // 2. The root files.
  const template = readdirSync(TEMPLATE)
  for (const name of template) copyEntry(path.join(TEMPLATE, name), path.join(split, name))
  const drifted = ['LICENSE', 'NOTICE'].filter((name) => !existsSync(path.join(TEMPLATE, name)) || readFileSync(path.join(TEMPLATE, name), 'utf8') !== readFileSync(path.join(BOOSTER, name), 'utf8'))
  if (drifted.length) fail('root files from scripts/split-template/', `${drifted.join(' and ')} differ from channel-booster's own: copy channel-booster/${drifted[0]} over scripts/split-template/${drifted[0]}`)
  else pass('root files from scripts/split-template/', template.sort().join(', '))

  // 3. A fresh repository, committed, holding nothing of Grok UI.
  const git = (args) => quiet('git', ['-c', 'user.name=split-rehearsal', '-c', 'user.email=split-rehearsal@localhost', '-c', 'commit.gpgsign=false', ...args], split)
  const committed = git(['init', '-q']).status === 0 && git(['add', '-A']).status === 0 && git(['commit', '-q', '-m', 'split rehearsal']).status === 0
  const root = readdirSync(split).sort()
  const strays = root.filter((name) => !EXPECTED_ROOT.includes(name))
  const hidden = git(['ls-files', '--cached', '--ignored', '--exclude-standard']).stdout.trim()
  if (!committed) fail('a fresh repository', 'git init, add or commit failed (see the transcript)')
  else if (strays.length) fail('a fresh repository', `the root holds ${strays.join(', ')}, which the private repository does not`)
  else if (hidden) fail('a fresh repository', `the root .gitignore hides tracked files: ${hidden.split('\n').slice(0, 5).join(', ')}`)
  else pass('a fresh repository', `root: ${root.join(' ')}`)

  // 4. Install and verify there.
  const install = await streamed(NPM, ['install', '--no-audit', '--no-fund'], split)
  if (install === 0) pass('npm install in the split repository')
  else fail('npm install in the split repository', `exit ${install}`)
  if (install === 0) {
    const verify = await streamed(NPM, ['run', 'verify'], split)
    say('')
    if (verify === 0) pass('npm run verify in the split repository', 'check, test and build pass with no Grok UI files present')
    else fail('npm run verify in the split repository', `exit ${verify}; the output above names the failing step`)
  } else {
    fail('npm run verify in the split repository', 'not run: npm install failed')
  }

  const failed = results.filter((r) => !r.pass)
  say('')
  say(failed.length === 0 ? `PASS split rehearsal: ${results.length} steps` : `FAIL split rehearsal: ${failed.length} of ${results.length} steps failed`)
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
process.exit(status)
