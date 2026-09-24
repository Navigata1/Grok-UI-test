/**
 * Commands: init, where.
 *
 * A channel workspace is one folder per channel (src/workspace.ts). `init`
 * creates it; every command run inside it, or pointed at it with --workspace
 * or BOOSTER_HOME, then keeps that channel's store, profile, packages, inbox
 * and learned rules there. `where` prints which folder each location resolves
 * to and where that came from (a flag, an environment variable, the
 * workspace, the legacy code-relative default, or the working directory),
 * plus the doctrine this build ships, and writes nothing. Neither command
 * opens a store.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { shippedDoctrine } from '../../src/ai/doctrine.js'
import { BUNDLED, VERSION, cliName } from '../../src/build-info.js'
import { defaultProfile, saveProfile } from '../../src/profile.js'
import { describeLocations, isWorkspace, WORKSPACE_LAYOUT, WORKSPACE_MARKER, type LocationReport, type ResolveOptions, type Workspace } from '../../src/workspace.js'
import { bool, nowFrom, out, str, type CommandModule, type Flags } from '../shared.js'

const USAGE_INIT = 'booster init <dir> [--channel "<name>"] [--force]'
const USAGE_WHERE = 'booster where [--json]'

/** booster-workspace.json, the file that makes a folder a channel workspace. */
export interface WorkspaceMarkerDoc {
  schemaVersion: 1
  kind: 'channel-booster-workspace'
  /** The channel's name from --channel, or null when none was given. */
  channel: string | null
  createdAt: string
}

/** The first run a new workspace is ready for: the bundled competitor export, one idea banked from it, and that idea's package. */
const FIRST_IDEA = 'I lived off a solar generator for 30 days'
const FIRST_SCORE = 'demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4'
const FIRST_PROMISE = 'thirty days on a solar generator, every failure shown'

/**
 * The three commands a person runs after `init`. The packaged bin finds the
 * workspace from inside the folder. `npm run booster` always starts at the
 * repository root, so from source every command names the workspace.
 */
export function nextCommands(root: string, bundled: boolean = BUNDLED): string[] {
  const cli = cliName(bundled)
  const where = bundled ? '' : ` --workspace ${JSON.stringify(root)}`
  return [
    `${cli} outliers example:competitors --save${where}`,
    `${cli} bank add ${JSON.stringify(FIRST_IDEA)} --score ${JSON.stringify(FIRST_SCORE)} --csv example:competitors --promise ${JSON.stringify(FIRST_PROMISE)}${where}`,
    `${cli} package build ${JSON.stringify(FIRST_IDEA)} --offline${where}`,
  ]
}

/** The marker an earlier init wrote, or undefined when it is missing or unreadable. */
function readMarker(root: string): Partial<WorkspaceMarkerDoc> | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, WORKSPACE_MARKER), 'utf8')) as unknown
    return typeof raw === 'object' && raw !== null ? (raw as Partial<WorkspaceMarkerDoc>) : undefined
  } catch {
    return undefined
  }
}

type PathStatus = 'created' | 'kept' | 'rewritten'

/**
 * Create the workspace: its folders, the default channel.json, and the marker,
 * written last so a failure part-way never leaves a marked folder without its
 * layout. An existing workspace is refused without --force; with it, what is
 * missing is created and the marker rewritten, keeping its name and date
 * unless --channel gives a new name. An existing channel.json is never
 * overwritten, so init also adopts a folder that already holds a profile.
 */
async function runInit(dir: string | undefined, rest: string[], flags: Flags): Promise<number> {
  if (!dir || rest.length > 0) throw new Error(`usage: ${USAGE_INIT} (one folder; quote a name with spaces)`)
  if (flags.channel === true) throw new Error(`--channel needs the channel's name: --channel "<name>". Usage: ${USAGE_INIT}`)
  const root = path.resolve(dir)
  if (existsSync(root) && !statSync(root).isDirectory()) throw new Error(`${root} is a file, not a folder: name a new or an existing folder. Usage: ${USAGE_INIT}`)
  const reinit = isWorkspace(root)
  if (reinit && !bool(flags, 'force')) {
    throw new Error(`${root} is already a booster workspace (it has ${WORKSPACE_MARKER}): run commands inside it, or pass --force to create whatever is missing (channel.json and the data are never overwritten)`)
  }
  const now = nowFrom(flags)
  const previous = reinit ? readMarker(root) : undefined
  const marker: WorkspaceMarkerDoc = {
    schemaVersion: 1,
    kind: 'channel-booster-workspace',
    channel: str(flags, 'channel')?.trim() || (typeof previous?.channel === 'string' ? previous.channel : null),
    createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : now.toISOString(),
  }

  const paths: Array<{ path: string; status: PathStatus }> = []
  mkdirSync(root, { recursive: true })
  for (const folder of [WORKSPACE_LAYOUT.data, WORKSPACE_LAYOUT.packages, WORKSPACE_LAYOUT.inbox, WORKSPACE_LAYOUT.playbook]) {
    const p = path.join(root, folder)
    paths.push({ path: p, status: existsSync(p) ? 'kept' : 'created' })
    mkdirSync(p, { recursive: true })
  }
  const profile = path.join(root, WORKSPACE_LAYOUT.profile)
  const newProfile = !existsSync(profile)
  if (newProfile) saveProfile(defaultProfile(), profile, { now })
  paths.push({ path: profile, status: newProfile ? 'created' : 'kept' })
  const markerFile = path.join(root, WORKSPACE_MARKER)
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`)
  paths.unshift({ path: markerFile, status: reinit ? 'rewritten' : 'created' })

  const next = nextCommands(root)
  out({ root, marker, reinitialised: reinit, paths, profile, next }, flags, () => [
    `${reinit ? 'Re-initialised the' : 'Created a'} booster workspace${marker.channel ? ` for "${marker.channel}"` : ''} at ${root}`,
    ...paths.map((p) => `  ${p.status.padEnd(9)} ${p.path}`),
    newProfile
      ? 'channel.json holds the default profile until you describe the channel (profile init --positioning ".." --force, or edit the file).'
      : 'channel.json was already there and is kept as it is.',
    '',
    BUNDLED ? `Next, from inside ${root} (or from any folder with --workspace ${JSON.stringify(root)}):` : 'Next (npm run starts at the repository root, so each command names the workspace):',
    ...next.map((c) => `  ${c}`),
  ].join('\n'))
  return 0
}

const LOCATION_LABELS: Record<keyof LocationReport['locations'], string> = {
  data: 'data',
  profile: 'profile',
  packagesRoot: 'packages root',
  inbox: 'inbox',
  playbook: 'playbook',
}

const WORKSPACE_SOURCES: Record<Workspace['source'], string> = {
  flag: 'from --workspace',
  env: 'from BOOSTER_HOME',
  discovered: 'found at or above the working directory',
}

/** What `where --json` prints: the build, the workspace, every location with its source, and the shipped doctrine. */
export interface WhereReport {
  bundled: boolean
  version: string
  workspace: Workspace | null
  workspaceError?: string
  locations: LocationReport['locations']
  doctrine: { hash: string; files: string[] }
}

/** Never throws: a location that cannot be resolved carries its error instead (the packaged bin with no workspace, a bad --workspace). */
export function whereReport(flags: Flags, options: ResolveOptions = {}): WhereReport {
  const report = describeLocations(flags, options)
  const doctrine = shippedDoctrine()
  return {
    bundled: report.bundled,
    version: VERSION,
    workspace: report.workspace ?? null,
    ...(report.workspaceError ? { workspaceError: report.workspaceError } : {}),
    locations: report.locations,
    doctrine: { hash: doctrine.hash, files: doctrine.files.map((f) => f.name) },
  }
}

export function renderWhere(r: WhereReport): string {
  const workspace = r.workspaceError
    ? `Workspace: ${r.workspaceError}`
    : r.workspace
      ? `Workspace: ${r.workspace.root} (${WORKSPACE_SOURCES[r.workspace.source]})`
      : `Workspace: none at or above ${process.cwd()}; create one with ${cliName(r.bundled)} init <folder>`
  const rows = (Object.keys(LOCATION_LABELS) as Array<keyof typeof LOCATION_LABELS>).map((key) => {
    const loc = r.locations[key]
    // A bad --workspace or BOOSTER_HOME fails every location the same way: the Workspace line already says it.
    const [from, where] = 'error' in loc ? ['-', loc.error === r.workspaceError ? 'not resolved (see Workspace above)' : loc.error] : [loc.source, loc.path]
    return `  ${LOCATION_LABELS[key].padEnd(14)} ${from.padEnd(10)} ${where}`
  })
  return [
    r.bundled ? `channel-booster ${r.version}` : `booster from a source checkout (${cliName(false)})`,
    workspace,
    '',
    `  ${'Location'.padEnd(14)} ${'From'.padEnd(10)} Path`,
    ...rows,
    '',
    `Doctrine ${r.doctrine.hash}: ${r.doctrine.files.length} file${r.doctrine.files.length === 1 ? '' : 's'} shipped with this build`,
  ].join('\n')
}

/** Exit 1 when --workspace or BOOSTER_HOME names a folder that is not a workspace: every other command would stop on it. */
async function runWhere(sub: string | undefined, flags: Flags): Promise<number> {
  if (sub !== undefined) throw new Error(`usage: ${USAGE_WHERE}`)
  const report = whereReport(flags)
  out(report, flags, () => renderWhere(report))
  return report.workspaceError ? 1 : 0
}

export const workspaceModule: CommandModule = {
  verbs: ['init', 'where'],
  help: [
    'init <dir> [--channel "<name>"] [--force]                          a channel workspace: booster-workspace.json, data/, packages/, inbox/, playbook/, channel.json; run commands inside it or pass --workspace <dir>',
    'where [--json]                                                     every folder commands read and write, where each came from (flag, env, workspace, legacy, cwd), and the doctrine this build ships',
  ],
  async run(cmd, sub, rest, flags) {
    return cmd === 'init' ? runInit(sub, rest, flags) : runWhere(sub, flags)
  },
}
