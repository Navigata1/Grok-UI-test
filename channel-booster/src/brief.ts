/**
 * The weekly (or daily) brief (architecture 2.16): the one page a person
 * reads on Monday. Everything on it is derived from the store and the
 * profile; every item ends in the one command that acts on it, so the brief
 * is a to-do list, never a report.
 *
 * Sections, in reading order: reads due, decisions awaiting a person,
 * experiments to close, rules that changed, alerts (baseline shift, loyalty
 * drift, stale inbox, WIP over cap, cadence over `maxPerWeek`), idea movers,
 * and the next three ideas the bank ranks highest.
 *
 * Pure: only `type Store` is imported, nothing reads the clock or the
 * filesystem (inbox state arrives as file names), so the module runs in the
 * Desk's browser bundle with a Store-shaped object.
 */
import { listIdeas, wipWarnings } from './bank.js'
import type { Bucket } from './buckets.js'
import { TEST_RULES } from './experiments.js'
import { baselineFrom, dueReads, readLedger } from './ledger.js'
import type { Baselines, DecisionDoc, IdeaDoc, LedgerRow, ProfileDoc, RuleDoc, Stat } from './schema.js'
import type { Store } from './store.js'
import { slugify } from './workflow.js'

/**
 * [house] Returning-viewer share under this multiple of baseline on the last
 * two 7-day reads is loyalty drift. Belongs in thresholds.ts as
 * `loyaltyDriftRel`; declared here because brief.ts does not own that file.
 */
export const LOYALTY_DRIFT_REL = 0.8

/**
 * [house] With reads due and no Studio export in the inbox, numbers older
 * than this many days mean the review loop has stalled. Belongs in
 * thresholds.ts as `inboxStaleDays`.
 */
export const INBOX_STALE_DAYS = 14

/** How many ideas the brief proposes for the next sprint (the WIP cap on greens). */
export const NEXT_IDEAS = 3

export type BriefWindow = 'week' | 'today'

/** Every brief line: what it is, and the one command that acts on it. */
export interface BriefItem {
  text: string
  command: string
}

export interface ReadDueItem extends BriefItem {
  slug: string
  bucket: Bucket
  overdueHours: number
}

export interface DecisionItem extends BriefItem {
  id: string
  slug: string
  bucket: Bucket
  decision: DecisionDoc['decision']
  /** `approve` when nobody has approved it; `apply` when approved but not yet applied in Studio. */
  stage: 'approve' | 'apply'
  flipCondition?: string
}

export interface ExperimentItem extends BriefItem {
  id: string
  slug: string
  hoursRunning: number
  /** Past the hour floor (TEST_RULES; the cold-start floor when the channel has no baseline). */
  ready: boolean
}

export interface RuleItem extends BriefItem {
  id: string
  rule: string
  status: RuleDoc['status']
  tests: number
  wins: number
  confidence: number
}

export type AlertKind = 'baseline-shift' | 'loyalty-drift' | 'inbox-stale' | 'wip-over-cap' | 'cadence-over-cap'

export interface Alert extends BriefItem {
  kind: AlertKind
}

export interface IdeaMover extends BriefItem {
  id: string
  idea: string
  status: IdeaDoc['status']
  total: number
  verdict: 'green' | 'yellow' | 'red'
  updatedAt: string
}

export interface NextIdea extends BriefItem {
  rank: number
  id: string
  idea: string
  status: IdeaDoc['status']
  total: number
  verdict: 'green' | 'yellow' | 'red'
  weakestAxis: string
}

export interface Brief {
  window: BriefWindow
  /** Start of the window (7 days or 24 hours before `now`). */
  from: string
  /** `now`. */
  to: string
  readsDue: ReadDueItem[]
  decisionsAwaiting: DecisionItem[]
  experimentsToClose: ExperimentItem[]
  rulesChanged: RuleItem[]
  alerts: Alert[]
  ideaMovers: IdeaMover[]
  nextThree: NextIdea[]
}

export interface BriefOptions {
  now: Date
  profile: ProfileDoc
  /** `week` (default) looks back 7 days; `today` 24 hours. Reads due, decisions and alerts ignore the window. */
  window?: BriefWindow
  /** Names of the files currently in `inbox/`, for the stale-inbox alert. Omit to skip that alert. */
  inboxFiles?: readonly string[]
}

const DAY_MS = 86_400_000

const STAT_KEYS = ['ctr', 'avpPct', 'retention30sPct', 'returningPct', 'views', 'impressions'] as const

/**
 * True when verdicts run on the cold-start priors: no baselines, tier
 * `prior`, or no CTR/AVP median. The same rule as
 * `profile.baselineInputFrom(profile).source === 'default'`, kept local so
 * this module stays free of profile.ts and its node:fs import.
 */
export function isColdStart(profile: ProfileDoc): boolean {
  const b = profile.baselines
  return b === undefined || b.tier === 'prior' || (b.ctr === undefined && b.avpPct === undefined)
}

/** Metrics whose median moved by more than the current MAD since `previous`; the same rule as `profile.shiftedMetrics`. */
function movedMetrics(next: Baselines, previous: Baselines | undefined): string[] {
  if (!previous) return []
  const out: string[] = []
  for (const key of STAT_KEYS) {
    const a: Stat | undefined = next[key]
    const b: Stat | undefined = previous[key]
    if (a && b && a.mad > 0 && Math.abs(a.median - b.median) > a.mad) out.push(key)
  }
  return out
}

function pct(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

function inWindow(iso: string, from: Date, to: Date): boolean {
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t >= from.getTime() && t <= to.getTime()
}

/** The typed numbers a bucket's read needs, for the `booster set` hint. */
function setHint(slug: string, bucket: Bucket): string {
  const base = `booster set ${slug} --bucket ${bucket} --impressions N --ctr X --avp Y`
  if (bucket === '48') return `${base} --ret30 Z --returning W`
  // The 7-day read carries a lever, and writing a lever is a human-only gate: print the --yes the command asks for rather than a line that stops at the gate.
  if (bucket === '168' || bucket === '672') return `${base} --views V --returning W${bucket === '168' ? ' --lever "<one sentence of learning>" --yes' : ''}`
  return base
}

function readsDueItems(rows: LedgerRow[], now: Date): ReadDueItem[] {
  return dueReads(rows, now).map((d) => ({
    slug: d.slug,
    bucket: d.bucket,
    overdueHours: d.overdueHours,
    text: `${d.slug} at ${d.bucket} h, ${d.overdueHours} h overdue`,
    command: `drop the Studio export in inbox/ then booster review run, or ${setHint(d.slug, d.bucket)}`,
  }))
}

function decisionItems(store: Store): DecisionItem[] {
  const ideas = store.read('ideas')
  const sequelIdea = (slug: string) => ideas.find((i) => i.sequelOf === slug && (i.status === 'banked' || i.status === 'green'))
  const out: DecisionItem[] = []
  for (const d of store.read('decisions')) {
    if (d.decision === 'HOLD' || d.decision === 'WAIT' || d.appliedAt) continue
    const stage: DecisionItem['stage'] = d.approvedAt ? 'apply' : 'approve'
    let command: string
    let text: string
    switch (d.decision) {
      case 'REPACKAGE':
        text = stage === 'approve' ? `${d.id}: REPACKAGE awaits approval (thumbnail first)` : `${d.id}: REPACKAGE approved by ${d.approvedBy ?? 'someone'}, swap not yet applied in Studio`
        command = stage === 'approve' ? `booster repackage prepare ${d.slug} then booster decide approve ${d.slug} --bucket ${d.bucket} --by <name> --yes` : `apply the swap in Studio, then booster decide apply ${d.slug} --bucket ${d.bucket} --by <name> --yes`
        break
      case 'RE-TEST-TITLE':
        text = stage === 'approve' ? `${d.id}: RE-TEST-TITLE awaits approval (Test & Compare on the title, thumbnail stays)` : `${d.id}: title test approved by ${d.approvedBy ?? 'someone'}, not yet started`
        command = stage === 'approve' ? `booster decide approve ${d.slug} --bucket ${d.bucket} --by <name> --yes` : `start Test & Compare in Studio, then booster decide apply ${d.slug} --bucket ${d.bucket} --by <name> --yes`
        break
      case 'SEQUEL': {
        const idea = sequelIdea(d.slug)
        text = `${d.id}: SEQUEL ${stage === 'approve' ? 'awaits approval' : 'approved'}; brief the sequel this week`
        command = idea ? `booster bank approve ${idea.id} --yes` : 'booster bank rescore <competitors.csv> (creates the sequel candidate) then booster bank approve <id> --yes'
        break
      }
      case 'EXPAND':
        text = `${d.id}: EXPAND ${stage === 'approve' ? 'awaits approval' : 'approved'}; bank two adjacent angles on the topic`
        command = `booster bank add "<adjacent angle>" --score "demand=5,packaging=..,fit=..,angle=..,payoff=..,feasibility=.."`
        break
      case 'PARK':
        text = `${d.id}: PARK ${stage === 'approve' ? 'awaits approval' : 'approved'}; park the topic with the weakest axis named`
        command = `booster bank park <idea-id> --reason "no audience at ${d.bucket} h" then booster decide approve ${d.slug} --bucket ${d.bucket} --by <name> --yes`
        break
    }
    out.push({ id: d.id, slug: d.slug, bucket: d.bucket, decision: d.decision, stage, flipCondition: d.flipCondition, text, command })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function experimentItems(store: Store, profile: ProfileDoc, now: Date): ExperimentItem[] {
  const coldStart = isColdStart(profile)
  const minHours = coldStart ? TEST_RULES.coldStartMinHours.value : TEST_RULES.minHours.value
  return store
    .read('experiments')
    .filter((e) => e.outcome === undefined)
    .map((e) => {
      const hoursRunning = Math.max(0, Math.round((now.getTime() - Date.parse(e.startedAt)) / 3_600_000))
      const ready = hoursRunning >= minHours
      return {
        id: e.id,
        slug: e.slug,
        hoursRunning,
        ready,
        text: `${e.id} (${e.kind}, ${e.variants.map((v) => v.name).join(' vs ')}) running ${hoursRunning} h: ${ready ? `past the ${minHours} h floor, judge it` : `under the ${minHours} h floor${coldStart ? ' (cold start)' : ''}, wait ${minHours - hoursRunning} h`}`,
        // `test judge` takes --slug and needs both arms; the wait is in the text, so the command stays something a person can paste.
        command: ready ? `type the Test & Compare panel, then booster test judge --slug ${e.slug} --a "<impressions>,<ctr>,<share>" --b "<impressions>,<ctr>,<share>" --hours ${hoursRunning} --record` : 'booster brief --today',
      }
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready) || b.hoursRunning - a.hoursRunning)
}

function ruleItems(store: Store, from: Date, to: Date): RuleItem[] {
  return store
    .read('rules')
    .filter((r) => inWindow(r.updatedAt, from, to))
    .map((r) => ({
      id: r.id,
      rule: r.rule,
      status: r.status,
      tests: r.tests,
      wins: r.wins,
      confidence: r.confidence,
      text: `"${r.rule}" is ${r.status} (${r.tests} test${r.tests === 1 ? '' : 's'}, ${r.wins} win${r.wins === 1 ? '' : 's'}, confidence ${r.confidence.toFixed(2)})`,
      command: r.status === 'candidate'
        ? `booster retro --accept-rule "${r.rule}" --into playbook/<file>.md --yes, or leave it to earn tests`
        : r.status === 'retired'
          ? 'booster rules compile (drops it from playbook/00-learned-rules.md); pin it only with a reason'
          : 'booster rules compile (refreshes playbook/00-learned-rules.md)',
    }))
    .sort((a, b) => b.confidence - a.confidence || a.rule.localeCompare(b.rule))
}

function alertItems(store: Store, rows: LedgerRow[], profile: ProfileDoc, now: Date, inboxFiles: readonly string[] | undefined): Alert[] {
  const out: Alert[] = []
  const b = profile.baselines
  if (b?.shift) {
    const moved = movedMetrics(b, profile.previousBaselines)
    out.push({
      kind: 'baseline-shift',
      text: `Baseline shifted by more than one MAD since the previous refresh${moved.length ? ` (${moved.join(', ')})` : ''}; every verdict now compares against the new medians`,
      command: 'booster profile show, then acknowledge with booster profile refresh (after a deliberate strategy change, booster profile refresh --window <n> drops the older rows from the median)',
    })
  }
  const withReturning = rows.filter((r) => r.reads['168']?.returningPct !== undefined)
  if (withReturning.length >= 2) {
    const baseline = b?.returningPct?.median ?? baselineFrom(rows, { bucket: '168', now }).returningPct?.median
    const n = b?.returningPct?.n ?? baselineFrom(rows, { bucket: '168', now }).returningPct?.n ?? 0
    if (baseline !== undefined && baseline > 0 && n >= 3) {
      const [last, prev] = withReturning
      const lastRel = (last.reads['168']!.returningPct as number) / baseline
      const prevRel = (prev.reads['168']!.returningPct as number) / baseline
      if (lastRel < LOYALTY_DRIFT_REL && prevRel < LOYALTY_DRIFT_REL) {
        out.push({
          kind: 'loyalty-drift',
          text: `Loyalty drift: returning share on the last two videos is ${pct(last.reads['168']!.returningPct as number)} (${last.slug}) and ${pct(prev.reads['168']!.returningPct as number)} (${prev.slug}), both under ${LOYALTY_DRIFT_REL}x the ${pct(baseline)} baseline [house]`,
          command: 'booster retro --since 14d: name what changed for the returning viewer, and brief the next video for them, not for strangers',
        })
      }
    }
  }
  if (inboxFiles !== undefined) {
    const csv = inboxFiles.filter((f) => f.toLowerCase().endsWith('.csv'))
    const due = dueReads(rows, now)
    if (csv.length === 0 && due.length > 0) {
      const lastAt = rows.flatMap((r) => Object.values(r.reads)).map((read) => (read ? Date.parse(read.at) : Number.NaN)).filter((t) => !Number.isNaN(t))
      const staleMs = INBOX_STALE_DAYS * DAY_MS
      const stale = lastAt.length ? now.getTime() - Math.max(...lastAt) >= staleMs : due.some((d) => d.overdueHours * 3_600_000 >= staleMs)
      if (stale) {
        out.push({
          kind: 'inbox-stale',
          text: `No Studio export in inbox/ and no numbers recorded for ${INBOX_STALE_DAYS} days [house] while ${due.length} read${due.length === 1 ? ' is' : 's are'} due; the loop has stalled`,
          command: 'Studio > Analytics > Content > Advanced mode > Export CSV into inbox/, then booster review run',
        })
      }
    }
  }
  for (const w of wipWarnings(store)) {
    out.push({
      kind: 'wip-over-cap',
      text: w.message,
      command: w.stage === 'packaging' ? 'booster workflow run <slug> --next on the oldest package, or booster bank park <id> --reason "over WIP"' : 'finish the edit: booster workflow run <slug> --next',
    })
  }
  const perWeek = profile.maxPerWeek
  if (perWeek > 0) {
    const windowDays = perWeek >= 1 ? 7 : 7 / perWeek
    const cap = perWeek >= 1 ? perWeek : 1
    const published = rows.filter((r) => now.getTime() - Date.parse(r.publishedAt) <= windowDays * DAY_MS && Date.parse(r.publishedAt) <= now.getTime())
    if (published.length > cap) {
      out.push({
        kind: 'cadence-over-cap',
        text: `${published.length} uploads in the last ${Math.round(windowDays)} days against a cap of ${cap} (maxPerWeek ${perWeek}); fewer, better uploads`,
        // `profile init` is a create, not an edit: on a channel that has a profile it exits 1, and --force rewrites the file from the init answers alone, dropping positioning, persona, series and the rest. Cadence is raised by hand.
        command: 'hold the next publish a week, or raise the cap on purpose: edit maxPerWeek in channel.json by hand (raising the cap is a human-only gate, and only with the trailing four rows at 0.9x baseline CTR)',
      })
    }
  }
  return out
}

function moverCommand(idea: IdeaDoc): string {
  const slug = slugify(idea.idea.replace(/^\s*sequel\s*:\s*/i, ''))
  switch (idea.status) {
    case 'green':
      return `booster package build ${idea.id}`
    case 'packaging':
    case 'production':
      return `booster workflow run ${slug} --next`
    case 'published':
      return 'booster review due'
    case 'parked':
      return `booster bank rescore <competitors.csv> reopens it on a fresh outlier; or booster bank list --status parked`
    case 'retired':
      return 'booster bank list --status retired'
    case 'banked':
      return `booster bank approve ${idea.id} --yes (or booster bank park ${idea.id} --reason "<weakest axis>")`
  }
}

function ideaMoverItems(store: Store, from: Date, to: Date): IdeaMover[] {
  return listIdeas(store, { status: ['banked', 'green', 'packaging', 'production', 'published', 'parked', 'retired'], sortBy: 'updatedAt', sequelFirst: false })
    .filter((i) => inWindow(i.updatedAt, from, to))
    .filter((i) => i.status !== 'banked' || Date.parse(i.createdAt) >= from.getTime())
    .map((i) => ({
      id: i.id,
      idea: i.idea,
      status: i.status,
      total: i.total,
      verdict: i.verdict.verdict,
      updatedAt: i.updatedAt,
      text: `"${i.idea}" ${i.status === 'banked' ? 'new in the bank' : `moved to ${i.status}`}${i.parkedReason ? ` (${i.parkedReason})` : ''} · ${i.total}/100 ${i.verdict.verdict}`,
      command: moverCommand(i),
    }))
}

function nextThreeItems(store: Store): NextIdea[] {
  return listIdeas(store, { status: ['green', 'banked'] })
    .slice(0, NEXT_IDEAS)
    .map((i, n) => ({
      rank: n + 1,
      id: i.id,
      idea: i.idea,
      status: i.status,
      total: i.total,
      verdict: i.verdict.verdict,
      weakestAxis: i.weakestAxis,
      text: `${i.idea} · ${i.total}/100 ${i.verdict.verdict}, ${i.status}${i.sequelOf ? ` (sequel of ${i.sequelOf})` : ''}; weakest axis ${i.weakestAxis}`,
      command: i.status === 'green' ? `booster package build ${i.id}` : i.verdict.verdict === 'green' ? `booster bank approve ${i.id} --yes` : `${i.verdict.fixes[0] ?? `raise ${i.weakestAxis}`}; then booster bank approve ${i.id} --yes`,
    }))
}

/**
 * Build the brief from the store and the profile. `readsDue`,
 * `decisionsAwaiting`, `experimentsToClose`, `alerts` and `nextThree` describe
 * the state now; `rulesChanged` and `ideaMovers` are limited to the window.
 * Pure and deterministic for a given store, profile and `now`.
 */
export function buildBrief(store: Store, options: BriefOptions): Brief {
  const { now, profile } = options
  const window = options.window ?? 'week'
  const from = new Date(now.getTime() - (window === 'week' ? 7 : 1) * DAY_MS)
  const rows = readLedger(store)
  return {
    window,
    from: from.toISOString(),
    to: now.toISOString(),
    readsDue: readsDueItems(rows, now),
    decisionsAwaiting: decisionItems(store),
    experimentsToClose: experimentItems(store, profile, now),
    rulesChanged: ruleItems(store, from, now),
    alerts: alertItems(store, rows, profile, now, options.inboxFiles),
    ideaMovers: ideaMoverItems(store, from, now),
    nextThree: nextThreeItems(store),
  }
}

function section(title: string, items: readonly BriefItem[], empty: string): string[] {
  const lines = [`## ${title}${items.length ? ` (${items.length})` : ''}`, '']
  if (items.length === 0) lines.push(`- ${empty}`)
  for (const i of items) lines.push(`- ${i.text} — do: \`${i.command}\``)
  lines.push('')
  return lines
}

/** The brief as Markdown: one section per list, one line per item, each ending in its command. */
export function renderBriefMarkdown(brief: Brief): string {
  const title = brief.window === 'week' ? 'Weekly brief' : 'Daily brief'
  const lines = [`# ${title} · ${brief.to.slice(0, 10)}`, '', `Window: ${brief.from.slice(0, 16).replace('T', ' ')} to ${brief.to.slice(0, 16).replace('T', ' ')} UTC.`, '']
  lines.push(...section('Reads due', brief.readsDue, 'nothing due'))
  lines.push(...section('Decisions awaiting a person', brief.decisionsAwaiting, 'nothing to approve or apply'))
  lines.push(...section('Experiments to close', brief.experimentsToClose, 'no open Test & Compare'))
  lines.push(...section('Rules changed', brief.rulesChanged, 'no rule moved in the window'))
  lines.push(...section('Alerts', brief.alerts, 'none'))
  lines.push(...section('Idea movers', brief.ideaMovers, 'no idea changed status in the window'))
  // Only green and banked ideas feed this list, so an empty list is not an empty bank: say which ideas are missing, not that the store is.
  lines.push(...section('Next three', brief.nextThree, 'no idea is banked or green (ideas in packaging or production do not count): booster bank add "<idea>" --score "..."'))
  return lines.join('\n').trimEnd() + '\n'
}
