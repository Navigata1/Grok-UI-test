import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_ROOT } from '../workspace.js'
import { DOCTRINE_FILE, doctrineHash, LEARNED_RULES_NAME, readShippedDoctrine, shippedDoctrine } from './doctrine.js'

describe('the shipped doctrine', () => {
  it('is docs/02 then every playbook file alphabetically, never the learned rules', () => {
    const d = readShippedDoctrine(CODE_ROOT)
    const playbook = readdirSync(path.join(CODE_ROOT, 'playbook')).filter((n) => n.endsWith('.md') && n !== LEARNED_RULES_NAME).sort()
    expect(d.files.map((f) => f.name)).toEqual([DOCTRINE_FILE, ...playbook.map((n) => `playbook/${n}`)])
    expect(d.files.length).toBeGreaterThanOrEqual(11)
    expect(d.packageFixTemplate).toContain('{{fixes}}')
    expect(d.hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('reads from the checkout when not bundled', () => {
    expect(shippedDoctrine(CODE_ROOT)).toEqual(readShippedDoctrine(CODE_ROOT))
  })

  it('leaves out a compiled 00-learned-rules.md and changes hash when any text changes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'booster-doctrine-'))
    mkdirSync(path.join(root, 'docs'))
    mkdirSync(path.join(root, 'playbook'))
    writeFileSync(path.join(root, DOCTRINE_FILE), 'R1 [house]')
    writeFileSync(path.join(root, 'playbook', 'b.md'), 'b')
    writeFileSync(path.join(root, 'playbook', LEARNED_RULES_NAME), 'learned')
    const first = readShippedDoctrine(root)
    expect(first.files.map((f) => f.name)).toEqual([DOCTRINE_FILE, 'playbook/b.md'])
    expect(first.packageFixTemplate).toBe('')
    writeFileSync(path.join(root, 'playbook', 'b.md'), 'b2')
    expect(readShippedDoctrine(root).hash).not.toBe(first.hash)
    expect(doctrineHash([])).toMatch(/^[0-9a-f]{12}$/)
  })
})
