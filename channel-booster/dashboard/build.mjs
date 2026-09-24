// Build the single-file dashboard: bundle the engines as an IIFE, inline them
// and the fonts into template.html (render.mjs), and write index.html next to it.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { DASHBOARD_DIR, renderDesk } from './render.mjs'

const { html, bundleBytes, fontBytes } = await renderDesk()
writeFileSync(path.join(DASHBOARD_DIR, 'index.html'), html)
console.log(`dashboard/index.html written (${(html.length / 1024).toFixed(0)} KB, engine ${(bundleBytes / 1024).toFixed(0)} KB, fonts ${(fontBytes / 1024).toFixed(0)} KB)`)
