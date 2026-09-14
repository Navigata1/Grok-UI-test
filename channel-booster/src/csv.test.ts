import { describe, expect, it } from 'vitest'
import { parseCount, parseCsv, parseDuration, readVideoRows } from './csv.js'

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
})
