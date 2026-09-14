/**
 * The idea bank: ideas persisted as data with a lifecycle, over the store's
 * `ideas` collection (schema.IdeaDoc). Architecture section 2.4.
 *
 *   banked -> green -> packaging -> production -> published
 *   banked | green -> parked (a parked idea reopens to banked)
 *   anything but retired -> retired
 *
 * Demand is the one axis the system derives: rescore() appends fresh outlier
 * evidence whose topic key matches an idea, raises demand to what that
 * evidence proves (ideas.suggestDemand), reopens parked ideas on a >= 5x match,
 * and decays demand by one when nothing new has arrived for 180 days. The
 * other five axes stay human. Every time-dependent function takes `now`.
 *
 * Only `type Store` is imported from store.ts, so this file has no node:fs
 * dependency and is safe for the browser bundle with a Store-shaped object.
 */
import { ageInDays } from './outliers.js'
import { DEMAND_AUTO, IDEA_WEIGHTS, scoreIdea, suggestDemand, type DemandRow } from './ideas.js'
import { ownOutliers } from './ledger.js'
import { IdeaDoc, IdeaScores, IdeaStatus, stableId, type LedgerRow } from './schema.js'
import type { Store } from './store.js'
import { thresholds } from './thresholds.js'
import { topicKey } from './topics.js'
import type { IdeaScore, IdeaVerdict } from './types.js'

type IdeaSource = IdeaDoc['sources'][number]

/**
 * [house] An idea with no new evidence for this many days loses one point of
 * demand per rescore that finds it still stale. Belongs in thresholds.ts as
 * `demandDecayDays`; declared here because bank.ts does not own that file.
 */
export const DEMAND_DECAY_DAYS = 180

/**
 * [house] The five human axes of an auto-created sequel candidate start at
 * mid-scale so the verdict is yellow until a person scores them. Demand is 5:
 * a video that already worked is the strongest demand signal on the platform.
 */
export const SEQUEL_HUMAN_AXIS_SCORE = 3

/** Allowed transitions. Retired is terminal; parked reopens to banked. */
export const LIFECYCLE: Record<IdeaStatus, readonly IdeaStatus[]> = {
  banked: ['green', 'parked', 'retired'],
  green: ['packaging', 'parked', 'retired'],
  packaging: ['production', 'retired'],
  production: ['published', 'retired'],
  published: ['retired'],
  parked: ['banked', 'retired'],
  retired: [],
}

/** Statuses that sit in the queue: they receive evidence, decay, and count as "not yet made". */
const QUEUE_STATUSES: readonly IdeaStatus[] = ['banked', 'green', 'parked']

/** Whether the lifecycle allows moving an idea from one status to another. */
export function canTransition(from: IdeaStatus, to: IdeaStatus): boolean {
  return LIFECYCLE[from].includes(to)
}

/** Deterministic id for an idea's text: `idea:<hash>`, case- and whitespace-insensitive. */
export function ideaId(idea: string): string {
  return stableId('idea', idea)
}

/**
 * The topic key of an idea: the two longest content tokens of its text (ties
 * alphabetical), sorted alphabetically and joined with "+". This is exactly
 * the outlier miner's topics.topicKey(), so a bank row and a scanned outlier
 * about the same subject share a key regardless of title frame. A leading
 * "Sequel:" label (sequelCandidates() adds it) is not part of the topic.
 */
export function ideaTopicKey(idea: string): string {
  return topicKey(idea.replace(/^\s*sequel\s*:\s*/i, ''))
}

/**
 * The axis with the lowest score. Ties go to the heavier axis (demand and
 * packaging first), the same order scoreIdea() lists its fixes in.
 */
export function weakestAxis(scores: IdeaScore): keyof IdeaScore {
  const axes = Object.keys(IDEA_WEIGHTS) as Array<keyof IdeaScore>
  return [...axes].sort((a, b) => scores[a] - scores[b] || IDEA_WEIGHTS[b] - IDEA_WEIGHTS[a])[0]
}

/** A bank row with its verdict attached, as listIdeas() returns it. */
export interface BankRow extends IdeaDoc {
  verdict: IdeaVerdict
  /** Weighted 0-100 total, copied from the verdict for sorting and printing. */
  total: number
  weakestAxis: keyof IdeaScore
}

/** Attach scoreIdea()'s verdict, total, and weakest axis to a stored idea. */
export function attachVerdict(doc: IdeaDoc): BankRow {
  const verdict = scoreIdea(doc.scores)
  return { ...doc, verdict, total: verdict.total, weakestAxis: weakestAxis(doc.scores) }
}

function checkScores(scores: IdeaScore): IdeaScore {
  if (scores.demand === DEMAND_AUTO) {
    throw new Error('demand is "auto" (-1): resolve it with suggestDemand() and resolveDemand() before banking the idea')
  }
  const parsed = IdeaScores.safeParse(scores)
  if (!parsed.success) {
    throw new Error(`scores must be 0-5 on every axis: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`)
  }
  return parsed.data
}

function sourceKey(s: IdeaSource): string {
  return `${s.title.trim().toLowerCase()}|${(s.channel ?? '').trim().toLowerCase()}`
}

/** Append sources not already present (same title and channel, case-insensitive). Returns the ones added. */
function mergeSources(existing: IdeaSource[], incoming: IdeaSource[]): { sources: IdeaSource[]; added: IdeaSource[] } {
  const seen = new Set(existing.map(sourceKey))
  const added: IdeaSource[] = []
  for (const s of incoming) {
    const key = sourceKey(s)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(s)
  }
  return { sources: [...existing, ...added], added }
}

export interface AddIdeaInput {
  idea: string
  scores: IdeaScore
  sources?: IdeaSource[]
  series?: string
  promise?: string
  sequelOf?: string
  /** Who wrote it: 'cli' (default), 'desk', or 'agent:<name>'. */
  source?: string
  now?: Date
}

/**
 * Bank an idea. The id is stableId('idea', idea), so adding the same text
 * twice updates the row instead of duplicating it: scores, series and promise
 * are replaced, new sources are appended, and status, createdAt and any
 * package link are kept. Demand must be resolved (no DEMAND_AUTO).
 */
export function addIdea(store: Store, input: AddIdeaInput): IdeaDoc {
  const idea = input.idea.trim()
  if (!idea) throw new Error('an idea needs text')
  const now = input.now ?? new Date()
  const scores = checkScores(input.scores)
  const id = ideaId(idea)
  const existing = store.get('ideas', id)
  const { sources } = mergeSources(existing?.sources ?? [], input.sources ?? [])
  const doc: IdeaDoc = IdeaDoc.parse({
    ...(existing ?? {}),
    id,
    idea: existing?.idea ?? idea,
    topicKey: ideaTopicKey(idea),
    sources,
    scores,
    status: existing?.status ?? 'banked',
    weakestAxis: weakestAxis(scores),
    promise: input.promise ?? existing?.promise,
    series: input.series ?? existing?.series,
    sequelOf: input.sequelOf ?? existing?.sequelOf,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    source: input.source ?? existing?.source ?? 'cli',
  })
  return store.upsert('ideas', doc)
}

export type BankSortKey = 'total' | 'demand' | 'updatedAt' | 'createdAt' | 'idea'

export interface ListIdeasOptions {
  /** One status or several. Default: every status except retired. */
  status?: IdeaStatus | IdeaStatus[]
  /** Default 'total' (highest first). 'demand' highest first; dates newest first; 'idea' alphabetical. */
  sortBy?: BankSortKey
  /**
   * Pin sequel candidates (sequelOf set, still banked or green) to the front
   * of the queue; the playbook briefs the sequel before the new topic. Default true.
   */
  sequelFirst?: boolean
}

/** The bank with verdicts attached, filtered and sorted. */
export function listIdeas(store: Store, options: ListIdeasOptions = {}): BankRow[] {
  const sortBy = options.sortBy ?? 'total'
  const sequelFirst = options.sequelFirst ?? true
  const wanted = options.status === undefined ? undefined : new Set(Array.isArray(options.status) ? options.status : [options.status])
  const rows = store
    .read('ideas')
    .filter((d) => (wanted ? wanted.has(d.status) : d.status !== 'retired'))
    .map(attachVerdict)
  const isSequel = (r: BankRow) => r.sequelOf !== undefined && (r.status === 'banked' || r.status === 'green')
  const compare = (a: BankRow, b: BankRow): number => {
    switch (sortBy) {
      case 'total':
        return b.total - a.total || b.scores.demand - a.scores.demand || a.idea.localeCompare(b.idea)
      case 'demand':
        return b.scores.demand - a.scores.demand || b.total - a.total || a.idea.localeCompare(b.idea)
      case 'updatedAt':
        return b.updatedAt.localeCompare(a.updatedAt) || a.idea.localeCompare(b.idea)
      case 'createdAt':
        return b.createdAt.localeCompare(a.createdAt) || a.idea.localeCompare(b.idea)
      case 'idea':
        return a.idea.localeCompare(b.idea)
    }
  }
  return rows.sort((a, b) => (sequelFirst ? Number(isSequel(b)) - Number(isSequel(a)) : 0) || compare(a, b))
}

export interface SetStatusOptions {
  /** Why. Stored in `parkedReason` when parking or retiring (the schema's one reason field); cleared on reopen. */
  reason?: string
  source?: string
  now?: Date
}

/**
 * Move an idea along the lifecycle. Throws when the idea is missing, already
 * in that status, or the transition is not in LIFECYCLE (retired is terminal).
 */
export function setStatus(store: Store, id: string, status: IdeaStatus, options: SetStatusOptions = {}): IdeaDoc {
  const doc = store.get('ideas', id)
  if (!doc) throw new Error(`no idea with id "${id}" in the bank`)
  if (doc.status === status) throw new Error(`"${doc.idea}" is already ${status}`)
  if (!canTransition(doc.status, status)) {
    const allowed = LIFECYCLE[doc.status]
    throw new Error(`cannot move "${doc.idea}" from ${doc.status} to ${status}: ${allowed.length ? `allowed: ${allowed.join(', ')}` : 'retired is final'}`)
  }
  const now = options.now ?? new Date()
  const next: IdeaDoc = { ...doc, status, updatedAt: now.toISOString(), source: options.source ?? doc.source }
  if (status === 'parked' || status === 'retired') {
    if (options.reason) next.parkedReason = options.reason
  } else if (doc.status === 'parked') {
    delete next.parkedReason
  }
  return store.upsert('ideas', IdeaDoc.parse(next))
}

/** A ranked outlier row as rescore() reads it; OutlierRow and OutlierRowV2 both qualify. */
export type RescoreRow = DemandRow

export interface RescoreOptions {
  now?: Date
  /** Rows published more than this many days ago are ignored. Default thresholds.demandWindowDays (90). */
  windowDays?: number
  /** Days without new evidence before demand decays by one. Default DEMAND_DECAY_DAYS (180). */
  decayDays?: number
  source?: string
}

export interface RescoreMatch {
  id: string
  idea: string
  topicKey: string
  /** Sources appended this run. */
  added: IdeaSource[]
  demand: { before: number; after: number }
  /** What the accumulated evidence proves, from ideas.suggestDemand. */
  reason: string
}

export interface RescoreReport {
  /** Rows in the scan. */
  scanned: number
  /** Rows inside the window (undated rows count as inside). */
  inWindow: number
  matched: RescoreMatch[]
  reopened: Array<{ id: string; idea: string; note: string }>
  decayed: Array<{ id: string; idea: string; from: number; to: number }>
  /** Ideas examined that neither gained evidence, reopened, nor decayed. */
  unchanged: number
  windowDays: number
  decayDays: number
}

function sourceRow(s: IdeaSource): DemandRow {
  const row: DemandRow = { title: s.title, multiplier: s.multiplier ?? 0 }
  if (s.channel !== undefined) row.channel = s.channel
  if (s.date !== undefined) row.published = s.date
  if (s.url !== undefined) row.url = s.url
  return row
}

/** The most recent date evidence arrived: the latest parseable source date, else createdAt. */
function lastEvidenceAt(doc: IdeaDoc): number {
  const dates = doc.sources.map((s) => (s.date ? Date.parse(s.date) : Number.NaN)).filter((t) => !Number.isNaN(t))
  return dates.length ? Math.max(...dates) : Date.parse(doc.createdAt)
}

/**
 * Bring the bank up to date with an outlier scan. For every idea still in
 * play (not published or retired):
 *   - rows inside the window whose topic key equals the idea's are appended
 *     as sources (deduplicated by title and channel);
 *   - demand rises to what the accumulated in-window evidence proves
 *     (ideas.suggestDemand over the idea's sources); it never falls here;
 *   - a parked idea reopens to banked when a new source is at or above
 *     thresholds.demandMatchMultiplier (5x);
 *   - a queued idea (banked, green, parked) with no new source this run and
 *     nothing newer than `decayDays` (latest source date or updatedAt) loses
 *     one point of demand, floor 0, and its updatedAt moves to `now` so the
 *     next decay is another `decayDays` away.
 * Everything is written in one pass. The report says what changed.
 */
export function rescore(store: Store, ranked: ReadonlyArray<RescoreRow>, options: RescoreOptions = {}): RescoreReport {
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? thresholds.demandWindowDays.value
  const decayDays = options.decayDays ?? DEMAND_DECAY_DAYS
  const strongX = thresholds.demandMatchMultiplier.value
  const nowIso = now.toISOString()

  const fresh = ranked.filter((r) => {
    const age = ageInDays(r.published, now)
    return age === undefined || age <= windowDays
  })
  const byKey = new Map<string, RescoreRow[]>()
  for (const row of fresh) {
    const key = topicKey(row.title)
    if (!key) continue
    byKey.set(key, [...(byKey.get(key) ?? []), row])
  }

  const report: RescoreReport = { scanned: ranked.length, inWindow: fresh.length, matched: [], reopened: [], decayed: [], unchanged: 0, windowDays, decayDays }
  const docs = store.read('ideas')
  let changed = false
  const next = docs.map((doc): IdeaDoc => {
    if (doc.status === 'published' || doc.status === 'retired') return doc
    const key = doc.topicKey ?? ideaTopicKey(doc.idea)
    const hits = key ? (byKey.get(key) ?? []) : []
    const incoming: IdeaSource[] = hits.map((r) => {
      const s: IdeaSource = { title: r.title, multiplier: r.multiplier }
      if (r.channel !== undefined) s.channel = r.channel
      if (r.published !== undefined) s.date = r.published
      if (r.url !== undefined) s.url = r.url
      return s
    })
    const { sources, added } = mergeSources(doc.sources, incoming)
    let out: IdeaDoc = doc
    let touched = false

    if (added.length > 0) {
      const suggestion = suggestDemand(doc.idea, sources.map(sourceRow), { windowDays, now })
      const before = doc.scores.demand
      const after = Math.max(before, suggestion.score)
      out = { ...out, sources, topicKey: key, scores: { ...out.scores, demand: after }, weakestAxis: weakestAxis({ ...out.scores, demand: after }) }
      report.matched.push({ id: doc.id, idea: doc.idea, topicKey: key, added, demand: { before, after }, reason: suggestion.reason })
      touched = true
      const strongest = added.reduce((m, s) => Math.max(m, s.multiplier ?? 0), 0)
      if (doc.status === 'parked' && strongest >= strongX) {
        const best = added.find((s) => (s.multiplier ?? 0) === strongest) as IdeaSource
        const note = `reopened: "${best.title}"${best.channel ? ` (${best.channel})` : ''} at ${strongest.toFixed(1)}x is a fresh >= ${strongX}x match on ${key}`
        out = { ...out, status: 'banked' }
        delete out.parkedReason
        report.reopened.push({ id: doc.id, idea: doc.idea, note })
      }
    } else if (QUEUE_STATUSES.includes(doc.status) && doc.scores.demand > 0) {
      const staleSince = Math.max(lastEvidenceAt(doc), Date.parse(doc.updatedAt))
      const staleDays = (now.getTime() - staleSince) / 86_400_000
      if (staleDays >= decayDays) {
        const from = doc.scores.demand
        const to = Math.max(0, from - 1)
        out = { ...out, scores: { ...out.scores, demand: to }, weakestAxis: weakestAxis({ ...out.scores, demand: to }) }
        report.decayed.push({ id: doc.id, idea: doc.idea, from, to })
        touched = true
      }
    }

    if (!touched) {
      report.unchanged += 1
      return doc
    }
    changed = true
    return IdeaDoc.parse({ ...out, updatedAt: nowIso, source: options.source ?? out.source })
  })
  if (changed) store.writeAll('ideas', next.sort((a, b) => a.id.localeCompare(b.id)))
  return report
}

export interface SequelOptions {
  now?: Date
  /** Own-winner bar. Default thresholds.ownWinnerMultiplier (5x the channel's 168-hour median). */
  multiplier?: number
  source?: string
}

/**
 * Sequel-first: for every own winner in the ledger (ledger.ownOutliers) that
 * has no sequel yet, bank "Sequel: <title>" with demand 5, the other axes at
 * SEQUEL_HUMAN_AXIS_SCORE, the winner as its source, and `sequelOf` = the
 * winner's slug. A winner already has a sequel when an idea carries its slug
 * in `sequelOf` (any status) or a ledger row does. Returns the ideas created.
 */
export function sequelCandidates(store: Store, ledgerRows: LedgerRow[], options: SequelOptions = {}): IdeaDoc[] {
  const now = options.now ?? new Date()
  const winners = ownOutliers(ledgerRows, options.multiplier ?? thresholds.ownWinnerMultiplier.value)
  const covered = new Set<string>([
    ...store.read('ideas').map((d) => d.sequelOf).filter((s): s is string => s !== undefined),
    ...ledgerRows.map((r) => r.sequelOf).filter((s): s is string => s !== undefined),
  ])
  const created: IdeaDoc[] = []
  for (const { row, multiple } of winners) {
    if (covered.has(row.slug)) continue
    covered.add(row.slug)
    const s = SEQUEL_HUMAN_AXIS_SCORE
    created.push(addIdea(store, {
      idea: `Sequel: ${row.title}`,
      scores: { demand: 5, packaging: s, fit: s, angle: s, payoff: s, feasibility: s },
      sources: [{ title: row.title, multiplier: Math.round(multiple * 100) / 100, channel: 'own', date: row.publishedAt }],
      sequelOf: row.slug,
      source: options.source,
      now,
    }))
  }
  return created
}

export interface WipWarning {
  stage: 'packaging' | 'production'
  count: number
  cap: number
  evidence: string
  message: string
}

/**
 * Work-in-progress caps as warnings, never blocks: packaging over
 * thresholds.wipPackaging, production over thresholds.wipProduction.
 * Empty when both stages are within their caps.
 */
export function wipWarnings(store: Store): WipWarning[] {
  const docs = store.read('ideas')
  const out: WipWarning[] = []
  const check = (stage: WipWarning['stage'], key: 'wipPackaging' | 'wipProduction') => {
    const count = docs.filter((d) => d.status === stage).length
    const t = thresholds[key]
    if (count > t.value) {
      out.push({ stage, count, cap: t.value, evidence: t.evidence, message: `${count} ideas in ${stage}, cap ${t.value} [${t.evidence}]: finish one before starting another` })
    }
  }
  check('packaging', 'wipPackaging')
  check('production', 'wipProduction')
  return out
}

export interface ImportOptions {
  /** Who wrote them: 'cli', 'desk', or 'agent:<name>'. Default 'agent:idea-engine' for the engine shape, 'cli' otherwise. */
  source?: string
  now?: Date
}

/** Fields of an `ai idea-engine` idea the schema has no column for, returned so the CLI can print them. */
export interface ImportedIdea {
  id: string
  idea: string
  status: IdeaStatus
  /** 'added' for a new row, 'updated' when the id already existed. */
  outcome: 'added' | 'updated'
  workingTitle?: string
  thumbnailConcept?: string
  angle?: string
}

export interface ImportReport {
  imported: ImportedIdea[]
  skipped: Array<{ index: number; reason: string }>
}

interface EngineIdea {
  idea: string
  working_title?: string
  thumbnail_concept?: string
  demand_evidence?: string
  angle?: string
  scores: IdeaScore
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isEngineIdea(x: Record<string, unknown>): x is Record<string, unknown> & EngineIdea {
  return typeof x.idea === 'string' && isRecord(x.scores) && ('working_title' in x || 'demand_evidence' in x || 'thumbnail_concept' in x)
}

/**
 * Import ideas from JSON: the object `booster ai idea-engine --json` prints
 * ({ideas: [{idea, working_title, thumbnail_concept, demand_evidence, angle,
 * scores}]}), a plain array of IdeaDoc rows (a Desk or ledger export; missing
 * timestamps default to `now`, a missing id is derived from the text, and an
 * existing row keeps its status), or `{ideas: IdeaDoc[]}`. A JSON string is
 * parsed first. Engine ideas keep `demand_evidence` as their first source;
 * working title, thumbnail concept and angle have no column and come back in
 * the report. Rows that fail validation are skipped with the reason, never
 * thrown, so one bad idea does not stop the batch.
 */
export function importIdeas(store: Store, json: unknown, options: ImportOptions = {}): ImportReport {
  const now = options.now ?? new Date()
  const parsed: unknown = typeof json === 'string' ? JSON.parse(json) : json
  const items: unknown[] = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.ideas) ? parsed.ideas : []
  if (items.length === 0 && !(Array.isArray(parsed) || (isRecord(parsed) && Array.isArray(parsed.ideas)))) {
    throw new Error('expected {ideas: [...]} (booster ai idea-engine --json) or an array of ideas')
  }
  const report: ImportReport = { imported: [], skipped: [] }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      report.skipped.push({ index, reason: 'not an object' })
      return
    }
    try {
      if (isEngineIdea(item)) {
        const existed = store.get('ideas', ideaId(item.idea)) !== undefined
        const sources: IdeaSource[] = item.demand_evidence ? [{ title: item.demand_evidence, channel: 'idea-engine' }] : []
        const doc = addIdea(store, { idea: item.idea, scores: item.scores, sources, source: options.source ?? 'agent:idea-engine', now })
        const entry: ImportedIdea = { id: doc.id, idea: doc.idea, status: doc.status, outcome: existed ? 'updated' : 'added' }
        if (typeof item.working_title === 'string') entry.workingTitle = item.working_title
        if (typeof item.thumbnail_concept === 'string') entry.thumbnailConcept = item.thumbnail_concept
        if (typeof item.angle === 'string') entry.angle = item.angle
        report.imported.push(entry)
        return
      }
      const ideaText = typeof item.idea === 'string' ? item.idea.trim() : ''
      if (!ideaText) throw new Error('missing idea text')
      const id = typeof item.id === 'string' && item.id ? item.id : ideaId(ideaText)
      const existing = store.get('ideas', id)
      const candidate = IdeaDoc.parse({
        ...(existing ?? {}),
        ...item,
        id,
        idea: existing?.idea ?? ideaText,
        topicKey: ideaTopicKey(existing?.idea ?? ideaText),
        status: existing?.status ?? item.status ?? 'banked',
        createdAt: existing?.createdAt ?? item.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        source: options.source ?? item.source ?? existing?.source ?? 'cli',
      })
      const scores = checkScores(candidate.scores)
      const { sources } = mergeSources(existing?.sources ?? [], candidate.sources)
      const doc = store.upsert('ideas', IdeaDoc.parse({ ...candidate, scores, sources, weakestAxis: weakestAxis(scores) }))
      report.imported.push({ id: doc.id, idea: doc.idea, status: doc.status, outcome: existing ? 'updated' : 'added' })
    } catch (err) {
      report.skipped.push({ index, reason: err instanceof Error ? err.message : String(err) })
    }
  })
  return report
}
