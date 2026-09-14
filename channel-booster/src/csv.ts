import type { VideoRow } from './types.js'

/** Column aliases accepted for each VideoRow field (case-insensitive, punctuation-insensitive). */
const ALIASES: Record<keyof VideoRow, string[]> = {
  title: ['title', 'video', 'name', 'videotitle'],
  views: ['views', 'viewcount', 'view_count', 'totalviews', 'plays'],
  published: ['published', 'publishedat', 'date', 'uploaddate', 'upload_date', 'publishdate', 'publish_date', 'videopublishtime'],
  channel: ['channel', 'channeltitle', 'channel_title', 'channelname', 'creator', 'uploader'],
  durationSec: ['durationsec', 'duration_sec', 'duration', 'length', 'seconds'],
  url: ['url', 'link', 'videourl', 'href'],
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Parse RFC-4180-ish CSV text (quoted fields, doubled quotes, CRLF) into rows of strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Parse "1.2M", "45K", "12,345", "1234" style counts. */
export function parseCount(value: string | undefined): number {
  if (!value) return 0
  const cleaned = value.trim().replace(/,/g, '').toUpperCase()
  const match = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([KMB])?/)
  if (!match) return 0
  const base = Number.parseFloat(match[1])
  const unit = match[2]
  const factor = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'B' ? 1e9 : 1
  return Math.round(base * factor)
}

/** Parse "12:34", "1:02:03", "754", or "PT12M34S" into seconds. */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10)
  const iso = v.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i)
  if (iso) {
    return (Number(iso[1] ?? 0) * 3600) + (Number(iso[2] ?? 0) * 60) + Number(iso[3] ?? 0)
  }
  const parts = v.split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => Number.isNaN(p))) return undefined
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** Turn CSV text into VideoRows, mapping any recognised header aliases. */
export function readVideoRows(text: string): VideoRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const headers = rows[0].map(normalizeHeader)
  const index = (field: keyof VideoRow): number => headers.findIndex((h) => ALIASES[field].includes(h))
  const col = {
    title: index('title'),
    views: index('views'),
    published: index('published'),
    channel: index('channel'),
    durationSec: index('durationSec'),
    url: index('url'),
  }
  if (col.title < 0 || col.views < 0) {
    throw new Error(`CSV needs at least a title column and a views column. Found headers: ${rows[0].join(', ')}`)
  }
  const out: VideoRow[] = []
  for (const r of rows.slice(1)) {
    const title = (r[col.title] ?? '').trim()
    if (!title) continue
    const row: VideoRow = { title, views: parseCount(r[col.views]) }
    if (col.published >= 0 && r[col.published]) row.published = r[col.published].trim()
    if (col.channel >= 0 && r[col.channel]) row.channel = r[col.channel].trim()
    if (col.durationSec >= 0) {
      const d = parseDuration(r[col.durationSec])
      if (d !== undefined) row.durationSec = d
    }
    if (col.url >= 0 && r[col.url]) row.url = r[col.url].trim()
    out.push(row)
  }
  return out
}
