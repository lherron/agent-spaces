import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { postSyntheticSessionEnd } from '../../src/runtime/tmux-launch-runner'

/**
 * Bind a one-shot unix socket that captures the single JSON envelope a client
 * posts (matching listenForHookEnvelopes' accept-one-envelope-per-connection
 * contract) and resolves with the parsed body.
 */
async function captureOneEnvelope(
  socketPath: string
): Promise<{ received: Promise<Record<string, unknown> | undefined>; close: () => void }> {
  let resolveBody: (v: Record<string, unknown> | undefined) => void = () => {}
  const received = new Promise<Record<string, unknown> | undefined>((resolve) => {
    resolveBody = resolve
  })
  const server = createServer((conn) => {
    const chunks: Buffer[] = []
    conn.on('data', (chunk: Buffer) => chunks.push(chunk))
    conn.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').trim()
      resolveBody(body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : undefined)
      conn.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { received, close: () => server.close() }
}

describe('postSyntheticSessionEnd', () => {
  test('clean exit (code 0) posts a SessionEnd with reason=prompt_input_exit and fence identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-session-end-'))
    const socketPath = join(dir, 's.sock')
    const cap = await captureOneEnvelope(socketPath)
    try {
      await postSyntheticSessionEnd(
        {
          HARNESS_BROKER_CALLBACK_SOCKET: socketPath,
          HARNESS_BROKER_INVOCATION_ID: 'inv_1',
          HARNESS_BROKER_RUNTIME_ID: 'rt_1',
          HARNESS_BROKER_HOOK_GENERATION: '2',
        },
        0,
        null
      )
      const env = await cap.received
      expect(env).toMatchObject({
        invocationId: 'inv_1',
        runtimeId: 'rt_1',
        generation: 2,
        callbackSocket: socketPath,
        hookData: { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
      })
    } finally {
      cap.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('signal exit posts reason=other (preserve continuation/resume durability)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-session-end-'))
    const socketPath = join(dir, 's.sock')
    const cap = await captureOneEnvelope(socketPath)
    try {
      await postSyntheticSessionEnd(
        {
          HARNESS_BROKER_CALLBACK_SOCKET: socketPath,
          HARNESS_BROKER_INVOCATION_ID: 'inv_2',
        },
        null,
        'SIGTERM'
      )
      const env = await cap.received
      expect(env).toMatchObject({
        hookData: { hook_event_name: 'SessionEnd', reason: 'other' },
      })
      // generation/runtimeId omitted when not provided (fence accepts absent fields)
      expect(env && 'generation' in env).toBe(false)
      expect(env && 'runtimeId' in env).toBe(false)
    } finally {
      cap.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('no-op (no throw) when callback socket env is absent', async () => {
    await postSyntheticSessionEnd({ HARNESS_BROKER_INVOCATION_ID: 'inv_3' }, 0, null)
  })

  test('does not hang when the socket is unreachable (bounded best-effort)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-session-end-'))
    const socketPath = join(dir, 'missing.sock')
    try {
      // No listener bound — connect errors immediately; must resolve, not hang.
      await postSyntheticSessionEnd(
        {
          HARNESS_BROKER_CALLBACK_SOCKET: socketPath,
          HARNESS_BROKER_INVOCATION_ID: 'inv_4',
        },
        0,
        null
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
