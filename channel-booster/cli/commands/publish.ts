/** Commands: publish, test. (Wiring lands in the CLI wave.) */
import type { CommandModule } from '../shared.js'

export const publishModule: CommandModule = {
  verbs: ['publish', 'test'],
  help: [],
  async run(cmd) {
    throw new Error(`"${cmd}" is not wired yet`)
  },
}
