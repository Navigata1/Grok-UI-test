#!/usr/bin/env tsx
/**
 * booster: the YouTube Channel Booster command line, run from source with tsx
 * (`npm run booster -- <command>`). Deterministic engines run offline.
 * `booster ai <engine>` adds Claude on top and needs ANTHROPIC_API_KEY (or an
 * `ant auth login` profile). main() lives in cli/main.ts.
 */
import { main, parseArgs, type Args } from './main.js'

export { main, parseArgs }
export type { Args }

const invokedDirectly = process.argv[1] !== undefined && /booster\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`booster: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
