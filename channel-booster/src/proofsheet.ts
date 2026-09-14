/**
 * Proof sheet (architecture 2.7): one self-contained HTML file that shows
 * every thumbnail concept at 120px wide (the phone feed) and 240px wide
 * (desktop) beside the top three competitor titles, once on a light ground
 * and once on a dark one, so the "would you click yours?" ritual runs on
 * the same stimulus every week.
 *
 * The file is opened from disk: inline CSS only, no scripts, no external
 * requests. Delivered PNGs are inlined as data URIs; anything that is not a
 * `data:image/...` URI is refused so the sheet can never phone home.
 * Browser-safe: no Node imports.
 */

export interface ProofSheetConcept {
  name: string
  /** Text on the thumbnail, or empty. Drawn on the placeholder when no image is given. */
  text?: string
  focalSubject: string
  /** Colour pair, e.g. ["yellow", "black"]: the placeholder uses the first as ink and the second as ground. */
  colors?: string[]
  /** Inlined delivered image, `data:image/png;base64,...`. Optional; the placeholder is drawn without it. */
  imageDataUri?: string
}

export interface ProofSheetInput {
  /** The working title the concepts ship with. */
  title: string
  concepts: ProofSheetConcept[]
  /** Competitor video titles; only the first three are drawn. */
  competitors: string[]
  channelName?: string
}

/** Width of the phone-feed card in CSS pixels; the sourced "readable at 120px wide" check. */
export const PROOF_SMALL_PX = 120
/** Width of the desktop-feed card in CSS pixels (twice the phone card). */
export const PROOF_LARGE_PX = 240
/** Competitor titles drawn beside each concept (the packaging review's "top three competing videos"). */
export const PROOF_COMPETITORS = 3

const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+=*$/
const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function cssColor(c: string | undefined, fallback: string): string {
  const v = (c ?? '').trim().toLowerCase()
  return CSS_COLOR.test(v) ? v : fallback
}

function card(concept: ProofSheetConcept, width: number): string {
  const height = Math.round((width * 9) / 16)
  const label = escapeHtml(concept.text?.trim() || concept.focalSubject.trim() || concept.name)
  const fontPx = Math.max(9, Math.round(width / 8))
  if (concept.imageDataUri) {
    return `<figure class="card" style="width:${width}px"><img src="${concept.imageDataUri}" width="${width}" height="${height}" alt="${escapeHtml(concept.name)}"><figcaption>${escapeHtml(concept.name)}</figcaption></figure>`
  }
  const ink = cssColor(concept.colors?.[0], '#ffd400')
  const ground = cssColor(concept.colors?.[1], '#111111')
  return `<figure class="card" style="width:${width}px"><div class="thumb" style="width:${width}px;height:${height}px;background:${ground};color:${ink};font-size:${fontPx}px">${label}</div><figcaption>${escapeHtml(concept.name)}</figcaption></figure>`
}

function competitorCard(title: string, width: number): string {
  const height = Math.round((width * 9) / 16)
  return `<figure class="card rival" style="width:${width}px"><div class="thumb grey" style="width:${width}px;height:${height}px"></div><figcaption>${escapeHtml(title)}</figcaption></figure>`
}

function feedRow(concept: ProofSheetConcept, competitors: string[], width: number): string {
  return `<div class="feed feed-${width}">${card(concept, width)}${competitors.map((t) => competitorCard(t, width)).join('')}</div>`
}

function section(theme: 'light' | 'dark', input: ProofSheetInput, competitors: string[]): string {
  const blocks = input.concepts.map((c, i) => `<div class="concept"><h3>${i + 1}. ${escapeHtml(c.name)} <small>${escapeHtml(c.focalSubject)}${c.text?.trim() ? ` · text “${escapeHtml(c.text.trim())}”` : ' · no text'}</small></h3>${feedRow(c, competitors, PROOF_SMALL_PX)}${feedRow(c, competitors, PROOF_LARGE_PX)}</div>`).join('')
  return `<section class="${theme}"><h2>${theme === 'light' ? 'Light' : 'Dark'} feed</h2>${blocks || '<p class="empty">No concepts yet.</p>'}</section>`
}

/**
 * Render the proof sheet as one HTML string. Throws when an `imageDataUri`
 * is not a base64 `data:image/...` URI (the sheet may not load anything
 * from the network). Pure: the same input yields the same string.
 */
export function renderProofSheet(input: ProofSheetInput): string {
  for (const c of input.concepts) {
    if (c.imageDataUri !== undefined && !DATA_IMAGE.test(c.imageDataUri)) {
      throw new Error(`concept "${c.name}": imageDataUri must be a base64 data:image/... URI (the proof sheet makes no external requests)`)
    }
  }
  const competitors = input.competitors.map((t) => t.trim()).filter(Boolean).slice(0, PROOF_COMPETITORS)
  const heading = `${input.channelName?.trim() ? `${escapeHtml(input.channelName.trim())} · ` : ''}${escapeHtml(input.title)}`
  const css = [
    'body{margin:0;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f4;color:#111}',
    'main{max-width:1100px;margin:0 auto;padding:24px 16px}',
    'h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}h3{font-size:14px;margin:16px 0 8px}h3 small{font-weight:normal;opacity:.7}',
    'section{border-radius:12px;padding:16px;margin:16px 0}section.light{background:#fff;color:#0f0f0f}section.dark{background:#0f0f0f;color:#f1f1f1}',
    '.feed{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin:8px 0}',
    '.card{margin:0;flex:0 0 auto}.card img{display:block;border-radius:6px;object-fit:cover}',
    '.thumb{display:flex;align-items:center;justify-content:center;text-align:center;padding:4px;box-sizing:border-box;border-radius:6px;font-weight:800;line-height:1.05;overflow:hidden;word-break:break-word}',
    '.thumb.grey{background:#8a8a8a}section.dark .thumb.grey{background:#3a3a3a}',
    'figcaption{font-size:11px;line-height:1.25;margin-top:4px;max-height:2.5em;overflow:hidden}.rival figcaption{opacity:.8}',
    '.ritual{background:#fff3c4;color:#3d2e00;border-radius:8px;padding:12px 16px;margin:12px 0}.ritual ol{margin:6px 0 0;padding-left:20px}',
    '.drift{border:1px dashed #999;border-radius:8px;padding:12px 16px;margin:12px 0;min-height:48px}',
    '.empty{opacity:.7}',
    '@media print{section{break-inside:avoid}}',
  ].join('\n')
  const ritual = `<div class="ritual"><strong>Would you click yours?</strong><ol><li>Look at the 120px row for one second. Where does the eye land?</li><li>Cover the title. Does the image alone make you curious?</li><li>Next to the three competitors, is yours the one you would tap? If not, say why in one sentence.</li></ol></div>`
  const drift = `<div class="drift"><strong>Deliberate signature drift (write it here or it did not happen):</strong></div>`
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    `<title>Proof sheet · ${escapeHtml(input.title)}</title>`,
    `<style>${css}</style>`,
    '</head>',
    '<body><main>',
    `<h1>Proof sheet · ${heading}</h1>`,
    `<p>${input.concepts.length} concept${input.concepts.length === 1 ? '' : 's'} at ${PROOF_SMALL_PX}px and ${PROOF_LARGE_PX}px beside ${competitors.length} competitor title${competitors.length === 1 ? '' : 's'}. Same stimulus every week.</p>`,
    ritual,
    section('light', input, competitors),
    section('dark', input, competitors),
    drift,
    '</main></body>',
    '</html>',
  ].join('\n')
}
