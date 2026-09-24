/**
 * The packaged bin and the playbook folder it ships. These tests load main()
 * from a fresh module graph built the way the bundle is (__BOOSTER_BUNDLED__
 * set, the code root inside an installed package), so they live in their own
 * file: resetting the module registry would leak into other tests' imports.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { captureIo as CaptureIo } from '../io.js'
import { addRow, recordRead } from '../ledger.js'
import { openStore } from '../store.js'
import { doctrineHash, type ShippedDoctrine } from './doctrine.js'

const NOW = '2026-09-14T12:00:00Z'

let tmp: string
let pkgPlaybook: string
let data: string
let profile: string
let channel: string
let link: string

/** A stand-in for the doctrine the bundle embeds. */
function embedded(): ShippedDoctrine {
  const files = [
    { name: 'docs/02-strategist-playbook.md', text: '# Doctrine' },
    { name: 'playbook/README.md', text: '# Index' },
    { name: 'playbook/title-formulas.md', text: '# Title formulas' },
  ]
  return { files, hash: doctrineHash(files), packageFixTemplate: '{{fixes}}\n{{previous}}' }
}

beforeEach(() => {
  vi.stubEnv('BOOSTER_DATA', '')
  vi.stubEnv('BOOSTER_PROFILE', '')
  vi.stubEnv('BOOSTER_HOME', '')
  tmp = mkdtempSync(path.join(tmpdir(), 'booster-packaged-'))
  pkgPlaybook = path.join(tmp, 'node_modules', 'channel-booster', 'playbook')
  mkdirSync(pkgPlaybook, { recursive: true })
  writeFileSync(path.join(pkgPlaybook, 'title-formulas.md'), '# Title formulas\n')
  // What a person types under npm link or pnpm: a path whose real path is the package's folder.
  link = path.join(tmp, 'pkgpb-link')
  symlinkSync(pkgPlaybook, link, 'dir')
  data = path.join(tmp, 'data')
  profile = path.join(tmp, 'channel.json')
  channel = path.join(tmp, 'my-channel', 'playbook')
  writeFileSync(profile, JSON.stringify({ positioning: 'Van builds for first-timers' }))
  const store = openStore(data)
  for (let i = 0; i < 3; i += 1) {
    const slug = `old-${i}`
    addRow(store, { slug, title: `Old video ${i}`, publishedAt: new Date(Date.parse(NOW) - (30 + i * 7) * 86_400_000).toISOString(), hypothesis: { levers: ['number-in-title'], predictedCtrMultiple: 1 }, now: new Date(NOW) })
    recordRead(store, { slug, bucket: '168', read: { impressions: 60000, ctr: 5, avpPct: 40, views: 5000, returningPct: 40 }, lever: 'numbers', now: new Date(NOW) })
  }
})

afterEach(() => {
  vi.doUnmock('../workspace.js')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(tmp, { recursive: true, force: true })
})

/** main() and captureIo from a fresh module graph built as the bundle is. */
async function bundledCli(): Promise<{ main: (argv: string[]) => Promise<number>; captureIo: typeof CaptureIo }> {
  vi.resetModules()
  vi.stubGlobal('__BOOSTER_BUNDLED__', true)
  vi.stubGlobal('__BOOSTER_DOCTRINE__', embedded())
  const codeRoot = path.dirname(pkgPlaybook)
  vi.doMock('../workspace.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../workspace.js')>()), CODE_ROOT: codeRoot }))
  const cli = await import('../../cli/main.js')
  const io = await import('../io.js')
  return { main: cli.main, captureIo: io.captureIo }
}

function flagsFor(playbook: string): string[] {
  return ['--data', data, '--path', profile, '--now', NOW, '--playbook', playbook, '--inbox', path.join(tmp, 'inbox'), '--root', tmp]
}

const REFUSED = /^refusing to write into the installed package's playbook \(.+\): keep this channel's rules in a channel workspace \(channel-booster init <folder>\) or pass --playbook with a folder outside the installed package$/

describe('the packaged bin', () => {
  it('never compiles or accepts rules into its own package, however --playbook reaches it, and leaves the store alone', async () => {
    const bundled = await bundledCli()
    for (const folder of [pkgPlaybook, link]) {
      const compiled = await bundled.captureIo(() => bundled.main(['rules', 'compile', ...flagsFor(folder)]))
      expect(compiled.threw).toBe(true)
      expect((compiled.error as Error).message).toMatch(REFUSED)
      const accepted = await bundled.captureIo(() => bundled.main(['retro', '--accept-rule', 'Numbers win', '--into', 'title-formulas.md', '--yes', ...flagsFor(folder)]))
      expect(accepted.threw).toBe(true)
      expect((accepted.error as Error).message).toMatch(REFUSED)
    }
    expect(readdirSync(pkgPlaybook)).toEqual(['title-formulas.md'])
    expect(readFileSync(path.join(pkgPlaybook, 'title-formulas.md'), 'utf8')).toBe('# Title formulas\n')
    // The refusal comes before the compile, so the store holds no half-done compile.
    expect(openStore(data).read('rules')).toEqual([])

    // Any folder outside the package is a channel's, and the bin writes it.
    const own = await bundled.captureIo(() => bundled.main(['rules', 'compile', ...flagsFor(channel)]))
    expect(own.threw).toBe(false)
    expect(own.stdout).toContain(`Wrote ${path.join(channel, '00-learned-rules.md')}`)
    expect(openStore(data).read('rules').map((r) => r.lever)).toEqual(['number-in-title'])
  })

  it('loads the package\'s playbook folder once when --playbook reaches it through a symlink', async () => {
    const bundled = await bundledCli()
    for (const folder of [pkgPlaybook, link]) {
      const r = await bundled.captureIo(() => bundled.main(['ai', 'title-lab', '--idea', 'Van build', '--dry-run', '--json', ...flagsFor(folder)]))
      expect(r.threw).toBe(false)
      const dry = JSON.parse(r.stdout)
      expect(dry.playbookFiles).toEqual(['docs/02-strategist-playbook.md', 'playbook/README.md', 'playbook/title-formulas.md'])
      expect(dry.overlay).toEqual([])
    }
  })
})
