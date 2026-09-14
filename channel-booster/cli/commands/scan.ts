/** Commands: outliers, audit. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readVideoRows } from '../../src/csv.js'
import {
  computeOutliers,
  formatLift,
  median,
  FRESH_MAX_AGE_DAYS,
  FRESH_VELOCITY_MULTIPLIER,
  type OutlierRowV2,
} from '../../src/outliers.js'
import { diffScans, saturation, topicDemand, SATURATION_SHARE, SCAN_DIFF_MIN_DELTA, type ScanDiff } from '../../src/topics.js'
import { thresholds } from '../../src/thresholds.js'
import { bool, fmt, getStore, nowFrom, num, out, str, warn, type CommandModule, type Flags } from '../shared.js'

/** Contract for data/last-scan.json (outliers) and data/last-audit.json (audit), read by --diff and written by --save. */
export interface SavedScan {
  scannedAt: string
  sinceDays: number
  ranked: OutlierRowV2[]
}

function readSavedScan(file: string): SavedScan | undefined {
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON; expected a scan written by --save`)
  }
  const doc = raw as Partial<SavedScan> | null
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.ranked)) {
    throw new Error(`${file} is not a saved scan: expected { scannedAt, sinceDays, ranked[] }`)
  }
  return { scannedAt: String(doc.scannedAt ?? ''), sinceDays: Number(doc.sinceDays ?? 0), ranked: doc.ranked as OutlierRowV2[] }
}

/**
 * `--save <path>`, or bare `--save`, which lands in the store directory so
 * `--data` picks the location. `outliers` (competitors) and `audit` (your own
 * uploads) rank different video sets, so each has its own default name: a bare
 * `audit --save` must never overwrite the competitor scan `--diff`, `direction`
 * and `bank rescore` read. A bare file name lands in the store too; a path with
 * a separator in it is the caller naming a directory, so it stays cwd-relative.
 */
function savePathFrom(flags: Flags, cmd: string): string | undefined {
  const v = flags.save
  if (v === undefined || v === false) return undefined
  const root = getStore(flags).root
  if (typeof v === 'string' && v !== 'true') return /[\\/]/.test(v) ? path.resolve(v) : path.join(root, v)
  return path.join(root, cmd === 'audit' ? 'last-audit.json' : 'last-scan.json')
}

/**
 * `--diff <path>`: the path as given, then the store copy, then the bare file
 * name inside the store — the same order `booster direction --scan` resolves,
 * so "data/last-scan.json" from the repo root finds the scan a bare `--save`
 * wrote under `--data`. Nothing on disk gives back the path as given, which is
 * what the "no previous scan" warning then names.
 */
function diffPathFrom(flags: Flags): string | undefined {
  // `--diff` with no value parses as a boolean and used to print nothing at all.
  if (flags.diff === true) throw new Error('--diff needs the scan to compare against: --diff last-scan.json (the file a previous --save wrote)')
  const v = str(flags, 'diff')
  if (v === undefined) return undefined
  const root = getStore(flags).root
  const candidates = [...new Set([path.resolve(v), path.resolve(root, v), path.resolve(root, path.basename(v))])]
  return candidates.find((f) => existsSync(f)) ?? candidates[0]
}

function velocityCell(r: OutlierRowV2): string {
  return r.velocityMultiplier === undefined ? '    —' : `${r.velocityMultiplier.toFixed(1).padStart(4)}x`
}

function rankedLines(rows: OutlierRowV2[]): string[] {
  const lines = ['Rank  Mult   Tier     Vel    Flag   Views    Formats                     Title']
  rows.forEach((r, i) => {
    lines.push(
      `${String(i + 1).padStart(4)}  ${r.multiplier.toFixed(1).padStart(5)}x ${r.tier.padEnd(8)} ${velocityCell(r)}  ${(r.stale ? 'stale' : '').padEnd(6)} ${fmt(r.views).padStart(7)}  ${r.formats.slice(0, 3).join(',').padEnd(27)} ${r.title}`,
    )
  })
  return lines
}

function diffLines(diff: ScanDiff<OutlierRowV2>, prev: SavedScan, top: number, file: string): string[] {
  const when = prev.scannedAt ? ` (scanned ${prev.scannedAt}, window ${prev.sinceDays}d)` : ''
  const lines = [
    `Since last scan${when}: ${diff.added.length} new, ${diff.removed.length} gone, ${diff.changed.length} moved by >= ${SCAN_DIFF_MIN_DELTA}x [house]`,
    `  read from ${file}`,
  ]
  if (diff.added.length) {
    lines.push('  New:')
    for (const r of diff.added.slice(0, top)) lines.push(`    + ${r.multiplier.toFixed(1)}x ${r.tier.padEnd(8)} ${r.channel ?? 'default'} · ${r.title}`)
  }
  if (diff.removed.length) {
    lines.push('  Gone:')
    for (const r of diff.removed.slice(0, top)) lines.push(`    - ${r.multiplier.toFixed(1)}x ${(r.tier ?? '').padEnd(8)} ${r.channel ?? 'default'} · ${r.title}`)
  }
  if (diff.changed.length) {
    lines.push('  Moved:')
    for (const c of diff.changed.slice(0, top)) {
      const tier = c.tierBefore && c.tierAfter && c.tierBefore !== c.tierAfter ? ` (${c.tierBefore} -> ${c.tierAfter})` : ''
      lines.push(`    ${c.delta >= 0 ? '↑' : '↓'} ${c.before.toFixed(1)}x -> ${c.after.toFixed(1)}x${tier} ${c.row.channel ?? 'default'} · ${c.row.title}`)
    }
  }
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) lines.push('  Nothing moved.')
  return lines
}

export const scanModule: CommandModule = {
  verbs: ['outliers', 'audit'],
  help: [
    'outliers <csv> [--threshold 10] [--min-age-days 7] [--top 20]     rank videos by views / channel median',
    '   [--since 90] [--fresh] [--by topic] [--saturation]                demand window, momentum-only view, topic table, format saturation',
    '   [--diff <last-scan.json>] [--save [<path>]] [--now ISO]           what moved since the last scan; save this one (bare --save writes <data>/last-scan.json)',
    'audit <csv> [--threshold 5] [--since 90] [--fresh] [--by topic]    audit your own uploads (same flags as outliers; bare --save writes <data>/last-audit.json)',
  ],
  async run(cmd, sub, _rest, flags) {
    const file = sub
    if (!file) throw new Error(`usage: booster ${cmd} <csv> [--since 90] [--fresh] [--by topic] [--diff <path>] [--save <path>] [--saturation]`)
    const rows = readVideoRows(readFileSync(file, 'utf8'))
    const now = nowFrom(flags)
    const threshold = num(flags, 'threshold') ?? (cmd === 'audit' ? 5 : 10)
    const minAgeDays = num(flags, 'min-age-days') ?? 7
    const sinceDays = num(flags, 'since') ?? thresholds.demandWindowDays.value
    if (sinceDays <= 0) throw new Error(`--since must be a positive number of days, got ${sinceDays}`)
    const top = num(flags, 'top') ?? 20
    const freshOnly = bool(flags, 'fresh')
    const byTopic = str(flags, 'by') === 'topic' || bool(flags, 'by-topic')
    const wantSaturation = bool(flags, 'saturation')
    const diffPath = diffPathFrom(flags)
    const savePath = savePathFrom(flags, cmd)

    const ranked = computeOutliers(rows, { threshold, minAgeDays, sinceDays, now })
    const fresh = ranked.filter((r) => r.tier === 'fresh')
    const stale = ranked.filter((r) => r.stale)
    // --fresh is the momentum view: stale rows drop out and fresh-tier rows lead, fastest first.
    const shown = freshOnly
      ? [...ranked].filter((r) => !r.stale).sort((a, b) => Number(b.tier === 'fresh') - Number(a.tier === 'fresh') || (b.velocityMultiplier ?? 0) - (a.velocityMultiplier ?? 0) || b.multiplier - a.multiplier)
      : ranked
    const lifts = formatLift(ranked)
    const channels = [...new Set(rows.map((r) => r.channel ?? 'default'))]
    const summary = channels.map((c) => {
      const own = rows.filter((r) => (r.channel ?? 'default') === c)
      const inWindow = ranked.filter((r) => (r.channel ?? 'default') === c && !r.stale).length
      return { channel: c, videos: own.length, inWindow, median: median(own.map((r) => r.views)) }
    })
    const topics = byTopic ? topicDemand(ranked) : undefined
    const sat = wantSaturation ? saturation(ranked, sinceDays, now) : undefined

    let prev: SavedScan | undefined
    let diff: ScanDiff<OutlierRowV2> | null | undefined
    if (diffPath) {
      prev = readSavedScan(diffPath)
      if (prev) diff = diffScans(prev.ranked, ranked)
      else {
        diff = null
        warn(`booster ${cmd}: no previous scan at ${diffPath}; nothing to diff (add --save ${diffPath} to start one)`)
      }
    }

    const scannedAt = now.toISOString()
    if (savePath) {
      mkdirSync(path.dirname(savePath), { recursive: true })
      const doc: SavedScan = { scannedAt, sinceDays, ranked }
      writeFileSync(savePath, `${JSON.stringify(doc, null, 2)}\n`)
    }

    const result: Record<string, unknown> = {
      threshold,
      sinceDays,
      scannedAt,
      minAgeDays,
      summary,
      ranked: shown.slice(0, top),
      fresh,
      staleCount: stale.length,
      formatLift: lifts,
    }
    if (topics) result.topics = topics
    if (diff !== undefined) result.diff = diff
    if (diffPath) result.diffedFrom = diffPath
    if (sat) result.saturation = sat
    if (savePath) result.savedTo = savePath

    out(result, flags, () => {
      const lines = [
        `${cmd === 'audit' ? 'Channel audit' : 'Outlier scan'} · threshold ${threshold}x · window ${sinceDays}d · ${rows.length} videos (${stale.length} stale, ${fresh.length} fresh) · as of ${scannedAt.slice(0, 10)}`,
        '',
      ]
      for (const s of summary) lines.push(`  ${s.channel}: ${s.videos} videos (${s.inWindow} in window), median ${fmt(s.median)} views`)
      lines.push('')
      if (freshOnly) lines.push(`Momentum view: ${stale.length} stale rows hidden, fresh tier first.`)
      lines.push(...rankedLines(shown.slice(0, top)))
      if (fresh.length) {
        lines.push('', `Fresh momentum (age <= ${FRESH_MAX_AGE_DAYS}d, velocity >= ${FRESH_VELOCITY_MULTIPLIER}x channel median [house]):`)
        for (const r of fresh) lines.push(`  ${velocityCell(r)} ${(r.channel ?? 'default').padEnd(14)} ${r.title}`)
      }
      if (topics) {
        lines.push('', 'Topic demand (ranked rows grouped by topic key; three channels on one topic is demand):')
        lines.push('  Best   Rows  Fresh  Stale  Channels                  Topic              Best title')
        for (const t of topics.slice(0, top)) {
          lines.push(`  ${t.bestMultiplier.toFixed(1).padStart(5)}x ${String(t.count).padStart(4)}  ${String(t.fresh).padStart(5)}  ${String(t.stale).padStart(5)}  ${t.channels.join(',').slice(0, 24).padEnd(24)}  ${t.topicKey.slice(0, 18).padEnd(18)} ${t.bestTitle}`)
        }
        if (!topics.length) lines.push('  No topic keys: every title is format words only.')
      }
      if (diff) lines.push('', ...diffLines(diff, prev as SavedScan, top, diffPath as string))
      if (sat) {
        lines.push('', `Format saturation (share of channels carrying a format inside ${sinceDays}d; >= ${Math.round(SATURATION_SHARE * 100)}% is a copy, not a trend [house]):`)
        for (const s of sat) lines.push(`  ${s.format.padEnd(15)} ${String(s.channels).padStart(2)}/${s.totalChannels} channels  ${Math.round(s.share * 100).toString().padStart(3)}%${s.saturated ? '  saturated' : ''}`)
        if (!sat.length) lines.push(`  No in-window title carries a format cue; widen --since or wait for the next scan.`)
      }
      lines.push('', 'Format lift among winners (smoothed lift: share in winners ÷ share overall, Laplace-smoothed; thin = fewer than 3 titles [house]):')
      for (const l of lifts.slice(0, 8)) lines.push(`  ${l.format.padEnd(15)} lift ${l.lift.toFixed(2)}  (${Math.round(l.shareInWinners * 100)}% of winners, ${Math.round(l.shareOverall * 100)}% overall, ${l.winners}/${l.count} titles${l.thin ? ', thin' : ''})`)
      if (cmd === 'audit') {
        const winners = ranked.filter((r) => r.tier !== 'normal')
        lines.push('', winners.length ? `Your proven formats: ${[...new Set(winners.flatMap((w) => w.formats))].join(', ')}. Brief a sequel to each winner before trying a new topic.` : `No video is ${threshold}x your median yet: the next win is a packaging win, not a production win.`)
      }
      if (savePath) lines.push('', `Saved scan to ${savePath}`)
      return lines.join('\n')
    })
    return 0
  },
}
