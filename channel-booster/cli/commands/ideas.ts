/** Commands: idea, bank. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  addIdea, attachVerdict, canTransition, ideaId, importIdeas, LIFECYCLE, listIdeas, rescore, sequelCandidates, setStatus, wipWarnings,
  type BankSortKey,
} from '../../src/bank.js'
import { readVideoRows } from '../../src/csv.js'
import { DEMAND_AUTO, IDEA_AXIS_QUESTIONS, parseIdeaScore, resolveDemand, scoreIdea, suggestDemand, type DemandEvidence, type DemandSuggestion } from '../../src/ideas.js'
import { readLedger } from '../../src/ledger.js'
import { computeOutliers, type OutlierRowV2 } from '../../src/outliers.js'
import { IdeaStatus, type IdeaDoc } from '../../src/schema.js'
import { thresholds } from '../../src/thresholds.js'
import type { IdeaScore } from '../../src/types.js'
import { bool, getStore, list, need, nowFrom, num, out, str, type CommandModule, type Flags } from '../shared.js'

const SORT_KEYS: readonly BankSortKey[] = ['total', 'demand', 'updatedAt', 'createdAt', 'idea']
const DEMAND_AUTO_HINT = 'demand=auto matches on two shared content words, so phrase the idea with the topic\'s two key nouns (e.g. "van life budget build")'

/** The strongest multiple suggestDemand() scored a row on: its velocity when fresh, else its views multiple. */
function scoredX(e: DemandEvidence): number {
  return Math.max(e.multiplier, e.velocityMultiplier ?? 0)
}

/** Shared demand=auto path: rank a scan, then read the demand axis for `idea` from it. */
function demandFromScan(idea: string, csv: string, flags: Flags, now: Date): { ranked: OutlierRowV2[]; suggestion: DemandSuggestion } {
  const rows = readVideoRows(readFileSync(csv, 'utf8'))
  const since = num(flags, 'since')
  const ranked = computeOutliers(rows, { now, sinceDays: since, minAgeDays: num(flags, 'min-age-days') ?? 7 })
  const suggestion = suggestDemand(idea, ranked, { now, windowDays: since })
  return { ranked, suggestion }
}

/** The demand line plus one evidence row per match, for every command that resolves demand=auto. */
function renderDemand(s: DemandSuggestion): string[] {
  const lines = [`Demand ${s.score}/5 (auto): ${s.reason} [house]`]
  for (const e of s.evidence) {
    const age = e.ageDays === undefined ? '   ?' : `${String(Math.round(e.ageDays)).padStart(3)}d`
    const fresh = e.velocityMultiplier !== undefined ? `  (fresh: ${e.velocityMultiplier.toFixed(1)}x velocity)` : ''
    lines.push(`  ${scoredX(e).toFixed(1).padStart(6)}x  ${age}  ${(e.channel ?? '-').padEnd(12)} ${e.title}${fresh}`)
  }
  if (s.evidence.length === 0) lines.push('  (no evidence rows inside the window)')
  if (s.staleMatches > 0) lines.push(`  ${s.staleMatches} older match${s.staleMatches === 1 ? '' : 'es'} outside ${s.windowDays} days ignored`)
  return lines
}

/** Structured form of a suggestion for --json: the reason always carries its [house] tag. */
function demandJson(s: DemandSuggestion): Record<string, unknown> {
  return { auto: true, score: s.score, reason: s.reason, evidenceTag: 'house', evidence: s.evidence, staleMatches: s.staleMatches, windowDays: s.windowDays }
}

/** A bank id from either form: `idea:<hash>` verbatim, anything else hashed as idea text. */
function bankId(raw: string | undefined, usage: string): string {
  if (!raw) throw new Error(`usage: ${usage}`)
  return raw.startsWith('idea:') ? raw : ideaId(raw)
}

/**
 * The bank row an `idea score` argument names: an `idea:<hash>` id, the idea
 * text, or the workflow slug the runner's demand stage passes, resolved
 * through the status document's idea text exactly as `package build <slug>`
 * resolves it.
 */
function bankIdeaFor(store: ReturnType<typeof getStore>, raw: string): IdeaDoc | undefined {
  const doc = store.get('ideas', raw.startsWith('idea:') ? raw : ideaId(raw))
  if (doc || raw.startsWith('idea:')) return doc
  const wf = store.get('workflows', raw)
  return wf ? store.get('ideas', ideaId(wf.idea)) : undefined
}

function getIdea(store: ReturnType<typeof getStore>, id: string): IdeaDoc {
  const doc = store.get('ideas', id)
  if (!doc) throw new Error(`no idea with id "${id}" in the bank (booster bank list shows ids; the text form is also accepted)`)
  return doc
}

function parseStatus(raw: string | undefined, usage: string): IdeaStatus {
  const parsed = IdeaStatus.safeParse(raw)
  if (!parsed.success) throw new Error(`status must be one of ${IdeaStatus.options.join(', ')}. Usage: ${usage}`)
  return parsed.data
}

/**
 * AGENTS.md gate 1: approving a green idea is a person's call. Print what is
 * about to happen; without --yes stop with a clear message instead of writing.
 */
function gateGreen(doc: IdeaDoc, flags: Flags): void {
  const allowed = canTransition(doc.status, 'green')
  const plan = { action: 'approve', id: doc.id, idea: doc.idea, from: doc.status, to: 'green', allowed, applied: false, needs: '--yes' }
  if (bool(flags, 'yes')) return
  out(plan, flags, () => [
    `About to approve "${doc.idea}" (${doc.id}): ${doc.status} -> green.`,
    allowed ? 'Approving a green idea is a human-only gate (AGENTS.md gate 1): the channel\'s own angle, not a clone.' : `Not allowed from ${doc.status}: ${LIFECYCLE[doc.status].length ? `allowed: ${LIFECYCLE[doc.status].join(', ')}` : 'retired is final'}.`,
  ].join('\n'))
  throw new Error(allowed ? `nothing written. A person re-runs with --yes to record the approval of "${doc.idea}".` : `cannot move "${doc.idea}" from ${doc.status} to green`)
}

function renderRow(r: ReturnType<typeof listIdeas>[number]): string {
  return `${r.verdict.verdict.toUpperCase().padEnd(6)} ${String(r.total).padStart(3)}  ${r.status.padEnd(10)} ${r.idea}${r.sequelOf ? ` (sequel of ${r.sequelOf})` : ''}  weakest: ${r.weakestAxis}  sources: ${r.sources.length}  ${r.id}`
}

function renderScorecard(idea: string, verdict: ReturnType<typeof scoreIdea>, demand?: DemandSuggestion): string {
  return [
    `Idea: ${idea}`,
    `Total ${verdict.total}/100 · verdict ${verdict.verdict.toUpperCase()}`,
    ...Object.entries(verdict.score).map(([k, v]) => `  ${k.padEnd(12)} ${'█'.repeat(v)}${'·'.repeat(5 - v)} ${v}/5`),
    ...(demand ? ['', ...renderDemand(demand)] : []),
    ...(verdict.fixes.length ? ['', 'Fix first:', ...verdict.fixes.map((f) => `  - ${f}`)] : ['', 'No axis below 3. Move it to the packaging sprint.']),
  ].join('\n')
}

async function runIdea(sub: string | undefined, rest: string[], flags: Flags): Promise<number> {
  if (sub === 'questions') {
    out(IDEA_AXIS_QUESTIONS, flags, () => Object.entries(IDEA_AXIS_QUESTIONS).map(([k, v]) => `${k.padEnd(12)} ${v}`).join('\n'))
    return 0
  }
  if (sub === 'score') {
    const idea = rest[0] ?? '(untitled idea)'
    const scoreText = str(flags, 'score')
    // Without typed axes the six come off the bank row this id, text or
    // workflow slug names, and the scorecard carries that row's status: the
    // demand stage of `booster workflow run` scores an approved idea by slug.
    const banked = scoreText ? undefined : bankIdeaFor(getStore(flags), idea)
    let score: IdeaScore
    if (scoreText) score = parseIdeaScore(scoreText)
    else if (banked) score = banked.scores
    else throw new Error(`usage: booster idea score "<idea>" --score "demand=4,packaging=3,fit=4,angle=3,payoff=4,feasibility=5" (demand=auto with --outliers <csv>). Nothing in the bank matches "${idea}": booster bank add "<idea>" --score "..", then a person approves it with booster bank approve "<idea>" --yes.`)
    let demand: DemandSuggestion | undefined
    if (score.demand === DEMAND_AUTO) {
      const csv = str(flags, 'outliers')
      if (!csv) throw new Error(`demand=auto needs --outliers <competitors.csv> [--since 90] [--min-age-days 7]. ${DEMAND_AUTO_HINT}`)
      demand = demandFromScan(idea, csv, flags, nowFrom(flags)).suggestion
      score = resolveDemand(score, demand)
    }
    const verdict = scoreIdea(score)
    const scorecard = { idea: banked?.idea ?? idea, ...(banked ? { id: banked.id, status: banked.status } : {}), ...verdict, ...(demand ? { demand: demandJson(demand) } : {}) }
    const outFlag = str(flags, 'out')
    const outFile = outFlag === undefined ? undefined : path.resolve(outFlag)
    if (outFile) {
      mkdirSync(path.dirname(outFile), { recursive: true })
      writeFileSync(outFile, `${JSON.stringify(scorecard, null, 2)}\n`)
    }
    out(scorecard, flags, () => [
      renderScorecard(scorecard.idea, verdict, demand),
      ...(banked ? [`Bank: ${banked.id} is ${banked.status}${banked.status === 'green' ? '' : `; a person approves it with booster bank approve "${banked.idea}" --yes`}.`] : []),
      ...(outFile ? [`Wrote ${outFile}`] : []),
    ].join('\n'))
    return 0
  }
  throw new Error('usage: booster idea questions | booster idea score "<idea>" --score ...')
}

async function runBank(sub: string | undefined, rest: string[], flags: Flags): Promise<number> {
  const store = getStore(flags)
  const now = nowFrom(flags)

  switch (sub) {
    case 'add': {
      const idea = rest[0]
      const usage = 'booster bank add "<idea>" --score "demand=4,packaging=3,..." [--csv competitors.csv] [--series ..] [--promise ..] [--source ..]'
      if (!idea) throw new Error(`usage: ${usage}`)
      let score = parseIdeaScore(need(flags, 'score', usage))
      let sources: IdeaDoc['sources'] = []
      let demand: DemandSuggestion | undefined
      if (score.demand === DEMAND_AUTO) {
        const csv = str(flags, 'csv')
        if (!csv) throw new Error(`demand=auto needs --csv <competitors.csv>. ${DEMAND_AUTO_HINT}`)
        demand = demandFromScan(idea, csv, flags, now).suggestion
        score = resolveDemand(score, demand)
        sources = demand.evidence.map((e) => ({ title: e.title, multiplier: e.multiplier, channel: e.channel, date: e.published, url: e.url }))
      }
      const doc = addIdea(store, { idea, scores: score, sources, series: str(flags, 'series'), promise: str(flags, 'promise'), source: str(flags, 'source'), now })
      const row = attachVerdict(doc)
      out({ ...row, ...(demand ? { demand: demandJson(demand) } : {}) }, flags, () => [
        `${doc.id} ${doc.status} ${doc.topicKey ?? ''} total ${row.total} weakest ${row.weakestAxis} verdict ${row.verdict.verdict.toUpperCase()}`,
        ...(demand ? renderDemand(demand) : []),
      ].join('\n'))
      return 0
    }
    case 'list': {
      const statusFlag = list(flags, 'status')
      const status = statusFlag?.map((s) => parseStatus(s, 'booster bank list [--status banked,green,...]'))
      const sortRaw = str(flags, 'sort')
      if (sortRaw !== undefined && !SORT_KEYS.includes(sortRaw as BankSortKey)) throw new Error(`--sort must be one of ${SORT_KEYS.join(', ')}`)
      const rows = listIdeas(store, { status, sortBy: sortRaw as BankSortKey | undefined, sequelFirst: !bool(flags, 'no-sequel-first') })
      const warnings = wipWarnings(store)
      out({ ideas: rows, warnings }, flags, () => [
        ...(rows.length ? rows.map(renderRow) : ['The bank is empty. Add one: booster bank add "<idea>" --score "demand=auto,..." --csv competitors.csv']),
        ...warnings.map((w) => `WARN ${w.message}`),
      ].join('\n'))
      return 0
    }
    case 'approve': {
      const id = bankId(rest[0], 'booster bank approve <id-or-text> --yes')
      const doc = getIdea(store, id)
      gateGreen(doc, flags)
      const next = setStatus(store, id, 'green', { now })
      out(next, flags, () => `${next.idea}: ${next.status} (approved by a person, ${next.updatedAt})`)
      return 0
    }
    case 'park':
    case 'reject': {
      const usage = `booster bank ${sub} <id-or-text> --reason "one line on why"`
      const id = bankId(rest[0], usage)
      const reason = need(flags, 'reason', usage)
      const next = setStatus(store, id, sub === 'park' ? 'parked' : 'retired', { reason, now })
      out(next, flags, () => `${next.idea}: ${next.status} (${reason})`)
      return 0
    }
    case 'status': {
      const usage = 'booster bank status <id-or-text> <banked|green|packaging|production|published|parked|retired> [--reason ..]'
      const id = bankId(rest[0], usage)
      const status = parseStatus(rest[1], usage)
      const doc = getIdea(store, id)
      if (status === 'green') gateGreen(doc, flags)
      const next = setStatus(store, id, status, { reason: str(flags, 'reason'), now })
      out(next, flags, () => `${next.idea}: ${doc.status} -> ${next.status}${next.parkedReason && (status === 'parked' || status === 'retired') ? ` (${next.parkedReason})` : ''}`)
      return 0
    }
    case 'rescore': {
      const csv = rest[0]
      if (!csv) throw new Error('usage: booster bank rescore <competitors.csv> [--own my-channel.csv] [--since 90] [--decay-days 180]')
      const since = num(flags, 'since')
      const ranked = computeOutliers(readVideoRows(readFileSync(csv, 'utf8')), { now, sinceDays: since })
      const report = rescore(store, ranked, { now, windowDays: since, decayDays: num(flags, 'decay-days'), source: 'cli' })
      const own = str(flags, 'own')
      let sequels: IdeaDoc[] = []
      let ownWinners: Array<{ title: string; multiplier: number; inLedger: boolean }> = []
      if (own) {
        // Sequels come from the ledger (the only place 168-hour reads live); the own export just says which winners the ledger is missing.
        const ledger = readLedger(store)
        const bar = thresholds.ownWinnerMultiplier.value
        const inLedger = new Set(ledger.map((r) => r.title.trim().toLowerCase()))
        ownWinners = computeOutliers(readVideoRows(readFileSync(own, 'utf8')), { now, sinceDays: since, threshold: bar })
          .filter((r) => r.multiplier >= bar)
          .map((r) => ({ title: r.title, multiplier: Math.round(r.multiplier * 100) / 100, inLedger: inLedger.has(r.title.trim().toLowerCase()) }))
        sequels = sequelCandidates(store, ledger, { now, source: 'cli' })
      }
      out({ ...report, sequels, ownWinners }, flags, () => [
        `scanned ${report.scanned}, ${report.inWindow} inside ${report.windowDays} days; ${report.unchanged} ideas unchanged`,
        ...report.matched.map((m) => `+${m.added.length} sources -> ${m.idea} demand ${m.demand.before}->${m.demand.after} (${m.reason} [house])`),
        ...report.reopened.map((r) => `REOPENED ${r.idea}: ${r.note}`),
        ...report.decayed.map((d) => `DECAY ${d.idea} demand ${d.from}->${d.to} (no evidence for ${report.decayDays} days [house])`),
        ...sequels.map((s) => `SEQUEL ${s.idea} (${s.id})`),
        ...ownWinners.filter((w) => !w.inLedger).map((w) => `OWN WINNER ${w.multiplier}x not in the ledger: "${w.title}" (booster publish confirm / ledger add, then bank sequels)`),
        ...(own && sequels.length === 0 ? ['No new own winner without a sequel idea.'] : []),
      ].join('\n'))
      return 0
    }
    case 'sequels': {
      const created = sequelCandidates(store, readLedger(store), { now, multiplier: num(flags, 'multiplier'), source: 'cli' })
      out(created, flags, () => (created.length ? created.map((s) => `${s.id} ${s.idea} (sequel of ${s.sequelOf})`).join('\n') : 'No new own winner without a sequel idea.'))
      return 0
    }
    case 'import': {
      const file = rest[0]
      if (!file) throw new Error('usage: booster bank import <ideas.json> [--source agent:idea-engine]   (booster ai idea-engine --json > ideas.json)')
      const report = importIdeas(store, readFileSync(file, 'utf8'), { source: str(flags, 'source'), now })
      out(report, flags, () => [
        ...report.imported.map((i) => `${i.outcome.padEnd(7)} ${i.id} ${i.idea}${i.workingTitle ? `  title: ${i.workingTitle}` : ''}${i.thumbnailConcept ? `  thumb: ${i.thumbnailConcept}` : ''}${i.angle ? `  angle: ${i.angle}` : ''}`),
        ...report.skipped.map((s) => `skipped #${s.index}: ${s.reason}`),
        `${report.imported.length} imported, ${report.skipped.length} skipped`,
      ].join('\n'))
      return 0
    }
    case 'wip': {
      const w = wipWarnings(store)
      out(w, flags, () => (w.length ? w.map((x) => x.message).join('\n') : 'WIP within caps.'))
      return 0
    }
    default:
      throw new Error('usage: booster bank add|list|approve|park|reject|status|rescore|sequels|import|wip')
  }
}

export const ideasModule: CommandModule = {
  verbs: ['idea', 'bank'],
  help: [
    'idea questions                                                     the six scorecard questions',
    'idea score "<idea>" --score "demand=4,packaging=3,fit=..."         verdict + fixes',
    'idea score "<idea>" --score "demand=auto,..." --outliers <csv>     demand read from the scan [--since 90] [--min-age-days 7]; phrase the idea with the topic\'s two key nouns',
    'idea score <slug>|<idea:id> [--out file.json]                      axes from the bank row when --score is omitted; the scorecard carries its bank status (the workflow demand stage)',
    'bank add "<idea>" --score "..." [--csv competitors.csv]            bank an idea (demand=auto reads --csv) [--series ..] [--promise ..]',
    'bank list [--status banked,green,..] [--sort total|demand|..]      the bank with verdicts, sequels first [--no-sequel-first]',
    'bank approve <id-or-text> --yes                                    banked -> green (human-only gate 1)',
    'bank park <id-or-text> --reason ".."                               shelve it; a fresh >= 5x match reopens it',
    'bank reject <id-or-text> --reason ".."                             retire it with one line on why',
    'bank status <id-or-text> <status> [--reason ..]                    move it along the lifecycle',
    'bank rescore <competitors.csv> [--own my-channel.csv]              append scan evidence, raise/decay demand [--since 90] [--decay-days 180]',
    'bank sequels [--multiplier 5]                                      bank a sequel for every own winner in the ledger',
    'bank import <ideas.json> [--source agent:idea-engine]              import booster ai idea-engine --json output',
    'bank wip                                                           packaging/production caps as warnings',
  ],
  async run(cmd, sub, rest, flags) {
    return cmd === 'bank' ? runBank(sub, rest, flags) : runIdea(sub, rest, flags)
  },
}
