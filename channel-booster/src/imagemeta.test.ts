import { describe, expect, it } from 'vitest'
import { checkThumbnailFile, readImageMeta, THUMB_MAX_BYTES } from './imagemeta.js'

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}
function u16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff]
}

/** A minimal PNG: signature, IHDR chunk (crc bytes are not checked), padded to `totalBytes`. */
function png(width: number, height: number, totalBytes?: number): Uint8Array {
  const head = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0,
  ]
  const out = new Uint8Array(Math.max(head.length, totalBytes ?? head.length))
  out.set(head)
  return out
}

/** A minimal JPEG: SOI, APP0 (JFIF), optional extra segments, then a frame header and SOS. */
function jpeg(width: number, height: number, options: { sof?: number; before?: number[]; totalBytes?: number; noFrame?: boolean } = {}): Uint8Array {
  const sof = options.sof ?? 0xc0
  const app0 = [0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, ...u16(1), ...u16(1), 0, 0]
  const frame = [0xff, sof, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const sos = [0xff, 0xda, ...u16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x12, 0x34]
  const head = [0xff, 0xd8, ...app0, ...(options.before ?? []), ...(options.noFrame ? [] : frame), ...sos, 0xff, 0xd9]
  const out = new Uint8Array(Math.max(head.length, options.totalBytes ?? head.length))
  out.set(head)
  return out
}

describe('readImageMeta', () => {
  it('reads a PNG IHDR', () => {
    expect(readImageMeta(png(1280, 720))).toEqual({ format: 'png', width: 1280, height: 720, bytes: 33 })
    expect(readImageMeta(png(3840, 2160, 5000))).toMatchObject({ format: 'png', width: 3840, height: 2160, bytes: 5000 })
  })

  it('reads a baseline (SOF0) and a progressive (SOF2) JPEG', () => {
    expect(readImageMeta(jpeg(1280, 720))).toMatchObject({ format: 'jpeg', width: 1280, height: 720 })
    expect(readImageMeta(jpeg(1920, 1080, { sof: 0xc2 }))).toMatchObject({ format: 'jpeg', width: 1920, height: 1080 })
  })

  it('skips application, comment and quantisation segments, fill bytes and restart markers before the frame', () => {
    const dqt = [0xff, 0xdb, ...u16(67), 0, ...new Array(64).fill(1)]
    const com = [0xff, 0xfe, ...u16(5), 0x68, 0x69, 0x21]
    const app1 = [0xff, 0xe1, ...u16(4), 0xab, 0xcd]
    const fill = [0xff, 0xff, 0xff, 0xd0, 0xff, 0x01]
    expect(readImageMeta(jpeg(1600, 900, { before: [...dqt, ...com, ...app1, ...fill] }))).toMatchObject({ format: 'jpeg', width: 1600, height: 900 })
  })

  it('does not mistake DHT (C4) for a frame header', () => {
    const dht = [0xff, 0xc4, ...u16(6), 0, 0x12, 0x34, 0x56]
    expect(readImageMeta(jpeg(1280, 720, { before: dht }))).toMatchObject({ width: 1280, height: 720 })
  })

  it('reports the byte length of a Buffer slice at its own offset', () => {
    const wrapped = Buffer.concat([Buffer.from([1, 2, 3]), Buffer.from(png(1280, 720))])
    const slice = wrapped.subarray(3)
    expect(readImageMeta(slice)).toEqual({ format: 'png', width: 1280, height: 720, bytes: 33 })
  })

  it('throws on unknown, truncated and malformed files', () => {
    expect(() => readImageMeta(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toThrow('not a PNG or JPEG file')
    expect(() => readImageMeta(new Uint8Array(0))).toThrow('not a PNG or JPEG file')
    expect(() => readImageMeta(png(1280, 720).subarray(0, 20))).toThrow(/PNG header is truncated/)
    const notIhdr = png(1280, 720)
    notIhdr.set([0x49, 0x44, 0x41, 0x54], 12)
    expect(() => readImageMeta(notIhdr)).toThrow(/not IHDR/)
    expect(() => readImageMeta(png(0, 720))).toThrow(/zero dimension/)
    expect(() => readImageMeta(jpeg(1280, 720, { noFrame: true }))).toThrow(/SOS/)
    expect(() => readImageMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow(/EOI/)
    expect(() => readImageMeta(jpeg(1280, 720).subarray(0, 24))).toThrow(/truncated|no frame header/)
    expect(() => readImageMeta(new Uint8Array([0xff, 0xd8, 0x00, 0x00]))).toThrow(/marker expected/)
    expect(() => readImageMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]))).toThrow(/invalid length/)
  })
})

describe('checkThumbnailFile', () => {
  it('passes 1280x720 PNG and JPEG under 2 MB', () => {
    expect(checkThumbnailFile(png(1280, 720))).toEqual({ pass: true, issues: [], meta: { format: 'png', width: 1280, height: 720, bytes: 33 } })
    expect(checkThumbnailFile(jpeg(1280, 720)).pass).toBe(true)
  })

  it('passes any 16:9 frame at least 1280 wide, allowing one pixel of rounding', () => {
    expect(checkThumbnailFile(png(1920, 1080)).pass).toBe(true)
    expect(checkThumbnailFile(png(2560, 1440)).pass).toBe(true)
    expect(checkThumbnailFile(png(1366, 768)).pass).toBe(true)
  })

  it('fails a small, a non-16:9 and an oversized file with one issue each', () => {
    const small = checkThumbnailFile(png(640, 360))
    expect(small.pass).toBe(false)
    expect(small.issues).toEqual(['640x360 is smaller than 1280x720'])
    const square = checkThumbnailFile(jpeg(1280, 1280))
    expect(square.issues).toEqual(['1280x1280 is not 16:9 (expected 1280x720)'])
    const heavy = checkThumbnailFile(png(1280, 720, THUMB_MAX_BYTES + 1))
    expect(heavy.pass).toBe(false)
    expect(heavy.issues).toEqual(['2,097,153 bytes is over the 2,097,152 byte limit (2 MB)'])
    expect(checkThumbnailFile(png(1280, 720, THUMB_MAX_BYTES)).pass).toBe(true)
  })

  it('stacks issues and keeps the meta when several rules fail', () => {
    const r = checkThumbnailFile(png(800, 800, THUMB_MAX_BYTES + 100))
    expect(r.pass).toBe(false)
    expect(r.issues).toHaveLength(3)
    expect(r.meta).toMatchObject({ width: 800, height: 800 })
  })

  it('turns an unreadable file into a failed check instead of throwing', () => {
    const r = checkThumbnailFile(new Uint8Array([1, 2, 3]))
    expect(r).toEqual({ pass: false, issues: ['unreadable: not a PNG or JPEG file'] })
  })
})
