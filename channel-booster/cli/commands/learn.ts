/**
 * Commands: review due | run, brief, retro, rules compile | show.
 *
 * The scheduled half of the system (architecture 2.16 and 2.17). `review run`
 * is what the six-hourly routine calls: ingest inbox/, diagnose every read
 * that is due, record decisions, prepare swaps, write the day's JSON and a
 * digest; with --slug and --bucket it is the workflow's review-48 and
 * postmortem stage and writes packages/<slug>/review-<bucket>.json. `brief`
 * is the Monday page. `retro` drafts the weekly retro and, with
 * --accept-rule, is the only writer to a playbook file (human-only gate: it
 * needs --yes). `rules compile` turns the ledger into 00-learned-rules.md,
 * whose compiled rules are hypotheses under observation: what it prints says
 * so, and never calls one doctrine.
 *
 * The inbox, packages/ and the channel playbook folder resolve like every
 * other location (src/workspace.ts): an explicit flag, then the workspace,
 * then the legacy default. The ai engines read the same playbook folder from
 * the same flags, so what `rules compile` writes is what they load.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildBrief, renderBriefMarkdown } from '../../src/brief.js'
import { BUCKETS, type Bucket } from '../../src/buckets.js'
import { readLedger } from '../../src/ledger.js'
import { acceptRule, buildRetro, formatRuleLine, planPlaybookWrite, renderRetroMarkdown } from '../../src/retro.js'
import { dueReviews, renderDigest, runReviews } from '../../src/review.js'
import { compileRules, describeRule, isProtected, refuseInstalledPlaybook, renderLearnedRules, sortRules, statusLabel, writeLearnedRules, LEARNED_RULES_FILE } from '../../src/rules.js'
import { stableId, type RuleDoc } from '../../src/schema.js'
import { resolvePlaybookDir, type Located } from '../../src/workspace.js'
import { bool, getProfile, getStore, inboxDir, list, need, nowFrom, num, out, packagesRoot, playbookDir, str, type CommandModule, type Flags } from '../shared.js'

const USAGE_REVIEW = 'booster review due [--now ISO] | booster review run [--slug <slug> --bucket 24|48|168|672] [--inbox dir] [--out dir] [--root dir] [--agent <name>] [--now ISO]'
const USAGE_BRIEF = 'booster brief [--week | --today] [--inbox dir] [--out brief.md] [--now ISO]'
const USAGE_RETRO = 'booster retro [--since 7d|30d|YYYY-MM-DD] [--out retro.md] [--now ISO]'
const USAGE_ACCEPT = 'booster retro --accept-rule "<rule>" --into playbook/<file>.md [--slugs a,b] [--by <name>] --yes'
const USAGE_RULES = 'booster rules compile [--half-life 90] [--promote-tests 3] [--promote-win-rate 0.6] [--retire-win-rate 0.35] [--playbook dir] [--agent <name>] | booster rules show'

/** `--agent <name>` as the store's source `agent:<name>`; the schema allows letters, digits, _ and - only. */
function sourceFrom(flags: Flags): string {
  const agent = str(flags, 'agent')
  if (agent === undefined) return 'cli'
  if (!/^[a-z0-9_-]+$/i.test(agent)) throw new Error(`--agent must be letters, digits, _ or - (stored as "agent:<name>"), got "${agent}"`)
  return `agent:${agent}`
}

function bucketFrom(flags: Flags, usage: string): Bucket | undefined {
  const v = str(flags, 'bucket')
  if (v === undefined) return undefined
  if (!(BUCKETS as readonly string[]).includes(v)) throw new Error(`--bucket must be one of ${BUCKETS.join('|')}, got "${v}". Usage: ${usage}`)
  return v as Bucket
}

function writeText(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`)
}

// ---------------------------------------------------------------- review

async function reviewDue(flags: Flags): Promise<number> {
  const now = nowFrom(flags)
  const store = getStore(flags)
  const due = dueReviews(store, now)
  const value = { now: now.toISOString(), due: due.map((d) => ({ slug: d.slug, bucket: d.bucket, overdueHours: d.overdueHours, title: d.row.title, videoId: d.row.videoId })) }
  out(value, flags, () => {
    if (due.length === 0) return renderDigest({ date: now.toISOString().slice(0, 10), reviews: [], awaitingData: [] }, { rows: readLedger(store), now }).split('\n')[2] ?? 'Nothing due.'
    return [
      `${due.length} read${due.length === 1 ? '' : 's'} due:`,
      ...due.map((d) => `  ${d.slug} at ${d.bucket} h, ${d.overdueHours} h overdue · ${d.row.title}`),
      '',
      'Drop the Studio export in inbox/ and run booster review run, or type the numbers: booster set <slug> --bucket <b> --impressions N --ctr X --avp Y',
    ].join('\n')
  })
  return 0
}

async function reviewRun(flags: Flags): Promise<number> {
  const now = nowFrom(flags)
  const store = getStore(flags)
  const profile = getProfile(flags)
  const slug = str(flags, 'slug')
  const bucket = bucketFrom(flags, USAGE_REVIEW)
  if (bucket && !slug) throw new Error(`--bucket needs --slug. Usage: ${USAGE_REVIEW}`)
  const inbox = inboxDir(flags)
  const root = packagesRoot(flags)
  const result = runReviews(store, {
    now,
    profile,
    inboxDir: existsSync(inbox) ? inbox : undefined,
    outDir: path.resolve(str(flags, 'out') ?? path.join(store.root, 'reviews')),
    packagesDir: path.join(root, 'packages'),
    slug,
    bucket,
    source: sourceFrom(flags),
  })
  // The workflow stages gate on packages/<slug>/review-<bucket>.json: it is written only when the
  // review ran on real numbers and reached a decision (or a person already applied one), so a
  // stage cannot pass on a missing read or a WAIT. Otherwise exit 1 and say what is missing.
  let stageFile: string | undefined
  let blocked: string | undefined
  if (slug && bucket) {
    const review = result.reviews.find((r) => r.slug === slug && r.bucket === bucket)
    const decision = store.get('decisions', `${slug}:${bucket}`)
    // The 7-day form carries a lever, and writing a lever needs --yes: print the flag so the blocked stage names a line that runs.
    const setHint = `booster set ${slug} --bucket ${bucket} --impressions N --ctr X --avp Y${bucket === '48' ? ' --ret30 Z --returning W' : bucket === '168' ? ' --views V --returning W --lever "<sentence>" --yes' : ''}`
    if (!review) {
      // runReviews leaves out a bucket a person already applied: that stage is done.
      if (decision?.appliedAt) {
        stageFile = path.join(root, 'packages', slug, `review-${bucket}.json`)
        writeText(stageFile, JSON.stringify({ slug, bucket, pass: true, date: result.date, reviewedAt: now.toISOString(), review: null, decision, digest: result.digest }, null, 2))
      } else {
        blocked = `${slug}:${bucket}: nothing was reviewed; drop the Studio export in inbox/ or type the numbers: ${setHint}`
      }
    } else if (review.readAt === undefined) {
      blocked = `${slug}:${bucket}: no numbers yet; drop the Studio export in inbox/ or type them: ${setHint}`
    } else if (review.decision.decision === 'WAIT') {
      blocked = `${slug}:${bucket}: decision is WAIT${review.decision.flipCondition ? ` (${review.decision.flipCondition})` : ''}; the stage file is not written until a decision is made`
    } else {
      stageFile = path.join(root, 'packages', slug, `review-${bucket}.json`)
      writeText(stageFile, JSON.stringify({ slug, bucket, pass: true, date: result.date, reviewedAt: now.toISOString(), review, digest: result.digest }, null, 2))
    }
  }
  out({ ...result, stageFile: stageFile ?? null, blocked: blocked ?? null }, flags, () => [
    result.digest,
    ...(result.outFile ? [`Wrote ${result.outFile}`] : []),
    ...(stageFile ? [`Wrote ${stageFile}`] : []),
    ...(blocked ? [`Stage not passed: ${blocked}`] : []),
  ].join('\n'))
  return blocked ? 1 : 0
}

// ---------------------------------------------------------------- brief

async function runBrief(flags: Flags): Promise<number> {
  if (bool(flags, 'week') && bool(flags, 'today')) throw new Error(`pick --week or --today, not both. Usage: ${USAGE_BRIEF}`)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const profile = getProfile(flags)
  const inbox = inboxDir(flags)
  const inboxFiles = existsSync(inbox) ? readdirSync(inbox).filter((f) => !f.startsWith('.')) : []
  const brief = buildBrief(store, { now, profile, window: bool(flags, 'today') ? 'today' : 'week', inboxFiles })
  const md = renderBriefMarkdown(brief)
  const outFile = str(flags, 'out')
  if (outFile) writeText(path.resolve(outFile), md)
  out(brief, flags, () => (outFile ? `${md.trimEnd()}\n\nWrote ${path.resolve(outFile)}` : md))
  return 0
}

// ---------------------------------------------------------------- retro

/** `--since 7d`, `--since 30d` or `--since YYYY-MM-DD` (UTC midnight); default seven days back. */
function sinceFrom(flags: Flags, now: Date): Date {
  const raw = str(flags, 'since') ?? '7d'
  const days = /^(\d+)d$/.exec(raw)
  if (days) return new Date(now.getTime() - Number(days[1]) * 86_400_000)
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw)
  if (Number.isNaN(d.getTime())) throw new Error(`--since must be Nd (7d, 30d) or an ISO date, got "${raw}". Usage: ${USAGE_RETRO}`)
  return d
}

/**
 * `--into` as a path inside the channel playbook folder: absolute,
 * `playbook/x.md`, `channel-booster/playbook/x.md` or bare `x.md`. Outside
 * the legacy source layout, `playbook/x.md` names this channel's x.md, never
 * the shipped file of that name.
 */
function intoFrom(into: string, folder: string): string {
  if (path.isAbsolute(into)) return path.relative(folder, into)
  const fromCwd = path.resolve(into)
  const rel = path.relative(folder, fromCwd)
  if (existsSync(fromCwd) && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  return into.replace(/^(?:\.\/)?(?:channel-booster\/)?playbook\//, '')
}

async function retroAccept(rule: string, flags: Flags): Promise<number> {
  const into = need(flags, 'into', USAGE_ACCEPT)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const folder = playbookDir(flags)
  const file = intoFrom(into, folder)
  const slugs = list(flags, 'slugs') ?? []
  const by = str(flags, 'by') ?? 'human'
  const text = rule.replace(/\s+/g, ' ').trim()
  if (!text) throw new Error(`a rule needs text. Usage: ${USAGE_ACCEPT}`)
  // The same checks acceptRule() makes, so the preview never names a file the --yes run would refuse.
  const target = planPlaybookWrite(folder, file)
  const line = formatRuleLine(text, slugs, now)
  const id = stableId('rule', text)
  const plan = { action: 'accept-rule', file: target.file, extends: target.extends ?? null, line, ruleId: id, acceptedBy: by, applied: false, needs: '--yes' }
  if (!bool(flags, 'yes')) {
    out(plan, flags, () => [
      target.extends ? `About to start ${target.file}, this channel's additions to the shipped ${target.extends}, and append:` : `About to append to ${target.file}:`,
      `  ${line}`,
      `and record rules/${id} as accepted by ${by} (protected from booster rules compile).`,
      'Accepting a playbook rule is a human-only decision (AGENTS.md).',
    ].join('\n'))
    throw new Error('nothing written. A person re-runs with --yes to accept the rule.')
  }
  const written = acceptRule(folder, file, text, { slugs, now })
  const doc: RuleDoc = {
    id,
    rule: text,
    tests: 0,
    wins: 0,
    confidence: 1,
    status: 'promoted',
    slugs,
    acceptedBy: by,
    pinned: false,
    updatedAt: now.toISOString(),
    source: sourceFrom(flags),
  }
  const existing = store.get('rules', id)
  store.upsert('rules', existing ? { ...existing, rule: text, status: 'promoted', slugs: [...new Set([...existing.slugs, ...slugs])], acceptedBy: by, updatedAt: now.toISOString() } : doc)
  out({ ...plan, applied: true, written }, flags, () => [
    `Accepted into ${written}:`,
    `  ${line}`,
    `Recorded rules/${id} (accepted by ${by}); booster rules compile keeps it.`,
    ...(target.extends ? [`The booster ai engines load ${written} after the shipped ${target.extends}.`] : []),
  ].join('\n'))
  return 0
}

async function runRetro(flags: Flags): Promise<number> {
  const rule = str(flags, 'accept-rule')
  if (rule !== undefined) return retroAccept(rule, flags)
  if (flags['accept-rule'] === true) throw new Error(`--accept-rule needs the rule text. Usage: ${USAGE_ACCEPT}`)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const retro = buildRetro(store, { since: sinceFrom(flags, now), now, profile: getProfile(flags) })
  const md = renderRetroMarkdown(retro)
  const outFile = str(flags, 'out')
  if (outFile) writeText(path.resolve(outFile), md)
  out(retro, flags, () => (outFile ? `${md.trimEnd()}\n\nWrote ${path.resolve(outFile)}` : md))
  return 0
}

// ---------------------------------------------------------------- rules

function ruleLine(r: RuleDoc): string {
  return `  ${describeRule(r)}`
}

/** Printed above any compiled rule a person sees: what the rules are, and the one way into the playbook. */
const OBSERVATION_NOTE = `Compiled rules are hypotheses under observation from this channel's own small sample, not doctrine. Only a person moves a rule into the playbook: ${USAGE_ACCEPT}`

/**
 * Where the ai engines pick up what `rules compile` wrote: they read the
 * channel playbook folder from the same flags and workspace, so name the
 * folder (`where`, as resolvePlaybookDir() found it) and how a run reaches
 * it again.
 */
export function enginesLoad(where: Located): string {
  const how = where.source === 'flag' ? `when they run with --playbook ${where.path}` : where.source === 'workspace' ? `from this workspace's playbook folder, ${where.path}` : `from ${where.path}`
  return `The booster ai engines load it ${how}, right after docs/02, as observations under test, not doctrine.`
}

async function rulesCompile(flags: Flags): Promise<number> {
  const where = resolvePlaybookDir(flags)
  // Before the compile touches the store, so a refused write leaves nothing half done.
  refuseInstalledPlaybook(where.path)
  const now = nowFrom(flags)
  const store = getStore(flags)
  const options = {
    now,
    halfLifeDays: num(flags, 'half-life'),
    promoteTests: num(flags, 'promote-tests'),
    promoteWinRate: num(flags, 'promote-win-rate'),
    retireWinRate: num(flags, 'retire-win-rate'),
    source: sourceFrom(flags),
  }
  for (const [key, flagName] of [['halfLifeDays', 'half-life'], ['promoteTests', 'promote-tests'], ['promoteWinRate', 'promote-win-rate'], ['retireWinRate', 'retire-win-rate']] as const) {
    if (options[key] === undefined && str(flags, flagName) !== undefined) throw new Error(`--${flagName} must be a number, got "${str(flags, flagName)}". Usage: ${USAGE_RULES}`)
  }
  const result = compileRules(store, options)
  const content = renderLearnedRules(result.rules, options)
  const written = writeLearnedRules(where.path, content)
  const accepted = result.rules.filter(isProtected)
  const observed = result.rules.filter((r) => !isProtected(r))
  const count = (status: RuleDoc['status']): number => observed.filter((r) => r.status === status).length
  out({ ...result, written, content }, flags, () => [
    `Compiled ${result.rules.length} rule${result.rules.length === 1 ? '' : 's'} from ${result.tested} tested row${result.tested === 1 ? '' : 's'}: ${count('promoted')} winning so far, ${count('retired')} losing so far, ${count('candidate')} under test${accepted.length ? `, ${accepted.length} accepted by a person` : ''}.`,
    ...(observed.length ? [OBSERVATION_NOTE] : []),
    ...(result.changes.length ? ['Changes:', ...result.changes.map((c) => `  ${c.lever}: ${statusLabel(c.from)} -> ${statusLabel(c.to)}`)] : ['No status changes since the last compile.']),
    ...[...accepted, ...observed.filter((r) => r.status === 'promoted')].map(ruleLine),
    `Wrote ${written} (${content.length} chars). ${enginesLoad(where)}`,
  ].join('\n'))
  return 0
}

async function rulesShow(flags: Flags): Promise<number> {
  const store = getStore(flags)
  const rules = sortRules(store.read('rules'))
  out({ rules, file: path.join(playbookDir(flags), LEARNED_RULES_FILE) }, flags, () => {
    if (rules.length === 0) return `No rules yet: run booster rules compile once the ledger has 7-day reads with levers, or accept one with ${USAGE_ACCEPT}`
    return [...(rules.some((r) => !isProtected(r)) ? [OBSERVATION_NOTE] : []), ...rules.map(ruleLine)].join('\n')
  })
  return 0
}

export const learnModule: CommandModule = {
  verbs: ['review', 'brief', 'retro', 'rules'],
  help: [
    'review due [--now ISO]                                             reads whose hour mark has passed with no numbers',
    'review run [--slug <slug> --bucket 24|48|168|672] [--inbox dir] [--out dir] [--root dir] [--agent <name>]   ingest inbox/, diagnose due reads, decide, prepare swaps; writes data/reviews/<date>.json (+ packages/<slug>/review-<bucket>.json with --slug, only once a real read reached a decision; exit 1 otherwise)',
    'brief [--week | --today] [--inbox dir] [--out brief.md]            the Monday page: reads due, decisions awaiting, tests to close, rule changes, alerts, next three',
    'retro [--since 7d|30d|YYYY-MM-DD] [--out retro.md]                 the weekly retro: published, levers, winners, losers, candidate rule, overrides',
    'retro --accept-rule ".." --into playbook/<file>.md [--slugs a,b] [--by <name>] --yes   accept a rule into the channel\'s playbook file (human-only gate; the only writer to playbook/*.md; in a workspace a shipped file\'s name starts the channel\'s copy of it)',
    'rules compile [--half-life 90] [--promote-tests 3] [--promote-win-rate 0.6] [--retire-win-rate 0.35] [--playbook dir] [--agent <name>]   compile the ledger into the channel playbook folder\'s 00-learned-rules.md: hypotheses under observation, not doctrine',
    'rules show                                                         every rule in the store: under observation, under test, or accepted by a person, with tests, wins, win rate and confidence',
  ],
  async run(cmd, sub, _rest, flags) {
    if (cmd === 'review') {
      if (sub === 'due') return reviewDue(flags)
      if (sub === 'run') return reviewRun(flags)
      throw new Error(`usage: ${USAGE_REVIEW}`)
    }
    if (cmd === 'brief') {
      if (sub !== undefined) throw new Error(`usage: ${USAGE_BRIEF}`)
      return runBrief(flags)
    }
    if (cmd === 'retro') {
      if (sub !== undefined && sub !== 'show') throw new Error(`usage: ${USAGE_RETRO} | ${USAGE_ACCEPT}`)
      return runRetro(flags)
    }
    if (sub === 'compile') return rulesCompile(flags)
    if (sub === 'show' || sub === undefined) return rulesShow(flags)
    throw new Error(`usage: ${USAGE_RULES}`)
  },
}
