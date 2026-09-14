#!/usr/bin/env tsx
/**
 * booster: the YouTube Channel Booster command line.
 *
 * Deterministic engines run offline. `booster ai <engine>` adds Claude on top
 * and needs ANTHROPIC_API_KEY (or an `ant auth login` profile). Commands live
 * in cli/commands/*.ts; this file only routes.
 */
import { MODULES } from './commands/index.js'
import { getProfile, parseArgs, warn, type Args } from './shared.js'

export { parseArgs }
export type { Args }

function help(): string {
  const lines = ['booster: YouTube Channel Booster', '']
  for (const m of MODULES) for (const h of m.help) lines.push(`  ${h}`)
  lines.push('', 'Add --json to any command for machine-readable output. --data <dir> and --path <channel.json> override the store and profile locations.')
  return `${lines.join('\n')}\n`
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [cmd, sub, ...rest] = positional
  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(help())
    return 0
  }
  // channel.json threshold overrides are live for every engine; a bad override is reported, not fatal.
  try {
    getProfile(flags)
  } catch (error) {
    warn(`booster: ${error instanceof Error ? error.message : String(error)}`)
  }
  const mod = MODULES.find((m) => m.verbs.includes(cmd))
  if (!mod) throw new Error(`unknown command "${cmd}". Run booster help.`)
  return mod.run(cmd, sub, rest, flags)
}

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
