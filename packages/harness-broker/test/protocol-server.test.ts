import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createProtocolServer } from '../src/protocol-server'
import { expectError, expectResult, parseFrames, request } from './helpers'

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

const withProtocolServer = async (
  run: (ctx: {
    input: PassThrough
    output: PassThrough
    stderr: PassThrough
    server: ReturnType<typeof createProtocolServer>
    outputText: () => string
  }) => Promise<void>
) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const stderr = new PassThrough()
  let outputText = ''
  output.on('data', (chunk) => {
    outputText += chunk.toString('utf8')
  })

  const server = createProtocolServer({ stdin: input, stdout: output, stderr })
  try {
    await run({ input, output, stderr, server, outputText: () => outputText })
  } finally {
    await server.close()
  }
}

const response = (id: string | number, result: unknown) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`

const errorResponse = (id: string | number, code: number, message: string) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`

describe('protocol server routing', () => {
  test('routes a registered request handler and responds with the same id', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      server.register('test.echo', async ({ params }) => ({ echoed: params }))
      await server.start()

      input.write(request('req-1', 'test.echo', { value: 42 }))
      await flush()

      const [frame] = parseFrames(outputText())
      expectResult(frame, 'req-1')
      expect(frame).toMatchObject({
        jsonrpc: '2.0',
        id: 'req-1',
        result: { echoed: { value: 42 } },
      })
    })
  })

  test('unknown method returns JSON-RPC -32601', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      await server.start()

      input.write(request('req-2', 'missing.method'))
      await flush()

      const [frame] = parseFrames(outputText())
      expectError(frame, 'req-2', -32601)
    })
  })

  test('malformed JSON frame returns an error and subsequent frames still route', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      server.register('test.ok', async () => ({ ok: true }))
      await server.start()

      input.write('{not json}\n')
      input.write(request('req-3', 'test.ok'))
      await flush()

      const frames = parseFrames(outputText())
      expectError(frames[0], null, -32700)
      expectResult(frames[1], 'req-3')
      expect(frames[1]).toMatchObject({ result: { ok: true } })
    })
  })

  // Refactor A9: a peer streaming non-NDJSON bytes must not amplify into one
  // parse-error frame per malformed line without bound. After a run of malformed
  // lines exceeds the cap, further parse-error replies are dropped; a subsequent
  // well-formed frame both routes normally and resets the run so a fresh garbage
  // burst is answered again.
  test('parse-error replies are bounded for a flood of malformed input', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      server.register('test.ok', async () => ({ ok: true }))
      await server.start()

      const garbageLines = 500
      for (let i = 0; i < garbageLines; i++) {
        input.write('{not json}\n')
      }
      await flush()

      const errorFrames = parseFrames(outputText()).filter(
        (frame) => 'error' in frame && frame.error.code === -32700
      )
      // Bounded well below the number of malformed lines pushed.
      expect(errorFrames.length).toBeGreaterThan(0)
      expect(errorFrames.length).toBeLessThan(garbageLines)

      // A valid frame after the flood still routes and resets the run.
      input.write(request('after-flood', 'test.ok'))
      await flush()
      const frames = parseFrames(outputText())
      const ok = frames.find((frame) => 'id' in frame && frame.id === 'after-flood')
      expect(ok).toMatchObject({ result: { ok: true } })

      // After the reset, a fresh burst of garbage is answered again.
      const errorsBeforeSecondBurst = parseFrames(outputText()).filter(
        (frame) => 'error' in frame && frame.error.code === -32700
      ).length
      input.write('{not json}\n')
      await flush()
      const errorsAfterSecondBurst = parseFrames(outputText()).filter(
        (frame) => 'error' in frame && frame.error.code === -32700
      ).length
      expect(errorsAfterSecondBurst).toBe(errorsBeforeSecondBurst + 1)
    })
  })

  test('stdout contains only JSON-RPC frames', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      server.register('test.noisy', async () => ({ ok: true }))
      await server.start()

      input.write(request('req-4', 'test.noisy'))
      await flush()

      const lines = outputText()
        .split('\n')
        .filter((line) => line.length > 0)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
      }
    })
  })

  test('broker-initiated request resolves from matching inbound response', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      await server.start()

      const pending = server.request<{ allowed: boolean }>('broker.permission.request', {
        command: 'ls',
      })
      await flush()

      const [outbound] = parseFrames(outputText())
      expect(outbound).toMatchObject({
        jsonrpc: '2.0',
        id: 'broker_req_1',
        method: 'broker.permission.request',
        params: { command: 'ls' },
      })

      input.write(response('broker_req_1', { allowed: true }))

      await expect(pending).resolves.toEqual({ allowed: true })
    })
  })

  test('broker-initiated request rejects on timeout', async () => {
    await withProtocolServer(async ({ server }) => {
      await server.start()

      const pending = server.request('broker.permission.request', {}, { timeoutMs: 5 })

      await expect(pending).rejects.toMatchObject({
        code: BrokerErrorCode.Timeout,
      })
    })
  })

  test('broker-initiated request rejects from matching inbound error response', async () => {
    await withProtocolServer(async ({ input, server }) => {
      await server.start()

      const pending = server.request('broker.permission.request', {})

      input.write(errorResponse('broker_req_1', BrokerErrorCode.InputRejected, 'Denied'))

      await expect(pending).rejects.toMatchObject({
        code: BrokerErrorCode.InputRejected,
        message: 'Denied',
      })
    })
  })

  test('close rejects all pending broker-initiated requests', async () => {
    await withProtocolServer(async ({ server }) => {
      await server.start()

      const first = server.request('broker.first', {})
      const second = server.request('broker.second', {})

      await server.close()

      await expect(first).rejects.toMatchObject({
        code: BrokerErrorCode.ShutdownInProgress,
      })
      await expect(second).rejects.toMatchObject({
        code: BrokerErrorCode.ShutdownInProgress,
      })
    })
  })

  test('broker-initiated requests preserve inbound request routing and notifications', async () => {
    await withProtocolServer(async ({ input, outputText, server }) => {
      server.register('test.echo', async ({ params }) => ({ echoed: params }))
      await server.start()

      server.notify({ jsonrpc: '2.0', method: 'test.notice', params: { ok: true } })
      input.write(request('req-regression', 'test.echo', { value: 7 }))
      await flush()

      const frames = parseFrames(outputText())
      expect(frames[0]).toEqual({
        jsonrpc: '2.0',
        method: 'test.notice',
        params: { ok: true },
      })
      expectResult(frames[1], 'req-regression')
      expect(frames[1]).toMatchObject({
        result: { echoed: { value: 7 } },
      })
    })
  })
})
