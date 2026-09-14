/**
 * Thumbnail file acceptance (architecture 2.7): read the PNG IHDR or the
 * JPEG SOF header in pure TypeScript, no image library, and check the file
 * against YouTube's thumbnail limits (1280x720, 16:9, 2 MB).
 *
 * Browser-safe: works on any Uint8Array (a Node Buffer included) and
 * imports nothing.
 */

export interface ImageMeta {
  format: 'png' | 'jpeg'
  width: number
  height: number
  /** Size of the buffer that was read. */
  bytes: number
}

export interface ThumbnailFileCheck {
  pass: boolean
  issues: string[]
  /** Present whenever the header could be read, even when the check fails. */
  meta?: ImageMeta
}

/** Minimum width of a delivered thumbnail [unverified: YouTube Help says 1280x720 is the recommended size]. Move to thresholds.ts (thumbMinWidth). */
export const THUMB_MIN_WIDTH = 1280
/** Minimum height, so that 1280 wide at 16:9 is 720 [unverified]. Move to thresholds.ts (thumbMinHeight). */
export const THUMB_MIN_HEIGHT = 720
/** Maximum file size in bytes, 2 MB [unverified: YouTube Help states a 2 MB limit for thumbnails]. Move to thresholds.ts (thumbMaxBytes). */
export const THUMB_MAX_BYTES = 2_097_152

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
}

function readPng(buf: Uint8Array): ImageMeta {
  // Signature (8) + first chunk: length (4), type "IHDR" (4), width (4), height (4).
  if (buf.byteLength < 24) throw new Error('PNG header is truncated')
  const dv = view(buf)
  const type = String.fromCharCode(buf[12], buf[13], buf[14], buf[15])
  if (type !== 'IHDR') throw new Error(`PNG first chunk is ${JSON.stringify(type)}, not IHDR`)
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  if (width === 0 || height === 0) throw new Error('PNG IHDR has a zero dimension')
  return { format: 'png', width, height, bytes: buf.byteLength }
}

function isSof(marker: number): boolean {
  // SOF0..SOF15 are C0..CF, except DHT (C4), JPG (C8) and DAC (CC).
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function readJpeg(buf: Uint8Array): ImageMeta {
  const dv = view(buf)
  let i = 2
  while (i < buf.byteLength) {
    if (buf[i] !== 0xff) throw new Error(`JPEG marker expected at byte ${i}`)
    // Fill bytes: any number of FF before the marker code.
    while (i < buf.byteLength && buf[i] === 0xff) i += 1
    if (i >= buf.byteLength) break
    const marker = buf[i]
    i += 1
    // Standalone markers carry no length: TEM (01), RSTn (D0-D7), SOI (D8).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9) throw new Error('JPEG ended (EOI) before a frame header')
    if (marker === 0xda) throw new Error('JPEG scan started (SOS) before a frame header')
    if (i + 2 > buf.byteLength) throw new Error('JPEG segment length is truncated')
    const length = dv.getUint16(i)
    if (length < 2) throw new Error(`JPEG segment 0x${marker.toString(16)} has an invalid length`)
    if (isSof(marker)) {
      // Payload: precision (1), height (2), width (2), components (1)...
      if (i + 7 > buf.byteLength) throw new Error('JPEG frame header is truncated')
      const height = dv.getUint16(i + 3)
      const width = dv.getUint16(i + 5)
      if (width === 0 || height === 0) throw new Error('JPEG frame header has a zero dimension')
      return { format: 'jpeg', width, height, bytes: buf.byteLength }
    }
    i += length
  }
  throw new Error('JPEG has no frame header (SOF) before the data ran out')
}

/**
 * Read the format and pixel size from the first bytes of a PNG or JPEG.
 * Only the header is parsed: a PNG's IHDR chunk, or a JPEG's SOFn segment
 * (baseline SOF0, progressive SOF2, and the other SOFn frames). Throws on
 * anything else, including a truncated header.
 */
export function readImageMeta(buf: Uint8Array): ImageMeta {
  if (buf.byteLength >= 8 && PNG_SIGNATURE.every((b, i) => buf[i] === b)) return readPng(buf)
  if (buf.byteLength >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return readJpeg(buf)
  throw new Error('not a PNG or JPEG file')
}

/**
 * Accept or refuse a delivered thumbnail file: PNG or JPEG, 1280x720 or
 * any 16:9 frame at least 1280 wide (a height within one pixel of 16:9 is
 * allowed for rounding), and at most 2,097,152 bytes. An unreadable file
 * fails with the parse error as its issue instead of throwing.
 */
export function checkThumbnailFile(buf: Uint8Array): ThumbnailFileCheck {
  let meta: ImageMeta
  try {
    meta = readImageMeta(buf)
  } catch (err) {
    return { pass: false, issues: [`unreadable: ${(err as Error).message}`] }
  }
  const issues: string[] = []
  if (meta.width < THUMB_MIN_WIDTH || meta.height < THUMB_MIN_HEIGHT) {
    issues.push(`${meta.width}x${meta.height} is smaller than ${THUMB_MIN_WIDTH}x${THUMB_MIN_HEIGHT}`)
  }
  const expectedHeight = (meta.width * 9) / 16
  if (Math.abs(meta.height - expectedHeight) > 1) {
    issues.push(`${meta.width}x${meta.height} is not 16:9 (expected ${meta.width}x${Math.round(expectedHeight)})`)
  }
  if (meta.bytes > THUMB_MAX_BYTES) {
    issues.push(`${meta.bytes.toLocaleString('en-US')} bytes is over the ${THUMB_MAX_BYTES.toLocaleString('en-US')} byte limit (2 MB)`)
  }
  return { pass: issues.length === 0, issues, meta }
}
