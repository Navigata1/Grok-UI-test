/**
 * Shared helpers for every booster command module: argument parsing,
 * output, time, and the store/profile handles.
 */
import { openStore, type Store } from '../src/store.js'
import { loadProfile, applyProfileThresholds } from '../src/profile.js'
import type { ProfileDoc } from '../src/schema.js'

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

/** `--now ISO` for reproducible runs; defaults to the wall clock. */
export function nowFrom(flags: Flags): Date {
  const v = str(flags, 'now')
  if (!v) return new Date()
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`--now must be an ISO date, got "${v}"`)
  return d
}

export function out(value: unknown, flags: Flags, render: () => string): void {
  if (flags.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${render()}\n`)
}

export function warn(message: string): void {
  process.stderr.write(`${message}\n`)
}

export function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`
}

export function pct(n: number | undefined, digits = 1): string {
  return n === undefined ? '—' : `${n.toFixed(digits)}%`
}

/** The JSONL store, honouring --data <dir> and BOOSTER_DATA. */
export function getStore(flags: Flags): Store {
  return openStore(str(flags, 'data'))
}

/** The channel profile, honouring --path <channel.json> and BOOSTER_PROFILE; applies its threshold overrides. */
export function getProfile(flags: Flags): ProfileDoc {
  const profile = loadProfile(str(flags, 'path'))
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
