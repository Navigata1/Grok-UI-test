#!/usr/bin/env node
// channel-booster: the packaged YouTube Channel Booster command line.
// It runs main() from the bundle scripts/build.ts writes to dist/, always with
// this process's arguments, and exits with its code. Plain JavaScript that
// imports the bundle only after checking the Node version, so an old Node
// gets a sentence instead of a syntax error.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REQUIRED_MAJOR = 22
const major = Number(process.versions.node.split('.')[0])
const bundle = new URL('../dist/channel-booster.mjs', import.meta.url)

// Let piped output drain before exiting: writes to a pipe are asynchronous on some platforms.
function exit(code) {
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function fail(error) {
  process.stderr.write(`channel-booster: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}

if (!(major >= REQUIRED_MAJOR)) {
  fail(`needs Node.js ${REQUIRED_MAJOR} or newer, and this is Node.js ${process.versions.node}. Install Node.js ${REQUIRED_MAJOR} or later from https://nodejs.org and run it again.`)
} else if (!existsSync(fileURLToPath(bundle))) {
  fail(`${fileURLToPath(bundle)} is missing: this copy was never built. Run \`npm run build\` in the channel-booster folder, or install the packaged release.`)
} else {
  import(bundle.href).then((m) => m.main(process.argv.slice(2))).then(exit, fail)
}
