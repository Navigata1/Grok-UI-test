/**
 * The Sunday retro: what was published in the window, which levers won,
 * which rows lost and why, every gate a person overrode, whether the
 * baseline moved, and the next three ideas to lock. One candidate rule is
 * drafted from the most frequent lever; a person accepts it with
 * `acceptRule()`, the only path that writes to `playbook/*.md`.
 *
 * Numbers come from the ledger (src/ledger.ts); nothing here is typed by hand.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { listIdeas, type BankRow } from './bank.js'
import { leverTally, ownOutliers, readLedger } from './ledger.js'
import { LEARNED_RULES_FILE } from './rules.js'
import type { LedgerRow, ProfileDoc } from './schema.js'
import type { Store } from './store.js'

/** The heading `acceptRule()` appends under, created once per playbook file. */
export const LEARNED_RULES_HEADING = '## Learned rules'

/** Ideas the retro locks for next week; the playbook approves at most three greens. */
export const NEXT_IDEAS_COUNT = 3

export interface RetroOptions {
  /** Start of the window (inclusive); rows published before it are not in this retro. */
  since: Date
  /** End of the window (inclusive). Defaults to the wall clock; inject it in tests. */
  now?: Date
  /** The channel profile, for the baseline-shift flag. Optional: without it the flag is false. */
  profile?: ProfileDoc
}

export interface RetroWindow {
  since: string
  until: string
  /** Whole days between since and until, rounded. */
  days: number
}

/** One lever and the rows that carried it, as `leverTally()` returns them. */
export interface LeverCount {
  lever: string
  count: number
  slugs: string[]
}

/** A rule drafted from the most frequent lever, for a person to accept or rewrite. */
export interface CandidateRule {
  rule: string
  lever: string
  count: number
  slugs: string[]
}

/** A stage a person overrode inside the window, with the reason they gave. */
export interface RetroOverride {
  slug: string
  stageId: string
  at: string
  reason?: string
  agent?: string
}

export interface Retro {
  window: RetroWindow
  /** Rows published inside the window, newest first. */
  published: LedgerRow[]
  /** Lever tally over the published rows, most frequent first. */
  levers: LeverCount[]
  /** Rows in the window whose 7-day views reached the own-winner multiple of the channel median. */
  winners: Array<{ row: LedgerRow; multiple: number }>
  /** Rows in the window with a bottleneck other than none. */
  losers: LedgerRow[]
  /** Drafted from the most frequent lever; absent when no row in the window carries a lever. */
  candidateRule?: CandidateRule
  /** Gates overridden inside the window, newest first. */
  overrides: RetroOverride[]
  /** True when the profile's baselines moved by more than one MAD at the last refresh. */
  baselineShift: boolean
  /** The top ideas in the bank (green first, then banked) to lock for next week. */
  nextThree: BankRow[]
}

function inWindow(iso: string | undefined, since: Date, until: Date): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t >= since.getTime() && t <= until.getTime()
}

/** Draft the candidate rule line the retro proposes for a lever. */
export function draftRule(lever: string, slugs: string[]): string {
  return `On this channel, ${lever} (n=${slugs.length}, slugs ${slugs.join(', ')})`
}

/**
 * Build the retro for the rows published between `since` and `now`. Winners
 * are judged against the whole ledger's 7-day median (the window alone is
 * too thin to be its own baseline); everything else is scoped to the window.
 */
export function buildRetro(store: Store, options: RetroOptions): Retro {
  const now = options.now ?? new Date()
  const since = options.since
  if (Number.isNaN(since.getTime())) throw new Error('retro: --since must be a date')
  if (since.getTime() > now.getTime()) throw new Error('retro: --since is after now')
  const all = readLedger(store)
  const published = all.filter((r) => inWindow(r.publishedAt, since, now))
  const slugs = new Set(published.map((r) => r.slug))
  // leverTally() counts a slug twice when the lever line and a hypothesis lever differ only in case; one row is one test.
  const levers: LeverCount[] = leverTally(published)
    .map((l) => ({ lever: l.lever, slugs: [...new Set(l.slugs)] }))
    .map((l) => ({ ...l, count: l.slugs.length }))
    .sort((a, b) => b.count - a.count)
  const winners = ownOutliers(all).filter((w) => slugs.has(w.row.slug))
  const losers = published.filter((r) => r.bottleneck !== undefined && r.bottleneck.trim() !== '' && r.bottleneck.trim().toLowerCase() !== 'none')
  const top = levers[0]
  const candidateRule: CandidateRule | undefined = top ? { rule: draftRule(top.lever, top.slugs), lever: top.lever, count: top.count, slugs: top.slugs } : undefined

  const overrides: RetroOverride[] = []
  for (const wf of store.read('workflows')) {
    for (const stage of wf.stages) {
      if (stage.status !== 'overridden') continue
      const at = stage.finishedAt ?? stage.startedAt
      if (!inWindow(at, since, now)) continue
      overrides.push({ slug: wf.slug, stageId: stage.id, at: at as string, reason: stage.overrideReason, agent: stage.agent })
    }
  }
  overrides.sort((a, b) => b.at.localeCompare(a.at) || a.slug.localeCompare(b.slug))

  const bank = listIdeas(store, { status: ['green', 'banked'] })
  const nextThree = [...bank.filter((i) => i.status === 'green'), ...bank.filter((i) => i.status !== 'green')].slice(0, NEXT_IDEAS_COUNT)

  return {
    window: { since: since.toISOString(), until: now.toISOString(), days: Math.round((now.getTime() - since.getTime()) / 86_400_000) },
    published,
    levers,
    winners,
    losers,
    candidateRule,
    overrides,
    baselineShift: options.profile?.baselines?.shift ?? false,
    nextThree,
  }
}

function day(iso: string): string {
  return iso.slice(0, 10)
}

function views7d(row: LedgerRow): string {
  const v = row.reads['168']?.views
  return v === undefined ? 'no 7-day read' : `${v} views at 7 d`
}

/** The retro as the one page a strategist reads on Sunday. */
export function renderRetroMarkdown(retro: Retro): string {
  const lines: string[] = []
  lines.push(`# Retro ${day(retro.window.since)} to ${day(retro.window.until)} (${retro.window.days} days)`, '')

  lines.push(`## Published (${retro.published.length})`)
  if (retro.published.length === 0) lines.push('- nothing published in this window')
  for (const r of retro.published) {
    const parts = [views7d(r)]
    if (r.bottleneck) parts.push(`bottleneck ${r.bottleneck}`)
    if (r.decision) parts.push(`decision ${r.decision}`)
    if (r.lever) parts.push(`lever: ${r.lever}`)
    lines.push(`- ${day(r.publishedAt)} ${r.title} (${r.slug}): ${parts.join('; ')}`)
  }
  lines.push('')

  lines.push('## Levers')
  if (retro.levers.length === 0) lines.push('- no lever recorded; the 7-day read writes one per video')
  for (const l of retro.levers) lines.push(`- ${l.lever}: ${l.count} (${l.slugs.join(', ')})`)
  lines.push('')

  lines.push('## Winners')
  if (retro.winners.length === 0) lines.push('- none reached the own-winner multiple')
  for (const w of retro.winners) lines.push(`- ${w.row.title} (${w.row.slug}): ${w.multiple.toFixed(1)}x the channel median at 7 d; brief the sequel`)
  lines.push('')

  lines.push('## Losers')
  if (retro.losers.length === 0) lines.push('- none with a named bottleneck')
  for (const r of retro.losers) lines.push(`- ${r.title} (${r.slug}): ${r.bottleneck}${r.decision ? `, ${r.decision}` : ''}`)
  lines.push('')

  lines.push('## Candidate rule')
  if (retro.candidateRule) {
    lines.push(`- ${retro.candidateRule.rule}`)
    lines.push('- accept it with `booster retro --accept-rule "..." --into playbook/<file>.md`, or rewrite it first')
  } else {
    lines.push('- none: no lever in this window')
  }
  lines.push('')

  lines.push('## Overrides')
  if (retro.overrides.length === 0) lines.push('- no gate was overridden')
  for (const o of retro.overrides) lines.push(`- ${day(o.at)} ${o.slug} / ${o.stageId}${o.agent ? ` by ${o.agent}` : ''}: ${o.reason ?? 'no reason recorded'}`)
  lines.push('')

  lines.push('## Baseline')
  lines.push(retro.baselineShift ? '- the baseline moved by more than one MAD since the last refresh: acknowledge it before judging this week against it' : '- no baseline shift')
  lines.push('')

  lines.push('## Next three')
  if (retro.nextThree.length === 0) lines.push('- the bank is empty; run the outlier scan and bank ideas')
  for (const i of retro.nextThree) lines.push(`- [${i.status}] ${i.idea} (${i.total}/100, weakest ${i.weakestAxis})`)

  return lines.join('\n')
}

export interface AcceptRuleOptions {
  /** Ledger slugs that back the rule; printed as refs after the rule. */
  slugs?: string[]
  /** Date stamp for the line. Defaults to the wall clock; inject it in tests. */
  now?: Date
}

/** Resolve `file` inside `playbookDir`, refusing anything outside it and the compiled rules file. */
export function resolvePlaybookFile(playbookDir: string, file: string): string {
  const root = path.resolve(playbookDir)
  const target = path.resolve(root, file)
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to write outside the playbook folder: ${file}`)
  if (path.basename(target) === LEARNED_RULES_FILE) throw new Error(`${LEARNED_RULES_FILE} is compiled by \`booster rules compile\`; accept rules into another playbook file`)
  if (path.extname(target).toLowerCase() !== '.md') throw new Error(`playbook files are Markdown: ${file}`)
  return target
}

/** The line `acceptRule()` appends. Slugs the rule text already names (a drafted candidate carries them) are not repeated. */
export function formatRuleLine(rule: string, slugs: string[], now: Date): string {
  const named = new Set(rule.split(/[\s,;()]+/).map((t) => t.toLowerCase()))
  const refs = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))].filter((s) => !named.has(s.toLowerCase()))
  return `- ${now.toISOString().slice(0, 10)}: ${rule}${refs.length ? ` (${refs.join(', ')})` : ''}`
}

/**
 * Append an accepted rule to a playbook file under `## Learned rules`,
 * creating the heading once at the end of the file. The line is
 * `- <date>: <rule> (<slug refs>)`. Refuses files outside `playbookDir`,
 * the compiled `00-learned-rules.md`, non-Markdown files, and files that do
 * not exist yet (a new playbook file is a deliberate act, not a side effect).
 * A rule already present under the heading is not appended twice.
 * Returns the absolute path written.
 */
export function acceptRule(playbookDir: string, file: string, rule: string, options: AcceptRuleOptions = {}): string {
  const text = rule.replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('a rule needs text')
  const target = resolvePlaybookFile(playbookDir, file)
  if (!existsSync(target)) throw new Error(`no such playbook file: ${target}`)
  const now = options.now ?? new Date()
  const line = formatRuleLine(text, options.slugs ?? [], now)

  const original = readFileSync(target, 'utf8')
  const lines = original.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let headingAt = lines.findIndex((l) => l.trim() === LEARNED_RULES_HEADING)
  if (headingAt === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length) lines.push('')
    lines.push(LEARNED_RULES_HEADING, '')
    headingAt = lines.length - 2
  }
  let sectionEnd = lines.length
  for (let i = headingAt + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) {
      sectionEnd = i
      break
    }
  }
  const section = lines.slice(headingAt + 1, sectionEnd)
  const already = section.some((l) => l.replace(/^- \d{4}-\d{2}-\d{2}: /, '').replace(/ \([^)]*\)$/, '').trim() === text)
  if (already) return target

  // Insert after the last non-blank line of the section, keeping one blank line before any following heading.
  let insertAt = sectionEnd
  while (insertAt > headingAt + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1
  const before = lines.slice(0, insertAt)
  const after = lines.slice(sectionEnd)
  const block = [...(insertAt === headingAt + 1 ? [''] : []), line]
  const next = [...before, ...block, ...(after.length ? ['', ...after] : [])]
  const content = `${next.join('\n')}\n`
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, target)
  return target
}
