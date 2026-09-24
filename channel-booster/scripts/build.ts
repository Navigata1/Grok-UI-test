/**
 * Build the packaged bin's bundle: cli/main.ts and everything it imports as
 * one ESM file, dist/channel-booster.mjs, which bin/channel-booster.mjs
 * imports. zod and the Anthropic SDK stay external (they are the package's
 * dependencies); everything else is inlined.
 *
 * The bundle is told what it is through esbuild defines (src/build-info.ts):
 * __BOOSTER_BUNDLED__ makes every location need a workspace instead of a
 * code-relative default, __BOOSTER_VERSION__ is this package's version, and
 * __BOOSTER_DOCTRINE__ embeds the shipped doctrine (src/ai/doctrine.ts), so
 * an installed bin never reads docs/ or playbook/ from disk.
 *
 * Run with `npm run build` (which then rebuilds the Desk) or
 * `npx tsx channel-booster/scripts/build.ts`.
 */
import { build } from 'esbuild'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readShippedDoctrine } from '../src/ai/doctrine.js'

/** channel-booster/: the package this script builds. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where the bin looks for the bundle. */
export const BUNDLE_FILE = path.join('dist', 'channel-booster.mjs')

/** Packages the bundle imports at run time instead of inlining; the package declares both as dependencies. */
export const EXTERNAL = ['zod', '@anthropic-ai/sdk']

export interface BuildOptions {
  /** The package to build; defaults to PACKAGE_ROOT. */
  root?: string
  /** Where to write the bundle; defaults to <root>/dist/channel-booster.mjs. */
  outfile?: string
}

export interface BuildResult {
  outfile: string
  bytes: number
  version: string
  doctrine: { hash: string; files: number }
}

/** Bundle cli/main.ts with the build's defines and return what was written. */
export async function buildBundle(options: BuildOptions = {}): Promise<BuildResult> {
  const root = path.resolve(options.root ?? PACKAGE_ROOT)
  const outfile = path.resolve(options.outfile ?? path.join(root, BUNDLE_FILE))
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error(`${path.join(root, 'package.json')} has no version: the bundle prints it, so set one`)
  const doctrine = readShippedDoctrine(root)
  if (doctrine.files.length === 0) throw new Error(`no doctrine under ${root}: the bundle must embed docs/02-strategist-playbook.md and playbook/*.md`)
  await build({
    entryPoints: [path.join(root, 'cli', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL,
    define: {
      __BOOSTER_BUNDLED__: 'true',
      __BOOSTER_VERSION__: JSON.stringify(pkg.version),
      __BOOSTER_DOCTRINE__: JSON.stringify(doctrine),
    },
    logLevel: 'warning',
  })
  return { outfile, bytes: statSync(outfile).size, version: pkg.version, doctrine: { hash: doctrine.hash, files: doctrine.files.length } }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const r = await buildBundle()
  process.stdout.write(`${path.relative(process.cwd(), r.outfile) || r.outfile} written (${(r.bytes / 1024).toFixed(0)} KB, version ${r.version}); doctrine ${r.doctrine.hash} embedded, ${r.doctrine.files} files\n`)
}
