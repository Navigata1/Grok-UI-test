/**
 * CSV ingest: competitor exports (any tool) and your own YouTube Studio
 * Content-tab export. Pure string-to-object mapping; no filesystem, so the
 * same module runs in the Desk's browser bundle.
 */
import { BUCKET_HOURS, LedgerRead, type Bucket } from './schema.js'
import type { VideoMetrics, VideoRow } from './types.js'

type CoreField = 'title' | 'views' | 'published' | 'channel' | 'durationSec' | 'url' | 'videoId' | 'thumbnailUrl'
type MetricField = keyof VideoMetrics
type AliasField = CoreField | MetricField

/**
 * Column aliases accepted for each VideoRow field (case-insensitive, punctuation-insensitive).
 * Order is priority: when two columns both match a field, the earlier alias wins,
 * so a Studio export with both "Video" (the id) and "Video title" maps the title
 * to "Video title".
 */
const ALIASES: Record<AliasField, string[]> = {
  title: ['videotitle', 'title', 'name', 'video'],
  views: ['views', 'viewcount', 'view_count', 'totalviews', 'plays'],
  published: ['videopublishtime', 'published', 'publishedat', 'publishdate', 'publish_date', 'date', 'uploaddate', 'upload_date'],
  channel: ['channel', 'channeltitle', 'channel_title', 'channelname', 'creator', 'uploader'],
  durationSec: ['durationsec', 'duration_sec', 'duration', 'length', 'seconds'],
  url: ['url', 'link', 'videourl', 'href'],
  // "content" and "video" are Studio's id column; "video" is only an id when a "Video title" column also exists (see resolveColumns).
  videoId: ['videoid', 'video_id', 'content', 'id', 'video'],
  thumbnailUrl: ['thumbnail', 'thumbnailurl', 'thumbnail_url', 'thumb'],
  impressions: ['impressions', 'impressioncount'],
  ctr: ['impressionsclickthroughrate', 'clickthroughrate', 'ctr', 'ctrpct'],
  avdSec: ['averageviewduration', 'averageviewdurationhhmmss', 'avgviewduration', 'avd', 'avdsec'],
  avpPct: ['averagepercentageviewed', 'avgpercentageviewed', 'averageviewedpercentage', 'avp', 'avppct'],
  watchTimeHours: ['watchtimehours', 'watchtime', 'watchtimehrs'],
  subscribers: ['subscribers', 'subscribersgained', 'subs'],
  likes: ['likes', 'likecount'],
  comments: ['commentsadded', 'comments', 'commentcount'],
  shares: ['shares', 'sharecount'],
}

const METRIC_FIELDS: MetricField[] = ['impressions', 'ctr', 'avdSec', 'avpPct', 'watchTimeHours', 'subscribers', 'likes', 'comments', 'shares']

/**
 * How far (as a share of the bucket's hour mark) a read may sit from 24/48/168/672 h
 * and still count as that bucket. House default; belongs in src/thresholds.ts as
 * `bucketTolerance` once the thresholds owner adds it.
 */
const BUCKET_TOLERANCE = 0.2

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

/**
 * Parse a decimal metric as Studio exports it: "4.52", "4.52%", "12,345.6", "1.2K".
 * Keeps fractions (unlike parseCount). Blank, "—", "N/A" and other non-numbers are undefined.
 */
export function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cleaned = value.trim().replace(/,/g, '').replace(/%$/, '').toUpperCase()
  const match = cleaned.match(/^(-?[0-9]*\.?[0-9]+)\s*([KMB])?$/)
  if (!match) return undefined
  const base = Number.parseFloat(match[1])
  const unit = match[2]
  const factor = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'B' ? 1e9 : 1
  return base * factor
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

type Columns = Record<AliasField, number>

interface Resolved {
  col: Columns
  /** Original header text of every column no alias recognised (blank headers skipped). */
  unknownColumns: string[]
}

/** Map header cells to fields by alias priority; a header can serve at most one field. */
function resolveColumns(rawHeaders: string[]): Resolved {
  const headers = rawHeaders.map(normalizeHeader)
  const col = {} as Columns
  const claimed = new Set<number>()
  for (const field of Object.keys(ALIASES) as AliasField[]) {
    let found = -1
    for (const alias of ALIASES[field]) {
      const i = headers.findIndex((h, idx) => h === alias && !claimed.has(idx))
      if (i >= 0) {
        found = i
        break
      }
    }
    col[field] = found
    if (found >= 0) claimed.add(found)
  }
  // "Video" alone is a title; it is only an id when a separate title column was found.
  if (col.videoId >= 0 && headers[col.videoId] === 'video' && col.title < 0) {
    claimed.delete(col.videoId)
    col.title = col.videoId
    col.videoId = -1
    claimed.add(col.title)
  }
  const unknownColumns = rawHeaders.filter((h, i) => !claimed.has(i) && h.trim() !== '')
  return { col, unknownColumns }
}

function isTotalRow(cells: string[], col: Columns): boolean {
  const first = (cells[0] ?? '').trim().toLowerCase()
  const title = col.title >= 0 ? (cells[col.title] ?? '').trim().toLowerCase() : ''
  return first === 'total' || title === 'total'
}

function toVideoRow(r: string[], col: Columns): VideoRow | undefined {
  const title = (r[col.title] ?? '').trim()
  if (!title) return undefined
  const row: VideoRow = { title, views: parseCount(r[col.views]) }
  if (col.published >= 0 && r[col.published]?.trim()) row.published = r[col.published].trim()
  if (col.channel >= 0 && r[col.channel]?.trim()) row.channel = r[col.channel].trim()
  if (col.durationSec >= 0) {
    const d = parseDuration(r[col.durationSec])
    if (d !== undefined) row.durationSec = d
  }
  if (col.url >= 0 && r[col.url]?.trim()) row.url = r[col.url].trim()
  if (col.videoId >= 0 && r[col.videoId]?.trim()) row.videoId = r[col.videoId].trim()
  if (col.thumbnailUrl >= 0 && r[col.thumbnailUrl]?.trim()) row.thumbnailUrl = r[col.thumbnailUrl].trim()
  const metrics: VideoMetrics = {}
  for (const field of METRIC_FIELDS) {
    if (col[field] < 0) continue
    const value = field === 'avdSec' ? parseAvd(r[col[field]]) : parseNumber(r[col[field]])
    if (value !== undefined) metrics[field] = value
  }
  if (Object.keys(metrics).length > 0) row.metrics = metrics
  return row
}

/** Average view duration arrives as hh:mm:ss, mm:ss, or plain seconds; decimals ("312.5") also accepted. */
function parseAvd(value: string | undefined): number | undefined {
  const d = parseDuration(value)
  if (d !== undefined) return d
  return parseNumber(value)
}

interface MappedCsv {
  rows: VideoRow[]
  unknownColumns: string[]
  droppedTotalRow: boolean
}

function mapCsv(text: string, options: { dropTotal: boolean }): MappedCsv {
  const rows = parseCsv(text)
  if (rows.length === 0) return { rows: [], unknownColumns: [], droppedTotalRow: false }
  const { col, unknownColumns } = resolveColumns(rows[0])
  if (col.title < 0 || col.views < 0) {
    throw new Error(`CSV needs at least a title column and a views column. Found headers: ${rows[0].join(', ')}`)
  }
  const out: VideoRow[] = []
  let droppedTotalRow = false
  for (const r of rows.slice(1)) {
    if (options.dropTotal && isTotalRow(r, col)) {
      droppedTotalRow = true
      continue
    }
    const row = toVideoRow(r, col)
    if (row) out.push(row)
  }
  return { rows: out, unknownColumns, droppedTotalRow }
}

/** Turn CSV text into VideoRows, mapping any recognised header aliases (competitor exports and your own). */
export function readVideoRows(text: string): VideoRow[] {
  return mapCsv(text, { dropTotal: false }).rows
}

/** What readStudioRows() returns: the video rows, the headers it did not recognise, and whether a Total row was dropped. */
export interface StudioImport {
  rows: VideoRow[]
  /** Header text of columns no alias matched, in file order, so the operator sees what was ignored. */
  unknownColumns: string[]
  /** True when the Studio "Total" summary row was present and removed. */
  droppedTotalRow: boolean
}

/**
 * Read a YouTube Studio Content-tab export (Analytics > Content > Export > CSV).
 * Drops the "Total" summary row, fills `metrics`, `videoId` and `thumbnailUrl`,
 * and names the columns it did not recognise.
 */
export function readStudioRows(text: string): StudioImport {
  return mapCsv(text, { dropTotal: true })
}

/** The Studio metrics of a row as a ledger read taken at `at` (impressions, ctr, views, avdSec, avpPct). */
export function ledgerReadFromRow(row: VideoRow, options: { at: Date | string }): LedgerRead {
  const at = typeof options.at === 'string' ? options.at : options.at.toISOString()
  const m = row.metrics ?? {}
  const read: LedgerRead = { at, views: row.views }
  if (m.impressions !== undefined) read.impressions = m.impressions
  if (m.ctr !== undefined) read.ctr = m.ctr
  if (m.avdSec !== undefined) read.avdSec = m.avdSec
  if (m.avpPct !== undefined) read.avpPct = m.avpPct
  return LedgerRead.parse(read)
}

/**
 * The bucket (24/48/168/672 h after publish) whose hour mark a read taken at `at`
 * sits closest to, or undefined when the read is more than BUCKET_TOLERANCE
 * (20%) away from every mark, before publish, or the publish time cannot be parsed.
 */
export function bucketFor(publishedAt: Date | string, at: Date | string): Bucket | undefined {
  const published = typeof publishedAt === 'string' ? Date.parse(publishedAt) : publishedAt.getTime()
  const when = typeof at === 'string' ? Date.parse(at) : at.getTime()
  if (Number.isNaN(published) || Number.isNaN(when)) return undefined
  const ageHours = (when - published) / 3_600_000
  if (ageHours < 0) return undefined
  let best: Bucket | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const bucket of Object.keys(BUCKET_HOURS) as Bucket[]) {
    const hours = BUCKET_HOURS[bucket]
    const distance = Math.abs(ageHours - hours) / hours
    if (distance < bestDistance) {
      best = bucket
      bestDistance = distance
    }
  }
  return bestDistance <= BUCKET_TOLERANCE ? best : undefined
}
