import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bucketFor, ledgerReadFromRow, parseCount, parseCsv, parseDuration, parseNumber, readStudioRows, readVideoRows } from './csv.js'
import { LedgerRead } from './schema.js'

const fixture = readFileSync(new URL('../examples/studio-content.csv', import.meta.url), 'utf8')

const STUDIO_HEADER = 'Content,Video title,Video publish time,Duration,Views,Watch time (hours),Subscribers,Impressions,Impressions click-through rate (%),Average view duration,Average percentage viewed (%),Likes,Comments added,Shares'

describe('parseCsv', () => {
  it('handles quoted fields, doubled quotes, and CRLF', () => {
    const rows = parseCsv('title,views\r\n"I Tried ""Everything"", Twice",1200\r\nPlain,5\n')
    expect(rows).toEqual([
      ['title', 'views'],
      ['I Tried "Everything", Twice', '1200'],
      ['Plain', '5'],
    ])
  })
})

describe('parseCount', () => {
  it('parses suffixes and separators', () => {
    expect(parseCount('1.2M')).toBe(1_200_000)
    expect(parseCount('45k')).toBe(45_000)
    expect(parseCount('12,345')).toBe(12_345)
    expect(parseCount('')).toBe(0)
  })
})

describe('parseNumber', () => {
  it('keeps decimals and strips separators and percent signs', () => {
    expect(parseNumber('4.52')).toBe(4.52)
    expect(parseNumber('4.52%')).toBe(4.52)
    expect(parseNumber('12,345.6')).toBe(12_345.6)
    expect(parseNumber('1.5K')).toBe(1500)
    expect(parseNumber('-3')).toBe(-3)
  })
  it('is undefined for blanks and placeholders', () => {
    expect(parseNumber(undefined)).toBeUndefined()
    expect(parseNumber('')).toBeUndefined()
    expect(parseNumber('—')).toBeUndefined()
    expect(parseNumber('N/A')).toBeUndefined()
  })
})

describe('parseDuration', () => {
  it('parses clock, seconds, and ISO 8601 forms', () => {
    expect(parseDuration('12:34')).toBe(754)
    expect(parseDuration('1:02:03')).toBe(3723)
    expect(parseDuration('90')).toBe(90)
    expect(parseDuration('PT12M34S')).toBe(754)
    expect(parseDuration('nope')).toBeUndefined()
  })
})

describe('readVideoRows', () => {
  it('maps header aliases from common exports', () => {
    const rows = readVideoRows('Video title,View count,Video publish time,Channel title,Duration\nHello,1.5K,2026-01-02,Acme,10:00\n')
    expect(rows).toEqual([{ title: 'Hello', views: 1500, published: '2026-01-02', channel: 'Acme', durationSec: 600 }])
  })
  it('throws a helpful error without title and views', () => {
    expect(() => readVideoRows('a,b\n1,2\n')).toThrow(/title column and a views column/)
  })
  it('leaves competitor exports untouched: no metrics, no videoId, Total rows kept', () => {
    const competitors = readFileSync(new URL('../examples/competitors.csv', import.meta.url), 'utf8')
    const rows = readVideoRows(competitors)
    expect(rows).toHaveLength(20)
    expect(rows[0]).toEqual({ title: "I Lived in a Van for 30 Days (Here's What Broke)", views: 2_400_000, published: '2026-03-02', channel: 'VanLifeCo', durationSec: 1102 })
    expect(rows.every((r) => r.metrics === undefined && r.videoId === undefined)).toBe(true)
    const withTotal = readVideoRows('title,views\nTotal,99\nReal,5\n')
    expect(withTotal.map((r) => r.title)).toEqual(['Total', 'Real'])
  })
  it('treats a lone "Video" column as the title, and as the id when "Video title" is present', () => {
    expect(readVideoRows('Video,Views\nHello,10\n')).toEqual([{ title: 'Hello', views: 10 }])
    expect(readVideoRows('Video,Video title,Views\nabc123,Hello,10\n')).toEqual([{ title: 'Hello', views: 10, videoId: 'abc123' }])
  })
  it('fills metrics, videoId and thumbnailUrl when the columns exist', () => {
    const [row] = readVideoRows(`${STUDIO_HEADER},Thumbnail\nabc,Hello,"Sep 1, 2026",754,1234,56.7,3,10000,5.2,0:05:01,41.3,80,12,4,https://i.ytimg.com/vi/abc/hqdefault.jpg\n`)
    expect(row).toEqual({
      title: 'Hello',
      views: 1234,
      published: 'Sep 1, 2026',
      durationSec: 754,
      videoId: 'abc',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      metrics: { impressions: 10000, ctr: 5.2, avdSec: 301, avpPct: 41.3, watchTimeHours: 56.7, subscribers: 3, likes: 80, comments: 12, shares: 4 },
    })
    expect(Date.parse(row.published!)).not.toBeNaN()
  })
})

describe('readStudioRows', () => {
  it('drops the Total row, keeps the rest, and reports it', () => {
    const text = `${STUDIO_HEADER}\nTotal,,,,1234,56.7,3,10000,5.2,0:05:01,41.3,80,12,4\nabc,Hello,"Sep 1, 2026",754,1234,56.7,3,10000,5.2,0:05:01,41.3,80,12,4\n`
    const result = readStudioRows(text)
    expect(result.droppedTotalRow).toBe(true)
    expect(result.unknownColumns).toEqual([])
    expect(result.rows.map((r) => r.videoId)).toEqual(['abc'])
  })
  it('drops a Total row that carries a title, wherever it sits', () => {
    const result = readStudioRows('Content,Video title,Views\nabc,Hello,10\nTotal,Total,10\n')
    expect(result.droppedTotalRow).toBe(true)
    expect(result.rows.map((r) => r.title)).toEqual(['Hello'])
  })
  it('reports droppedTotalRow false when there is none', () => {
    const result = readStudioRows('Content,Video title,Views\nabc,Hello,10\n')
    expect(result.droppedTotalRow).toBe(false)
    expect(result.rows).toHaveLength(1)
  })
  it('names unrecognised columns in file order and still maps the rest', () => {
    const result = readStudioRows('Content,Video title,Views,Revenue (USD),RPM\nabc,Hello,10,12.5,3.1\n')
    expect(result.unknownColumns).toEqual(['Revenue (USD)', 'RPM'])
    expect(result.rows[0]).toEqual({ title: 'Hello', views: 10, videoId: 'abc' })
  })
  it('leaves a metric out of metrics when its cell is blank', () => {
    const result = readStudioRows('Content,Video title,Views,Impressions,Impressions click-through rate (%)\nabc,Hello,10,,4.1\n')
    expect(result.rows[0].metrics).toEqual({ ctr: 4.1 })
    const none = readStudioRows('Content,Video title,Views,Impressions\nabc,Hello,10,\n')
    expect(none.rows[0].metrics).toBeUndefined()
  })
  it('accepts average view duration as seconds or decimal seconds', () => {
    const header = 'Content,Video title,Views,Average view duration'
    expect(readStudioRows(`${header}\na,A,1,312\n`).rows[0].metrics?.avdSec).toBe(312)
    expect(readStudioRows(`${header}\na,A,1,312.5\n`).rows[0].metrics?.avdSec).toBe(312.5)
  })
  it('returns nothing for empty text', () => {
    expect(readStudioRows('')).toEqual({ rows: [], unknownColumns: [], droppedTotalRow: false })
  })
  it('still requires a title and views column', () => {
    expect(() => readStudioRows('Content,Impressions\nabc,10\n')).toThrow(/title column and a views column/)
  })

  it('round-trips the examples/studio-content.csv fixture', () => {
    const result = readStudioRows(fixture)
    expect(result.droppedTotalRow).toBe(true)
    expect(result.unknownColumns).toEqual([])
    expect(result.rows).toHaveLength(8)
    for (const row of result.rows) {
      expect(row.title).not.toBe('')
      expect(row.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/)
      expect(row.thumbnailUrl).toBe(`https://i.ytimg.com/vi/${row.videoId}/hqdefault.jpg`)
      expect(Date.parse(row.published!)).not.toBeNaN()
      expect(row.durationSec).toBeGreaterThan(0)
      expect(row.views).toBeGreaterThan(0)
      const m = row.metrics!
      expect(Object.keys(m).sort()).toEqual(['avdSec', 'avpPct', 'comments', 'ctr', 'impressions', 'likes', 'shares', 'subscribers', 'watchTimeHours'])
      expect(m.impressions).toBeGreaterThan(row.views)
      expect(m.ctr).toBeGreaterThan(0)
      expect(m.ctr).toBeLessThan(100)
      expect(m.avdSec).toBeLessThan(row.durationSec!)
      expect(m.avpPct).toBeGreaterThan(0)
      expect(m.avpPct).toBeLessThan(100)
    }
    const winner = result.rows.find((r) => r.videoId === 'aB3dEfGh1jK')!
    expect(winner).toMatchObject({ title: 'I Tried Sleeping in the Camper for 7 Nights', published: 'May 31, 2026', durationSec: 930, views: 38000 })
    expect(winner.metrics).toEqual({ impressions: 721000, ctr: 5.9, avdSec: 342, avpPct: 36.8, watchTimeHours: 3610, subscribers: 812, likes: 2140, comments: 318, shares: 201 })
    // The Total row's views never leak into the rows.
    expect(result.rows.some((r) => r.views === 80500)).toBe(false)
    // Every row becomes a valid ledger read.
    for (const row of result.rows) {
      expect(() => LedgerRead.parse(ledgerReadFromRow(row, { at: '2026-09-14T12:00:00.000Z' }))).not.toThrow()
    }
  })
})

describe('ledgerReadFromRow', () => {
  const at = new Date('2026-09-14T12:00:00Z')
  it('maps metrics to a schema.LedgerRead with the read time', () => {
    const row = readStudioRows(`${STUDIO_HEADER}\nabc,Hello,"Sep 1, 2026",754,1234,56.7,3,10000,5.2,0:05:01,41.3,80,12,4\n`).rows[0]
    const read = ledgerReadFromRow(row, { at })
    expect(read).toEqual({ at: '2026-09-14T12:00:00.000Z', impressions: 10000, ctr: 5.2, views: 1234, avdSec: 301, avpPct: 41.3 })
    expect(LedgerRead.parse(read)).toEqual(read)
  })
  it('accepts an ISO string for at and omits missing metrics', () => {
    const read = ledgerReadFromRow({ title: 'Bare', views: 7 }, { at: '2026-09-14T12:00:00Z' })
    expect(read).toEqual({ at: '2026-09-14T12:00:00Z', views: 7 })
    expect('impressions' in read).toBe(false)
  })
  it('does not carry likes, shares or watch time into the read', () => {
    const read = ledgerReadFromRow({ title: 'X', views: 1, metrics: { likes: 5, shares: 2, watchTimeHours: 3, ctr: 4 } }, { at })
    expect(read).toEqual({ at: at.toISOString(), views: 1, ctr: 4 })
  })
})

describe('bucketFor', () => {
  const published = '2026-09-01T00:00:00Z'
  const hoursLater = (h: number) => new Date(Date.parse(published) + h * 3_600_000)
  it('returns the exact bucket at each hour mark', () => {
    expect(bucketFor(published, hoursLater(24))).toBe('24')
    expect(bucketFor(published, hoursLater(48))).toBe('48')
    expect(bucketFor(published, hoursLater(168))).toBe('168')
    expect(bucketFor(published, hoursLater(672))).toBe('672')
  })
  it('snaps to the nearest mark inside 20 percent', () => {
    expect(bucketFor(published, hoursLater(22))).toBe('24')
    expect(bucketFor(published, hoursLater(28.8))).toBe('24')
    expect(bucketFor(published, hoursLater(40))).toBe('48')
    expect(bucketFor(published, hoursLater(57))).toBe('48')
    expect(bucketFor(published, hoursLater(150))).toBe('168')
    expect(bucketFor(published, hoursLater(200))).toBe('168')
    expect(bucketFor(published, hoursLater(600))).toBe('672')
    expect(bucketFor(published, hoursLater(800))).toBe('672')
  })
  it('is undefined more than 20 percent from every mark', () => {
    expect(bucketFor(published, hoursLater(0))).toBeUndefined()
    expect(bucketFor(published, hoursLater(12))).toBeUndefined()
    expect(bucketFor(published, hoursLater(36))).toBeUndefined()
    expect(bucketFor(published, hoursLater(100))).toBeUndefined()
    expect(bucketFor(published, hoursLater(400))).toBeUndefined()
    expect(bucketFor(published, hoursLater(900))).toBeUndefined()
  })
  it('is undefined before publish or with an unparsable date', () => {
    expect(bucketFor(published, hoursLater(-48))).toBeUndefined()
    expect(bucketFor('not a date', hoursLater(48))).toBeUndefined()
    expect(bucketFor(published, 'nope')).toBeUndefined()
  })
  it('accepts Date objects and Studio-style publish strings', () => {
    expect(bucketFor(new Date(published), hoursLater(48).toISOString())).toBe('48')
    expect(bucketFor('Sep 1, 2026', new Date(Date.parse('Sep 1, 2026') + 168 * 3_600_000))).toBe('168')
  })
})
