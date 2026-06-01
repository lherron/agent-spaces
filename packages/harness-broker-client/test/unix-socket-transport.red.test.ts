import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import {
  brokerCommand,
  codexSpec,
  collectUntil,
  helloRequest,
  repoRoot,
  userInput,
} from './helpers'

type UnixCapableBrokerClient = typeof BrokerClient & {
  connectUnix(options: {
    socketPath: string
    timeoutMs?: number | undefined
  }): Promise<BrokerClient>
}

const tmpDirs: string[] = []

const brokerUnixArgs = (socketPath: string): string[] => [
  'packages/harness-broker/bin/harness-broker.js',
  'run',
  '--transport',
  'unix',
  '--socket',
  socketPath,
]

const waitForSocket = async (
  socketPath: string,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 1500
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`broker exited before creating unix socket: ${stderr.trim()}`)
    }
    try {
      const info = await stat(socketPath)
      if (info.isSocket()) {
        return
      }
    } catch {
      // Keep polling until the broker binds the socket or exits.
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for unix socket ${socketPath}`)
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('BrokerClient unix socket transport red tests for T-01792', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('connectUnix drives request/response and event notifications without killing the broker on close', async () => {
    // T-01792 Phase B: UnixSocketTransport.close() must destroy only the client socket.
    // It must not inherit StdioTransport.close() behavior, which terminates its owned child process.
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-client-unix-'))
    tmpDirs.push(dir)
    const socketPath = join(dir, 'broker.sock')
    const broker = Bun.spawn({
      cmd: [brokerCommand, ...brokerUnixArgs(socketPath)],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const brokerPid = broker.pid

    let client: BrokerClient | undefined
    try {
      await waitForSocket(socketPath, broker)
      client = await (BrokerClient as UnixCapableBrokerClient).connectUnix({
        socketPath,
        timeoutMs: 1000,
      })

      const hello: BrokerHelloResponse = await client.hello(helloRequest())
      expect(hello.capabilities.transports).toContain('unix-jsonrpc-ndjson')
      expect(hello.capabilities.transports).toContain('stdio-jsonrpc-ndjson')

      const { invocationId, events } = await client.startInvocation(codexSpec('start-fresh-turn'))
      expect(invocationId).toBe('inv_client_start_fresh_turn')
      expect((await collectUntil(events, 'invocation.ready')).map((event) => event.type)).toContain(
        'invocation.ready'
      )

      await expect(
        client.input({
          invocationId,
          input: userInput('Complete the unix socket client integration turn.'),
        })
      ).resolves.toMatchObject({ accepted: true })
      expect((await collectUntil(events, 'turn.completed')).map((event) => event.type)).toContain(
        'turn.completed'
      )

      await client.close()
      client = undefined
      await Bun.sleep(100)

      expect(isPidAlive(brokerPid)).toBe(true)
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(brokerPid)) {
        broker.kill('SIGTERM')
      }
      await broker.exited.catch(() => {})
    }
  })
})
