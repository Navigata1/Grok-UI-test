/**
 * The prose is a surface like any other: a document that names a flag the CLI
 * does not accept, or a store file the system never writes, sends a reader down
 * a path that cannot work. These tests read the shipped docs and check the
 * claims that are checkable against the code, so the two cannot drift apart
 * again silently. Ground truth comes from the modules themselves wherever it
 * can, never from a second copy of the same string.
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateWorkflow } from './workflow.js'
import { DEFAULT_THRESHOLDS } from './thresholds.js'
import { COLLECTIONS } from './schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const module = path.resolve(here, '..')
const repo = path.resolve(module, '..')

const DOCS = [
  'channel-booster/README.md',
  'channel-booster/AGENTS.md',
  'channel-booster/docs/03-system-architecture.md',
  'channel-booster/docs/routines.md',
  'channel-booster/prompts/packaging-sprint.md',
  'channel-booster/playbook/README.md',
  '.claude/skills/booster/SKILL.md',
  '.claude/skills/booster-channel-audit/SKILL.md',
  '.claude/skills/booster-workflow/SKILL.md',
] as const

const read = (rel: string): string => readFileSync(path.join(repo, rel), 'utf8')
const all = (): Array<[string, string]> => DOCS.map((rel) => [rel, read(rel)])

const arch = () => read('channel-booster/docs/03-system-architecture.md')

describe('docs name only what the system has', () => {
  it('names no store file outside the six collections', () => {
    // `openStore` can only ever write `${collection}.jsonl`, so `data/videos.jsonl`
    // and `data/rules.json` are unreachable by construction.
    const known = new Set(Object.keys(COLLECTIONS).map((c) => `data/${c}.jsonl`))
    for (const [rel, text] of all()) {
      for (const hit of text.match(/data\/[a-z-]+\.jsonl?\b/g) ?? []) {
        if (hit === 'data/last-scan.json' || hit === 'data/last-audit.json') continue
        expect(known.has(hit), `${rel} names ${hit}, which the store never writes`).toBe(true)
      }
    }
  })

  it('cites research and workflow files that exist in the tree', () => {
    for (const rel of ['channel-booster/docs/research/findings.json', 'channel-booster/docs/research/dossier.md']) {
      expect(existsSync(path.join(repo, rel)), `${rel} is cited but missing`).toBe(true)
    }
    for (const [rel, text] of all()) {
      for (const hit of text.match(/`\.github\/workflows\/[\w.-]+`/g) ?? []) {
        const file = hit.slice(1, -1)
        expect(existsSync(path.join(repo, file)), `${rel} points at ${file}, which is not in the tree`).toBe(true)
      }
      expect(text.includes('sourced-findings.json'), `${rel} cites a research file that does not exist`).toBe(false)
    }
  })

  it('names only threshold keys applyOverrides accepts', () => {
    // A `channel.json` written from the doc must not be rejected on every command.
    for (const [rel, text] of all()) {
      for (const hit of text.match(/thresholds\.([A-Za-z][A-Za-z0-9]*)/g) ?? []) {
        const key = hit.slice('thresholds.'.length)
        if (key === 'value' || key === 'ts') continue
        expect(key in DEFAULT_THRESHOLDS, `${rel} names profile threshold "${key}", which applyOverrides rejects`).toBe(true)
      }
    }
  })

  it('does not tell anyone to reset a baseline with a command that does not exist', () => {
    for (const [rel, text] of all()) {
      expect(text.includes('baseline reset'), `${rel} names "baseline reset"; the command is profile refresh --yes`).toBe(false)
    }
  })
})

describe('docs agree with the workflow the generator emits', () => {
  const stages = generateWorkflow('Budget van build for under 5k', { format: 'talking-head' }).stages
  const humanIds = stages.filter((s) => s.run?.kind === 'human').map((s) => s.id)
  const commandIds = stages.filter((s) => s.run?.kind === 'command').map((s) => s.id)

  it('AGENTS.md counts the stages the generator emits', () => {
    expect(stages).toHaveLength(10)
    const agents = read('channel-booster/AGENTS.md')
    expect(agents).toContain('ten gated stages')
    expect(agents).not.toContain('eleven gated stages')
  })

  it('section 2.13 classifies every stage the way the generator runs it', () => {
    const sentence = arch().match(/Stages `demand`[^.]*\./)?.[0]
    expect(sentence, 'section 2.13 no longer names the command stages').toBeTruthy()
    for (const id of commandIds) expect(sentence, `${id} is a command stage`).toContain(`\`${id}\``)
    // `plan` runs `plan shots` and is checked by file-exists, so it must not be
    // described as a human stage waiting on an evidence file.
    expect(commandIds).toContain('plan')
    expect(humanIds).toEqual(['production', 'edit'])
    const humanClause = arch().match(/only `production` and `edit` are `human`/)
    expect(humanClause, 'section 2.13 must name production and edit as the only human stages').toBeTruthy()
  })

  it('the section 3 stage table has one numbered row per generated stage', () => {
    const rows = arch().match(/^\| \d+ \| /gm) ?? []
    expect(rows).toHaveLength(stages.length)
  })
})

describe('documented commands match the shipped CLI', () => {
  const cliSource = (): string =>
    ['package.ts', 'scan.ts', 'ideas.ts', 'data.ts', 'publish.ts', 'review.ts', 'workflow.ts', 'direction.ts', 'learn.ts', 'ai.ts']
      .map((f) => readFileSync(path.join(module, 'cli', 'commands', f), 'utf8'))
      .join('\n')

  it('the packaging sprint does not ask for flags package review lacks', () => {
    const sprint = read('channel-booster/prompts/packaging-sprint.md')
    expect(sprint).toContain('package review --title')
    // `--record` parses as a boolean and `--reviewer` as an unread string, so both
    // fail silently: the review is printed and nothing is stored anywhere.
    expect(sprint).not.toContain('--record')
    expect(sprint).not.toContain('--reviewer')
    expect(sprint, 'step 12 must not gate on a review the CLI never records').not.toContain('recorded review')
    expect(cliSource()).not.toContain("str(flags, 'reviewer')")
  })

  it('every --diff and --scan example uses a bare file name the store resolves', () => {
    // A path with a separator is taken as given and stays cwd-relative, so it
    // stops matching what a bare --save wrote as soon as --data moves the store.
    for (const [rel, text] of all()) {
      for (const hit of text.match(/--(?:diff|scan) +\S+/g) ?? []) {
        const value = hit.split(/ +/)[1]
        expect(value.startsWith('--'), `${rel}: "${hit}" leaves --diff/--scan without a value, so it is silently ignored`).toBe(false)
        expect(/[\\/]/.test(value), `${rel}: "${hit}" should pass a bare file name so the store resolves it`).toBe(false)
      }
    }
  })

  it('writes the 7-day lever with the command that accepts it', () => {
    // `ledger add` rejects --lever outright; the lever is a 7-day read, so it
    // goes on `set --bucket 168` and carries the --yes of human-only gate 6.
    // `package build --lever` is another flag: the lever a person's title tests,
    // pre-registered with the title before any number is in, so it needs none.
    for (const [rel, text] of all()) {
      for (const line of text.split('\n')) {
        const sevenDay = [...line.matchAll(/--lever /g)].filter((m) => {
          const before = line.slice(0, m.index)
          return !/package build/.test(before.slice(Math.max(before.lastIndexOf('booster '), before.lastIndexOf('`'))))
        })
        if (sevenDay.length === 0) continue
        expect(/ledger add[^\n]*--lever/.test(line), `${rel}: "ledger add --lever" is refused by the CLI`).toBe(false)
        expect(line.includes('--yes'), `${rel}: writing a lever is a human-only gate, so the example needs --yes: ${line.trim()}`).toBe(true)
      }
    }
  })

  it('names last-audit.json wherever a doc feeds an audit scan to direction', () => {
    // `audit --save` writes last-audit.json so it cannot overwrite the competitor
    // scan; a doc that still pairs it with last-scan.json sends direction at the
    // wrong file.
    const audit = read('.claude/skills/booster-channel-audit/SKILL.md')
    expect(audit).toContain('--scan last-audit.json')
    expect(audit).not.toContain('--scan last-scan.json')
  })

  it('marks profile refresh and publish confirm as the human-only gates they are', () => {
    const readme = read('channel-booster/README.md')
    expect(readme).toMatch(/profile refresh[^\n]*--yes/)
    expect(readme).toMatch(/publish confirm[^\n]*--levers[^\n]*--yes/)
    expect(cliSource()).toContain('human-only gate 6')
  })
})
