/**
 * The clock a scan of a CSV reads at.
 *
 * The bundled example exports (channel-booster/examples/*.csv) carry fixed
 * publish dates. On the wall clock they age out of the demand window, so the
 * first idea a new user scores from them reads RED and the scan calls nearly
 * every row stale. A command that reads one of these files, with no --now and
 * no BOOSTER_NOW, reads it as of the date the file was written for and prints
 * one line saying so. Every other CSV, a copy of an example included, runs on
 * the given clock or the wall clock.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nowFrom, str, type Flags } from './shared.js'

const EXAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples')

/**
 * The date each bundled export was written for, a few days after its newest
 * row. cli/example-clock.test.ts holds every date after its file's newest row
 * and the README quick start's result at each date, so new rows in a file mean
 * a new date here.
 */
export const EXAMPLE_AS_OF: Readonly<Record<string, string>> = {
  // Newest row 2026-07-06. "How I Built a Solar Generator for $300" (2026-05-05) is 66 days old.
  'competitors.csv': '2026-07-10T00:00:00Z',
  // Newest upload 2026-08-09, so every upload is at least 7 days old. The 7.6x winner (2026-05-31) is 77 days old.
  'my-channel.csv': '2026-08-16T00:00:00Z',
  // The same channel's uploads as a Studio export.
  'studio-content.csv': '2026-08-16T00:00:00Z',
}

function realOrResolved(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/** The date a bundled example export was written for, or undefined for any other file. */
export function exampleAsOf(csv: string): string | undefined {
  const name = path.basename(csv)
  if (!Object.hasOwn(EXAMPLE_AS_OF, name)) return undefined
  return realOrResolved(csv) === realOrResolved(path.join(EXAMPLES_DIR, name)) ? EXAMPLE_AS_OF[name] : undefined
}

export interface ScanClock {
  now: Date
  /** Set when the clock was pinned to a bundled example's date: the ISO date it was written for. */
  exampleAsOf?: string
}

/** --now or BOOSTER_NOW when either is given; else a bundled example's own date; else the wall clock. */
export function scanClock(csv: string, flags: Flags): ScanClock {
  const pinned = str(flags, 'now') !== undefined || Boolean(process.env.BOOSTER_NOW)
  const asOf = pinned ? undefined : exampleAsOf(csv)
  return asOf ? { now: new Date(asOf), exampleAsOf: asOf } : { now: nowFrom(flags) }
}

/** The one line a command prints when it read a bundled example at the example's own date. */
export function exampleNote(asOf: string): string {
  return `Example data: scored as of ${asOf.slice(0, 10)}, the date it was written for; pass --now to override.`
}
