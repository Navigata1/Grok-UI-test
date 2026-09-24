/**
 * Where one channel's files live.
 *
 * A workspace is one folder per channel, marked by booster-workspace.json
 * (written by `booster init`). Inside it:
 *
 *   channel.json   the channel profile
 *   data/          the JSONL store (reviews/ and last-scan.json sit under it)
 *   packages/      packages/<slug>/ for every video
 *   inbox/         Studio and competitor exports dropped for ingest
 *   playbook/      the compiled learned rules and the rules a person accepted
 *
 * The workspace is found, in order, from --workspace <dir>, BOOSTER_HOME, or
 * the nearest folder at or above the working directory holding the marker.
 *
 * Every location still has its own override, so the runbooks written before
 * workspaces existed keep working: an explicit flag wins, then the location's
 * own environment variable, then the workspace, then the legacy default.
 * The legacy defaults are the code-relative folders a source checkout has
 * always used (channel-booster/data, channel-booster/channel.json, ...). The
 * packaged bin sits inside node_modules, so it has no legacy default: without
 * a workspace or an explicit location it stops and says how to create one.
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED, cliName } from './build-info.js'
import { shellQuote } from './shell.js'

/** The file that marks a folder as a channel workspace. */
export const WORKSPACE_MARKER = 'booster-workspace.json'

/** channel-booster/ in a source checkout: the home of the legacy default locations. */
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The workspace's layout, relative to its root. */
export const WORKSPACE_LAYOUT = {
  profile: 'channel.json',
  data: 'data',
  packages: 'packages',
  inbox: 'inbox',
  playbook: 'playbook',
} as const

export type Flags = Record<string, string | boolean>

/** Where a location came from: its flag, its environment variable, the workspace, the legacy default, or the working directory. */
export type LocationSource = 'flag' | 'env' | 'workspace' | 'legacy' | 'cwd'

export interface Located {
  path: string
  source: LocationSource
}

export interface Workspace {
  root: string
  /** How it was found: --workspace, BOOSTER_HOME, or the marker at or above the working directory. */
  source: 'flag' | 'env' | 'discovered'
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  /** The working directory relative paths resolve against and discovery starts from; defaults to process.cwd(). */
  cwd?: string
  /** Whether this is the packaged bin; defaults to the build (src/build-info.ts). */
  bundled?: boolean
  /** Where the legacy defaults live; defaults to CODE_ROOT. */
  codeRoot?: string
}

/** No workspace, and the location has no explicit override and no legacy default in this build. */
export class NoWorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoWorkspaceError'
  }
}

function flagValue(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  return v !== undefined && v.trim() ? v : undefined
}

/** True when dir holds the workspace marker. */
export function isWorkspace(dir: string): boolean {
  const marker = path.join(dir, WORKSPACE_MARKER)
  try {
    return existsSync(marker) && statSync(marker).isFile()
  } catch {
    return false
  }
}

/** The nearest folder at or above start that holds the marker. */
export function discoverWorkspace(start: string): string | undefined {
  let dir = path.resolve(start)
  for (;;) {
    if (isWorkspace(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function notAWorkspace(root: string, given: string, how: string, bundled: boolean): NoWorkspaceError {
  return new NoWorkspaceError(`${root} (from ${how}) is not a booster workspace: it has no ${WORKSPACE_MARKER}. Create it with: ${cliName(bundled)} init ${shellQuote(given)}`)
}

/**
 * The workspace in use, or undefined. --workspace and BOOSTER_HOME must name
 * an initialised workspace: a typo never scatters a channel's data into a new
 * folder.
 */
export function findWorkspace(flags: Flags, options: ResolveOptions = {}): Workspace | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const bundled = options.bundled ?? BUNDLED
  const explicit = flagValue(flags, 'workspace')
  if (explicit) {
    const root = path.resolve(cwd, explicit)
    if (!isWorkspace(root)) throw notAWorkspace(root, explicit, '--workspace', bundled)
    return { root, source: 'flag' }
  }
  const home = envValue(env, 'BOOSTER_HOME')
  if (home) {
    const root = path.resolve(cwd, home)
    if (!isWorkspace(root)) throw notAWorkspace(root, home, 'BOOSTER_HOME', bundled)
    return { root, source: 'env' }
  }
  const found = discoverWorkspace(cwd)
  return found ? { root: found, source: 'discovered' } : undefined
}

function noLegacy(what: string, flag: string, bundled: boolean): NoWorkspaceError {
  return new NoWorkspaceError(
    `No channel workspace for the ${what}. Create one with \`${cliName(bundled)} init <folder>\` and run commands inside it, pass --workspace <folder> or set BOOSTER_HOME, or give the location itself with ${flag}.`,
  )
}

interface Rule {
  what: string
  flag: string
  env?: string
  inWorkspace: string
  /** The legacy default, relative to the code root; undefined means the working directory. */
  legacy?: string
}

function resolveOne(rule: Rule, flags: Flags, options: ResolveOptions): Located {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const bundled = options.bundled ?? BUNDLED
  const fromFlag = flagValue(flags, rule.flag)
  if (fromFlag) return { path: path.resolve(cwd, fromFlag), source: 'flag' }
  const fromEnv = rule.env ? envValue(env, rule.env) : undefined
  if (fromEnv) return { path: path.resolve(cwd, fromEnv), source: 'env' }
  const ws = findWorkspace(flags, options)
  if (ws) return { path: rule.inWorkspace ? path.join(ws.root, rule.inWorkspace) : ws.root, source: 'workspace' }
  if (rule.legacy === undefined) return { path: path.resolve(cwd), source: 'cwd' }
  if (bundled) throw noLegacy(rule.what, `--${rule.flag}`, bundled)
  return { path: path.join(options.codeRoot ?? CODE_ROOT, rule.legacy), source: 'legacy' }
}

const RULES = {
  data: { what: 'store', flag: 'data', env: 'BOOSTER_DATA', inWorkspace: WORKSPACE_LAYOUT.data, legacy: 'data' },
  profile: { what: 'channel profile', flag: 'path', env: 'BOOSTER_PROFILE', inWorkspace: WORKSPACE_LAYOUT.profile, legacy: 'channel.json' },
  // packages/<slug>/ has always resolved under --root or the working directory, in every build.
  packagesRoot: { what: 'packages folder', flag: 'root', inWorkspace: '', legacy: undefined },
  inbox: { what: 'inbox', flag: 'inbox', inWorkspace: WORKSPACE_LAYOUT.inbox, legacy: 'inbox' },
  playbook: { what: 'learned-rules folder', flag: 'playbook', inWorkspace: WORKSPACE_LAYOUT.playbook, legacy: 'playbook' },
} satisfies Record<string, Rule>

/** The JSONL store folder: --data, BOOSTER_DATA, <workspace>/data, or channel-booster/data from source. */
export function resolveDataDir(flags: Flags, options: ResolveOptions = {}): Located {
  return resolveOne(RULES.data, flags, options)
}

/** channel.json: --path, BOOSTER_PROFILE, <workspace>/channel.json, or channel-booster/channel.json from source. */
export function resolveProfileFile(flags: Flags, options: ResolveOptions = {}): Located {
  return resolveOne(RULES.profile, flags, options)
}

/** The folder holding packages/<slug>/: --root, the workspace root, or the working directory. */
export function resolvePackagesRoot(flags: Flags, options: ResolveOptions = {}): Located {
  return resolveOne(RULES.packagesRoot, flags, options)
}

/** The inbox `review run` and `brief` read: --inbox, <workspace>/inbox, or channel-booster/inbox from source. */
export function resolveInboxDir(flags: Flags, options: ResolveOptions = {}): Located {
  return resolveOne(RULES.inbox, flags, options)
}

/** Where compiled and accepted rules are written and read: --playbook, <workspace>/playbook, or channel-booster/playbook from source. */
export function resolvePlaybookDir(flags: Flags, options: ResolveOptions = {}): Located {
  return resolveOne(RULES.playbook, flags, options)
}

export interface LocationReport {
  workspace?: Workspace
  /** Set when --workspace or BOOSTER_HOME names a folder that is not a workspace. */
  workspaceError?: string
  bundled: boolean
  locations: Record<keyof typeof RULES, Located | { error: string }>
}

/** Every location with where it came from, never throwing: what `booster where` prints. */
export function describeLocations(flags: Flags, options: ResolveOptions = {}): LocationReport {
  const bundled = options.bundled ?? BUNDLED
  let workspace: Workspace | undefined
  let workspaceError: string | undefined
  try {
    workspace = findWorkspace(flags, options)
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error)
  }
  const locations = {} as LocationReport['locations']
  for (const key of Object.keys(RULES) as Array<keyof typeof RULES>) {
    try {
      locations[key] = resolveOne(RULES[key], flags, options)
    } catch (error) {
      locations[key] = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { workspace, workspaceError, bundled, locations }
}
