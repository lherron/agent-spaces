import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
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
})
