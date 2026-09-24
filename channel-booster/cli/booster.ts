#!/usr/bin/env tsx
/**
 * booster: the YouTube Channel Booster command line, run from source with tsx
 * (`npm run booster -- <command>`). Deterministic engines run offline.
 * `booster ai <engine>` adds Claude on top and needs ANTHROPIC_API_KEY (or an
 * `ant auth login` profile). main() lives in cli/main.ts; the packaged bin
 * (bin/channel-booster.mjs) calls the same function from the bundle.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, parseArgs, type Args } from './main.js'

export { main, parseArgs }
export type { Args }

/**
 * True when this file is the script tsx was asked to run, however it was
 * named (relative, absolute, through a symlink), and false when a test or
 * another module imports it, whatever that module's file is called.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`booster: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
