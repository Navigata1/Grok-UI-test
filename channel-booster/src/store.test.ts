import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stableId } from './schema.js'
import { openStore, type Store } from './store.js'

let root: string
let store: Store
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'booster-')); store = openStore(root) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const now = '2026-09-14T09:00:00.000Z'

describe('store', () => {
  it('reads an empty collection, upserts by id, and validates on write', () => {
    expect(store.read('ideas')).toEqual([])
    const doc = store.upsert('ideas', { id: stableId('idea', 'Cold showers'), idea: 'Cold showers', sources: [], scores: { demand: 4, packaging: 3, fit: 3, angle: 2, payoff: 3, feasibility: 4 }, status: 'banked', createdAt: now, updatedAt: now, source: 'cli' })
    expect(doc.id).toBe(stableId('idea', 'cold showers'))
    store.upsert('ideas', { ...doc, status: 'green' })
    expect(store.read('ideas')).toHaveLength(1)
    expect(store.get('ideas', doc.id)?.status).toBe('green')
    expect(() => store.upsert('ideas', { ...doc, scores: { ...doc.scores, demand: 9 } })).toThrow()
    expect(store.remove('ideas', doc.id)).toBe(true)
    expect(store.remove('ideas', doc.id)).toBe(false)
  })
  it('names the line that fails validation on read', () => {
    writeFileSync(path.join(root, 'ledger.jsonl'), '{"id":"x"}\n')
    expect(() => store.read('ledger')).toThrow(/ledger.jsonl:1 does not match/)
  })
  it('stable ids are deterministic and case-insensitive', () => {
    expect(stableId('idea', 'Hello World')).toBe(stableId('idea', '  hello world '))
    expect(stableId('idea', 'a')).not.toBe(stableId('idea', 'b'))
  })
})
