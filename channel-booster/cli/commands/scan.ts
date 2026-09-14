/** Commands: outliers, audit. */
import { readFileSync } from 'node:fs'
import { readVideoRows } from '../../src/csv.js'
import { computeOutliers, formatLift, median } from '../../src/outliers.js'
import { fmt, num, out, type CommandModule } from '../shared.js'

export const scanModule: CommandModule = {
  verbs: ['outliers', 'audit'],
  help: [
    'outliers <csv> [--threshold 10] [--min-age-days 7] [--top 20]     rank videos by views / channel median',
    'audit <csv> [--threshold 5]                                        audit your own uploads',
  ],
  async run(cmd, sub, _rest, flags) {
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
      lines.push('', 'Format lift among winners (smoothed: share in winners ÷ share overall):')
      for (const l of lifts.slice(0, 8)) lines.push(`  ${l.format.padEnd(15)} lift ${l.lift.toFixed(2)}  (${Math.round(l.shareInWinners * 100)}% of winners, ${Math.round(l.shareOverall * 100)}% overall)`)
      if (cmd === 'audit') {
        const winners = ranked.filter((r) => r.tier !== 'normal')
        lines.push('', winners.length ? `Your proven formats: ${[...new Set(winners.flatMap((w) => w.formats))].join(', ')}. Brief a sequel to each winner before trying a new topic.` : 'No video is 5x your median yet: the next win is a packaging win, not a production win.')
      }
      return lines.join('\n')
    })
    return 0
  },
}
