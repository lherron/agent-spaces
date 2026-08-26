import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Socket, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
} from 'spaces-harness-broker-protocol'
import { listenForAgentHarnessControl } from '../../../src/drivers/agent-harness-tmux/control-listener'
import type { AgentHarnessControlListenerHandle } from '../../../src/drivers/agent-harness-tmux/control-listener'

/**
 * The ack the child writes is NOT one of the five wire verbs, so it can never
 * be correlated by the frame decoder. These pin both shapes the child end is
 * permitted to write: `{ack:true,requestId}` (what harness/agent-harness's
 * BrokerControlConnection#ack writes today) and a bare `{ack:true}`. The bare
 * form is only safe because turn concurrency is 'single'; the echoing form is
 * order-independent, and this file is what keeps BOTH working so a change on
 * either side of the seam cannot silently strand a pending request.
 */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startListener(
  onFrame: (frame: AgentHarnessControlFrame) => Promise<void> = async () => undefined
): Promise<{ handle: AgentHarnessControlListenerHandle; connect: () => Promise<Socket> }> {
  const directory = await mkdtemp(join(tmpdir(), 'ah-control-'))
  const handle = await listenForAgentHarnessControl(join(directory, 'control.sock'), onFrame)
  cleanups.push(async () => {
    await handle.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    handle,
    connect: async () => {
      const socket = createConnection(handle.socketPath)
      socket.setEncoding('utf8')
      cleanups.push(async () => {
        socket.destroy()
      })
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      return socket
    },
  }
}

function turnBegin(turnId: string, requestId: string): AgentHarnessControlRequest {
  return {
    verb: 'turn.begin',
    requestId,
    payload: { turnId, inputId: 'input-listener-1', structured: false },
  }
}

function readLines(socket: Socket, onLine: (line: Record<string, unknown>) => void): void {
  let buffer = ''
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) onLine(JSON.parse(line) as Record<string, unknown>)
      newline = buffer.indexOf('\n')
    }
  })
}

describe('agent-harness control listener ack correlation', () => {
  test('settles the matching request when the child echoes requestId, out of order', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    const seen: string[] = []
    readLines(socket, (line) => {
      const requestId = line['requestId']
      if (typeof requestId === 'string') seen.push(requestId)
    })

    const settled: string[] = []
    const first = handle.request(turnBegin('turn-1', 'req-1')).then(() => settled.push('req-1'))
    const second = handle.request(turnBegin('turn-2', 'req-2')).then(() => settled.push('req-2'))

    await Bun.sleep(50)
    expect(seen).toEqual(['req-1', 'req-2'])

    // Acknowledge the SECOND request first: echoing requestId must correlate by
    // identity, never by arrival order.
    socket.write(`${JSON.stringify({ ack: true, requestId: 'req-2' })}\n`)
    await second
    expect(settled).toEqual(['req-2'])

    socket.write(`${JSON.stringify({ ack: true, requestId: 'req-1' })}\n`)
    await first
    expect(settled).toEqual(['req-2', 'req-1'])
  })

  test('settles FIFO when the child writes a bare ack with no requestId', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    const settled: string[] = []
    const first = handle.request(turnBegin('turn-1', 'req-1')).then(() => settled.push('req-1'))
    await Bun.sleep(20)

    socket.write(`${JSON.stringify({ ack: true })}\n`)
    await first
    expect(settled).toEqual(['req-1'])
  })

  test('an unmatched requestId leaves the request pending rather than settling the wrong one', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    let settled = false
    // Never acknowledged: swallow the close-time rejection this test provokes.
    void handle
      .request(turnBegin('turn-1', 'req-1'))
      .then(() => {
        settled = true
      })
      .catch(() => undefined)
    await Bun.sleep(20)

    socket.write(`${JSON.stringify({ ack: true, requestId: 'req-does-not-exist' })}\n`)
    await Bun.sleep(30)
    expect(settled).toBe(false)
  })

  test('delivers TUI-to-driver frames to the handler and never mistakes an ack for one', async () => {
    const frames: AgentHarnessControlFrame[] = []
    const { handle, connect } = await startListener(async (frame) => {
      frames.push(frame)
    })
    const socket = await connect()
    readLines(socket, () => undefined)

    socket.write(
      `${JSON.stringify({
        verb: 'hello',
        payload: { protocolVersion: 'agent-harness-control/v1' },
      })}\n`
    )
    socket.write(`${JSON.stringify({ ack: true, requestId: 'no-such-request' })}\n`)
    socket.write(
      `${JSON.stringify({ verb: 'ready', payload: { sessionFile: '/tmp/session.jsonl' } })}\n`
    )
    await Bun.sleep(50)

    expect(frames.map((frame) => frame.verb)).toEqual(['hello', 'ready'])
    await handle.close()
  })

  // T-07584: the ack result is now discriminated on `ack`. A refusal is an
  // ANSWER to the request, so it must settle the pending promise with the
  // closed-code payload — not reject it, and not fall through to the frame
  // decoder (where it would be an unsupported verb and a protocol error).
  test('settles the matching request with a negative acknowledgement, by requestId', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    const first = handle.request(turnBegin('turn-1', 'req-1'))
    const second = handle.request(turnBegin('turn-2', 'req-2'))
    await Bun.sleep(20)

    socket.write(
      `${JSON.stringify({
        ack: false,
        requestId: 'req-2',
        code: 'turn_already_active',
        message: 'Cannot begin a pi SDK turn while turn-1 is active',
      })}\n`
    )
    expect(await second).toEqual({
      ack: false,
      code: 'turn_already_active',
      message: 'Cannot begin a pi SDK turn while turn-1 is active',
    })

    socket.write(`${JSON.stringify({ ack: true, requestId: 'req-1' })}\n`)
    expect(await first).toEqual({ ack: true })
  })

  test('settles FIFO on a bare negative acknowledgement with no requestId', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    const pending = handle.request(turnBegin('turn-1', 'req-1'))
    await Bun.sleep(20)

    socket.write(
      `${JSON.stringify({ ack: false, code: 'turn_begin_failed', message: 'no session' })}\n`
    )
    expect(await pending).toEqual({ ack: false, code: 'turn_begin_failed', message: 'no session' })
  })

  test('rejects rather than settles when a negative acknowledgement is malformed', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    const pending = handle.request(turnBegin('turn-1', 'req-1'))
    await Bun.sleep(20)

    // Off the closed code set: the driver cannot act on it, so it must not be
    // mistaken for a legible refusal.
    socket.write(
      `${JSON.stringify({
        ack: false,
        requestId: 'req-1',
        code: 'session_config_failed',
        message: 'not a turn code',
      })}\n`
    )
    await expect(pending).rejects.toThrow()
  })

  test('rejects when a negative acknowledgement omits its message', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    const pending = handle.request(turnBegin('turn-1', 'req-1'))
    await Bun.sleep(20)

    socket.write(
      `${JSON.stringify({ ack: false, requestId: 'req-1', code: 'turn_begin_failed' })}\n`
    )
    await expect(pending).rejects.toThrow()
  })

  test('rejects a pending request when the child disconnects before acknowledging', async () => {
    const { handle, connect } = await startListener()
    const socket = await connect()
    readLines(socket, () => undefined)

    const pending = handle.request(turnBegin('turn-1', 'req-1'))
    await Bun.sleep(20)
    socket.destroy()

    await expect(pending).rejects.toThrow(/closed before acknowledgement/)
  })
})
