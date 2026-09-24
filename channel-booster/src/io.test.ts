import { describe, expect, it } from 'vitest'
import { captureIo, writeErr, writeOut } from './io.js'

describe('captureIo', () => {
  it('collects what the function writes and returns its value', async () => {
    const r = await captureIo(async () => {
      writeOut('hello\n')
      writeErr('careful\n')
      return 7
    })
    expect(r).toEqual({ value: 7, threw: false, stdout: 'hello\n', stderr: 'careful\n' })
  })

  it('keeps the output of a function that throws, and never rethrows', async () => {
    const r = await captureIo(async () => {
      writeOut('partial\n')
      throw new Error('boom')
    })
    expect(r.threw).toBe(true)
    expect((r.error as Error).message).toBe('boom')
    expect(r.stdout).toBe('partial\n')
  })

  it('nests, and restores the outer sink afterwards', async () => {
    const outer = await captureIo(async () => {
      writeOut('a')
      const inner = await captureIo(async () => {
        writeOut('b')
      })
      writeOut('c')
      return inner.stdout
    })
    expect(outer.value).toBe('b')
    expect(outer.stdout).toBe('ac')
  })
})
