// Build the single-file dashboard: bundle the engines as an IIFE and inline
// them into template.html, writing index.html next to it.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [path.join(here, 'engine.ts')],
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
const template = readFileSync(path.join(here, 'template.html'), 'utf8')
const marker = '<!-- @@ENGINE@@ -->'
if (!template.includes(marker)) throw new Error('template.html is missing the engine marker')
const html = template.replace(marker, `<script>\n${bundle}\n</script>`)
writeFileSync(path.join(here, 'index.html'), html)
console.log(`dashboard/index.html written (${(html.length / 1024).toFixed(0)} KB, engine ${(bundle.length / 1024).toFixed(0)} KB)`)
