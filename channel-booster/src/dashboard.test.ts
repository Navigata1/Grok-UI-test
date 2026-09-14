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
