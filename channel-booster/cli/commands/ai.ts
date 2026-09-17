/** Command: ai <engine> (loads the Claude engines on demand). */
import type { CommandModule } from '../shared.js'

export const aiModule: CommandModule = {
  verbs: ['ai'],
  help: ['ai <engine> ...                                                    Claude-powered engines (see: booster ai help)'],
  async run(_cmd, sub, rest, flags) {
    const { runAiCommand } = await import('../../src/ai/index.js')
    return runAiCommand(sub, rest, flags)
  },
}
