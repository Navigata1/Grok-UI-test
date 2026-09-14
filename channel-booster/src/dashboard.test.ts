import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const dashboard = path.resolve(here, '..', 'dashboard')

describe('dashboard build', () => {
  it('index.html is the current template with the current engine bundle inlined', async () => {
    const result = await build({
      entryPoints: [path.join(dashboard, 'engine.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'Booster',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      legalComments: 'none',
    })
    const bundle = result.outputFiles[0].text
    const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
    const expected = template.replace('<!-- @@ENGINE@@ -->', `<script>\n${bundle}\n</script>`)
    const actual = readFileSync(path.join(dashboard, 'index.html'), 'utf8')
    expect(actual === expected, 'dashboard/index.html is stale: run `node channel-booster/dashboard/build.mjs`').toBe(true)
  }, 30_000)

  it('template starts with a title and declares both theme blocks', () => {
    const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')
    expect(template.startsWith('<title>')).toBe(true)
    expect(template).toContain(':root:not([data-theme="light"])')
    expect(template).toContain(':root[data-theme="dark"]')
    expect(template).not.toMatch(/<!doctype|<html|<head>|<body>/i)
  })
})

/**
 * The Desk's behaviour, pinned at the source level: no DOM runtime is installed, so the
 * template is asserted the way the build is. Each case failed against the template that
 * shipped before the walkthrough fixes.
 */
describe('desk template', () => {
  const template = readFileSync(path.join(dashboard, 'template.html'), 'utf8')

  it('grades the publish gate from what the thumbnail panel actually QA-d', () => {
    expect(template).toContain("thumbGrades: [gradeFor($('pb-thumb-a').value), gradeFor($('pb-thumb-b').value)]")
    expect(template).not.toContain("thumbGrades: ['ship', 'ship']")
    expect(template).toContain("function gradeFor(name) { return conceptGrades.get(gradeKey(name)) || 'rethink' }")
  })

  it('does not assert on a person\u2019s behalf that the 48-hour review is scheduled', () => {
    expect(template).not.toMatch(/checkPublish\([^\n]*reviewScheduled: true/)
  })

  it('renders the detail of every failed checklist item', () => {
    expect(template).toContain('${it.detail ? `<br><small class="muted">${esc(it.detail)}</small>` : \'\'}')
  })

  it('keeps the pasted scan across a reload instead of restoring the example', () => {
    expect(template).toMatch(/local\.write\('scanInput'/)
    expect(template).toContain("$('scan-csv').value = scanInput?.csv || EXAMPLE_CSV")
  })

  it('writes the outlier into sources[], never into the document provenance field', () => {
    expect(template).not.toMatch(/source: \$\('idea-source'\)/)
    expect(template).toContain("$('idea-source').value = i.sources?.[0]?.title || ''")
  })

  it('names the real scan order in the card header', () => {
    expect(template).toContain('<h3>Ranked by demand (velocity while a video is fresh, multiplier after)</h3>')
    expect(template).not.toContain('<h3>Ranked by multiplier</h3>')
  })
})
