/** Commands: profile, ingest, set, ledger, fetch, thresholds. (Wiring lands in the CLI wave.) */
import type { CommandModule } from '../shared.js'

export const dataModule: CommandModule = {
  verbs: ['profile', 'ingest', 'set', 'ledger', 'fetch', 'thresholds'],
  help: [],
  async run(cmd) {
    throw new Error(`"${cmd}" is not wired yet`)
  },
}
