import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { brokerProcessEnv } from './helpers'

// T-10321: the operator subcommands share one control-socket connect. A socket
// path that is missing or has no listener must exit non-zero with one stderr
// line naming the path, never a raw runtime stack.

const repoRoot = new URL('../../..', import.meta.url).pathname
// macOS caps AF_UNIX paths near 104 bytes, so the socket dir stays short.
const SOCKET_ROOT = '/tmp'

const runOperator = async (args: string[]) => {
  const proc = Bun.spawn({
    cmd: ['bun', 'harness/harness-broker/bin/harness-broker.js', ...args],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: brokerProcessEnv(),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

const commandsFor = (socketPath: string): Array<[string, string[]]> => [
  [
    'capture status',
    ['capture', 'status', '--socket', socketPath, '--invocation', 'inv-x', '--json'],
  ],
  [
    'capture release',
    [
      'capture',
      'release',
      '--socket',
      socketPath,
      '--invocation',
      'inv-x',
      '--raw-record',
      'raw-x',
      '--disposition',
      'ignored-known',
    ],
  ],
  [
    'submission withdraw',
    ['submission', 'withdraw', 'sub-x', '--socket', socketPath, '--reason', 'r'],
  ],
]

const expectCleanConnectFailure = (
  result: { stdout: string; stderr: string; exitCode: number },
  socketPath: string,
  reason: string
) => {
  expect(result.exitCode).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).not.toMatch(/^\s*at /m)
  expect(result.stderr.trim()).toBe(`cannot connect to broker socket ${socketPath}: ${reason}`)
}

describe('operator CLI connect failures (T-10321)', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  test('a nonexistent socket path is a one-line error naming the path', async () => {
    dir = await mkdtemp(join(SOCKET_ROOT, 'hb-op-'))
    const socketPath = join(dir, 'missing.sock')
    for (const [, args] of commandsFor(socketPath)) {
      expectCleanConnectFailure(await runOperator(args), socketPath, 'no socket at that path')
    }
  })

  test('a stale socket file with no listener is a one-line error naming the path', async () => {
    dir = await mkdtemp(join(SOCKET_ROOT, 'hb-op-'))
    const socketPath = join(dir, 'stale.sock')
    // A bound but never-listening socket: the file exists, nobody accepts.
    // (node and Bun servers unlink their socket on close, so python binds it.)
    const py = Bun.spawnSync([
      'python3',
      '-c',
      `import socket;socket.socket(socket.AF_UNIX).bind(${JSON.stringify(socketPath)})`,
    ])
    expect(py.exitCode).toBe(0)
    expect((await stat(socketPath)).isSocket()).toBe(true)

    for (const [, args] of commandsFor(socketPath)) {
      expectCleanConnectFailure(
        await runOperator(args),
        socketPath,
        'connection refused (no broker listening)'
      )
    }
  })
})
