/** Command: ai <engine> (loads the Claude engines on demand). */
import { resolveCsvArg } from '../example-clock.js'
import type { CommandModule } from '../shared.js'

export const aiModule: CommandModule = {
  verbs: ['ai'],
  help: ['ai <engine> ...                                                    Claude-powered engines (see: booster ai help)'],
  async run(_cmd, sub, rest, flags) {
    // --csv example:<name> reads the bundled example export, as every other command that reads a CSV does.
    const csv = typeof flags.csv === 'string' ? resolveCsvArg(flags.csv) : undefined
    const { runAiCommand } = await import('../../src/ai/index.js')
    return runAiCommand(sub, rest, csv === undefined ? flags : { ...flags, csv })
  },
}
