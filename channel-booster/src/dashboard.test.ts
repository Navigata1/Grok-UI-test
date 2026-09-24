import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_AS_OF } from '../cli/example-clock.js'
import { FONTS, renderDesk } from '../dashboard/render.mjs'
import { readVideoRows } from './csv.js'
import { suggestDemand } from './ideas.js'
import { computeOutliers } from './outliers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dashboard = path.resolve(here, '..', 'dashboard')

/**
 * Every place a page could pull a resource from another origin: a src, href or data
 * attribute on a fetching element, a CSS url() that is not a data: URI, an @import,
 * a script API that opens a connection, and any other absolute URL outside an <a href>
 * a person clicks.
 */
function remoteResources(html: string): string[] {
  const found: string[] = []
  for (const m of html.matchAll(/<(?:link|script|img|iframe|source|video|audio|embed|object|track|image|use)\b[^>]*>/gi)) {
    if (/\b(?:src|href|data|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(m[0])) found.push(m[0].slice(0, 160))
  }
  for (const m of html.matchAll(/url\(\s*["']?\s*([^"')\s]*)/gi)) if (!m[1].startsWith('data:')) found.push(m[0].slice(0, 160))
  for (const m of html.matchAll(/@import\b[^;]{0,160}/gi)) found.push(m[0])
  for (const m of html.matchAll(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/g)) found.push(m[0])
  for (const m of html.matchAll(/https?:\/\/[^\s"'`<>)]+/gi)) {
    if (!/<a\s[^>]*href=["']$/i.test(html.slice(Math.max(0, m.index - 400), m.index))) found.push(m[0].slice(0, 160))
  }
  return found
}

describe('dashboard build', () => {
  it('index.html is the current template with the current engine bundle and fonts inlined', async () => {
    // The same render build.mjs runs, so the check cannot drift from the build.
    const { html } = await renderDesk()
    const actual = readFileSync(path.join(dashboard, 'index.html'), 'utf8')
    expect(actual === html, 'dashboard/index.html is stale: run `node channel-booster/dashboard/build.mjs`').toBe(true)
  }, 30_000)

  it('template starts with a title and declares both theme blocks', () => {
    const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
    expect(template.startsWith('<title>')).toBe(true)
    expect(template).toContain(':root:not([data-theme="light"])')
    expect(template).toContain(':root[data-theme="dark"]')
    expect(template).not.toMatch(/<!doctype|<html|<head>|<body>/i)
  })

  it('declares the charset and a device-width viewport right after the title, still a fragment', () => {
    // Without the viewport a phone lays the Desk out at 980px and the 760px breakpoint never fires.
    // After the title the parser is still in the implied head, so both land there.
    const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
    expect(template).toMatch(/^<title>[^<]*<\/title>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n/)
  })

  it('index.html loads nothing from another origin', () => {
    // The checker catches what the Desk used to ship.
    expect(remoteResources('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@500">')).not.toEqual([])
    expect(remoteResources('<style>@font-face { src: url(https://example.com/a.woff2) }</style>')).not.toEqual([])
    expect(remoteResources('<script>fetch(location.href)</script>')).not.toEqual([])
    expect(remoteResources('<a href="https://www.youtube.com/">Studio</a>')).toEqual([])
    const html = readFileSync(path.join(dashboard, 'index.html'), 'utf8')
    expect(remoteResources(html)).toEqual([])
    expect(html).not.toContain('fonts.googleapis.com')
  })

  it('inlines every font the type stack names, each with its SIL OFL 1.1 text in fonts/', () => {
    const html = readFileSync(path.join(dashboard, 'index.html'), 'utf8')
    const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
    for (const f of FONTS) {
      const woff2 = readFileSync(path.join(dashboard, 'fonts', f.file))
      expect(woff2.subarray(0, 4).toString('latin1'), f.file).toBe('wOF2')
      expect(html).toContain(`font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2');`)
      const licence = path.join(dashboard, 'fonts', f.licence)
      expect(existsSync(licence), f.licence).toBe(true)
      expect(readFileSync(licence, 'utf8')).toContain('This Font Software is licensed under the SIL Open Font License, Version 1.1.')
    }
    expect(template).toContain("--display: 'Syne',")
    expect(template).toContain("--body: 'IBM Plex Sans',")
    expect(template).toContain("--mono: 'IBM Plex Mono',")
  })
})

/**
 * The Desk's behaviour, pinned at the source level: no DOM runtime is installed, so the
 * template is asserted the way the build is. Each case failed against the template that
 * shipped before its fix; the browser walk behind them is in the commit that added them.
 */
describe('desk template', () => {
  const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
  const engine = readFileSync(path.join(dashboard, 'engine.ts'), 'utf8')
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('grades the publish gate from what the thumbnail panel actually QA-d', () => {
    expect(template).toContain("thumbGrades: [gradeFor($('pb-thumb-a').value), gradeFor($('pb-thumb-b').value)]")
    expect(template).not.toContain("thumbGrades: ['ship', 'ship']")
    expect(template).toContain("function gradeFor(name) { return conceptGrades.get(gradeKey(name)) || 'rethink' }")
  })

  it('does not assert on a person’s behalf that the 48-hour review is scheduled', () => {
    expect(template).not.toMatch(/checkPublish\([^\n]*reviewScheduled: true/)
  })

  it('renders the detail of every failed checklist item', () => {
    expect(template).toContain('${it.detail ? `<br><small class="muted">${esc(it.detail)}</small>` : \'\'}')
  })

  it('keeps the pasted scan across a reload instead of restoring the example', () => {
    expect(template).toMatch(/local\.write\('scanInput'/)
    // Presence, not truthiness: a cleared box is a scan of nothing, not "never scanned".
    expect(template).toContain("$('scan-csv').value = typeof scanInput?.csv === 'string' ? scanInput.csv : EXAMPLE_CSV")
  })

  it('writes the outlier into sources[], never into the document provenance field', () => {
    expect(template).not.toMatch(/source: \$\('idea-source'\)/)
    expect(template).toContain("$('idea-source').value = i.sources?.[0]?.title || ''")
  })

  it('names the real scan order in the card header', () => {
    expect(template).toContain('<h3>Ranked by demand (velocity while a video is fresh, multiplier after)</h3>')
    expect(template).not.toContain('<h3>Ranked by multiplier</h3>')
  })

  it('asks every human gate in the page, never through a native confirm dialog', () => {
    // A published artifact answers confirm() with false: every gate there failed silently.
    expect(template).not.toMatch(/\bconfirm\(/)
    // The gate passes only on its action button; Cancel has the focus, so Enter or Escape cancel.
    expect(template).toContain('<button class="btn" value="cancel" id="gate-cancel" autofocus>Cancel</button><button class="btn primary" value="ok" id="gate-ok"></button>')
    expect(template).toContain("resolve(gateBox.returnValue === 'ok')")
    // The wording each gate had, now stating its consequence in the page.
    for (const words of [
      'Approving a green idea is a human gate: this is your angle, not a clone?',
      'Confirm "${title}" is live as of ${at.slice(0, 16)}? This starts the 24 / 48 / 168 / 672 hour reads.',
      'Approve ${doc.decision} for "${row.title || row.slug}"? An agent prepared it; you own it.',
      'Delete this ledger row?',
      'Accept this rule into the playbook? The CLI appends it under Learned rules on the next sync.',
      'Delete "${i.idea}" from the idea bank?',
    ]) expect(template).toMatch(new RegExp(`!\\(await gate\\(\\{ title: '[^']+', text: ['\`]${escapeRe(words)}`))
  })

  it('deletes a banked idea only after the gate, from a labelled button', () => {
    expect(template).toMatch(/querySelectorAll\('\[data-del\]'\)[^\n]*\n[^\n]*\n\s*if \(!\(await gate\(\{ title: 'Delete an idea'[^\n]*\n\s*await store\.del\('ideas', i\.id\)/)
    expect(template).not.toContain("b.addEventListener('click', () => store.del('ideas', b.dataset.del))")
    expect(template).toContain('aria-label="Delete idea">✕</button>')
    expect(template).toContain('aria-label="Delete ledger row">✕</button>')
  })

  it('carries the concept names from Thumbnail to Publish instead of the letters A and B', () => {
    // The gate looks each grade up by name, so a letter never matches a QA'd concept.
    expect(template).not.toContain("fill('pb-thumb-a', 'A')")
    expect(template).not.toMatch(/\$\('pb-thumb-[ab]'\)\.value\.trim\(\) \|\| '[AB]'/)
    expect(template).toContain("fill('pb-thumb-a', c.a); fill('pb-thumb-b', c.b)")
    expect(template).toContain("thumbs: { a: $('pb-thumb-a').value.trim(), b: $('pb-thumb-b').value.trim() }")
    expect(template).toContain("return { a: i?.thumbA || fallback.a, b: i?.thumbB || fallback.b }")
    expect(template).toContain('data-use-concept="a"')
  })

  it('checks the two exported thumbnail files in the browser and passes the real result', () => {
    expect(engine).toMatch(/export \{ readImageMeta, checkThumbnailFile \} from '\.\.\/src\/imagemeta\.js'/)
    expect(template).toContain('<input id="pb-file-a" type="file" accept="image/png,image/jpeg">')
    expect(template).toContain('<input id="pb-file-b" type="file" accept="image/png,image/jpeg">')
    expect(template).toContain('B.checkThumbnailFile(new Uint8Array(await f.arrayBuffer()))')
    expect(template).toContain('thumbFilesOk: files.every((f) => f.pass), thumbFileIssues: files.flatMap((f) => f.issues)')
  })

  it('escapes every store value it writes as markup', () => {
    // Rows can come from a teammate or an agent through the shared db.
    expect(template).toContain("(x.variants || []).map((v) => esc(v.name)).join(' vs ')")
    expect(template).toContain('${esc(r.title)} · ${esc(r.publishedAt.slice(0, 10))}</option>')
    expect(template).toContain('<span class="chip">${esc(d.bucket)} h</span>')
    expect(template).toContain("r.reads?.[b]?.[k] === undefined ? '—' : esc(")
    expect(template).toContain(' n=${esc(r.tests)}')
    // A document id in an attribute must not close the attribute: only loop indexes and constants go in raw.
    expect([...template.matchAll(/data-[a-z-]+="\$\{(?!esc\(|i\}|stage\})[^}]*\}/g)].map((m) => m[0])).toEqual([])
  })

  it('shows the title formulas offline as shapes with a blank, never as scored fills', () => {
    expect(engine).toMatch(/titleShapes/)
    expect(template).not.toContain('B.generateTitles(')
    expect(template).toContain("const shapes = B.titleShapes({ number: $('tl-number').value.trim() || undefined")
    expect(template).toContain("'<tr><th>Shape</th><th>Formula</th><th>Worked example</th><th></th></tr>'")
  })

  it('ships the CLI example and reads it as of the date it was written for', () => {
    const csv = template.match(/const EXAMPLE_CSV = `([^`]*)`/)?.[1]
    const asOf = template.match(/const EXAMPLE_AS_OF = '([^']+)'/)?.[1]
    expect(csv).toBe(readFileSync(path.resolve(here, '..', 'examples', 'competitors.csv'), 'utf8').trim())
    expect(asOf).toBe(EXAMPLE_AS_OF['competitors.csv'])
    expect(template).toContain('const now = example ? new Date(EXAMPLE_AS_OF) : new Date()')
    expect(template).toContain("sinceDays: numv('scan-since') || 90, now })")
    expect(template).toContain('B.suggestDemand(idea, state.lastScan.ranked, { now: asOf ? new Date(asOf) : new Date() })')
    // At that date the Desk's own placeholder idea finds its demand in the example; on a later wall clock it read 0.
    const idea = template.match(/<input id="idea-text" placeholder="([^"]+)">/)?.[1] ?? ''
    const now = new Date(asOf ?? '')
    const ranked = computeOutliers(readVideoRows(csv ?? ''), { threshold: 10, minAgeDays: 7, sinceDays: 90, now })
    expect(suggestDemand(idea, ranked, { now }).score).toBe(3)
    expect(suggestDemand(idea, ranked, { now: new Date('2026-09-24T00:00:00Z') }).score).toBe(0)
  })

  it('declares a colour scheme so native controls follow the theme', () => {
    expect(template).toMatch(/:root \{\n\s*color-scheme: light;/)
    expect(template).toMatch(/:root:not\(\[data-theme="light"\]\) \{\n\s*color-scheme: dark;/)
    expect(template).toMatch(/:root\[data-theme="dark"\] \{\n\s*color-scheme: dark;/)
    expect(template).toContain('.stack input, td select { padding: 7px 9px; border: 1px solid var(--line);')
  })

  it('labels a compiled rule by where it stands, never as a bare store status', () => {
    expect(engine).toContain("export { ruleStanding, statusLabel } from '../src/rules-core.js'")
    expect(template).toContain('<span class="chip">${esc(B.ruleStanding(r))}')
    expect(template).not.toContain('<span class="chip">${esc(r.status)}')
  })
})
