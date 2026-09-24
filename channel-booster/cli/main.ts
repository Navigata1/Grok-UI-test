/**
 * The booster command line as a function: main(argv) routes to a command
 * module and returns its exit code. The tsx entry (cli/booster.ts), the
 * packaged bin (bin/channel-booster.mjs) and the workflow runner's in-process
 * stages all call this one function. Commands live in cli/commands/*.ts.
 */
import { writeOut } from '../src/io.js'
import { MODULES } from './commands/index.js'
import { getProfile, parseArgs, warn, type Args } from './shared.js'

export { parseArgs }
export type { Args }

export function help(): string {
  const lines = ['booster: YouTube Channel Booster', '']
  for (const m of MODULES) for (const h of m.help) lines.push(`  ${h}`)
  lines.push('', 'Add --json to any command for machine-readable output. --data <dir> and --path <channel.json> override the store and profile locations.')
  return `${lines.join('\n')}\n`
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [cmd, sub, ...rest] = positional
  if (!cmd || cmd === 'help' || flags.help) {
    writeOut(help())
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
