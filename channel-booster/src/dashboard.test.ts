import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_AS_OF } from '../cli/example-clock.js'
import { FONTS, renderDesk } from '../dashboard/render.mjs'
import { readVideoRows } from './csv.js'
import { suggestDemand } from './ideas.js'
import { computeOutliers } from './outliers.js'
import { ruleSentence } from './rules-core.js'
import type { RuleDoc } from './schema.js'

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

  it('template starts with a title, dark on bare :root, light only through the Desk’s own control', () => {
    const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
    expect(template.startsWith('<title>')).toBe(true)
    expect(template).toMatch(/\n {2}:root \{\n {4}color-scheme: dark;\n {4}--bg: #0A0A0B;/)
    expect(template).toMatch(/\n {2}:root\[data-desk-theme="light"\] \{\n {4}color-scheme: light;\n/)
    // The viewer stamps data-theme on the root from its own setting and the OS has its own preference: neither decides.
    expect(template).not.toMatch(/prefers-color-scheme/)
    expect(template).not.toMatch(/\[data-theme\b|dataset\.theme\b/)
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

  /** A function the Desk's script declares, as source text, cut at its matching brace (its body has no braces in strings). */
  function deskFunction(name: string): string {
    const start = template.indexOf(`function ${name}(`)
    expect(start, `template declares function ${name}`).toBeGreaterThanOrEqual(0)
    let depth = 0
    // The body opens after the parameter list, which may itself hold a destructuring brace.
    for (let i = template.indexOf(') {', start) + 2; i < template.length; i += 1) {
      if (template[i] === '{') depth += 1
      else if (template[i] === '}' && --depth === 0) return template.slice(start, i + 1)
    }
    throw new Error(`unbalanced function ${name}`)
  }

  /** Form fields as the Desk's $() returns them: value, text, class and markup, created empty on first use. */
  function fields(): { $: (id: string) => Record<string, string>; all: Map<string, Record<string, string>> } {
    const all = new Map<string, Record<string, string>>()
    const $ = (id: string) => {
      if (!all.has(id)) all.set(id, { value: '', textContent: '', className: '', innerHTML: '' })
      return all.get(id)!
    }
    return { $, all }
  }

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
    // The gate passes only on its action button; Cancel has the focus, so Enter or Escape cancel. The focus is
    // set when the gate opens: autofocus in a cross-origin frame (the published Desk runs in one) is blocked
    // and logs a console error on every load.
    expect(template).toContain('<button class="btn" value="cancel" id="gate-cancel">Cancel</button><button class="btn human" value="ok" id="gate-ok"></button>')
    expect(template).not.toMatch(/<[a-z]+\b[^>]*\sautofocus\b/)
    expect(deskFunction('gate')).toMatch(/gateBox\.showModal\(\)[\s\S]*\$\('gate-cancel'\)\.focus\(\)/)
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

  it('closes the gate from its own buttons, so a frame sandboxed without allow-forms still gets an answer', () => {
    // There the form's method="dialog" submit is blocked: Cancel and the action button did nothing and the gate
    // stayed open. Run the line as shipped against two fake buttons and a fake dialog.
    const line = template.match(/\n {2}(for \(const b of \[\$\('gate-cancel'\), \$\('gate-ok'\)\]\)[^\n]*)/)?.[1]
    expect(line, 'template wires the gate buttons').toBeTruthy()
    const handlers: Record<string, (e: { preventDefault: () => void }) => void> = {}
    const button = (id: string, value: string) => ({ value, addEventListener: (type: string, f: (e: { preventDefault: () => void }) => void) => { if (type === 'click') handlers[id] = f } })
    const buttons: Record<string, ReturnType<typeof button>> = { 'gate-cancel': button('gate-cancel', 'cancel'), 'gate-ok': button('gate-ok', 'ok') }
    const closed: string[] = []
    new Function('$', 'gateBox', line!)((id: string) => buttons[id], { close: (v: string) => closed.push(v) })
    let prevented = 0
    const click = { preventDefault: () => { prevented += 1 } }
    handlers['gate-cancel'](click)
    handlers['gate-ok'](click)
    expect(closed).toEqual(['cancel', 'ok'])
    expect(prevented).toBe(2)
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
    expect(template).toContain('data-use-concept="a"')
  })

  it('never offers the concept picked for one slot as the other in Publish', () => {
    // The Desk's own chosenConcepts(), run on the review's case: QA "stakes", QA "result", use "result" as A.
    const pick = (idea: { thumbA?: string; thumbB?: string } | undefined, qaOrder: string[], typed: { a?: string; b?: string } = {}) => {
      const { $ } = fields()
      $('pb-thumb-a').value = typed.a ?? ''
      $('pb-thumb-b').value = typed.b ?? ''
      const gradeKey = (name: string | undefined) => (name || '').trim().toLowerCase()
      // eslint-disable-next-line no-new-func
      return new Function('$', 'currentIdea', 'qaOrder', 'gradeKey', `${deskFunction('chosenConcepts')}; return chosenConcepts()`)($, () => idea, qaOrder, gradeKey) as { a: string; b: string }
    }
    expect(pick({ thumbA: 'result' }, ['stakes', 'result'])).toEqual({ a: 'result', b: 'stakes' })
    expect(pick({ thumbB: 'Stakes' }, ['stakes', 'result'])).toEqual({ a: 'result', b: 'Stakes' })
    // Picked straight into the field with no idea open: the field counts as the pick.
    expect(pick(undefined, ['stakes', 'result'], { a: 'result' })).toEqual({ a: 'result', b: 'stakes' })
    // Nothing picked: the last two QA'd, older first; one concept QA'd fills A only.
    expect(pick(undefined, ['curiosity', 'stakes', 'result'])).toEqual({ a: 'stakes', b: 'result' })
    expect(pick({ thumbA: 'result' }, ['result'])).toEqual({ a: 'result', b: '' })
    expect(pick({ thumbA: 'stakes', thumbB: 'contrast' }, ['result'])).toEqual({ a: 'stakes', b: 'contrast' })
  })

  it('opening another idea replaces every per-idea field, so Publish never carries the last idea\'s pair or upload', () => {
    const { $ } = fields()
    const ideas = [
      { id: 'x', idea: 'Idea X solar fridge', title: 'I Lived Off a $300 Solar Generator for 30 Days', promise: 'p', thumbText: 'DEAD BY NOON', thumbA: 'stakes', thumbB: 'contrast', script: 'x script', thumbnailMoment: 'the fridge', scores: {} },
      { id: 'y', idea: 'Idea Y camping stove', scores: {} },
    ]
    // eslint-disable-next-line no-new-func
    const loadIdea = new Function('$', 'ideas', 'state', 'local', 'AXES', 'scoreCurrentIdea', 'renderCurrent', `${deskFunction('loadIdea')}; return loadIdea`)(
      $, () => ideas, {}, { write: () => {} }, [], () => {}, () => {},
    ) as (id: string) => void
    loadIdea('x')
    expect([$('pb-title').value, $('pb-thumb-a').value, $('pb-thumb-b').value]).toEqual(['I Lived Off a $300 Solar Generator for 30 Days', 'stakes', 'contrast'])
    // What a person typed into Publish for X's upload.
    $('pb-video-id').value = 'aB3dEfGh1jK'; $('pb-levers').value = 'stakes, contrast'; $('pb-predict').value = '1.4'; $('pb-sequel').value = 'q'
    $('pb-check').innerHTML = '<h3>Checklist</h3>'
    loadIdea('y')
    for (const id of ['pr-title', 'tq-title', 'st-title', 'pb-title', 'pk-promise', 'st-promise', 'pb-promise', 'pr-thumb', 'tq-text', 'pb-thumb-a', 'pb-thumb-b', 'st-script', 'st-moment', 'pb-video-id', 'pb-levers', 'pb-sequel', 'pb-related', 'pb-at']) {
      expect($(id).value, `${id} after opening Y`).toBe('')
    }
    expect($('pb-predict').value).toBe('1.0')
    expect($('pb-check').innerHTML).toBe('')
    expect($('idea-text').value).toBe('Idea Y camping stove')
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
    expect(template).toMatch(/\n {2}:root \{\n {4}color-scheme: dark;/)
    expect(template).toMatch(/\n {2}:root\[data-desk-theme="light"\] \{\n {4}color-scheme: light;/)
    // Inputs outside a .field share the .field box by construction: one rule, one selector list.
    expect(template).toContain('.field input, .field select, .field textarea, .stack input, td select { padding: 8px 12px; border: 1px solid var(--line-strong);')
  })

  describe('theme', () => {
    const style = template.slice(template.indexOf('<style>\n'), template.indexOf('</style>'))
    const dark = style.match(/\n {2}:root \{\n([\s\S]*?)\n {2}\}/)?.[1] ?? ''
    const light = style.match(/\n {2}:root\[data-desk-theme="light"\] \{\n([\s\S]*?)\n {2}\}/)?.[1] ?? ''
    const names = (block: string) => [...block.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1])

    it('takes every colour from a token defined on bare :root; the light block only redefines them', () => {
      expect(names(dark)).toEqual(expect.arrayContaining(['bg', 'panel', 'panel-2', 'raised', 'ink', 'muted', 'line', 'line-strong', 'primary', 'primary-ink', 'accent', 'accent-ink', 'good', 'warn', 'bad', 'good-soft', 'warn-soft', 'bad-soft']))
      expect(names(light).filter((n) => !names(dark).includes(n))).toEqual([])
      const rules = style.replace(dark, '').replace(light, '')
      expect(rules.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/gi)).toBeNull()
      expect([...rules.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]).filter((n) => !names(dark).includes(n))).toEqual([])
      expect([...template.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).filter((s) => /#|rgb|hsl|color/i.test(s))).toEqual([])
      expect(style).toContain('body { margin: 0; background: var(--bg);')
    })

    it('keeps the Grok roles: a white pill for primary actions, amber only where a person decides', () => {
      expect(dark).toContain('--bg: #0A0A0B;')
      expect(dark).toContain('--primary: #F2F2F0;')
      expect(dark).toContain('--primary-ink: #0A0A0B;')
      expect(dark).toContain('--accent: #F5B400;')
      expect(style).toContain('.btn.primary { background: var(--primary); color: var(--primary-ink);')
      expect(style).toContain('.btn.human { background: var(--accent); color: var(--accent-ink);')
      // The buttons that open a human gate, and the gate's own action button.
      for (const id of ['pb-confirm', 'retro-accept', 'rv-approve', 'gate-ok']) expect(template).toMatch(new RegExp(`<button class="btn human"[^>]* id="${id}"`))
      expect(style).toContain(':focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }')
      expect(style).not.toMatch(/outline: [^;]*var\(--accent\)/)
      expect(style).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{[^\n]*transition:/)
      expect(style.match(/transition:/g)).toHaveLength(1)
    })

    /** The theme script as the Desk ships it, run against a fake root, the two buttons and a storage. */
    function runTheme(storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }) {
      const body = template.match(/\n {2}<script>\n( {2}\/\/ The theme[\s\S]*?)<\/script>/)?.[1]
      expect(body, 'template ships the theme script after the header').toBeTruthy()
      const root = { dataset: {} as Record<string, string> }
      const buttons = ['dark', 'light'].map((choice) => {
        let onClick = () => {}
        const attrs: Record<string, string> = {}
        return { choice, attrs, dataset: { deskThemeChoice: choice }, setAttribute: (k: string, v: string) => { attrs[k] = v }, addEventListener: (type: string, f: () => void) => { if (type === 'click') onClick = f }, click: () => onClick() }
      })
      new Function('document', 'localStorage', body!)({ documentElement: root, querySelectorAll: () => buttons }, storage)
      const pressed = () => Object.fromEntries(buttons.map((b) => [b.choice, b.attrs['aria-pressed']]))
      return { root, pressed, click: (choice: string) => buttons.find((b) => b.choice === choice)!.click() }
    }

    it('offers Dark and Light as a pressed-state pair in the header, Dark pressed in the markup', () => {
      expect(template).toContain('<div class="theme" role="group" aria-label="Theme"><button type="button" data-desk-theme-choice="dark" aria-pressed="true">Dark</button><button type="button" data-desk-theme-choice="light" aria-pressed="false">Light</button></div>\n  </header>\n  <script>\n  // The theme')
    })

    it('opens dark and still switches where storage throws, as in the sandboxed artifact frame', () => {
      const denied = () => { throw new Error('SecurityError') }
      const t = runTheme({ getItem: denied, setItem: denied })
      expect(t.root.dataset.deskTheme).toBe('dark')
      expect(t.pressed()).toEqual({ dark: 'true', light: 'false' })
      t.click('light')
      expect(t.root.dataset.deskTheme).toBe('light')
      expect(t.pressed()).toEqual({ dark: 'false', light: 'true' })
    })

    it('remembers the pick in this browser under booster.desk.theme, and opens with it', () => {
      const saved = new Map<string, string>()
      const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v) } }
      const first = runTheme(storage)
      expect(first.root.dataset.deskTheme).toBe('dark')
      first.click('light')
      expect([...saved]).toEqual([['booster.desk.theme', 'light']])
      const second = runTheme(storage)
      expect(second.root.dataset.deskTheme).toBe('light')
      expect(second.pressed()).toEqual({ dark: 'false', light: 'true' })
      second.click('dark')
      expect(saved.get('booster.desk.theme')).toBe('dark')
      expect(runTheme(storage).root.dataset.deskTheme).toBe('dark')
      // Anything but "light" in the store is the default.
      saved.set('booster.desk.theme', 'blue')
      expect(runTheme(storage).root.dataset.deskTheme).toBe('dark')
    })

    /** The declarations of one rule inside the phone breakpoint, found by its exact selector. */
    const phone = style.match(/\n {2}@media \(max-width: 760px\) \{\n([\s\S]*?)\n {2}\}\n/)?.[1] ?? ''
    const phoneRule = (selector: string) => phone.match(new RegExp(`\\n {4}${escapeRe(selector)} \\{ ([^}]*) \\}`))?.[1] ?? ''
    /** A padding or margin shorthand as [top, right, bottom, left] in px. */
    const sides = (value: string) => {
      const [t, r = t, b = t, l = r] = value.trim().split(/\s+/).map((v) => parseFloat(v))
      return [t, r, b, l]
    }

    it('gives the phone rail room for the whole focus ring, since a sideways scroller clips what it paints', () => {
      const ring = style.match(/:focus-visible \{ outline: (\d+)px solid var\(--ink\); outline-offset: (\d+)px; \}/)
      expect(ring, 'one focus ring rule').toBeTruthy()
      const reach = Number(ring![1]) + Number(ring![2])
      const rail = phoneRule('nav.rail')
      expect(rail).toContain('overflow-x: auto;')
      const padding = sides(rail.match(/(?:^|; )padding: ([^;]+);/)?.[1] ?? '0')
      expect(Math.min(...padding), `rail padding ${padding.join(' ')} leaves room for a ${reach}px ring`).toBeGreaterThanOrEqual(reach)
      // Pulled back out by as much on the top and sides, so the buttons sit where they did.
      expect(sides(rail.match(/(?:^|; )margin: ([^;]+);/)?.[1] ?? '0')).toEqual([-padding[0], -padding[1], 0, -padding[3]])
      expect(parseFloat(rail.match(/scroll-padding-inline: ([^;]+);/)?.[1] ?? '0')).toBeGreaterThanOrEqual(reach)
    })

    it('lets a verdict’s explanation drop below a long label on a phone instead of squeezing it', () => {
      expect(phoneRule('.verdict')).toContain('flex-wrap: wrap;')
      const basis = phoneRule('.verdict > div').match(/flex: 1 1 (\d+)px; min-width: 0;/)
      expect(Number(basis?.[1])).toBeGreaterThanOrEqual(200)
    })
  })

  it('labels a compiled rule by where it stands, never as a bare store status', () => {
    expect(engine).toContain("export { ruleSentence, ruleStanding, statusLabel } from '../src/rules-core.js'")
    expect(template).toContain('<span class="chip">${esc(B.ruleStanding(r))}')
    expect(template).not.toContain('<span class="chip">${esc(r.status)}')
  })

  it('shows a compiled rule as the hypothesis sentence, even a row an older compile stored as an instruction', () => {
    // Agents write compiled rules into the Desk's db; before rules were hypotheses a compile stored "Prefer ...".
    expect(template).toContain('<li>${esc(B.ruleSentence(r))} <span class="chip">')
    expect(template).not.toContain('<li>${esc(r.rule)} <span class="chip">')
    const legacy = { rule: 'Prefer "number-in-title" on this channel', lever: 'number-in-title', status: 'promoted', tests: 3, wins: 3, confidence: 0.8, pinned: false, slugs: [] } as unknown as RuleDoc
    expect(ruleSentence(legacy)).toBe('Hypothesis under observation: "number-in-title" may help on this channel')
    expect(ruleSentence({ ...legacy, rule: 'Avoid "question-title"', lever: 'question-title', status: 'retired' })).toBe('Hypothesis under observation: "question-title" may not help on this channel')
    // A person's rule is shown as they wrote it.
    expect(ruleSentence({ ...legacy, rule: 'Stakes in the title beat curiosity here', status: 'pinned', pinned: true, acceptedBy: 'desk' })).toBe('Stakes in the title beat curiosity here')
  })

  it('diagnoses a 7 or 28-day read on the views baseline decide() uses, never the typed one', () => {
    // The typed views (4,000) against the 7-day median decide() judged (2,000) put two baselines on one Review card.
    expect(template).not.toContain("baseline: baselines.n < 5 ? flatBaseline() : undefined")
    expect(template).toContain("const weekRead = bucket === '168' || bucket === '672'")
    expect(template).toContain('const flat = baselines.n < 5 ? { ...flatBaseline(), ...(weekRead ? { views: undefined } : {}) } : undefined')
    expect(template).toContain('baselines: baselines.n > 0 ? baselines : undefined, baseline: flat, hoursSincePublish: hours')
  })
})
