/**
 * Where command output goes. Every command writes through writeOut() and
 * writeErr() rather than process.stdout, so the workflow runner can run a
 * booster stage in-process and keep that stage's output as its record, the
 * way it kept a child process's stdout before.
 */

export interface IoSink {
  out(text: string): void
  err(text: string): void
}

const processSink: IoSink = {
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
}

let current: IoSink = processSink

export function writeOut(text: string): void {
  current.out(text)
}

export function writeErr(text: string): void {
  current.err(text)
}

export interface Captured<T> {
  /** fn's value when it resolved. */
  value?: T
  /** What fn threw or rejected with; captureIo never rethrows it. */
  error?: unknown
  threw: boolean
  stdout: string
  stderr: string
}

/**
 * Run fn with its output collected instead of printed. Captures nest: the
 * previous sink comes back when fn settles, whatever it did. One capture runs
 * at a time per process, which is how the runner uses it (stages run in order).
 */
export async function captureIo<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const previous = current
  let stdout = ''
  let stderr = ''
  current = {
    out: (text) => {
      stdout += text
    },
    err: (text) => {
      stderr += text
    },
  }
  try {
    const value = await fn()
    return { value, threw: false, stdout, stderr }
  } catch (error) {
    return { error, threw: true, stdout, stderr }
  } finally {
    current = previous
  }
}
