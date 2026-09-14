/**
 * Optional data adapter (architecture 2.19): read a channel's public upload
 * list and view counts through the YouTube Data API v3, so the competitor
 * CSV the module reads can be produced by `booster fetch channel <handle|id>`
 * instead of an export tool.
 *
 * Three official endpoints, native `fetch`, no dependencies:
 *   1. channels.list      (part=contentDetails,snippet; id=UC... or forHandle=@handle)
 *   2. playlistItems.list (the channel's "uploads" playlist, 50 per page)
 *   3. videos.list        (part=snippet,statistics,contentDetails, 50 ids per call)
 *
 * The API key is read by the caller (`YOUTUBE_API_KEY` in the environment)
 * and passed in; this module never logs it, never puts it in an error
 * message, and redacts it from any API error text it repeats. Errors name
 * the endpoint and the HTTP status so a quota or key problem is obvious.
 * Tests stub `fetchImpl` with canned JSON; nothing here touches the network
 * unless a caller hands it the real `fetch`. Agents must not scrape: this is
 * the only sanctioned way to read another channel's numbers.
 */
import type { VideoRow } from '../types.js'

/** Base URL of the YouTube Data API v3. */
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

/**
 * Items per page / ids per call. The API caps both at 50 (sourced: Data API
 * reference for playlistItems.list maxResults and videos.list id). An API
 * limit, not a tunable gate, so it stays here rather than in thresholds.ts.
 */
const PAGE_SIZE = 50

/** The endpoints this adapter calls, as they appear in error messages. */
export type YouTubeEndpoint = 'channels.list' | 'playlistItems.list' | 'videos.list'

/** The subset of `fetch` the adapter needs; `globalThis.fetch` satisfies it, and tests pass a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>

export interface FetchChannelVideosOptions {
  /** "@handle", "handle", a youtube.com/@handle URL, or a "UC..." channel id. */
  handleOrId: string
  /** YouTube Data API v3 key. Read it from YOUTUBE_API_KEY; never commit it. */
  apiKey: string
  /** Most recent uploads to return. Defaults to 50; rounded up to whole pages of 50 on the wire, trimmed on return. */
  max?: number
  /** Transport. Defaults to the global fetch; tests inject a stub that returns canned JSON. */
  fetchImpl?: FetchLike
}

/** What channels.list resolved: the id, the display name, and the uploads playlist the videos come from. */
export interface ResolvedChannel {
  channelId: string
  title: string
  uploadsPlaylistId: string
}

/**
 * Error from the YouTube Data API: names the endpoint and HTTP status, carries
 * the API's own reason (for example `quotaExceeded`, `keyInvalid`) when the
 * body had one, and never contains the API key.
 */
export class YouTubeDataApiError extends Error {
  readonly endpoint: YouTubeEndpoint
  /** HTTP status of the failed call, or 0 when the transport itself failed or the body was unusable. */
  readonly status: number
  /** The API's `error.errors[0].reason`, when present. */
  readonly reason?: string

  constructor(endpoint: YouTubeEndpoint, status: number, detail: string, reason?: string) {
    const suffix = detail ? `: ${detail}` : ''
    super(status > 0 ? `YouTube Data API ${endpoint} failed with HTTP ${status}${suffix}` : `YouTube Data API ${endpoint} failed${suffix}`)
    this.name = 'YouTubeDataApiError'
    this.endpoint = endpoint
    this.status = status
    if (reason) this.reason = reason
  }
}

/** Replace every occurrence of the key (raw and URL-encoded) in `text` so it cannot leak through an error. */
export function redactKey(text: string, apiKey: string): string {
  if (!apiKey) return text
  let out = text.split(apiKey).join('[redacted]')
  const encoded = encodeURIComponent(apiKey)
  if (encoded !== apiKey) out = out.split(encoded).join('[redacted]')
  return out
}

/**
 * Decide whether `handleOrId` is a channel id ("UC" + 22 url-safe characters)
 * or a handle, and normalise the handle to "@name" (strips a youtube.com URL
 * prefix and a leading "@"). Throws on blank input.
 */
export function resolveChannelRef(handleOrId: string): { id: string } | { forHandle: string } {
  const raw = handleOrId.trim()
  if (!raw) throw new Error('fetch channel: a handle (@name) or a channel id (UC...) is required')
  if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) return { id: raw }
  let handle = raw.replace(/^https?:\/\/(www\.|m\.)?youtube\.com\//i, '')
  handle = handle.replace(/^(channel\/|c\/|user\/)/i, '')
  handle = handle.replace(/[/?#].*$/, '')
  handle = handle.replace(/^@+/, '')
  if (!handle) throw new Error(`fetch channel: could not read a handle from "${handleOrId}"`)
  return { forHandle: `@${handle}` }
}

/**
 * Parse an ISO 8601 duration as videos.list returns it ("PT12M34S", "PT1H2M",
 * "P1DT2H", "PT0S") into whole seconds. Undefined when the text is not a duration.
 */
export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined
  const m = value.trim().match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i)
  if (!m) return undefined
  const [, w, d, h, min, s] = m
  if (w === undefined && d === undefined && h === undefined && min === undefined && s === undefined) return undefined
  const seconds = Number(w ?? 0) * 604_800 + Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)
  return Math.round(seconds)
}

/** Watch URL for a video id. */
export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

interface ApiErrorBody {
  error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> }
}

interface ChannelsResponse {
  items?: Array<{ id?: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>
}

interface PlaylistItemsResponse {
  nextPageToken?: string
  items?: Array<{ contentDetails?: { videoId?: string } }>
}

interface Thumbnail {
  url?: string
}

type Thumbnails = Partial<Record<'maxres' | 'standard' | 'high' | 'medium' | 'default', Thumbnail>>

interface VideosResponse {
  items?: Array<{
    id?: string
    snippet?: {
      title?: string
      publishedAt?: string
      channelTitle?: string
      thumbnails?: Thumbnails
    }
    statistics?: { viewCount?: string }
    contentDetails?: { duration?: string }
  }>
}

function buildUrl(endpoint: YouTubeEndpoint, params: Record<string, string>, apiKey: string): string {
  const resource = endpoint.replace(/\.list$/, '')
  const search = new URLSearchParams({ ...params, key: apiKey })
  return `${YOUTUBE_API_BASE}/${resource}?${search.toString()}`
}

async function callApi<T>(endpoint: YouTubeEndpoint, params: Record<string, string>, apiKey: string, fetchImpl: FetchLike): Promise<T> {
  let res: Pick<Response, 'ok' | 'status' | 'text'>
  try {
    res = await fetchImpl(buildUrl(endpoint, params, apiKey), { method: 'GET', headers: { accept: 'application/json' } })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new YouTubeDataApiError(endpoint, 0, `transport error (${redactKey(detail, apiKey)})`)
  }
  const text = await res.text()
  if (!res.ok) {
    let reason: string | undefined
    let message: string | undefined
    try {
      const body = JSON.parse(text) as ApiErrorBody
      reason = body.error?.errors?.[0]?.reason
      message = body.error?.message
    } catch {
      // Not JSON: the status alone is the diagnosis.
    }
    const detail = redactKey([reason, message].filter((s): s is string => Boolean(s)).join(': '), apiKey)
    throw new YouTubeDataApiError(endpoint, res.status, detail, reason)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new YouTubeDataApiError(endpoint, res.status, 'response was not JSON')
  }
}

/** Resolve a handle or channel id to its uploads playlist with one channels.list call. */
export async function resolveChannel(options: Pick<FetchChannelVideosOptions, 'handleOrId' | 'apiKey' | 'fetchImpl'>): Promise<ResolvedChannel> {
  const { handleOrId, apiKey } = options
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  requireKey(apiKey)
  const ref = resolveChannelRef(handleOrId)
  const params: Record<string, string> = { part: 'contentDetails,snippet', maxResults: '1' }
  if ('id' in ref) params.id = ref.id
  else params.forHandle = ref.forHandle
  const body = await callApi<ChannelsResponse>('channels.list', params, apiKey, fetchImpl)
  const item = body.items?.[0]
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads
  const label = 'id' in ref ? ref.id : ref.forHandle
  if (!item || !item.id) throw new YouTubeDataApiError('channels.list', 200, `no channel found for "${label}"`)
  if (!uploads) throw new YouTubeDataApiError('channels.list', 200, `channel "${label}" has no uploads playlist`)
  return { channelId: item.id, title: item.snippet?.title ?? '', uploadsPlaylistId: uploads }
}

function requireKey(apiKey: string): void {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('fetch channel: no API key. Set YOUTUBE_API_KEY in the environment (a Data API v3 key from Google Cloud); never commit it.')
  }
}

function pickThumbnail(thumbs: Thumbnails | undefined): string | undefined {
  if (!thumbs) return undefined
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default'] as const) {
    const url = thumbs[size]?.url
    if (url) return url
  }
  return undefined
}

/**
 * Fetch the most recent `max` uploads of a channel as VideoRows (title, views,
 * published, channel, durationSec, url, videoId, thumbnailUrl), newest first.
 * Costs about 2 + ceil(max / 50) * 2 quota units. Throws YouTubeDataApiError
 * naming the endpoint and HTTP status; the key never appears in the message.
 */
export async function fetchChannelVideos(options: FetchChannelVideosOptions): Promise<VideoRow[]> {
  const { apiKey } = options
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  const max = Math.max(1, Math.floor(options.max ?? PAGE_SIZE))
  const channel = await resolveChannel({ handleOrId: options.handleOrId, apiKey, fetchImpl })

  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const params: Record<string, string> = { part: 'contentDetails', playlistId: channel.uploadsPlaylistId, maxResults: String(Math.min(PAGE_SIZE, max - ids.length)) }
    if (pageToken) params.pageToken = pageToken
    const page = await callApi<PlaylistItemsResponse>('playlistItems.list', params, apiKey, fetchImpl)
    for (const item of page.items ?? []) {
      const id = item.contentDetails?.videoId
      if (id && !ids.includes(id)) ids.push(id)
    }
    pageToken = page.nextPageToken
  } while (pageToken && ids.length < max)

  const rows: VideoRow[] = []
  for (let i = 0; i < ids.length && rows.length < max; i += PAGE_SIZE) {
    const batch = ids.slice(i, i + PAGE_SIZE)
    const body = await callApi<VideosResponse>('videos.list', { part: 'snippet,statistics,contentDetails', id: batch.join(','), maxResults: String(PAGE_SIZE) }, apiKey, fetchImpl)
    const byId = new Map((body.items ?? []).filter((v) => v.id).map((v) => [v.id as string, v]))
    for (const id of batch) {
      const v = byId.get(id)
      if (!v) continue // private or deleted since the playlist was read
      const row: VideoRow = {
        title: v.snippet?.title ?? '',
        views: Number.parseInt(v.statistics?.viewCount ?? '0', 10) || 0,
        url: videoUrl(id),
        videoId: id,
      }
      if (v.snippet?.publishedAt) row.published = v.snippet.publishedAt
      const channelTitle = v.snippet?.channelTitle ?? channel.title
      if (channelTitle) row.channel = channelTitle
      const duration = parseIsoDuration(v.contentDetails?.duration)
      if (duration !== undefined) row.durationSec = duration
      const thumb = pickThumbnail(v.snippet?.thumbnails)
      if (thumb) row.thumbnailUrl = thumb
      rows.push(row)
    }
  }
  return rows.slice(0, max)
}

/** Header of the competitor CSV this adapter writes; `readVideoRows()` in src/csv.ts maps every column. */
export const CSV_HEADER = ['title', 'views', 'published', 'channel', 'duration', 'url', 'videoId'] as const

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Serialise rows as the competitor CSV shape the module reads
 * (title,views,published,channel,duration,url,videoId), duration in whole
 * seconds, blank cells for missing values, LF line endings, trailing newline.
 * Round-trips through `readVideoRows()`.
 */
export function toCsv(rows: VideoRow[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push([r.title, r.views, r.published, r.channel, r.durationSec, r.url, r.videoId].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}
