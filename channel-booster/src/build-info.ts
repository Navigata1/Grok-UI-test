/**
 * What kind of build is running. The packaged bin is an esbuild bundle that
 * defines the constants below (scripts/build.ts); running from source with
 * tsx leaves them undefined.
 *
 * The difference matters for paths: a source checkout may fall back to the
 * code-relative locations it has always used (channel-booster/data,
 * channel-booster/channel.json), while a bundle sits inside node_modules and
 * must never write there, so it needs a workspace (src/workspace.ts).
 */

declare const __BOOSTER_BUNDLED__: boolean | undefined
declare const __BOOSTER_VERSION__: string | undefined

/** True inside the packaged bundle. */
export const BUNDLED: boolean = typeof __BOOSTER_BUNDLED__ !== 'undefined' && __BOOSTER_BUNDLED__ === true

/** The package version inside the bundle, 'source' otherwise. */
export const VERSION: string = typeof __BOOSTER_VERSION__ === 'string' ? __BOOSTER_VERSION__ : 'source'

/** How a person types the CLI in this build: the bin name when packaged, the repo script from source. */
export function cliName(bundled: boolean = BUNDLED): string {
  return bundled ? 'channel-booster' : 'npm run booster --'
}
