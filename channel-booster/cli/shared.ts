/**
 * Shared helpers for every booster command module: argument parsing,
 * output, time, the store/profile handles, and where a channel's files live.
 */
import { writeErr, writeOut } from '../src/io.js'
import { openStore, type Store } from '../src/store.js'
import { loadProfile, applyProfileThresholds } from '../src/profile.js'
import type { ProfileDoc } from '../src/schema.js'
import {
  findWorkspace,
  resolveDataDir,
  resolveInboxDir,
  resolvePackagesRoot,
  resolvePlaybookDir,
  resolveProfileFile,
  type Workspace,
} from '../src/workspace.js'

export { writeErr, writeOut }

export interface Args {
  positional: string[]
  flags: Record<string, string | boolean>
}
export type Flags = Args['flags']

/** Flags that never take a value, so `--json "topic"` keeps "topic" positional. */
export const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'md', 'offline', 'record', 'dry-run', 'fresh', 'solo', 'team', 'next', 'override', 'week', 'today',
  'force', 'all', 'verbose', 'quiet', 'no-save', 'apply', 'pinned', 'accept', 'cold-start', 'by-topic', 'stale', 'open',
  'thumb-files-ok', 'window-confirmed', 'review-scheduled', 'no-sequel-first', 'no-signature', 'saturation', 'confirm', 'yes',
])

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

export function str(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

export function num(flags: Flags, key: string): number | undefined {
  const v = str(flags, key)
  if (v === undefined) return undefined
  const n = Number.parseFloat(v)
  return Number.isNaN(n) ? undefined : n
}

export function bool(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

export function list(flags: Flags, key: string): string[] | undefined {
  const v = str(flags, key)
  return v ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : undefined
}

export function need(flags: Flags, key: string, usage: string): string {
  const v = str(flags, key)
  if (!v) throw new Error(`--${key} is required. Usage: ${usage}`)
  return v
}

/** `--now ISO` for reproducible runs, or `BOOSTER_NOW` when the workflow runner spawned this command; defaults to the wall clock. */
export function nowFrom(flags: Flags): Date {
  const v = str(flags, 'now') ?? process.env.BOOSTER_NOW
  if (!v) return new Date()
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`--now must be an ISO date, got "${v}"`)
  return d
}

/** Print a command's result: JSON with --json, else the rendered text. Goes through src/io.ts so an in-process stage can keep it. */
export function out(value: unknown, flags: Flags, render: () => string): void {
  if (flags.json) writeOut(`${JSON.stringify(value, null, 2)}\n`)
  else writeOut(`${render()}\n`)
}

export function warn(message: string): void {
  writeErr(`${message}\n`)
}

export function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`
}

export function pct(n: number | undefined, digits = 1): string {
  return n === undefined ? '—' : `${n.toFixed(digits)}%`
}

/** A YouTube video id: exactly 11 characters of the URL-safe alphabet. */
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * `--video-id` as an 11-character YouTube id. `ingest` matches a Studio export on this exact
 * string, so a malformed id writes a ledger row no read can ever find.
 */
export function needVideoId(flags: Flags, usage: string): string {
  const videoId = need(flags, 'video-id', usage)
  if (!VIDEO_ID.test(videoId)) throw new Error(`--video-id must be the 11-character YouTube id, got "${videoId}"`)
  return videoId
}

/** The channel workspace in use (--workspace, BOOSTER_HOME, or the marker at or above the working directory), or undefined. */
export function activeWorkspace(flags: Flags): Workspace | undefined {
  return findWorkspace(flags)
}

/** The store folder: --data, BOOSTER_DATA, <workspace>/data, or channel-booster/data from source. */
export function dataDir(flags: Flags): string {
  return resolveDataDir(flags).path
}

/** channel.json: --path, BOOSTER_PROFILE, <workspace>/channel.json, or channel-booster/channel.json from source. */
export function profilePath(flags: Flags): string {
  return resolveProfileFile(flags).path
}

/** The folder that holds packages/<slug>/: --root, the workspace root, or the working directory. */
export function packagesRoot(flags: Flags): string {
  return resolvePackagesRoot(flags).path
}

/** The inbox review run and brief read: --inbox, <workspace>/inbox, or channel-booster/inbox from source. */
export function inboxDir(flags: Flags): string {
  return resolveInboxDir(flags).path
}

/** Where rules compile and retro --accept-rule write: --playbook, <workspace>/playbook, or channel-booster/playbook from source. */
export function playbookDir(flags: Flags): string {
  return resolvePlaybookDir(flags).path
}

/** The JSONL store at dataDir(flags). */
export function getStore(flags: Flags): Store {
  return openStore(dataDir(flags))
}

/** The channel profile at profilePath(flags); applies its threshold overrides. */
export function getProfile(flags: Flags): ProfileDoc {
  const profile = loadProfile(profilePath(flags))
  applyProfileThresholds(profile)
  return profile
}

/** One command group: a verb, its help lines, and a runner. */
export interface CommandModule {
  /** Top-level verbs this module answers to. */
  verbs: string[]
  /** Help lines, one per command. */
  help: string[]
  run(cmd: string, sub: string | undefined, rest: string[], flags: Flags): Promise<number>
}
