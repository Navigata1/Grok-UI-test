/**
 * `npm run booster` runs with the repo root as its cwd, and the commands that
 * write per-video or per-channel files default their root to the cwd. So the
 * repo-root .gitignore has to cover what they write there, or one `git add -A`
 * commits unreleased titles, competitor statistics and Studio numbers. These
 * tests run the writers against a scratch git repo that carries this repo's
 * .gitignore and ask git what it would add.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/booster.js'
import { packageDir } from '../src/runner.js'
import { slugify } from '../src/workflow.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const competitors = path.resolve(here, '..', 'examples', 'competitors.csv')
const NOW = '2026-07-10T00:00:00Z'
const IDEA = 'I lived off a solar generator for 30 days'
const SLUG = slugify(IDEA)

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const hasGit = git(repo, ['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true'

let root: string
let store: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'booster-private-root-'))
  store = mkdtempSync(path.join(os.tmpdir(), 'booster-private-store-'))
  if (hasGit) {
    git(root, ['init', '-q'])
    copyFileSync(path.join(repo, '.gitignore'), path.join(root, '.gitignore'))
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<number> {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    return await main(argv)
  } finally {
    vi.restoreAllMocks()
  }
}

/** Canned YouTube Data API bodies for the three calls `fetch channel` makes. */
function youtubeStub(url: string): unknown {
  if (url.includes('/channels')) return { items: [{ id: 'UCstub', snippet: { title: 'Stub' }, contentDetails: { relatedPlaylists: { uploads: 'UUstub' } } }] }
  if (url.includes('/playlistItems')) return { items: [{ contentDetails: { videoId: 'aB3dEfGh1jK' } }] }
  return { items: [{ id: 'aB3dEfGh1jK', snippet: { title: 'Stub video', publishedAt: '2026-07-01T00:00:00Z', channelTitle: 'Stub' }, statistics: { viewCount: '1000' }, contentDetails: { duration: 'PT10M' } }] }
}

describe.skipIf(!hasGit)('private working data written from the repo root stays out of git', () => {
  it('ignores every file the documented writers put under the cwd, the learned rules included', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('YOUTUBE_API_KEY', 'stub-key')
    vi.stubGlobal('fetch', async (url: string | URL) => ({ ok: true, status: 200, text: async () => JSON.stringify(youtubeStub(String(url))) }))
    const own = ['--data', store, '--path', path.join(store, 'channel.json'), '--now', NOW]

    // AGENTS.md "The loop": the runbook, then the stage artifacts under packages/<slug>/.
    expect(await run(['workflow', IDEA, '--format', 'challenge', '--days', '14', '--out', path.join(root, 'packages'), ...own])).toBe(0)
    expect(await run(['package', 'build', IDEA, '--promise', 'A solar generator runs a van for 30 days', '--title', 'Thirty Days on a Solar Generator, Every Failure', '--offline', '--root', root, ...own])).toBe(0)
    expect(await run(['idea', 'score', IDEA, '--score', '3,3,3,3,3,3', '--out', path.join(packageDir(root, SLUG), 'demand.json'), ...own])).toBe(0)
    // fetch channel: other channels' statistics land in <cwd>/inbox/.
    expect(await run(['fetch', 'channel', '@stubchannel', '--root', root, ...own])).toBe(0)
    // The store and the profile, moved to the root with --data data and --path channel.json.
    expect(await run(['outliers', competitors, '--save', '--data', path.join(root, 'data'), '--now', NOW])).toBe(0)
    expect(await run(['profile', 'init', '--positioning', 'Budget solar builds', '--solo', '--path', path.join(root, 'channel.json'), '--data', store, '--now', NOW])).toBe(0)
    // rules compile writes the channel's compiled rules into channel-booster/playbook/.
    expect(await run(['rules', 'compile', '--playbook', path.join(root, 'channel-booster', 'playbook'), ...own])).toBe(0)

    const written = [
      `packages/${SLUG}.json`,
      `packages/${SLUG}.md`,
      `packages/${SLUG}/package.json`,
      `packages/${SLUG}/demand.json`,
      'inbox/stubchannel.csv',
      'data/last-scan.json',
      'channel.json',
      'channel-booster/playbook/00-learned-rules.md',
    ]
    for (const rel of written) expect(existsSync(path.join(root, rel)), `${rel} was not written`).toBe(true)

    // Only the .gitignore itself is left for git to add.
    const status = git(root, ['status', '--porcelain', '--untracked-files=all'])
    expect(status.status).toBe(0)
    expect(status.stdout.trim().split('\n')).toEqual(['?? .gitignore'])
    // The shell redirect the bank import usage suggests (ai idea-engine --json > ideas.json).
    expect(git(root, ['check-ignore', '-q', '--no-index', 'ideas.json']).status).toBe(0)
  })

  it('hides no tracked file of this repo', () => {
    const hidden = git(repo, ['ls-files', '--cached', '--ignored', '--exclude-standard'])
    expect(hidden.status).toBe(0)
    expect(hidden.stdout.trim()).toBe('')
  })
})
