// Render the single-file Desk: the engine bundle and the fonts inlined into
// template.html. build.mjs writes the result to index.html; src/dashboard.test.ts
// renders it again and requires the two to be identical, so the file on disk is
// never older than its template, its engines or its fonts.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DASHBOARD_DIR = path.dirname(fileURLToPath(import.meta.url))
export const ENGINE_MARKER = '<!-- @@ENGINE@@ -->'
export const FONTS_MARKER = '<!-- @@FONTS@@ -->'

/**
 * The latin subsets the Desk's type stack names, from the Fontsource 5.3.0
 * packages (@fontsource-variable/syne, @fontsource-variable/ibm-plex-sans,
 * @fontsource/ibm-plex-mono). Each family's SIL OFL 1.1 text sits beside its
 * files in fonts/. Inlined as data URIs, so opening the Desk makes no request.
 */
export const FONTS = [
  { family: 'Syne', weight: '400 800', file: 'syne-latin-wght-normal.woff2', licence: 'OFL-Syne.txt' },
  { family: 'IBM Plex Sans', weight: '100 700', file: 'ibm-plex-sans-latin-wght-normal.woff2', licence: 'OFL-IBM-Plex-Sans.txt' },
  { family: 'IBM Plex Mono', weight: '400', file: 'ibm-plex-mono-latin-400-normal.woff2', licence: 'OFL-IBM-Plex-Mono.txt' },
  { family: 'IBM Plex Mono', weight: '500', file: 'ibm-plex-mono-latin-500-normal.woff2', licence: 'OFL-IBM-Plex-Mono.txt' },
]

/** One @font-face per file, the WOFF2 bytes as base64. */
export function fontFaceCss(dir = DASHBOARD_DIR) {
  return FONTS.map((f) => {
    const b64 = readFileSync(path.join(dir, 'fonts', f.file)).toString('base64')
    return `@font-face { font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url(data:font/woff2;base64,${b64}) format('woff2'); }`
  }).join('\n')
}

/** The engines as one IIFE that sets window.Booster. */
export async function engineBundle(dir = DASHBOARD_DIR) {
  const result = await build({
    entryPoints: [path.join(dir, 'engine.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'Booster',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
  })
  return result.outputFiles[0].text
}

function inline(html, marker, content) {
  const at = html.indexOf(marker)
  if (at < 0 || html.indexOf(marker, at + marker.length) >= 0) throw new Error(`template.html must hold ${marker} exactly once`)
  // Sliced, not String.replace: a `$&` or `$'` inside the bundle must land as written.
  return html.slice(0, at) + content + html.slice(at + marker.length)
}

/** The Desk as index.html holds it. */
export async function renderDesk(dir = DASHBOARD_DIR) {
  const bundle = await engineBundle(dir)
  const fonts = fontFaceCss(dir)
  const template = readFileSync(path.join(dir, 'template.html'), 'utf8')
  const html = inline(inline(template, FONTS_MARKER, `<style>\n${fonts}\n</style>`), ENGINE_MARKER, `<script>\n${bundle}\n</script>`)
  return { html, bundleBytes: bundle.length, fontBytes: fonts.length }
}
