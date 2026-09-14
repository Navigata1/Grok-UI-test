#!/usr/bin/env tsx
/**
 * booster: the YouTube Channel Booster command line.
 *
 * Deterministic engines run offline. `booster ai <engine>` adds Claude on top
 * and needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readVideoRows } from '../src/csv.js'
import { computeOutliers, formatLift, median } from '../src/outliers.js'
import { IDEA_AXIS_QUESTIONS, parseIdeaScore, scoreIdea } from '../src/ideas.js'
import { generateTitles, scoreTitle, titleThumbnailOverlap } from '../src/titles.js'
import { buildThumbnailBrief, qaThumbnail } from '../src/thumbnails.js'
import { diagnose } from '../src/postmortem.js'
import { buildCalendar, generateWorkflow, renderWorkflowMarkdown, weeklyCadence, WORKFLOW_FORMATS } from '../src/workflow.js'
import type { ThumbnailSpec, WorkflowFormat } from '../src/types.js'

export interface Args {
  positional: string[]
  flags: Record<string, string | boolean>
}

/** Flags that never take a value, so `--json "topic"` keeps "topic" positional. */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'md', 'offline', 'record', 'dry-run', 'fresh', 'solo', 'next', 'override', 'week', 'today'])

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function num(flags: Args['flags'], key: string): number | undefined {
  const v = str(flags, key)
  if (v === undefined) return undefined
  const n = Number.parseFloat(v)
  return Number.isNaN(n) ? undefined : n
}

function list(flags: Args['flags'], key: string): string[] | undefined {
  const v = str(flags, key)
  return v ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : undefined
}

function out(value: unknown, flags: Args['flags'], render: () => string): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  } else {
    process.stdout.write(`${render()}\n`)
  }
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`
}

const HELP = `booster: YouTube Channel Booster

  outliers <csv> [--threshold 10] [--min-age-days 7] [--top 20]     rank videos by views / channel median
  audit <csv> [--threshold 5]                                        audit your own uploads
  idea questions                                                     the six scorecard questions
  idea score "<idea>" --score "demand=4,packaging=3,fit=..."         verdict + fixes
  titles "<topic>" [--number ..] [--subject ..] [--audience ..]      generate and rank titles
  titles score "<title>"                                             score one title
  thumbnail brief "<idea>" --title ".." [--subject ..] [--stake ..] [--result ..]
  thumbnail qa --subject ".." --elements "a,b,c" [--emotion ..] [--text ..] [--background ..] [--colors "yellow,black"] [--title ..]
  package review --title ".." --thumb-text ".." [--elements ..]     title + thumbnail coherence
  workflow "<idea>" [--format talking-head] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]
  cadence                                                            the weekly operating rhythm
  calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14]
  postmortem --ctr 4.2 [--impressions N] [--avp 38] [--avd-sec ..] [--duration-sec ..] [--retention30 ..] [--hours 48] [--baseline-ctr ..] [--baseline-avp ..] [--baseline-views ..]
  ai <engine> ...                                                    Claude-powered engines (see: booster ai help)

Add --json to any command for machine-readable output.
`

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [cmd, sub, ...rest] = positional
  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(HELP)
    return 0
  }

  switch (cmd) {
    case 'outliers':
    case 'audit': {
      const file = sub
      if (!file) throw new Error(`usage: booster ${cmd} <csv>`)
      const rows = readVideoRows(readFileSync(file, 'utf8'))
      const threshold = num(flags, 'threshold') ?? (cmd === 'audit' ? 5 : 10)
      const ranked = computeOutliers(rows, { threshold, minAgeDays: num(flags, 'min-age-days') ?? 7 })
      const top = num(flags, 'top') ?? 20
      const lifts = formatLift(ranked)
      const channels = [...new Set(rows.map((r) => r.channel ?? 'default'))]
      const summary = channels.map((c) => ({ channel: c, videos: rows.filter((r) => (r.channel ?? 'default') === c).length, median: median(rows.filter((r) => (r.channel ?? 'default') === c).map((r) => r.views)) }))
      out({ threshold, summary, ranked: ranked.slice(0, top), formatLift: lifts }, flags, () => {
        const lines = [`${cmd === 'audit' ? 'Channel audit' : 'Outlier scan'} · threshold ${threshold}x · ${rows.length} videos`, '']
        for (const s of summary) lines.push(`  ${s.channel}: ${s.videos} videos, median ${fmt(s.median)} views`)
        lines.push('', 'Rank  Mult   Tier     Views    Formats                     Title')
        ranked.slice(0, top).forEach((r, i) => {
          lines.push(`${String(i + 1).padStart(4)}  ${r.multiplier.toFixed(1).padStart(5)}x ${r.tier.padEnd(8)} ${fmt(r.views).padStart(7)}  ${r.formats.slice(0, 3).join(',').padEnd(27)} ${r.title}`)
        })
        lines.push('', 'Format lift among winners (share in winners ÷ share overall):')
        for (const l of lifts.slice(0, 8)) lines.push(`  ${l.format.padEnd(15)} lift ${l.lift.toFixed(2)}  (${Math.round(l.shareInWinners * 100)}% of winners, ${Math.round(l.shareOverall * 100)}% overall)`)
        if (cmd === 'audit') {
          const winners = ranked.filter((r) => r.tier !== 'normal')
          lines.push('', winners.length ? `Your proven formats: ${[...new Set(winners.flatMap((w) => w.formats))].join(', ')}. Brief a sequel to each winner before trying a new topic.` : 'No video is 5x your median yet: the next win is a packaging win, not a production win.')
        }
        return lines.join('\n')
      })
      return 0
    }

    case 'idea': {
      if (sub === 'questions') {
        out(IDEA_AXIS_QUESTIONS, flags, () => Object.entries(IDEA_AXIS_QUESTIONS).map(([k, v]) => `${k.padEnd(12)} ${v}`).join('\n'))
        return 0
      }
      if (sub === 'score') {
        const idea = rest[0] ?? '(untitled idea)'
        const scoreText = str(flags, 'score')
        if (!scoreText) throw new Error('usage: booster idea score "<idea>" --score "demand=4,packaging=3,fit=4,angle=3,payoff=4,feasibility=5"')
        const verdict = scoreIdea(parseIdeaScore(scoreText))
        out({ idea, ...verdict }, flags, () => [
          `Idea: ${idea}`,
          `Total ${verdict.total}/100 · verdict ${verdict.verdict.toUpperCase()}`,
          ...Object.entries(verdict.score).map(([k, v]) => `  ${k.padEnd(12)} ${'█'.repeat(v)}${'·'.repeat(5 - v)} ${v}/5`),
          ...(verdict.fixes.length ? ['', 'Fix first:', ...verdict.fixes.map((f) => `  - ${f}`)] : ['', 'No axis below 3. Move it to the packaging sprint.']),
        ].join('\n'))
        return 0
      }
      throw new Error('usage: booster idea questions | booster idea score "<idea>" --score ...')
    }

    case 'titles': {
      if (sub === 'score') {
        const title = rest[0]
        if (!title) throw new Error('usage: booster titles score "<title>"')
        const s = scoreTitle(title)
        out({ title, ...s }, flags, () => [`"${title}"`, `Score ${s.score}/100`, ...s.notes.map((n) => `  - ${n}`)].join('\n'))
        return 0
      }
      const topic = sub
      if (!topic) throw new Error('usage: booster titles "<topic>" [--number ..] [--subject ..] [--audience ..]')
      const candidates = generateTitles({ topic, number: str(flags, 'number'), subject: str(flags, 'subject'), audience: str(flags, 'audience') })
      out(candidates, flags, () => ['Score  Formula               Title', ...candidates.map((c) => `${String(c.score).padStart(5)}  ${c.formula.padEnd(21)} ${c.title}`), '', 'Pick two: the highest score and the one most different from it. Then write three of your own that beat both.'].join('\n'))
      return 0
    }

    case 'thumbnail': {
      if (sub === 'brief') {
        const idea = rest[0]
        const title = str(flags, 'title')
        if (!idea || !title) throw new Error('usage: booster thumbnail brief "<idea>" --title "<title>" [--subject ..] [--stake ..] [--result ..]')
        const brief = buildThumbnailBrief(idea, title, { subject: str(flags, 'subject'), stake: str(flags, 'stake'), result: str(flags, 'result') })
        out(brief, flags, () => [
          `Thumbnail brief · ${idea}`, `Title: ${title}`, '',
          ...brief.concepts.flatMap((c, i) => [`${i + 1}. ${c.name} (${c.angle})`, `   focal: ${c.focalSubject}`, `   support: ${c.supportingElement}`, `   text: ${c.text || '(none)'}`, `   composition: ${c.composition}`, `   why: ${c.whyItWorks}`, '']),
          'Rules:', ...brief.rules.map((r) => `  - ${r}`), '', 'QA before export:', ...brief.qaChecklist.map((r) => `  - ${r}`), '', 'Test plan:', ...brief.testPlan.map((r) => `  - ${r}`),
        ].join('\n'))
        return 0
      }
      if (sub === 'qa') {
        const spec: ThumbnailSpec = {
          focalSubject: str(flags, 'subject') ?? '',
          emotion: str(flags, 'emotion'),
          elements: list(flags, 'elements') ?? [],
          text: str(flags, 'text'),
          background: str(flags, 'background'),
          colors: list(flags, 'colors'),
          title: str(flags, 'title'),
        }
        const qa = qaThumbnail(spec)
        out({ spec, ...qa }, flags, () => [`Thumbnail QA · ${qa.score}/100 · ${qa.grade.toUpperCase()}`, ...qa.passes.map((p) => `  ✓ ${p}`), ...qa.failures.map((f) => `  ✕ ${f}`), ...(qa.fixes.length ? ['', 'Fixes:', ...qa.fixes.map((f) => `  - ${f}`)] : [])].join('\n'))
        return 0
      }
      throw new Error('usage: booster thumbnail brief ... | booster thumbnail qa ...')
    }

    case 'package': {
      const title = str(flags, 'title')
      const thumbText = str(flags, 'thumb-text') ?? ''
      if (!title) throw new Error('usage: booster package review --title ".." --thumb-text ".." [--elements "a,b,c"]')
      const t = scoreTitle(title)
      const overlap = titleThumbnailOverlap(title, thumbText)
      const elements = list(flags, 'elements') ?? []
      const issues: string[] = []
      if (t.score < 60) issues.push('title scores under 60: rewrite before testing the thumbnail')
      if (overlap >= 0.67) issues.push('thumbnail text repeats the title: the pair says one thing twice instead of two things once')
      if (thumbText.split(/\s+/).filter(Boolean).length > 3) issues.push('thumbnail text is longer than three words')
      if (elements.length > 3) issues.push(`thumbnail has ${elements.length} elements; cut to three`)
      const verdict = issues.length === 0 ? 'pass' : issues.length === 1 ? 'revise' : 'fail'
      out({ title, thumbText, titleScore: t.score, overlap, verdict, issues, titleNotes: t.notes }, flags, () => [`Packaging review · ${verdict.toUpperCase()}`, `Title ${t.score}/100 · overlap ${Math.round(overlap * 100)}%`, ...t.notes.map((n) => `  · ${n}`), ...(issues.length ? ['', 'Issues:', ...issues.map((i) => `  - ${i}`)] : ['', 'Title tells, thumbnail shows. Ship it to Test & Compare.'])].join('\n'))
      return 0
    }

    case 'workflow': {
      const idea = sub
      if (!idea) throw new Error('usage: booster workflow "<idea>" [--format ..] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]')
      const format = (str(flags, 'format') ?? 'talking-head') as WorkflowFormat
      if (!WORKFLOW_FORMATS.includes(format)) throw new Error(`format must be one of ${WORKFLOW_FORMATS.join(', ')}`)
      const wf = generateWorkflow(idea, { format, days: num(flags, 'days') })
      const kickoffText = str(flags, 'kickoff')
      const kickoff = kickoffText ? new Date(`${kickoffText}T00:00:00Z`) : undefined
      const md = renderWorkflowMarkdown(wf, kickoff)
      const dir = str(flags, 'out')
      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, `${wf.slug}.md`), md)
        writeFileSync(path.join(dir, `${wf.slug}.json`), `${JSON.stringify(wf, null, 2)}\n`)
        process.stderr.write(`wrote ${path.join(dir, wf.slug)}.md and .json\n`)
      }
      out(wf, flags, () => md)
      return 0
    }

    case 'cadence': {
      const rituals = weeklyCadence()
      out(rituals, flags, () => rituals.map((r) => [`${r.when} · ${r.name} (${r.owner}, ${r.minutes} min)`, ...r.agenda.map((a) => `  - ${a}`)].join('\n')).join('\n\n'))
      return 0
    }

    case 'calendar': {
      const ideas = list(flags, 'ideas')
      const start = str(flags, 'start')
      if (!ideas || !start) throw new Error('usage: booster calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14]')
      const slots = buildCalendar(ideas, new Date(`${start}T00:00:00Z`), num(flags, 'per-week') ?? 1, num(flags, 'cycle-days') ?? 14)
      out(slots, flags, () => ['Publish     Kickoff     Idea', ...slots.map((s) => `${s.date}  ${s.kickoff}  ${s.idea}`)].join('\n'))
      return 0
    }

    case 'postmortem': {
      const d = diagnose({
        impressions: num(flags, 'impressions'),
        ctr: num(flags, 'ctr'),
        views: num(flags, 'views'),
        avdSec: num(flags, 'avd-sec'),
        durationSec: num(flags, 'duration-sec'),
        avpPct: num(flags, 'avp'),
        retention30sPct: num(flags, 'retention30'),
        hoursSincePublish: num(flags, 'hours'),
        baseline: { ctr: num(flags, 'baseline-ctr'), avpPct: num(flags, 'baseline-avp'), views: num(flags, 'baseline-views') },
      })
      out(d, flags, () => [`Bottleneck: ${d.bottleneck.toUpperCase()}${d.repackage ? ' · REPACKAGE NOW' : ''}`, d.headline, '', ...d.evidence.map((e) => `  · ${e}`), '', 'Do this:', ...d.actions.map((a) => `  - ${a}`)].join('\n'))
      return 0
    }

    case 'ai': {
      const { runAiCommand } = await import('../src/ai/index.js')
      return runAiCommand(sub, rest, flags)
    }

    default:
      throw new Error(`unknown command "${cmd}". Run booster help.`)
  }
}

export { main }

const invokedDirectly = process.argv[1] !== undefined && /booster\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`booster: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
