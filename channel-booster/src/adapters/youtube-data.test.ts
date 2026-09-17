import { afterEach, describe, expect, it, vi } from 'vitest'
import { readVideoRows } from '../csv.js'
import type { VideoRow } from '../types.js'
import { AnalyticsNotConfiguredError, NotConfiguredAnalyticsReader } from './analytics.js'
import {
  CSV_HEADER,
  YouTubeDataApiError,
  fetchChannelVideos,
  parseIsoDuration,
  redactKey,
  resolveChannel,
  resolveChannelRef,
  toCsv,
  videoUrl,
  type FetchLike,
} from './youtube-data.js'

/** A key with characters URLSearchParams encodes, so redaction of the encoded form is exercised too. */
const KEY = 'AIza-secret/key+1'
const UPLOADS = 'UUxxxxxxxxxxxxxxxxxxxxxx'
const CHANNEL_ID = 'UCxxxxxxxxxxxxxxxxxxxxxx'

interface Call {
  endpoint: string
  params: URLSearchParams
}

type Handler = (endpoint: string, params: URLSearchParams) => { status?: number; body: unknown } | undefined

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fetch stub that routes by endpoint path, records every call, and serves canned JSON. */
function stubFetch(handler: Handler): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input)
    const endpoint = `${url.pathname.split('/').pop()}.list`
    calls.push({ endpoint, params: url.searchParams })
    const out = handler(endpoint, url.searchParams)
    if (!out) return json({ error: { message: `unexpected call to ${endpoint}` } }, 500)
    return json(out.body, out.status ?? 200)
  }
  return { fetchImpl, calls }
}

function videoItem(id: string, i: number) {
  return {
    id,
    snippet: {
      title: `Video ${i}`,
      publishedAt: `2026-0${(i % 9) + 1}-10T12:00:00Z`,
      channelTitle: 'Acme',
      thumbnails: { default: { url: `https://i.ytimg.com/vi/${id}/default.jpg` }, high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
    },
    statistics: { viewCount: String(1000 * (i + 1)) },
    contentDetails: { duration: 'PT12M34S' },
  }
}

/** A canned channel with `count` uploads, paged 50 at a time like the real API. */
function channelWith(count: number): Handler {
  const ids = Array.from({ length: count }, (_, i) => `vid${String(i).padStart(3, '0')}`)
  return (endpoint, params) => {
    if (endpoint === 'channels.list') {
      return { body: { items: [{ id: CHANNEL_ID, snippet: { title: 'Acme' }, contentDetails: { relatedPlaylists: { uploads: UPLOADS } } }] } }
    }
    if (endpoint === 'playlistItems.list') {
      const start = Number(params.get('pageToken') ?? 0)
      const size = Number(params.get('maxResults'))
      const page = ids.slice(start, start + size)
      const next = start + size < ids.length ? String(start + size) : undefined
      return { body: { ...(next ? { nextPageToken: next } : {}), items: page.map((videoId) => ({ contentDetails: { videoId } })) } }
    }
    if (endpoint === 'videos.list') {
      const wanted = (params.get('id') ?? '').split(',')
      return { body: { items: wanted.map((id) => videoItem(id, ids.indexOf(id))) } }
    }
    return undefined
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveChannelRef', () => {
  it('recognises a UC channel id', () => {
    expect(resolveChannelRef(CHANNEL_ID)).toEqual({ id: CHANNEL_ID })
  })
  it('normalises handles with or without @ and from youtube.com URLs', () => {
    expect(resolveChannelRef('@acme')).toEqual({ forHandle: '@acme' })
    expect(resolveChannelRef('acme')).toEqual({ forHandle: '@acme' })
    expect(resolveChannelRef('https://www.youtube.com/@acme/videos')).toEqual({ forHandle: '@acme' })
    expect(resolveChannelRef('https://youtube.com/@acme?sub_confirmation=1')).toEqual({ forHandle: '@acme' })
    expect(resolveChannelRef('https://www.youtube.com/c/acme')).toEqual({ forHandle: '@acme' })
  })
  it('throws on blank input', () => {
    expect(() => resolveChannelRef('   ')).toThrow(/handle .* or a channel id/)
    expect(() => resolveChannelRef('@')).toThrow(/could not read a handle/)
  })
})

describe('parseIsoDuration', () => {
  it('parses the forms videos.list returns', () => {
    expect(parseIsoDuration('PT12M34S')).toBe(754)
    expect(parseIsoDuration('PT1H2M')).toBe(3720)
    expect(parseIsoDuration('PT45S')).toBe(45)
    expect(parseIsoDuration('PT0S')).toBe(0)
    expect(parseIsoDuration('P1DT2H')).toBe(93_600)
    expect(parseIsoDuration('pt3m')).toBe(180)
  })
  it('is undefined for blanks and non-durations', () => {
    expect(parseIsoDuration(undefined)).toBeUndefined()
    expect(parseIsoDuration('')).toBeUndefined()
    expect(parseIsoDuration('P')).toBeUndefined()
    expect(parseIsoDuration('12:34')).toBeUndefined()
  })
})

describe('redactKey', () => {
  it('removes the raw and the URL-encoded key', () => {
    const text = `bad key ${KEY} in ${encodeURIComponent(KEY)}`
    expect(redactKey(text, KEY)).toBe('bad key [redacted] in [redacted]')
    expect(redactKey('nothing', '')).toBe('nothing')
  })
})

describe('resolveChannel', () => {
  it('queries by forHandle for a handle and by id for a channel id', async () => {
    const { fetchImpl, calls } = stubFetch(channelWith(1))
    const byHandle = await resolveChannel({ handleOrId: 'acme', apiKey: KEY, fetchImpl })
    expect(byHandle).toEqual({ channelId: CHANNEL_ID, title: 'Acme', uploadsPlaylistId: UPLOADS })
    expect(calls[0].endpoint).toBe('channels.list')
    expect(calls[0].params.get('forHandle')).toBe('@acme')
    expect(calls[0].params.get('id')).toBeNull()
    expect(calls[0].params.get('part')).toBe('contentDetails,snippet')
    expect(calls[0].params.get('key')).toBe(KEY)

    await resolveChannel({ handleOrId: CHANNEL_ID, apiKey: KEY, fetchImpl })
    expect(calls[1].params.get('id')).toBe(CHANNEL_ID)
    expect(calls[1].params.get('forHandle')).toBeNull()
  })
  it('fails clearly when the channel does not exist', async () => {
    const { fetchImpl } = stubFetch((endpoint) => (endpoint === 'channels.list' ? { body: { items: [] } } : undefined))
    await expect(resolveChannel({ handleOrId: '@ghost', apiKey: KEY, fetchImpl })).rejects.toThrow(/channels\.list .*no channel found for "@ghost"/)
  })
  it('refuses to call the API without a key and names the environment variable', async () => {
    const { fetchImpl, calls } = stubFetch(channelWith(1))
    await expect(resolveChannel({ handleOrId: '@acme', apiKey: '', fetchImpl })).rejects.toThrow(/YOUTUBE_API_KEY/)
    expect(calls).toHaveLength(0)
  })
})

describe('fetchChannelVideos', () => {
  it('walks channels.list, playlistItems.list and videos.list and maps every VideoRow field', async () => {
    const { fetchImpl, calls } = stubFetch(channelWith(3))
    const rows = await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, max: 10, fetchImpl })
    expect(calls.map((c) => c.endpoint)).toEqual(['channels.list', 'playlistItems.list', 'videos.list'])
    expect(calls[1].params.get('playlistId')).toBe(UPLOADS)
    expect(calls[1].params.get('part')).toBe('contentDetails')
    expect(calls[1].params.get('maxResults')).toBe('10')
    expect(calls[2].params.get('part')).toBe('snippet,statistics,contentDetails')
    expect(calls[2].params.get('id')).toBe('vid000,vid001,vid002')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      title: 'Video 0',
      views: 1000,
      published: '2026-01-10T12:00:00Z',
      channel: 'Acme',
      durationSec: 754,
      url: 'https://www.youtube.com/watch?v=vid000',
      videoId: 'vid000',
      thumbnailUrl: 'https://i.ytimg.com/vi/vid000/hqdefault.jpg',
    })
    expect(rows.map((r) => r.views)).toEqual([1000, 2000, 3000])
  })

  it('defaults max to 50 and never asks for more than 50 per page', async () => {
    const { fetchImpl, calls } = stubFetch(channelWith(80))
    const rows = await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl })
    expect(rows).toHaveLength(50)
    expect(calls.map((c) => c.endpoint)).toEqual(['channels.list', 'playlistItems.list', 'videos.list'])
    expect(calls[1].params.get('maxResults')).toBe('50')
  })

  it('pages the uploads playlist and batches videos.list by 50', async () => {
    const { fetchImpl, calls } = stubFetch(channelWith(130))
    const rows = await fetchChannelVideos({ handleOrId: CHANNEL_ID, apiKey: KEY, max: 120, fetchImpl })
    expect(rows).toHaveLength(120)
    expect(rows[0].videoId).toBe('vid000')
    expect(rows[119].videoId).toBe('vid119')
    const playlistCalls = calls.filter((c) => c.endpoint === 'playlistItems.list')
    const videoCalls = calls.filter((c) => c.endpoint === 'videos.list')
    expect(playlistCalls).toHaveLength(3)
    expect(playlistCalls.map((c) => c.params.get('pageToken'))).toEqual([null, '50', '100'])
    expect(playlistCalls.map((c) => c.params.get('maxResults'))).toEqual(['50', '50', '20'])
    expect(videoCalls).toHaveLength(3)
    expect(videoCalls.map((c) => c.params.get('id')!.split(',').length)).toEqual([50, 50, 20])
  })

  it('stops paging when the playlist runs out', async () => {
    const { fetchImpl, calls } = stubFetch(channelWith(7))
    const rows = await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, max: 500, fetchImpl })
    expect(rows).toHaveLength(7)
    expect(calls.filter((c) => c.endpoint === 'playlistItems.list')).toHaveLength(1)
  })

  it('trims to max even when the API returns a fuller page than asked', async () => {
    const base = channelWith(5)
    const { fetchImpl } = stubFetch((endpoint, params) => {
      if (endpoint === 'playlistItems.list') {
        params.set('maxResults', '50')
      }
      return base(endpoint, params)
    })
    const rows = await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, max: 2, fetchImpl })
    expect(rows.map((r) => r.videoId)).toEqual(['vid000', 'vid001'])
  })

  it('skips videos that vanished between the playlist read and videos.list, falls back to the channel name, and prefers the largest thumbnail', async () => {
    const base = channelWith(3)
    const { fetchImpl } = stubFetch((endpoint, params) => {
      if (endpoint !== 'videos.list') return base(endpoint, params)
      return {
        body: {
          items: [
            {
              id: 'vid000',
              snippet: { title: 'Kept', thumbnails: { default: { url: 'd' }, maxres: { url: 'https://i.ytimg.com/vi/vid000/maxresdefault.jpg' }, medium: { url: 'm' } } },
              statistics: {},
              contentDetails: { duration: 'PT1M' },
            },
            { id: 'vid002', snippet: { title: 'Hidden stats', publishedAt: '2026-02-01T00:00:00Z' }, statistics: { viewCount: 'not-a-number' } },
          ],
        },
      }
    })
    const rows = await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl })
    expect(rows).toEqual([
      { title: 'Kept', views: 0, channel: 'Acme', durationSec: 60, url: videoUrl('vid000'), videoId: 'vid000', thumbnailUrl: 'https://i.ytimg.com/vi/vid000/maxresdefault.jpg' },
      { title: 'Hidden stats', views: 0, published: '2026-02-01T00:00:00Z', channel: 'Acme', url: videoUrl('vid002'), videoId: 'vid002' },
    ])
  })

  it('reports the endpoint, HTTP status and API reason on failure, without the key', async () => {
    const { fetchImpl } = stubFetch((endpoint) => {
      if (endpoint !== 'channels.list') return undefined
      return { status: 403, body: { error: { code: 403, message: `The request key ${KEY} exceeded quota`, errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded' }] } } }
    })
    const promise = fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl })
    await expect(promise).rejects.toBeInstanceOf(YouTubeDataApiError)
    const err = (await promise.catch((e: unknown) => e)) as YouTubeDataApiError
    expect(err.message).toBe('YouTube Data API channels.list failed with HTTP 403: quotaExceeded: The request key [redacted] exceeded quota')
    expect(err.endpoint).toBe('channels.list')
    expect(err.status).toBe(403)
    expect(err.reason).toBe('quotaExceeded')
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain(encodeURIComponent(KEY))
  })

  it('names the later endpoints too, and copes with a non-JSON error body', async () => {
    const base = channelWith(2)
    const { fetchImpl } = stubFetch((endpoint, params) => (endpoint === 'videos.list' ? { status: 500, body: '<html>boom</html>' } : base(endpoint, params)))
    await expect(fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl })).rejects.toThrow('YouTube Data API videos.list failed with HTTP 500')
    const notFound = stubFetch((endpoint, params) => (endpoint === 'playlistItems.list' ? { status: 404, body: { error: { message: 'playlist not found', errors: [{ reason: 'playlistNotFound' }] } } } : base(endpoint, params)))
    await expect(fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl: notFound.fetchImpl })).rejects.toThrow('YouTube Data API playlistItems.list failed with HTTP 404: playlistNotFound: playlist not found')
  })

  it('wraps transport failures and redacts the key from the URL they echo', async () => {
    const fetchImpl: FetchLike = async (input) => {
      throw new Error(`ECONNREFUSED ${input}`)
    }
    const err = (await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl }).catch((e: unknown) => e)) as YouTubeDataApiError
    expect(err).toBeInstanceOf(YouTubeDataApiError)
    expect(err.status).toBe(0)
    expect(err.message).toMatch(/^YouTube Data API channels\.list failed: transport error \(ECONNREFUSED https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?/)
    expect(err.message).toContain('key=[redacted]')
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain(encodeURIComponent(KEY))
  })

  it('fails on a 200 that is not JSON', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: 'not json' }))
    await expect(fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl })).rejects.toThrow('YouTube Data API channels.list failed with HTTP 200: response was not JSON')
  })

  it('never writes to the console', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')]
    for (const s of spies) s.mockImplementation(() => undefined)
    const ok = stubFetch(channelWith(2))
    await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl: ok.fetchImpl })
    const bad = stubFetch(() => ({ status: 400, body: { error: { message: 'keyInvalid' } } }))
    await fetchChannelVideos({ handleOrId: '@acme', apiKey: KEY, fetchImpl: bad.fetchImpl }).catch(() => undefined)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})

describe('toCsv', () => {
  const rows: VideoRow[] = [
    { title: 'I Tried "Everything", Twice', views: 1200, published: '2026-03-02T10:00:00Z', channel: 'Acme, Inc', durationSec: 754, url: videoUrl('a1'), videoId: 'a1', thumbnailUrl: 'https://i.ytimg.com/vi/a1/hqdefault.jpg' },
    { title: 'Plain', views: 5 },
  ]

  it('writes the competitor header and quotes only what needs quoting', () => {
    const csv = toCsv(rows)
    expect(CSV_HEADER).toEqual(['title', 'views', 'published', 'channel', 'duration', 'url', 'videoId'])
    expect(csv).toBe(
      'title,views,published,channel,duration,url,videoId\n' +
        '"I Tried ""Everything"", Twice",1200,2026-03-02T10:00:00Z,"Acme, Inc",754,https://www.youtube.com/watch?v=a1,a1\n' +
        'Plain,5,,,,,\n',
    )
    expect(toCsv([])).toBe('title,views,published,channel,duration,url,videoId\n')
  })

  it('round-trips through readVideoRows()', () => {
    const back = readVideoRows(toCsv(rows))
    expect(back).toEqual([
      { title: 'I Tried "Everything", Twice', views: 1200, published: '2026-03-02T10:00:00Z', channel: 'Acme, Inc', durationSec: 754, url: 'https://www.youtube.com/watch?v=a1', videoId: 'a1' },
      { title: 'Plain', views: 5 },
    ])
  })

  it('quotes titles with line breaks so the row survives parseCsv', () => {
    const back = readVideoRows(toCsv([{ title: 'Line one\nline two', views: 1 }]))
    expect(back).toEqual([{ title: 'Line one\nline two', views: 1 }])
  })
})

describe('NotConfiguredAnalyticsReader', () => {
  it('rejects with an OAuth explanation and the Studio-export alternative', async () => {
    const reader = new NotConfiguredAnalyticsReader()
    const promise = reader.fetchVideoMetrics('abc123', { since: '2026-09-01', until: '2026-09-08' })
    await expect(promise).rejects.toBeInstanceOf(AnalyticsNotConfiguredError)
    await expect(promise).rejects.toThrow(/OAuth 2\.0/)
    await expect(promise).rejects.toThrow(/abc123/)
    await expect(promise).rejects.toThrow(/inbox\//)
  })
})
