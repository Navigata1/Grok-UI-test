/**
 * The booster command line as a function: main(argv) routes to a command
 * module and returns its exit code. The tsx entry (cli/booster.ts), the
 * packaged bin (bin/channel-booster.mjs) and the workflow runner's in-process
 * stages all call this one function. Commands live in cli/commands/*.ts.
 */
import { shippedDoctrine } from '../src/ai/doctrine.js'
import { BUNDLED, VERSION, cliName, programName } from '../src/build-info.js'
import { writeOut } from '../src/io.js'
import { NoWorkspaceError } from '../src/workspace.js'
import { MODULES } from './commands/index.js'
import { activeWorkspace, getProfile, parseArgs, warn, type Args, type Flags } from './shared.js'

export { parseArgs }
export type { Args }

/** The name the program signs its messages with: the bin's name when packaged, as the bin prints a thrown error. */
const PROGRAM = programName()

export function help(): string {
  const cli = cliName()
  const lines = [`${BUNDLED ? `${PROGRAM} ${VERSION}` : PROGRAM}: YouTube Channel Booster`, '']
  for (const m of MODULES) for (const h of m.help) lines.push(`  ${h}`)
  lines.push(
    '',
    'Add --json to any command for machine-readable output. --data <dir> and --path <channel.json> override the store and profile locations.',
    // From source, npm run starts at the repository root, so the folder the help names sits beside the checkout: a
    // workspace inside it would leave the channel's private files where `git add` finds them.
    `A workspace is one folder per channel: channel.json, data/, packages/, inbox/ and playbook/. Create one with \`${cli} init ${BUNDLED ? '<folder>' : '../<folder>'}\`.`,
    ...(BUNDLED
      ? ['Run commands inside it, or name it from anywhere with --workspace <folder> or BOOSTER_HOME=<folder>. A command that reads or writes a channel\'s files needs one.']
      : [
          'npm run starts at the repository root, so keep the workspace outside the checkout and name it with --workspace ../<folder> or BOOSTER_HOME=<folder>.',
          'Without one, a source checkout keeps its files in channel-booster/data/ and channel-booster/channel.json, as before.',
        ]),
    `\`${cli} where\` prints the folder each location resolves to and where it came from.`,
  )
  return `${lines.join('\n')}\n`
}

/** What this build is: bundled or from source, its version, and the doctrine it ships (embedded in the bundle, read from the checkout from source). */
export function buildInfo(): { bundled: boolean; version: string; doctrine: { hash: string; files: string[] } } {
  const doctrine = shippedDoctrine()
  return { bundled: BUNDLED, version: VERSION, doctrine: { hash: doctrine.hash, files: doctrine.files.map((f) => f.name) } }
}

/** True when --workspace or BOOSTER_HOME names a folder that is not a workspace. */
function badWorkspace(flags: Flags): boolean {
  try {
    activeWorkspace(flags)
    return false
  } catch {
    return true
  }
}

/**
 * Commands that never read the channel profile at startup: init creates the
 * workspace --workspace or BOOSTER_HOME may already name, and where reports a
 * workspace that is not one itself.
 */
const NO_STARTUP_PROFILE = new Set(['init', 'where'])

/**
 * Read channel.json once so its threshold overrides are live for every engine.
 * A bad profile is reported, not fatal. Having no workspace is not reported
 * here: the packaged bin has no default channel.json, and a command that needs
 * the channel's files stops and says how to create one. A --workspace or
 * BOOSTER_HOME that names no workspace is returned, to be reported once
 * whatever the command does (see main), except to init and where
 * (NO_STARTUP_PROFILE).
 */
function loadStartupProfile(flags: Flags): string | undefined {
  try {
    getProfile(flags)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof NoWorkspaceError)) warn(`${PROGRAM}: ${message}`)
    else if (badWorkspace(flags)) return message
  }
  return undefined
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [cmd, sub, ...rest] = positional
  if (!cmd || cmd === 'help' || flags.help) {
    writeOut(help())
    return 0
  }
  const badWorkspaceMessage = NO_STARTUP_PROFILE.has(cmd) ? undefined : loadStartupProfile(flags)
  const mod = MODULES.find((m) => m.verbs.includes(cmd))
  if (!mod) {
    if (badWorkspaceMessage) warn(`${PROGRAM}: ${badWorkspaceMessage}`)
    throw new Error(`unknown command "${cmd}". Run ${cliName()} help.`)
  }
  if (!badWorkspaceMessage) return mod.run(cmd, sub, rest, flags)
  // A --workspace or BOOSTER_HOME that is not a workspace is said once: a command that stops on it throws the
  // same message, which the entry prints; one that never reads the channel's files still hears it, after its output.
  let code: number
  try {
    code = await mod.run(cmd, sub, rest, flags)
  } catch (error) {
    if (!(error instanceof NoWorkspaceError && error.message === badWorkspaceMessage)) warn(`${PROGRAM}: ${badWorkspaceMessage}`)
    throw error
  }
  warn(`${PROGRAM}: ${badWorkspaceMessage}`)
  return code
}
