/** Command: ai <engine> (loads the Claude engines on demand). */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { CODE_ROOT } from '../../src/workspace.js'
import type { CommandModule } from '../shared.js'

const EXAMPLES_DIR = path.join(CODE_ROOT, 'examples')
const EXAMPLE_PREFIX = 'example:'

/**
 * `--csv example:<name>` as the bundled channel-booster/examples/<name>.csv,
 * so the engines can read an example export from any folder. Any other value
 * is a path and passes through. Stands in for resolveCsvArg() from
 * cli/example-clock.ts, which every other command that reads a CSV uses.
 */
function resolveCsvArg(value: string): string {
  if (!value.startsWith(EXAMPLE_PREFIX)) return value
  const name = value.slice(EXAMPLE_PREFIX.length).replace(/\.csv$/i, '')
  const file = path.join(EXAMPLES_DIR, `${name}.csv`)
  if (/^[a-z0-9_-]+$/i.test(name) && existsSync(file)) return file
  const known = existsSync(EXAMPLES_DIR) ? readdirSync(EXAMPLES_DIR).filter((n) => n.endsWith('.csv')).map((n) => `${EXAMPLE_PREFIX}${n.slice(0, -4)}`).sort() : []
  throw new Error(`--csv ${value}: there is no bundled example "${name}". The bundled examples are ${known.join(', ') || '(none in this build)'}; any other --csv is a path to your own export.`)
}

export const aiModule: CommandModule = {
  verbs: ['ai'],
  help: ['ai <engine> ...                                                    Claude-powered engines (see: booster ai help)'],
  async run(_cmd, sub, rest, flags) {
    const csv = typeof flags.csv === 'string' ? resolveCsvArg(flags.csv) : undefined
    const { runAiCommand } = await import('../../src/ai/index.js')
    return runAiCommand(sub, rest, csv === undefined ? flags : { ...flags, csv })
  },
}
