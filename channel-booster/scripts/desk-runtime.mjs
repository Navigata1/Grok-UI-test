#!/usr/bin/env node
// P1-G2, the Desk runtime journey: drives the built Desk (dashboard/index.html) in Chromium and checks what the
// source tests cannot. It opens dark whatever the OS or the host page says, the theme control switches and
// remembers, the human gates work inside a sandboxed artifact frame, nothing is requested from the network, a
// phone never scrolls sideways nor squeezes a verdict, no select cuts off an option and the publish pack's Copy
// button covers none of its text, every control shows the whole focus ring on desktop and phone, reduced motion
// stops the transitions, and the text tokens meet 4.5:1 on their surfaces in both themes.
// Each check prints PASS or FAIL; any FAIL exits 1.
//
//   node channel-booster/scripts/desk-runtime.mjs
//
// Evidence lands in ops/mission/evidence/desk/ under the repo root: desktop-dark.png, desktop-light.png,
// phone-dark.png, phone-light.png, gate-dialog.png, artifact-frame.png, trace.zip (journeys a-c) and
// journey.json (every check, what it measured, PASS or FAIL). Rebuild the Desk first if the template changed:
// `node channel-booster/dashboard/build.mjs`.
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESK = path.resolve(HERE, '..', 'dashboard', 'index.html')
const THEME_KEY = 'booster.desk.theme'
const STAGES = ['today', 'scan', 'ideas', 'package', 'thumb', 'story', 'workflow', 'publish', 'review', 'ledger', 'retro', 'profile']
const IDEA = 'I lived off a $300 solar generator for 30 days'

/** The nearest folder above this script that holds .git (a worktree holds a .git file), else two levels up. */
function repoRoot() {
  for (let dir = HERE; path.dirname(dir) !== dir; dir = path.dirname(dir)) if (existsSync(path.join(dir, '.git'))) return dir
  return path.resolve(HERE, '..', '..')
}
const ROOT = repoRoot()
const EVIDENCE = path.join(ROOT, 'ops', 'mission', 'evidence', 'desk')

// ---------- checks ----------
const checks = []
function check(id, name, pass, measured, line = JSON.stringify(measured)) {
  checks.push({ id, name, result: pass ? 'PASS' : 'FAIL', measured })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${line ? ' :: ' + line : ''}`)
}
/** One step of a journey. A step that throws fails the check it owns, and the journey goes on to the next. */
async function step(id, name, fn) {
  try {
    await fn()
  } catch (e) {
    check(id, name, false, { error: String(e?.stack ?? e) }, 'did not complete: ' + String(e?.message ?? e).split('\n')[0])
  }
}

// ---------- colour ----------
/** A computed CSS colour as [r, g, b, a] (0-255, alpha 0-1): Chromium reports rgb() and rgba(). */
function parseColor(css) {
  const n = String(css).match(/[\d.]+/g)?.map(Number) ?? []
  if (css === 'transparent' || n.length < 3) return [0, 0, 0, 0]
  return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]
}
/** `top` painted over an opaque `under`. */
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)
function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()

// ---------- browser ----------
async function launch() {
  try {
    return await chromium.launch()
  } catch (e) {
    // This Playwright may expect a newer browser build than the one installed: fall back to the newest installed Chromium.
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
    const found = existsSync(base)
      ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))).map((d) => path.join(base, d, 'chrome-linux', 'chrome')).find((p) => existsSync(p))
      : undefined
    if (!found) throw new Error(`Chromium did not launch (${String(e.message).split('\n')[0]}). Install it with \`npx playwright install chromium\`, or set PLAYWRIGHT_BROWSERS_PATH to a folder holding chromium-<rev>/chrome-linux/chrome.`)
    return chromium.launch({ executablePath: found })
  }
}

/** A context that records every request, console error, uncaught error and native dialog, and lets nothing out. */
async function context(browser, options) {
  const ctx = await browser.newContext(options)
  ctx.setDefaultTimeout(10_000)
  const seen = { offsite: [], consoleErrors: [], nativeDialogs: [] }
  ctx.on('request', (r) => { if (!/^(file|data):/i.test(r.url())) seen.offsite.push(r.url().slice(0, 160)) })
  ctx.on('console', (m) => { if (m.type() === 'error') seen.consoleErrors.push(m.text().slice(0, 240)) })
  ctx.on('weberror', (e) => seen.consoleErrors.push('uncaught: ' + String(e.error()?.message ?? e.error()).slice(0, 240)))
  ctx.on('dialog', (d) => { seen.nativeDialogs.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}) })
  await ctx.route(/^(https?|wss?):/i, (r) => r.abort())
  return { ctx, seen }
}
const clean = (seen) => seen.consoleErrors.length === 0 && seen.offsite.length === 0
const cleanLine = (seen) => `console errors ${seen.consoleErrors.length}, offsite requests ${seen.offsite.length}` + ([...seen.consoleErrors, ...seen.offsite].length ? ': ' + [...seen.consoleErrors, ...seen.offsite].join(' | ') : '')

/** The theme as the page renders it: the Desk's own attribute, the root colour scheme, the canvas and the control. */
const themeState = (frame) => frame.evaluate(() => {
  const root = document.documentElement
  const pressed = Object.fromEntries([...document.querySelectorAll('[data-desk-theme-choice]')].map((b) => [b.dataset.deskThemeChoice, b.getAttribute('aria-pressed')]))
  return { deskTheme: root.dataset.deskTheme ?? null, hostTheme: root.getAttribute('data-theme'), colorScheme: getComputedStyle(root).colorScheme, bodyBackground: getComputedStyle(document.body).backgroundColor, pressed }
})
const isDark = (s) => s.deskTheme === 'dark' && s.colorScheme === 'dark' && luminance(parseColor(s.bodyBackground)) < 0.06 && s.pressed.dark === 'true' && s.pressed.light === 'false'
const isLight = (s) => s.deskTheme === 'light' && s.colorScheme === 'light' && luminance(parseColor(s.bodyBackground)) > 0.6 && s.pressed.light === 'true' && s.pressed.dark === 'false'
const describe = (s) => `data-desk-theme=${s.deskTheme} color-scheme=${s.colorScheme} body=${hex(parseColor(s.bodyBackground))} (L=${luminance(parseColor(s.bodyBackground)).toFixed(3)}) pressed dark=${s.pressed.dark} light=${s.pressed.light}` + (s.hostTheme === null ? '' : ` host data-theme=${s.hostTheme}`)
const storedTheme = (page) => page.evaluate((key) => { try { return localStorage.getItem(key) } catch (e) { return 'throws ' + e.name } }, THEME_KEY)

/** Wait out the colour transitions a click starts, so nothing is measured halfway between two states. */
const settle = (frame) => frame.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => true))
const stage = async (frame, name) => { await frame.locator(`nav.rail button[data-stage="${name}"]`).click(); await frame.locator(`#stage-${name}`).waitFor({ state: 'visible' }); await settle(frame) }
const pickTheme = async (frame, theme) => { await frame.locator(`[data-desk-theme-choice="${theme}"]`).click(); await settle(frame) }
const fontsReady = (frame) => frame.evaluate(() => document.fonts.ready.then(() => true))

/** A person saves an idea in the bank; returns its row. */
async function saveIdea(frame, idea) {
  await stage(frame, 'ideas')
  await frame.locator('#idea-text').fill(idea)
  await frame.locator('#idea-save').click()
  const row = frame.locator('#ideas-table tbody tr', { hasText: idea })
  await row.waitFor()
  // The "Saved." toast leaves on a timer: wait it out so no screenshot or measurement catches it over the page.
  await frame.locator('.toast').waitFor({ state: 'detached' })
  return row
}

/** The gate dialog as a person meets it. */
const gateState = (frame) => frame.evaluate(() => {
  const g = document.getElementById('gate')
  return { open: g.open, modal: g.matches(':modal'), title: document.getElementById('gate-title').textContent, action: document.getElementById('gate-ok').textContent, focus: document.activeElement?.id ?? null, actionBackground: getComputedStyle(document.getElementById('gate-ok')).backgroundColor }
})

// ---------- (a)-(c): desktop, the theme control, the artifact frame ----------
async function desktopJourney(browser, deskUrl, deskHtml, tmp) {
  // The OS reports light: the Desk must open dark anyway.
  const { ctx, seen } = await context(browser, { viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
  await ctx.tracing.start({ screenshots: true, snapshots: true, title: 'Desk runtime journey (a)-(c)' })
  const page = await ctx.newPage()
  try {
    // (a) desktop from file://, nothing chosen yet
    await step('a1', 'opens dark by default with the OS set to light', async () => {
      await page.goto(deskUrl)
      await fontsReady(page)
      const s = await themeState(page)
      check('a1', 'opens dark by default with the OS set to light', isDark(s), s, describe(s))
    })
    await step('a2', 'the inlined fonts load (Syne, IBM Plex Sans, IBM Plex Mono)', async () => {
      const fonts = await page.evaluate(() => [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))])
      check('a2', 'the inlined fonts load (Syne, IBM Plex Sans, IBM Plex Mono)', ['Syne', 'IBM Plex Sans', 'IBM Plex Mono'].every((f) => fonts.includes(f)), { loaded: fonts }, fonts.join(', '))
      await saveIdea(page, IDEA)
      await page.screenshot({ path: path.join(EVIDENCE, 'desktop-dark.png'), fullPage: true })
    })
    check('a3', 'no console errors on the desktop page', seen.consoleErrors.length === 0, { consoleErrors: [...seen.consoleErrors] }, seen.consoleErrors.join(' | ') || 'none')
    check('a4', 'no request outside file: and data:', seen.offsite.length === 0, { offsite: [...seen.offsite] }, seen.offsite.join(' | ') || 'none')

    // (b) the theme control switches, the pick survives a reload, and it switches back
    await step('b1', 'Light switches the Desk to the light palette and stores the pick', async () => {
      await pickTheme(page, 'light')
      const s = await themeState(page)
      const stored = await storedTheme(page)
      check('b1', 'Light switches the Desk to the light palette and stores the pick', isLight(s) && stored === 'light', { ...s, stored }, `${describe(s)} stored=${stored}`)
      await page.screenshot({ path: path.join(EVIDENCE, 'desktop-light.png'), fullPage: true })
    })
    await step('b2', 'the light pick survives a reload', async () => {
      await page.reload()
      const s = await themeState(page)
      check('b2', 'the light pick survives a reload', isLight(s), s, describe(s))
    })
    await step('b3', 'Dark switches back, and that pick survives a reload too', async () => {
      await pickTheme(page, 'dark')
      const clicked = await themeState(page)
      await page.reload()
      const reloaded = await themeState(page)
      const stored = await storedTheme(page)
      check('b3', 'Dark switches back, and that pick survives a reload too', isDark(clicked) && isDark(reloaded) && stored === 'dark', { afterClick: clicked, afterReload: reloaded, stored }, `${describe(reloaded)} stored=${stored}`)
    })

    // (c) the published artifact: the Desk inside the viewer's skeleton, in a frame allowed scripts but not
    // same-origin (so localStorage throws) nor forms, under a host root that says light, dark, or nothing.
    for (const host of ['light', 'dark', 'none']) {
      let frame
      await step(`c1-${host}`, `artifact frame, host data-theme ${host}: the Desk renders dark`, async () => {
        const frameFile = path.join(tmp, `frame-${host}.html`)
        const parentFile = path.join(tmp, `parent-${host}.html`)
        writeFileSync(frameFile, `<!doctype html><html${host === 'none' ? '' : ` data-theme="${host}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:light} body{margin:0;background:#faf9f5;font:14px system-ui}</style></head><body>${deskHtml}</body></html>`)
        writeFileSync(parentFile, `<!doctype html><html><head><meta charset="utf-8"><title>Artifact frame, host ${host}</title><style>html,body{margin:0;background:#faf9f5;color:#1f1e1d;font:13px system-ui}p{margin:0;padding:12px 16px}iframe{display:block;width:calc(100% - 32px);height:calc(100vh - 58px);margin:0 16px;border:1px solid #d9d6cc;border-radius:12px}</style></head><body><p>Host page · frame root data-theme=${host === 'none' ? '(none)' : `"${host}"`} · iframe sandbox="allow-scripts"</p><iframe sandbox="allow-scripts" src="${path.basename(frameFile)}" title="Channel Booster Desk"></iframe></body></html>`)
        await page.goto(pathToFileURL(parentFile).href)
        frame = await (await page.locator('iframe').elementHandle()).contentFrame()
        await frame.waitForLoadState('load')
        await fontsReady(frame)
        const s = await themeState(frame)
        const storage = await frame.evaluate(() => { try { localStorage.getItem('x'); return 'readable' } catch (e) { return 'throws ' + e.name } })
        check(`c1-${host}`, `artifact frame, host data-theme ${host}: the Desk renders dark`, isDark(s) && s.hostTheme === (host === 'none' ? null : host) && storage.startsWith('throws'), { ...s, storage }, `${describe(s)} localStorage ${storage}`)
        if (host === 'light') await page.screenshot({ path: path.join(EVIDENCE, 'artifact-frame.png') })
      })
      if (!frame) continue
      const idea = `Frame gate (${host}): a $300 solar fridge for 30 days`
      const rows = () => frame.locator('#ideas-table tbody tr', { hasText: idea })
      const gateBox = frame.locator('#gate')

      // A person deletes an idea: the in-page gate opens, Cancel keeps it, the action button deletes it.
      const delName = `artifact frame, host ${host}: delete gate opens in the page, Cancel keeps the idea, Delete idea removes it`
      await step(`c2-${host}`, delName, async () => {
        const row = await saveIdea(frame, idea)
        await row.locator('[data-del]').click()
        await gateBox.waitFor({ state: 'visible' })
        const gate = await gateState(frame)
        if (host === 'light') await page.screenshot({ path: path.join(EVIDENCE, 'gate-dialog.png') })
        await frame.locator('#gate-cancel').click()
        await gateBox.waitFor({ state: 'hidden' })
        const keptAfterCancel = await rows().count()
        await row.locator('[data-del]').click()
        await gateBox.waitFor({ state: 'visible' })
        await frame.locator('#gate-ok').click()
        await gateBox.waitFor({ state: 'hidden' })
        await rows().waitFor({ state: 'detached' })
        const leftAfterDelete = await rows().count()
        const pass = gate.open && gate.modal && gate.title === 'Delete an idea' && gate.action === 'Delete idea' && gate.focus === 'gate-cancel' && keptAfterCancel === 1 && leftAfterDelete === 0
        check(`c2-${host}`, delName, pass, { gate, keptAfterCancel, leftAfterDelete }, `modal=${gate.modal} title="${gate.title}" focus=${gate.focus} action=${hex(parseColor(gate.actionBackground))} kept after Cancel=${keptAfterCancel} left after Delete=${leftAfterDelete}`)
      })

      // A person approves the idea green: Cancel leaves it banked, Approve green marks it.
      const greenName = `artifact frame, host ${host}: approve-green gate, Cancel leaves it banked, Approve green marks it`
      await step(`c3-${host}`, greenName, async () => {
        const status = () => rows().locator('select[data-status]')
        await saveIdea(frame, idea)
        const before = await status().inputValue()
        await status().selectOption('green')
        await gateBox.waitFor({ state: 'visible' })
        const gate = await gateState(frame)
        await frame.locator('#gate-cancel').click()
        await gateBox.waitFor({ state: 'hidden' })
        const afterCancel = await status().inputValue()
        await status().selectOption('green')
        await gateBox.waitFor({ state: 'visible' })
        await frame.locator('#gate-ok').click()
        await gateBox.waitFor({ state: 'hidden' })
        const afterApprove = await status().inputValue()
        const pass = gate.open && gate.modal && gate.title === 'Approve a green idea' && before === 'banked' && afterCancel === 'banked' && afterApprove === 'green'
        check(`c3-${host}`, greenName, pass, { gate, before, afterCancel, afterApprove }, `title="${gate.title}" ${before} -> Cancel -> ${afterCancel} -> Approve green -> ${afterApprove}`)
      })
    }
    check('c4', 'no native dialog opened: every gate stayed in the page', seen.nativeDialogs.length === 0, { nativeDialogs: seen.nativeDialogs }, seen.nativeDialogs.join(' | ') || 'none')
    check('c5', 'no console errors and no request outside file: and data: across journeys a-c', clean(seen), seen, cleanLine(seen))
  } finally {
    await ctx.tracing.stop({ path: path.join(EVIDENCE, 'trace.zip') })
    await ctx.close()
  }
}

// ---------- clipped text: selects and the publish pack's Copy button ----------
/**
 * Every visible select narrower than it needs to be for its widest option: a copy of it at its own width (auto,
 * which fits the widest option beside the arrow Chromium draws) is laid out next to it, under the same rules, and
 * compared. A select that is narrower cuts the end off an option, the way the Format select once read "talking-heac".
 * A select that already spans its whole row cannot be wider, so a free-text option longer than the row (a video
 * title in Review, on a phone) is left to the picker, which shows it whole.
 */
const clippedSelects = (frame) => frame.evaluate(() => [...document.querySelectorAll('select')].filter((s) => s.checkVisibility()).flatMap((s) => {
  const probe = s.cloneNode(true)
  probe.removeAttribute('id')
  probe.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:auto;min-width:0;max-width:none'
  s.parentElement.appendChild(probe)
  const needs = probe.getBoundingClientRect().width
  probe.remove()
  const has = s.getBoundingClientRect().width
  const row = s.closest('.row') ?? s.parentElement
  const cs = getComputedStyle(row)
  const room = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  return needs > has + 0.5 && has < room - 1 ? [{ select: s.id || s.getAttribute('aria-label') || 'select', width: Math.round(has), needs: Math.round(needs), room: Math.round(room), widest: [...s.options].map((o) => o.text).reduce((a, b) => (b.length > a.length ? b : a), '') }] : []
}))

/** Every select on every stage that cuts off an option. */
async function clippedAcrossStages(page) {
  const found = []
  for (const id of STAGES) {
    await stage(page, id)
    found.push(...(await clippedSelects(page)).map((c) => ({ stage: id, ...c })))
  }
  return found
}
const clippedLine = (found) => found.map((c) => `${c.stage} #${c.select} ${c.width}px wide of a ${c.room}px row, "${c.widest}" needs ${c.needs}px`).join(' · ')

/** The publish pack's Copy button against the pack it copies: the button must sit clear of the text box. */
const copyButton = (frame) => frame.evaluate(() => {
  const button = document.getElementById('pb-copy')
  const pre = document.querySelector('#pb-out pre')
  if (!button || !pre) return null
  const b = button.getBoundingClientRect()
  const p = pre.getBoundingClientRect()
  const box = (r) => ({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) })
  return { button: box(b), pack: box(p), overlaps: b.left < p.right && b.right > p.left && b.top < p.bottom && b.bottom > p.top }
})

// ---------- (d): a phone in both themes, no stage scrolls the page sideways ----------
/**
 * How wide the page is against the layout viewport. Under mobile emulation innerWidth grows with the content when
 * the page overflows, so it can never show the overflow; documentElement.clientWidth stays at the device width.
 */
const pageWidth = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth, innerWidth }))
const widest = (w) => Math.max(w.scrollWidth, w.bodyScrollWidth)
const fitsWidth = (w) => widest(w) <= w.clientWidth + 1

async function phoneJourney(browser, deskUrl) {
  const { ctx, seen } = await context(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light' })
  const page = await ctx.newPage()
  try {
    await page.goto(deskUrl)
    await fontsReady(page)
    // Every stage with output in it, so the widths below are those of a Desk in use, not of empty forms.
    await populate(page)

    // The measure has to be able to say no: a 600px element in the page must read as overflow.
    const probeName = 'phone: the sideways measure catches a 600px element, so the checks below can fail'
    await step('d-probe', probeName, async () => {
      await stage(page, 'today')
      const before = await pageWidth(page)
      await page.evaluate(() => { const wide = document.createElement('div'); wide.id = 'desk-runtime-wide'; wide.style.cssText = 'width:600px;height:1px'; document.querySelector('main').appendChild(wide) })
      const injected = await pageWidth(page)
      await page.evaluate(() => document.getElementById('desk-runtime-wide').remove())
      const after = await pageWidth(page)
      check('d-probe', probeName, fitsWidth(before) && !fitsWidth(injected) && fitsWidth(after), { before, injected, after }, `600px element: scrollWidth=${widest(injected)} clientWidth=${injected.clientWidth} innerWidth=${injected.innerWidth} reads as overflow=${!fitsWidth(injected)}; without it scrollWidth=${widest(after)}`)
    })

    for (const theme of ['dark', 'light']) {
      const name = `phone 390x844, ${theme}: no stage scrolls sideways`
      await step(`d-${theme}`, name, async () => {
        await pickTheme(page, theme)
        const s = await themeState(page)
        const widths = []
        for (const id of STAGES) {
          await stage(page, id)
          widths.push({ stage: id, ...(await pageWidth(page)) })
        }
        const worst = widths.reduce((w, x) => (widest(x) > widest(w) ? x : w))
        const fits = widths.every(fitsWidth)
        check(`d-${theme}`, name, fits && (theme === 'dark' ? isDark(s) : isLight(s)), { theme: s, widths }, `widest ${worst.stage} scrollWidth=${widest(worst)} clientWidth=${worst.clientWidth} over ${widths.length} stages; ${describe(s)}`)
        await stage(page, 'today')
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: path.join(EVIDENCE, `phone-${theme}.png`), fullPage: true })
      })
    }

    // A verdict's label can run long (PACKAGING · REPACKAGE): its explanation must not be squeezed into a sliver.
    const verdictName = 'phone: every verdict keeps its explanation at least 200px wide'
    await step('d-verdict', verdictName, async () => {
      await pickTheme(page, 'dark')
      const verdicts = []
      for (const id of ['ideas', 'package', 'thumb', 'story', 'review']) {
        await stage(page, id)
        verdicts.push(...(await page.evaluate(() => [...document.querySelectorAll('.verdict')].filter((v) => v.checkVisibility()).map((v) => {
          const text = v.querySelector(':scope > div').getBoundingClientRect()
          return { in: v.id || v.parentElement.id, label: v.querySelector('.big').textContent, width: Math.round(v.getBoundingClientRect().width), textWidth: Math.round(text.width), textHeight: Math.round(text.height) }
        }))).map((v) => ({ stage: id, ...v })))
      }
      const narrow = verdicts.filter((v) => v.textWidth < 200)
      const review = verdicts.find((v) => v.stage === 'review')
      check('d-verdict', verdictName, narrow.length === 0 && Boolean(review), { verdicts }, (narrow.length ? 'too narrow: ' + narrow.map((v) => `${v.stage} #${v.in} "${v.label}" text ${v.textWidth}x${v.textHeight}`).join(' · ') : `${verdicts.length} verdicts, narrowest text ${Math.min(...verdicts.map((v) => v.textWidth))}px`) + (review ? `; review "${review.label}" text ${review.textWidth}x${review.textHeight}` : '; no review verdict rendered'))
    })

    // (f) on a phone the rail scrolls sideways, and a scrolling box clips whatever it paints, focus rings included.
    const ringName = 'phone: every control reached by Tab shows its whole focus ring, never cut off by a scrolling box'
    await step('f-phone', ringName, async () => {
      const rings = await tabRound(page, ['ideas', 'review'])
      const rail = new Set(rings.filter((r) => r.el.includes('[data-stage=')).map((r) => r.el)).size
      const bad = rings.filter((r) => !ringDrawn(r) || r.cut.length)
      check('f-phone', ringName, rail === STAGES.length && bad.length === 0, { reached: rings.length, railButtons: rail, bad }, bad.length ? bad.slice(0, 10).map((r) => `${r.stage} ${r.el} ${r.cut.join(', ') || `${r.style} ${r.width} offset ${r.offset}`}`).join(' · ') : `${rings.length} tab stops on ideas and review, all ${rail} rail buttons among them, no ring cut off`)
    })
    const selectName = 'phone: every select is wide enough for its longest option, so none reads cut off'
    await step('d-select', selectName, async () => {
      await pickTheme(page, 'dark')
      const found = await clippedAcrossStages(page)
      check('d-select', selectName, found.length === 0, { clipped: found }, found.length ? clippedLine(found) : `no select cut off on ${STAGES.length} stages`)
    })

    const copyName = 'phone: the publish pack\'s Copy button sits clear of the pack, covering none of its text'
    await step('d-copy', copyName, async () => {
      await stage(page, 'publish')
      const copy = await copyButton(page)
      check('d-copy', copyName, copy !== null && !copy.overlaps, { copy }, copy ? `button ${JSON.stringify(copy.button)} pack ${JSON.stringify(copy.pack)} overlaps=${copy.overlaps}` : 'no assembled pack on the publish stage')
    })
    check('d-clean', 'phone: no console errors and no request outside file: and data:', clean(seen), seen, cleanLine(seen))
  } finally {
    await ctx.close()
  }
}

// ---------- (e)-(g): contrast, focus ring, reduced motion ----------
/** Text tokens on the surfaces they are painted on; a soft fill is composited over the panel it sits in. */
const TOKEN_PAIRS = [
  ['ink', 'bg'], ['ink', 'panel'], ['ink', 'panel-2'], ['ink', 'raised'],
  ['muted', 'bg'], ['muted', 'panel'], ['muted', 'panel-2'], ['muted', 'raised'],
  ['primary-ink', 'primary'], ['accent-ink', 'accent'],
  ['good', 'panel', 'good-soft'], ['warn', 'panel', 'warn-soft'], ['bad', 'panel', 'bad-soft'],
  ['ink', 'panel', 'good-soft'], ['ink', 'panel', 'warn-soft'], ['ink', 'panel', 'bad-soft'],
  ['good', 'panel'], ['bad', 'panel'], ['bg', 'ink'],
]

/** Every visible text in the page against the background it is painted on, computed from the DOM. */
function sweepText() {
  const parse = (css) => { const n = String(css).match(/[\d.]+/g)?.map(Number) ?? []; return css === 'transparent' || n.length < 3 ? [0, 0, 0, 0] : [n[0], n[1], n[2], n.length > 3 ? n[3] : 1] }
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1)
  const lum = ([r, g, b]) => { const l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }; return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b) }
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
  const canvas = over(parse(getComputedStyle(document.body).backgroundColor), [255, 255, 255, 1])
  const out = []
  const els = [...document.querySelectorAll('body *')].filter((el) => !['SCRIPT', 'STYLE', 'OPTION', 'TITLE', 'META'].includes(el.tagName))
  for (const el of els) {
    const field = el.matches('input:not([type=range]):not([type=file]):not([type=checkbox]), select, textarea')
    const text = field ? el.value : [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
    if (!text || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest(':disabled, [aria-hidden="true"]')) continue
    const chain = []
    let translucent = false
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) { chain.unshift(parse(getComputedStyle(a).backgroundColor)); if (Number(getComputedStyle(a).opacity) < 1) translucent = true }
    if (translucent) continue
    const bg = chain.reduce((under, top) => over(top, under), canvas)
    const cs = getComputedStyle(el)
    const fg = over(parse(cs.color), bg)
    const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight)
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
    out.push({ text: text.slice(0, 48), tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''), fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, need })
  }
  return out
}

/**
 * The focused control and its ring: the outline as computed, and where a scrolling ancestor cuts the ring off.
 * A side counts only where the control itself is inside that box: a control scrolled out of view is not a cut ring.
 */
function focusedRing() {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const cs = getComputedStyle(el)
  const reach = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset)
  const box = el.getBoundingClientRect()
  const cut = []
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a)
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
    const r = a.getBoundingClientRect()
    const clip = { left: r.left + a.clientLeft, top: r.top + a.clientTop, right: r.left + a.clientLeft + a.clientWidth, bottom: r.top + a.clientTop + a.clientHeight }
    const sides = {
      left: box.left >= clip.left - 0.5 ? clip.left - (box.left - reach) : 0,
      top: box.top >= clip.top - 0.5 ? clip.top - (box.top - reach) : 0,
      right: box.right <= clip.right + 0.5 ? box.right + reach - clip.right : 0,
      bottom: box.bottom <= clip.bottom + 0.5 ? box.bottom + reach - clip.bottom : 0,
    }
    const name = a.tagName.toLowerCase() + (typeof a.className === 'string' && a.className.trim() ? '.' + a.className.trim().split(/\s+/).join('.') : '')
    for (const [side, px] of Object.entries(sides)) if (px > 0.5) cut.push(`${side} ${Math.round(px * 10) / 10}px by ${name}`)
  }
  return { key: [...document.querySelectorAll('*')].indexOf(el), el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.dataset.stage ? `[data-stage=${el.dataset.stage}]` : ''), style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, color: cs.outlineColor, ink: getComputedStyle(document.body).color, cut }
}
/** A 2px solid ring in the ink colour, set off from the control. */
const ringDrawn = (r) => r.style === 'solid' && r.width === '2px' && parseFloat(r.offset) >= 1 && r.color === r.ink

/** Tab from the top of each stage, every sideways scroller at its start, until the focus comes back round. */
async function tabRound(page, stageIds) {
  const rings = []
  for (const id of stageIds) {
    await stage(page, id)
    await page.evaluate(() => {
      // Blurring leaves Tab starting after the rail button just clicked: focus the body instead, so the round
      // starts at the top of the page.
      document.body.tabIndex = -1
      document.body.focus()
      document.body.removeAttribute('tabindex')
      for (const el of document.querySelectorAll('nav.rail, .tablewrap')) el.scrollLeft = 0
      window.scrollTo(0, 0)
    })
    const visited = new Set()
    for (let i = 0; i < 150; i += 1) {
      await page.keyboard.press('Tab')
      const r = await page.evaluate(focusedRing)
      if (!r || visited.has(r.key)) break
      visited.add(r.key)
      rings.push({ stage: id, ...r })
    }
  }
  return rings
}

/** Put output in the panels a person works through, so the sweep sees pills, verdicts, runbooks and the decision card. */
async function populate(page) {
  const fill = async (values) => { for (const [id, v] of Object.entries(values)) await page.locator('#' + id).fill(v) }
  await saveIdea(page, IDEA)
  await stage(page, 'package')
  await fill({ 'pk-promise': 'A $300 solar generator runs a van fridge for 30 days, with two failures along the way', 'tl-topic': 'living off a $300 solar generator', 'pr-title': 'I Lived Off a $300 Solar Generator for 30 Days', 'pr-thumb': 'Day 30', 'pr-elements': 'face, dead battery, text' })
  await page.locator('#tl-run').click()
  await page.locator('#pr-run').click()
  await stage(page, 'thumb')
  await fill({ 'tq-name': 'stakes', 'tq-subject': 'my face lit by a headlamp', 'tq-emotion': 'worried', 'tq-elements': 'face, dead battery, fridge', 'tq-text': 'Day 30', 'tq-bg': 'dark van interior', 'tq-colors': 'yellow, black', 'tb-subject': 'me', 'tb-stake': 'a dead battery at night', 'tb-result': 'the fridge still running on day 30' })
  await page.locator('#tq-run').click()
  await page.locator('#tb-run').click()
  await stage(page, 'story')
  await fill({ 'st-script': '0:00 The fridge is still running. Thirty days ago I bet it would not.\n0:20 Here is the rule: $300, no shore power, no cheating.\n1:40 Day 12, the battery dies at 3am.\n3:10 Day 30, the fridge light is still on.' })
  await page.locator('#st-run').click()
  await stage(page, 'workflow')
  await fill({ 'wf-idea': IDEA })
  await page.locator('#wf-run').click()
  await stage(page, 'publish')
  await fill({ 'pb-thumb-a': 'stakes', 'pb-thumb-b': 'result', 'pb-related': 'How I Built a Solar Generator for $300', 'pb-sequel': 'Should I try a bigger fridge?', 'pb-levers': 'stakes, first-person test' })
  await page.locator('#pb-run').click()
  await page.locator('#pb-confirm').click()
  await page.locator('#gate-ok').click()
  await page.locator('#stage-today').waitFor({ state: 'visible' })
  await stage(page, 'review')
  await fill({ 'rv-impr': '12000', 'rv-ctr': '2.1', 'rv-views': '900', 'rv-avp': '38' })
  await page.locator('#rv-run').click()
  await page.locator('#rv-approve').waitFor()
  await page.locator('.toast').waitFor({ state: 'detached' })
}

async function contrastJourney(browser, deskUrl) {
  const { ctx, seen } = await context(browser, { viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  try {
    await page.goto(deskUrl)
    await fontsReady(page)
    await populate(page)

    for (const theme of ['dark', 'light']) {
      const tokensName = `${theme}: every text token meets 4.5:1 on its surface`
      await step(`e-tokens-${theme}`, tokensName, async () => {
        await pickTheme(page, theme)
        const probes = await page.evaluate((pairs) => {
          const host = document.createElement('div')
          host.style.cssText = 'position:absolute;left:-9999px;top:0'
          document.body.appendChild(host)
          const root = getComputedStyle(document.documentElement)
          const out = pairs.map(([text, surface, fill]) => {
            const outer = document.createElement('div'); outer.style.background = `var(--${surface})`
            const inner = document.createElement('div'); inner.style.background = fill ? `var(--${fill})` : 'transparent'; inner.style.color = `var(--${text})`; inner.textContent = 'Aa'
            outer.appendChild(inner); host.appendChild(outer)
            return { text, surface, fill, defined: [text, surface, fill].filter(Boolean).every((t) => root.getPropertyValue('--' + t).trim() !== ''), textColor: getComputedStyle(inner).color, surfaceColor: getComputedStyle(outer).backgroundColor, fillColor: getComputedStyle(inner).backgroundColor }
          })
          host.remove()
          return { canvas: getComputedStyle(document.body).backgroundColor, pairs: out }
        }, TOKEN_PAIRS)
        const canvas = over(parseColor(probes.canvas), [255, 255, 255, 1])
        const pairs = probes.pairs.map((p) => {
          const bg = over(parseColor(p.fillColor), over(parseColor(p.surfaceColor), canvas))
          const fg = over(parseColor(p.textColor), bg)
          return { pair: `${p.text} on ${p.fill ? p.fill + ' over ' : ''}${p.surface}`, fg: hex(fg), bg: hex(bg), ratio: Math.round(contrast(fg, bg) * 100) / 100, defined: p.defined }
        })
        const low = pairs.filter((p) => p.ratio < 4.5 || !p.defined)
        console.log(`     ${theme} token pairs: ` + pairs.map((p) => `${p.pair} ${p.ratio}`).join(' · '))
        const lowest = pairs.reduce((m, p) => (p.ratio < m.ratio ? p : m))
        check(`e-tokens-${theme}`, tokensName, low.length === 0, { pairs }, low.length ? 'below 4.5:1 or undefined: ' + low.map((p) => `${p.pair} ${p.fg}/${p.bg} ${p.ratio}`).join(' · ') : `min ${lowest.ratio} (${lowest.pair}) over ${pairs.length} pairs`)
      })

      // The rendered page: every visible text on every stage against what it is actually painted on.
      const pageName = `${theme}: every visible text on every stage meets its WCAG AA ratio`
      await step(`e-page-${theme}`, pageName, async () => {
        const texts = []
        for (const id of STAGES) { await stage(page, id); texts.push(...(await page.evaluate(sweepText)).map((t) => ({ stage: id, ...t }))) }
        const failing = texts.filter((t) => t.ratio < t.need)
        const unique = [...new Map(failing.map((t) => [`${t.tag} ${t.fg} ${t.bg}`, t])).values()]
        const min = texts.reduce((m, t) => (t.ratio < m.ratio ? t : m))
        check(`e-page-${theme}`, pageName, failing.length === 0, { checked: texts.length, failing: unique, lowest: min }, failing.length ? unique.slice(0, 12).map((t) => `${t.stage} ${t.tag} "${t.text}" ${t.fg}/${t.bg} ${t.ratio} < ${t.need}`).join(' · ') : `${texts.length} texts, lowest ${min.ratio} (${min.stage} ${min.tag} ${min.fg}/${min.bg})`)
      })
    }

    // (f) every control a keyboard reaches on the two busiest stages shows a 2px ink ring set off from it.
    const ringName = 'every control reached by Tab shows a 2px ink focus ring with an offset, never cut off'
    await step('f', ringName, async () => {
      await pickTheme(page, 'dark')
      const rings = await tabRound(page, ['ideas', 'review'])
      const bad = rings.filter((r) => !ringDrawn(r) || r.cut.length)
      check('f', ringName, rings.length > 20 && bad.length === 0, { reached: rings.length, bad }, bad.length ? bad.slice(0, 10).map((r) => `${r.el} ${r.cut.join(', ') || `${r.style} ${r.width} offset ${r.offset} ${r.color}`}`).join(' · ') : `${rings.length} tab stops on ideas and review, all ${rings[0]?.style} ${rings[0]?.width} offset ${rings[0]?.offset}, none cut off`)
    })

    // (g) the colour transitions run only for people who have not asked for less motion.
    await step('g', 'reduced motion turns the transitions off', async () => {
      const durations = async (reducedMotion) => {
        await page.emulateMedia({ reducedMotion })
        return page.evaluate(() => Object.fromEntries(['.btn', 'nav.rail button', '.theme button'].map((s) => [s, getComputedStyle(document.querySelector(s)).transitionDuration])))
      }
      const still = await durations('reduce')
      const moving = await durations('no-preference')
      const pass = Object.values(still).every((d) => d.split(',').every((x) => parseFloat(x) === 0)) && Object.values(moving).every((d) => parseFloat(d) > 0)
      check('g', 'reduced motion turns the transitions off', pass, { reduce: still, noPreference: moving }, `reduce: ${JSON.stringify(still)}; no-preference: ${JSON.stringify(moving)}`)
    })
    const selectName = 'desktop: every select is wide enough for its longest option, so none reads cut off'
    await step('e-select', selectName, async () => {
      await pickTheme(page, 'dark')
      const found = await clippedAcrossStages(page)
      check('e-select', selectName, found.length === 0, { clipped: found }, found.length ? clippedLine(found) : `no select cut off on ${STAGES.length} stages`)
    })
    check('e-clean', 'contrast pages: no console errors and no request outside file: and data:', clean(seen), seen, cleanLine(seen))
  } finally {
    await ctx.close()
  }
}

// ---------- run ----------
if (!existsSync(DESK)) {
  console.error(`No Desk at ${path.relative(ROOT, DESK)}: build it with \`node channel-booster/dashboard/build.mjs\`.`)
  process.exit(1)
}
mkdirSync(EVIDENCE, { recursive: true })
const deskHtml = readFileSync(DESK, 'utf8')
const deskUrl = pathToFileURL(DESK).href
const tmp = mkdtempSync(path.join(os.tmpdir(), 'desk-runtime-'))
const browser = await launch()
console.log(`Desk runtime journey: ${path.relative(ROOT, DESK)} in Chromium ${browser.version()}; evidence in ${path.relative(ROOT, EVIDENCE)}/`)
try {
  await step('run-a-c', 'journeys a-c ran to the end', () => desktopJourney(browser, deskUrl, deskHtml, tmp))
  await step('run-d', 'journey d ran to the end', () => phoneJourney(browser, deskUrl))
  await step('run-e-g', 'journeys e-g ran to the end', () => contrastJourney(browser, deskUrl))
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}
const failed = checks.filter((c) => c.result === 'FAIL')
writeFileSync(path.join(EVIDENCE, 'journey.json'), JSON.stringify({
  gate: 'P1-G2',
  script: path.relative(ROOT, fileURLToPath(import.meta.url)),
  desk: path.relative(ROOT, DESK),
  deskSha256: createHash('sha256').update(deskHtml).digest('hex'),
  ranAt: new Date().toISOString(),
  browser: `Chromium ${browser.version()}`,
  result: failed.length ? 'FAIL' : 'PASS',
  evidence: ['desktop-dark.png', 'desktop-light.png', 'phone-dark.png', 'phone-light.png', 'gate-dialog.png', 'artifact-frame.png', 'trace.zip'],
  checks,
}, null, 2) + '\n')
console.log(`${failed.length ? 'FAIL' : 'PASS'} P1-G2: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? '; failed: ' + failed.map((c) => c.id).join(', ') : ''}`)
process.exitCode = failed.length ? 1 : 0
