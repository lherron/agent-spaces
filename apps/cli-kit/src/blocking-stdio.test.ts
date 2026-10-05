import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GUARD = join(import.meta.dirname, 'blocking-stdio.ts')
const PAYLOAD_BYTES = 200_000

// A child CLI that probes stdout the way chalk does, then writes a large payload
// through the named write path. `guard` decides whether it calls ensureBlockingStdio.
function childScript(guard: boolean, writePath: string): string {
  return `
    import { writeSync } from 'node:fs'
    import { dlopen, FFIType } from 'bun:ffi'
    import { ensureBlockingStdio } from ${JSON.stringify(GUARD)}
    const lib = process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6'
    // F_GETFL ignores its variadic argument, so the plain signature is safe here.
    const { symbols } = dlopen(lib, { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    const before = symbols.fcntl(1, 3, 0)
    void process.stdout.isTTY
    const fds = ${guard} ? ensureBlockingStdio() : []
    console.error(JSON.stringify({ before, after: symbols.fcntl(1, 3, 0), fds }))
    const payload = 'x'.repeat(${PAYLOAD_BYTES})
    switch (${JSON.stringify(writePath)}) {
      case 'console.log': console.log(payload); break
      case 'writeSync': writeSync(1, payload + '\\n'); break
      case 'stream+exit': process.stdout.write(payload + '\\n'); process.exit(0)
    }
  `
}

interface Run {
  bytes: number
  flags: { before: number; after: number; fds: number[] }
}

function runThroughSlowReader(guard: boolean, writePath: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'cli-kit-stdio-'))
  try {
    const stderrFile = join(dir, 'stderr')
    const stdout = execFileSync(
      'sh',
      [
        '-c',
        '"$@" 2>"$STDERR_FILE" | (sleep 1; cat) | wc -c',
        'sh',
        'bun',
        '-e',
        childScript(guard, writePath),
      ],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, STDERR_FILE: stderrFile } }
    )
    const flags = JSON.parse(readFileSync(stderrFile, 'utf8').trim()) as Run['flags']
    return { bytes: Number(stdout.trim()), flags }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('ensureBlockingStdio', () => {
  test.each(['console.log', 'writeSync', 'stream+exit'])(
    'delivers a %s payload intact through a slow pipe reader',
    (writePath) => {
      const run = runThroughSlowReader(true, writePath)
      expect(run.bytes).toBe(PAYLOAD_BYTES + 1)
      expect(run.flags.fds).toEqual([1, 2])
      // Exactly the pre-Bun flags: O_NONBLOCK gone, and no stray bits from a
      // mis-passed variadic argument (e.g. O_ASYNC/O_SYNC on Apple arm64).
      expect(run.flags.after).toBe(run.flags.before)
    },
    30_000
  )

  test('without the guard the same child truncates (control)', () => {
    const run = runThroughSlowReader(false, 'console.log')
    expect(run.flags.after).not.toBe(run.flags.before)
    expect(run.bytes).toBeLessThan(PAYLOAD_BYTES)
  }, 30_000)
})
