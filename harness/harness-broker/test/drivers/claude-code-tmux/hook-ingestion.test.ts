import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runClaudeHookBridge } from '../../../src/drivers/claude-code-tmux/hook-bridge'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A broker callback socket that counts the connections the bridge opens. */
const countingSocket = async (): Promise<{
  socketPath: string
  connections: () => number
  close: () => Promise<void>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'claude-hook-ingestion-'))
  tempRoots.push(root)
  const socketPath = join(root, 'hook.sock')
  let connections = 0
  const server = createServer((conn) => {
    connections += 1
    conn.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('claude-code-tmux hook ingestion', () => {
  test.each([
    {
      env: 'generation and callback socket missing',
      brokerEnv: { HARNESS_BROKER_INVOCATION_ID: 'inv' },
      error:
        'missing required hook environment: HARNESS_BROKER_HOOK_GENERATION, HARNESS_BROKER_CALLBACK_SOCKET',
    },
    {
      env: 'generation not a number',
      brokerEnv: {
        HARNESS_BROKER_INVOCATION_ID: 'inv_cc_1',
        HARNESS_BROKER_HOOK_GENERATION: 'not-a-number',
        HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/hook.sock',
      },
      error: 'invalid HARNESS_BROKER_HOOK_GENERATION: not-a-number',
    },
  ])(
    'the Claude hook bridge refuses to post when broker hook env is missing or the generation is not a number ($env)',
    async ({ brokerEnv, error }) => {
      const socket = await countingSocket()
      try {
        await expect(
          runClaudeHookBridge({
            socketPath: socket.socketPath,
            stdin: Readable.from([Buffer.from('{"hook_event_name":"Stop"}\n')]),
            env: brokerEnv,
          })
        ).rejects.toThrow(error)
        expect(socket.connections()).toBe(0)
      } finally {
        await socket.close()
      }
    }
  )
})
