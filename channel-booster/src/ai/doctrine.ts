/**
 * The doctrine this build ships: docs/02-strategist-playbook.md, the
 * playbook/*.md files, and the package-fix prompt template.
 *
 * From source it is read from the checkout. The packaged bundle carries the
 * same files embedded at build time (scripts/build.ts defines
 * __BOOSTER_DOCTRINE__ from readShippedDoctrine()), so an installed bin never
 * depends on where it sits on disk, and it can never pick up a foreign
 * playbook/ folder that happens to be nearby.
 *
 * The compiled learned rules (playbook/00-learned-rules.md) are never part of
 * the shipped doctrine: they belong to one channel and live with its data.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CODE_ROOT } from '../workspace.js'

/** The doctrine file: the R-table with evidence tags; loaded first, always. */
export const DOCTRINE_FILE = 'docs/02-strategist-playbook.md'

/** The compiled rules file name; it lives in a channel's playbook folder, never in the shipped doctrine. */
export const LEARNED_RULES_NAME = '00-learned-rules.md'

/** The fix-round template `ai package-fix` fills with `{{fixes}}` and `{{previous}}`. */
export const PACKAGE_FIX_TEMPLATE_FILE = 'prompts/package-fix.md'

export interface DoctrineFile {
  /** Path relative to the package root, with forward slashes: docs/02-strategist-playbook.md, playbook/title-formulas.md. */
  name: string
  text: string
}

export interface ShippedDoctrine {
  /** docs/02 first, then playbook/*.md alphabetically, without the learned rules. */
  files: DoctrineFile[]
  /** Short content hash of files (names and text): the doctrine version printed with every AI run. */
  hash: string
  /** prompts/package-fix.md, or '' when absent. */
  packageFixTemplate: string
}

declare const __BOOSTER_DOCTRINE__: ShippedDoctrine | undefined

/** 12 hex characters of sha256 over every file's name and text, in load order. */
export function doctrineHash(files: DoctrineFile[]): string {
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f.name)
    h.update('\0')
    h.update(f.text)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

/** Read the shipped doctrine from a package root on disk (a source checkout, or the build script). */
export function readShippedDoctrine(root: string = CODE_ROOT): ShippedDoctrine {
  const files: DoctrineFile[] = []
  const doctrine = path.join(root, DOCTRINE_FILE)
  if (existsSync(doctrine)) files.push({ name: DOCTRINE_FILE, text: readFileSync(doctrine, 'utf8') })
  const playbookDir = path.join(root, 'playbook')
  if (existsSync(playbookDir)) {
    for (const name of [...readdirSync(playbookDir)].sort()) {
      if (!name.endsWith('.md') || name === LEARNED_RULES_NAME) continue
      files.push({ name: `playbook/${name}`, text: readFileSync(path.join(playbookDir, name), 'utf8') })
    }
  }
  const template = path.join(root, PACKAGE_FIX_TEMPLATE_FILE)
  return { files, hash: doctrineHash(files), packageFixTemplate: existsSync(template) ? readFileSync(template, 'utf8') : '' }
}

/** The doctrine this build ships: embedded in the bundle, read from the checkout from source. */
export function shippedDoctrine(root: string = CODE_ROOT): ShippedDoctrine {
  if (typeof __BOOSTER_DOCTRINE__ !== 'undefined' && __BOOSTER_DOCTRINE__) return __BOOSTER_DOCTRINE__
  return readShippedDoctrine(root)
}
