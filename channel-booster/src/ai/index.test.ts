import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../cli/main.js'
import { captureIo } from '../io.js'
import { SHIPPED_PLAYBOOK_DIR } from '../rules.js'
import { WORKSPACE_MARKER } from '../workspace.js'
import { doctrineHash, shippedDoctrine, type ShippedDoctrine } from './doctrine.js'
import * as ai from './index.js'
import { NO_DOCTRINE_NOTE } from './prompt.js'

/** What the stand-in SDK saw: how often each module was loaded, and every request sent. */
const sdk = vi.hoisted(() => ({ core: 0, helpers: 0, requests: [] as Array<Record<string, any>>, output: undefined as unknown, error: undefined as Error | undefined }))

vi.mock('@anthropic-ai/sdk', () => {
  sdk.core += 1
  class Anthropic {
    messages = {
      parse: async (request: Record<string, any>) => {
        sdk.requests.push(request)
        if (sdk.error) throw sdk.error
        return { stop_reason: 'end_turn', parsed_output: sdk.output }
      },
    }
  }
  return { default: Anthropic }
})

vi.mock('@anthropic-ai/sdk/helpers/zod', () => {
  sdk.helpers += 1
  return { zodOutputFormat: (schema: unknown) => ({ type: 'json_schema', schema }) }
})

const TITLES = {
  titles: Array.from({ length: 12 }, (_, i) => ({ title: `I Built a Van Kitchen for $${300 + i}`, lever: 'specificity', why: 'a number and a named thing' })),
  top_three: ['a', 'b', 'c'],
  thumbnail_pairing_note: 'show the finished kitchen, not the price',
}

/** The doctrine a bundle would embed, standing in for the build (src/ai/doctrine.ts reads __BOOSTER_DOCTRINE__ first). */
function embedded(files: Record<string, string>, packageFixTemplate = 'EMBEDDED FIX\n{{fixes}}\n{{previous}}'): ShippedDoctrine {
  const list = Object.entries(files).map(([name, text]) => ({ name, text }))
  return { files: list, hash: doctrineHash(list), packageFixTemplate }
}

let tmp: string
let overlay: string
let profile: string

beforeEach(() => {
  vi.stubEnv('BOOSTER_DATA', '')
  vi.stubEnv('BOOSTER_PROFILE', '')
  vi.stubEnv('BOOSTER_HOME', '')
  tmp =mkdtempSync(path.join(tmpdir(), 'booster-ai-'))
  overlay = path.join(tmp, 'playbook')
  profile = path.join(tmp, 'channel.json')
  mkdirSync(overlay)
  writeFileSync(path.join(overlay, '00-learned-rules.md'), '# Learned rules (compiled): hypotheses under observation\n\n- none yet')
  writeFileSync(profile, JSON.stringify({ positioning: 'Van builds for first-timers' }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(tmp, { recursive: true, force: true })
})

async function run(engine: string, flags: ai.Flags): Promise<string> {
  const r = await captureIo(() => ai.runAiCommand(engine, [], { playbook: overlay, path: profile, ...flags }))
  if (r.threw) throw r.error
  expect(r.value).toBe(0)
  return r.stdout
}

describe('the Anthropic SDK', () => {
  // These two run first and in order: the counts are per test file.
  it('is not loaded by importing the engines module, a dry run, or help', async () => {
    expect(sdk.core).toBe(0)
    expect(sdk.helpers).toBe(0)
    await run('title-lab', { idea: 'Van build', 'dry-run': true })
    await run('help', {})
    expect(sdk.core).toBe(0)
    expect(sdk.helpers).toBe(0)
  })

  it('is loaded when an engine runs, which sends the doctrine cached and prints the doctrine hash with the model and effort', async () => {
    sdk.output = TITLES
    const shipped = shippedDoctrine()
    const text = await run('title-lab', { idea: 'Van build', model: 'claude-test', effort: 'low' })
    expect(sdk.core).toBe(1)
    expect(sdk.helpers).toBe(1)
    const request = sdk.requests.at(-1) as Record<string, any>
    expect(request.model).toBe('claude-test')
    expect(request.output_config.effort).toBe('low')
    expect(request.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(request.system[1].text.indexOf('<!-- docs/02-strategist-playbook.md -->')).toBe(0)
    expect(request.system[1].text).toContain('<!-- channel playbook/00-learned-rules.md -->')
    expect(request.messages[0].content).toContain('Channel: Positioning: Van builds for first-timers.')
    expect(text).toContain(`Provenance: model claude-test · effort low · doctrine ${shipped.hash} (${shipped.files.length} files) · overlay ${overlay}: playbook/00-learned-rules.md`)

    const outFile = path.join(tmp, 'titles.json')
    const json = JSON.parse(await run('title-lab', { idea: 'Van build', json: true, out: outFile }))
    const provenance = { model: ai.modelFrom({}), effort: 'high', doctrine: { hash: shipped.hash, files: shipped.files.map((f) => f.name) }, overlay: ['playbook/00-learned-rules.md'], overlayDir: overlay }
    expect(json.provenance).toEqual(provenance)
    expect(json.titles).toHaveLength(12)
    expect(JSON.parse(readFileSync(outFile, 'utf8')).provenance).toEqual(provenance)
  })

  it('says which variable to set when there is no API key, and passes any other failure through', async () => {
    // The SDK's own words when it finds no key, token or profile.
    sdk.error = new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted')
    try {
      await expect(run('title-lab', { idea: 'Van build' })).rejects.toThrow(/^npm run booster -- ai title-lab needs ANTHROPIC_API_KEY \(or an `ant auth login` profile\) to call the model; --dry-run shows the prompt without one$/)
      sdk.error = new Error('529 overloaded')
      await expect(run('title-lab', { idea: 'Van build' })).rejects.toThrow(/^529 overloaded$/)
    } finally {
      sdk.error = undefined
    }
  })

  it('names the install when it is missing, and passes any other failure through', async () => {
    const missing = Object.assign(new Error("Cannot find package '@anthropic-ai/sdk' imported from /x/dist/channel-booster.mjs"), { code: 'ERR_MODULE_NOT_FOUND' })
    await expect(ai.loadSdk(() => Promise.reject(missing))).rejects.toThrow(/npm run booster -- ai needs the Anthropic SDK, and @anthropic-ai\/sdk is not installed \(Cannot find package '@anthropic-ai\/sdk'.*\)\. Install it next to channel-booster with: npm install @anthropic-ai\/sdk/)
    const cjs = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })
    await expect(ai.loadSdk(() => Promise.reject(cjs))).rejects.toThrow(/npm install @anthropic-ai\/sdk/)
    await expect(ai.loadSdk(() => Promise.reject(new Error('disk on fire')))).rejects.toThrow(/^disk on fire$/)
  })
})

describe('ai <engine> --dry-run', () => {
  it('--json prints one object with the doctrine it loaded and the channel playbook files after it', async () => {
    writeFileSync(path.join(overlay, 'title-formulas.md'), '# Accepted rules for this channel, extending the shipped playbook/title-formulas.md')
    const shipped = shippedDoctrine()
    const out = await run('title-lab', { idea: 'Van build', 'dry-run': true, json: true })
    const dry = JSON.parse(out)
    expect(Object.keys(dry)).toEqual(['engine', 'model', 'effort', 'doctrine', 'overlay', 'overlayDir', 'playbookFiles', 'system', 'user'])
    expect(dry.engine).toBe('title-lab')
    expect(dry.doctrine).toEqual({ hash: shipped.hash, files: shipped.files.map((f) => f.name) })
    expect(dry.doctrine.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(dry.overlay).toEqual(['playbook/00-learned-rules.md', 'playbook/title-formulas.md'])
    expect(dry.overlayDir).toBe(overlay)
    expect(dry.system).toHaveLength(2)
    expect(dry.user).toContain('Idea: Van build')
  })

  it('--json reports the effort a real run would send, and refuses one the API does not accept', async () => {
    expect(JSON.parse(await run('title-lab', { idea: 'Van build', 'dry-run': true, json: true, effort: 'low' })).effort).toBe('low')
    await expect(run('title-lab', { idea: 'Van build', 'dry-run': true, json: true, effort: 'bogus' })).rejects.toThrow('--effort must be one of low, medium, high, xhigh, max; got "bogus"')
  })

  it('--playbook through a symlink to the shipped folder loads the shipped playbook once, as the folder itself does', async () => {
    const link = path.join(tmp, 'pb-link')
    symlinkSync(SHIPPED_PLAYBOOK_DIR, link, 'dir')
    const direct = JSON.parse(await run('title-lab', { idea: 'Van build', 'dry-run': true, json: true, playbook: SHIPPED_PLAYBOOK_DIR }))
    const viaLink = JSON.parse(await run('title-lab', { idea: 'Van build', 'dry-run': true, json: true, playbook: link }))
    expect(viaLink.playbookFiles).toEqual(direct.playbookFiles)
    expect(viaLink.playbookFiles.filter((f: string) => f.startsWith('channel playbook/'))).toEqual([])
    expect(viaLink.overlay).toEqual(direct.overlay)
    expect(viaLink.system).toEqual(direct.system)
  })

  it('prints the doctrine hash, its file count and the overlay files in the text view', async () => {
    const shipped = shippedDoctrine()
    const text = await run('title-lab', { idea: 'Van build', 'dry-run': true })
    expect(text).toContain(`\ndoctrine ${shipped.hash} (${shipped.files.length} files)\noverlay ${overlay}: playbook/00-learned-rules.md\n`)
  })

  it('--no-doctrine runs without the shipped doctrine and the prompt says so; a build without doctrine refuses without the flag', async () => {
    const text = await run('title-lab', { idea: 'Van build', 'dry-run': true, 'no-doctrine': true })
    expect(text).toContain('\ndoctrine none (--no-doctrine)\n')
    expect(text).toContain(`<!-- no doctrine -->\n${NO_DOCTRINE_NOTE}`)
    expect(text).not.toContain('<!-- docs/02-strategist-playbook.md -->')
    vi.stubGlobal('__BOOSTER_DOCTRINE__', embedded({}))
    expect(() => ai.preparePrompt('title-lab', { idea: 'x', playbook: overlay })).toThrow(/This build ships no doctrine.*pass --no-doctrine/)
    const dry = JSON.parse(await run('title-lab', { idea: 'Van build', 'dry-run': true, json: true, 'no-doctrine': true }))
    expect(dry.doctrine).toEqual({ hash: 'none', files: [] })
    expect(dry.overlay).toEqual(['playbook/00-learned-rules.md'])
  })
})

describe('preparePrompt', () => {
  it('takes the doctrine and the fix template from the build, never from files beside the code', async () => {
    vi.stubGlobal('__BOOSTER_DOCTRINE__', embedded({ 'docs/02-strategist-playbook.md': 'EMBEDDED R1', 'playbook/title-formulas.md': 'EMBEDDED titles' }))
    const assembled = ai.preparePrompt('title-lab', { idea: 'x', playbook: overlay })
    expect(assembled.playbookFiles).toEqual(['docs/02-strategist-playbook.md', 'channel playbook/00-learned-rules.md', 'playbook/title-formulas.md'])
    expect(assembled.system[1].text).toContain('EMBEDDED R1')
    expect(assembled.system[1].text).not.toContain('Channel Booster runs on')
    sdk.output = { concepts: [], ab_pick: { a: 'A', b: 'B', reason: 'two levers' } }
    await ai.runEngine('package-fix', { idea: 'x', title: 'y', playbook: overlay }, { fixes: ['cut the text'], previous: 'round 1' })
    const request = sdk.requests.at(-1) as Record<string, any>
    expect(request.messages[0].content).toContain('EMBEDDED FIX\n- cut the text\nround 1')
  })

  it('reads channel.json and the playbook folder from the workspace', () => {
    const ws = path.join(tmp, 'channel')
    mkdirSync(path.join(ws, 'playbook'), { recursive: true })
    writeFileSync(path.join(ws, WORKSPACE_MARKER), '{"schemaVersion":1,"kind":"channel-booster-workspace"}')
    writeFileSync(path.join(ws, 'channel.json'), JSON.stringify({ positioning: 'Solar for renters' }))
    writeFileSync(path.join(ws, 'playbook', 'zz-accepted.md'), '# Accepted\n\n## Learned rules\n\n- 2026-09-14: Face left')
    const assembled = ai.preparePrompt('title-lab', { idea: 'x', workspace: ws })
    expect(assembled.user).toContain('Channel: Positioning: Solar for renters.')
    expect(assembled.overlayDir).toBe(path.join(ws, 'playbook'))
    expect(assembled.overlay).toEqual(['playbook/zz-accepted.md'])
    expect(assembled.playbookFiles.at(-1)).toBe('channel playbook/zz-accepted.md')
    expect(ai.profileContext({ workspace: ws }).profileText).toContain('Solar for renters')
  })

  it('has no channel playbook folder in the packaged bin outside a workspace, but a bad --workspace is still an error', () => {
    const outside = { bundled: true, cwd: tmp, env: {} }
    expect(ai.overlayDir({}, outside)).toBeUndefined()
    expect(ai.profileContext({}, outside)).toEqual({})
    expect(ai.overlayDir({ playbook: 'rules' }, outside)).toBe(path.join(tmp, 'rules'))
    expect(() => ai.overlayDir({ workspace: 'nope' }, outside)).toThrow(/is not a booster workspace/)
    expect(ai.overlayDir({}, { cwd: tmp, env: {}, bundled: false, codeRoot: '/code' })).toBe(path.join('/code', 'playbook'))
  })
})

describe('booster ai --csv example:<name>', () => {
  it('reads the bundled example export from any folder, and names the examples when the name is wrong', async () => {
    const r = await captureIo(() => main(['ai', 'idea-engine', '--niche', 'vans', '--csv', 'example:competitors', '--dry-run', '--json', '--playbook', overlay, '--path', profile]))
    expect(r.threw).toBe(false)
    const dry = JSON.parse(r.stdout)
    expect(dry.user).toMatch(/Outlier scan of \d+ videos/)
    expect(dry.user).not.toContain('No competitor CSV supplied')
    const wrong = await captureIo(() => main(['ai', 'channel-audit', '--csv', 'example:nope', '--dry-run', '--playbook', overlay, '--path', profile]))
    expect(wrong.threw).toBe(true)
    expect((wrong.error as Error).message).toBe('unknown example "example:nope": the bundled examples are example:competitors, example:my-channel, example:studio-content')
  })
})
