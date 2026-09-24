import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellQuote } from './shell.js'

/** What a POSIX shell hands a program for the quoted argument. */
function readBack(quoted: string): string {
  const r = spawnSync('sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

describe('shellQuote', () => {
  it('leaves a plain path, flag value or slug as it is', () => {
    for (const arg of ['/tmp/booster-ws/solar-van', 'example:competitors', 'demand=auto,packaging=4', 'packages/i-lived-off/demand.json', 'a@b%c+d']) expect(shellQuote(arg)).toBe(arg)
  })

  it('quotes anything else so the shell reads back the same argument: $, backticks, !, quotes, spaces, and an empty one', () => {
    for (const arg of ['/tmp/esc/chan$one', 'my `whoami` folder', 'wow!', 'it\'s mine', 'say "hi"', 'two words', '$HOME/x', '']) {
      const quoted = shellQuote(arg)
      expect(quoted.startsWith("'"), arg).toBe(true)
      expect(readBack(quoted)).toBe(arg)
    }
  })
})
