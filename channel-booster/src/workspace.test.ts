import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CODE_ROOT,
  describeLocations,
  discoverWorkspace,
  findWorkspace,
  NoWorkspaceError,
  resolveDataDir,
  resolveInboxDir,
  resolvePackagesRoot,
  resolvePlaybookDir,
  resolveProfileFile,
  WORKSPACE_MARKER,
} from './workspace.js'

/** Every temp folder this file made, removed once its tests are done. */
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'booster-ws-'))
  made.push(dir)
  return dir
}

function makeWorkspace(root: string): string {
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, WORKSPACE_MARKER), '{"schemaVersion":1}\n')
  return root
}

describe('legacy resolution (no workspace), unchanged from before workspaces', () => {
  const cwd = tmp()
  const opts = { env: {}, cwd, bundled: false }

  it('keeps the code-relative defaults a source checkout has always used', () => {
    expect(resolveDataDir({}, opts)).toEqual({ path: path.join(CODE_ROOT, 'data'), source: 'legacy' })
    expect(resolveProfileFile({}, opts)).toEqual({ path: path.join(CODE_ROOT, 'channel.json'), source: 'legacy' })
    expect(resolveInboxDir({}, opts)).toEqual({ path: path.join(CODE_ROOT, 'inbox'), source: 'legacy' })
    expect(resolvePlaybookDir({}, opts)).toEqual({ path: path.join(CODE_ROOT, 'playbook'), source: 'legacy' })
  })

  it('resolves packages/ under the working directory, as --root always defaulted', () => {
    expect(resolvePackagesRoot({}, opts)).toEqual({ path: cwd, source: 'cwd' })
  })

  it('honours every old flag and environment variable', () => {
    const env = { BOOSTER_DATA: 'env-data', BOOSTER_PROFILE: 'env.json' }
    expect(resolveDataDir({}, { ...opts, env }).path).toBe(path.join(cwd, 'env-data'))
    expect(resolveProfileFile({}, { ...opts, env }).path).toBe(path.join(cwd, 'env.json'))
    const flags = { data: 'd', path: 'p.json', root: 'r', inbox: 'i', playbook: 'pb' }
    expect(resolveDataDir(flags, { ...opts, env }).path).toBe(path.join(cwd, 'd'))
    expect(resolveProfileFile(flags, { ...opts, env }).path).toBe(path.join(cwd, 'p.json'))
    expect(resolvePackagesRoot(flags, opts).path).toBe(path.join(cwd, 'r'))
    expect(resolveInboxDir(flags, opts).path).toBe(path.join(cwd, 'i'))
    expect(resolvePlaybookDir(flags, opts).path).toBe(path.join(cwd, 'pb'))
  })

  it('treats a blank environment variable as unset', () => {
    expect(resolveDataDir({}, { ...opts, env: { BOOSTER_DATA: '  ' } }).source).toBe('legacy')
  })
})

describe('workspace resolution', () => {
  it('puts every location inside the workspace given by --workspace', () => {
    const ws = makeWorkspace(path.join(tmp(), 'my-channel'))
    const opts = { env: {}, cwd: tmp(), bundled: true }
    const flags = { workspace: ws }
    expect(resolveDataDir(flags, opts)).toEqual({ path: path.join(ws, 'data'), source: 'workspace' })
    expect(resolveProfileFile(flags, opts)).toEqual({ path: path.join(ws, 'channel.json'), source: 'workspace' })
    expect(resolvePackagesRoot(flags, opts)).toEqual({ path: ws, source: 'workspace' })
    expect(resolveInboxDir(flags, opts)).toEqual({ path: path.join(ws, 'inbox'), source: 'workspace' })
    expect(resolvePlaybookDir(flags, opts)).toEqual({ path: path.join(ws, 'playbook'), source: 'workspace' })
  })

  it('finds the workspace from BOOSTER_HOME, then from the marker at or above the working directory', () => {
    const ws = makeWorkspace(path.join(tmp(), 'channel'))
    expect(findWorkspace({}, { env: { BOOSTER_HOME: ws }, cwd: tmp() })).toEqual({ root: ws, source: 'env' })
    const deep = path.join(ws, 'packages', 'some-slug')
    mkdirSync(deep, { recursive: true })
    expect(discoverWorkspace(deep)).toBe(ws)
    expect(findWorkspace({}, { env: {}, cwd: deep })).toEqual({ root: ws, source: 'discovered' })
  })

  it('prefers --workspace over BOOSTER_HOME over discovery', () => {
    const a = makeWorkspace(path.join(tmp(), 'a'))
    const b = makeWorkspace(path.join(tmp(), 'b'))
    const c = makeWorkspace(path.join(tmp(), 'c'))
    expect(findWorkspace({ workspace: a }, { env: { BOOSTER_HOME: b }, cwd: c })?.root).toBe(a)
    expect(findWorkspace({}, { env: { BOOSTER_HOME: b }, cwd: c })?.root).toBe(b)
  })

  it('lets an explicit location override the workspace, so old flags still win', () => {
    const ws = makeWorkspace(path.join(tmp(), 'ws'))
    const cwd = tmp()
    const opts = { env: { BOOSTER_DATA: 'elsewhere' }, cwd, bundled: true }
    expect(resolveDataDir({ workspace: ws }, opts)).toEqual({ path: path.join(cwd, 'elsewhere'), source: 'env' })
    expect(resolveDataDir({ workspace: ws, data: 'mine' }, opts)).toEqual({ path: path.join(cwd, 'mine'), source: 'flag' })
  })

  it('refuses a --workspace or BOOSTER_HOME folder that was never initialised', () => {
    const plain = tmp()
    expect(() => findWorkspace({ workspace: plain }, { env: {}, cwd: tmp() })).toThrow(NoWorkspaceError)
    expect(() => findWorkspace({ workspace: plain }, { env: {}, cwd: tmp() })).toThrow(/init/)
    expect(() => findWorkspace({}, { env: { BOOSTER_HOME: plain }, cwd: tmp() })).toThrow(/BOOSTER_HOME/)
  })
})

describe('the packaged bin', () => {
  it('has no legacy default: without a workspace it stops and names init', () => {
    const opts = { env: {}, cwd: tmp(), bundled: true }
    expect(() => resolveDataDir({}, opts)).toThrow(NoWorkspaceError)
    expect(() => resolveDataDir({}, opts)).toThrow(/channel-booster init/)
    expect(() => resolveProfileFile({}, opts)).toThrow(NoWorkspaceError)
    expect(() => resolveInboxDir({}, opts)).toThrow(NoWorkspaceError)
    expect(() => resolvePlaybookDir({}, opts)).toThrow(NoWorkspaceError)
  })

  it('still takes explicit locations, and packages/ under the working directory', () => {
    const cwd = tmp()
    const opts = { env: {}, cwd, bundled: true }
    expect(resolveDataDir({ data: 'd' }, opts).path).toBe(path.join(cwd, 'd'))
    expect(resolvePackagesRoot({}, opts)).toEqual({ path: cwd, source: 'cwd' })
  })
})

describe('describeLocations', () => {
  it('reports every location without throwing, errors included', () => {
    const report = describeLocations({}, { env: {}, cwd: tmp(), bundled: true })
    expect(report.workspace).toBeUndefined()
    expect(report.bundled).toBe(true)
    expect(report.locations.data).toHaveProperty('error')
    expect(report.locations.packagesRoot).toHaveProperty('source', 'cwd')
    const bad = describeLocations({ workspace: tmp() }, { env: {}, cwd: tmp(), bundled: false })
    expect(bad.workspaceError).toMatch(/not a booster workspace/)
  })
})
