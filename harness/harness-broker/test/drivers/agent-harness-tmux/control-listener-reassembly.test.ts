import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Socket, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentHarnessControlFrame } from 'spaces-harness-broker-protocol'
import { listenForAgentHarnessControl } from '../../../src/drivers/agent-harness-tmux/control-listener'
import type { AgentHarnessControlListenerHandle } from '../../../src/drivers/agent-harness-tmux/control-listener'

/**
 * T-07866. A socket read boundary falls wherever the kernel put it, so a control
 * frame arrives split across `data` events whenever it exceeds one read (8KB on
 * darwin) or the writer outruns the reader. The listener used to split each raw
 * chunk on '\n' and re-terminate every piece before decoding, which turned one
 * straddling frame into two malformed "complete" lines and dropped it silently.
 *
 * The frame that died was the one that matters: `turn.completed` carries the
 * final assistant text, so EVERY turn whose final message exceeded one read lost
 * its terminal and left the seat `turn-active` forever.
 *
 * The fixture is the real wire capture from a wedged
 * `admission-matrix --row agent-harness-tmux` run, replayed in its captured
 * chunk boundaries.
 */

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../testdata/agent-harness-tmux/t07866-wedge-frames.ndjson'
)

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startListener(): Promise<{
  received: AgentHarnessControlFrame[]
  handle: AgentHarnessControlListenerHandle
  socket: Socket
}> {
  const received: AgentHarnessControlFrame[] = []
  const directory = await mkdtemp(join(tmpdir(), 'ah-reassembly-'))
  const handle = await listenForAgentHarnessControl(
    join(directory, 'control.sock'),
    async (frame) => {
      received.push(frame)
    },
    undefined
  )
  const socket = createConnection(handle.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  cleanups.push(async () => {
    socket.destroy()
    await handle.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { received, handle, socket }
}

/** Give the listener's drain chain time to run every queued handler call. */
async function settle(): Promise<void> {
  await Bun.sleep(250)
}

const seqOf = (frame: AgentHarnessControlFrame): number =>
  (frame as { payload: { seq: number } }).payload.seq

const typeOf = (frame: AgentHarnessControlFrame): string =>
  (frame as { payload: { type: string } }).payload.type

describe('agent-harness control listener frame reassembly (T-07866)', () => {
  test('delivers every frame of the captured wedge, terminal included', async () => {
    const wire = readFileSync(fixturePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    const { received, socket } = await startListener()

    // Write the capture as ONE buffer, exactly as the child wrote it. The kernel
    // splits it wherever it likes; that is the condition under test.
    socket.write(wire.map((line) => `${line}\n`).join(''))
    await settle()

    expect(received.map(seqOf)).toEqual(
      wire.map((line) => (JSON.parse(line) as { payload: { seq: number } }).payload.seq)
    )
    // The frame whose loss wedged the seat.
    const terminal = received.find((frame) => typeOf(frame) === 'turn.completed')
    expect(terminal).toBeDefined()
    expect(seqOf(terminal as AgentHarnessControlFrame)).toBe(343)
  })

  test('reassembles a single frame larger than one socket read', async () => {
    const wire = readFileSync(fixturePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    // seq 343 (`turn.completed`, ~11.8KB) on its own: bigger than one 8KB read,
    // so it is guaranteed to straddle.
    const terminalLine = wire.find(
      (line) => (JSON.parse(line) as { payload: { seq: number } }).payload.seq === 343
    )
    expect(terminalLine).toBeDefined()
    expect((terminalLine as string).length).toBeGreaterThan(8192)

    const { received, socket } = await startListener()
    socket.write(`${terminalLine as string}\n`)
    await settle()

    expect(received).toHaveLength(1)
    expect(typeOf(received[0] as AgentHarnessControlFrame)).toBe('turn.completed')
  })

  test('loses no frame in a burst where the writer outruns the reader', async () => {
    const { received, socket } = await startListener()
    const count = 2_000
    let batch = ''
    for (let seq = 1; seq <= count; seq += 1) {
      batch += `${JSON.stringify({
        verb: 'event',
        payload: {
          invocationId: 'inv_t07866_burst',
          seq,
          time: '2026-09-02T01:49:51.299Z',
          type: 'assistant.message.delta',
          payload: { messageId: 'message-burst', text: `chunk-${seq} `.repeat(4) },
        },
      })}\n`
    }
    socket.write(batch)
    await Bun.sleep(1_500)

    expect(received).toHaveLength(count)
    expect(received.map(seqOf)).toEqual(Array.from({ length: count }, (_, index) => index + 1))
  })

  test('still correlates an ack that shares a read with a straddling frame', async () => {
    const wire = readFileSync(fixturePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    const big = wire.find(
      (line) => (JSON.parse(line) as { payload: { seq: number } }).payload.seq === 343
    ) as string

    const { received, handle, socket } = await startListener()
    // Drain the driver's outbound writes so the request can be issued.
    socket.on('data', () => undefined)
    const pending = handle.request({
      verb: 'turn.begin',
      requestId: 'req-t07866',
      payload: { turnId: 'turn-t07866', inputId: 'input-t07866', structured: false },
    })
    await Bun.sleep(30)

    // One write carrying an oversized frame AND the ack behind it.
    socket.write(`${big}\n${JSON.stringify({ ack: true, requestId: 'req-t07866' })}\n`)

    expect(await pending).toEqual({ ack: true })
    await settle()
    expect(received.map(typeOf)).toEqual(['turn.completed'])
  })
})
