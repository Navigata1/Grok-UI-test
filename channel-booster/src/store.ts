/**
 * JSONL store under the channel's data folder (src/workspace.ts: --data,
 * BOOSTER_DATA, <workspace>/data, or channel-booster/data from source). One file per
 * collection, one document per line, validated on read and write against
 * src/schema.ts. Last writer wins by id; the file is rewritten on every
 * upsert, which is fine at the scale of one channel.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { COLLECTIONS, type CollectionName } from './schema.js'
import { resolveDataDir } from './workspace.js'

type DocOf<C extends CollectionName> = z.infer<(typeof COLLECTIONS)[C]>

export interface Store {
  root: string
  path(collection: CollectionName): string
  read<C extends CollectionName>(collection: C): DocOf<C>[]
  get<C extends CollectionName>(collection: C, id: string): DocOf<C> | undefined
  upsert<C extends CollectionName>(collection: C, doc: DocOf<C>): DocOf<C>
  remove(collection: CollectionName, id: string): boolean
  writeAll<C extends CollectionName>(collection: C, docs: DocOf<C>[]): void
}

/** Open the store at root; without one, where src/workspace.ts resolves it (read when called, not at import). */
export function openStore(root: string = resolveDataDir({}).path): Store {
  const file = (collection: CollectionName) => path.join(root, `${collection}.jsonl`)

  function read<C extends CollectionName>(collection: C): DocOf<C>[] {
    const p = file(collection)
    if (!existsSync(p)) return []
    const schema = COLLECTIONS[collection]
    const out: DocOf<C>[] = []
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.trim()) return
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        throw new Error(`${p}:${i + 1} is not valid JSON`)
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw new Error(`${p}:${i + 1} does not match the ${collection} schema: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`)
      out.push(parsed.data as DocOf<C>)
    })
    return out
  }

  function writeAll<C extends CollectionName>(collection: C, docs: DocOf<C>[]): void {
    mkdirSync(root, { recursive: true })
    const p = file(collection)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, docs.map((d) => JSON.stringify(d)).join('\n') + (docs.length ? '\n' : ''))
    renameSync(tmp, p)
  }

  return {
    root,
    path: file,
    read,
    writeAll,
    get(collection, id) {
      return read(collection).find((d) => d.id === id)
    },
    upsert(collection, doc) {
      const schema = COLLECTIONS[collection]
      const parsed = schema.parse(doc) as DocOf<typeof collection>
      const docs = read(collection).filter((d) => d.id !== parsed.id)
      docs.push(parsed)
      docs.sort((a, b) => a.id.localeCompare(b.id))
      writeAll(collection, docs)
      return parsed
    },
    remove(collection, id) {
      const docs = read(collection)
      const kept = docs.filter((d) => d.id !== id)
      if (kept.length === docs.length) return false
      writeAll(collection, kept)
      return true
    },
  }
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}
