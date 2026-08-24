import { describe, expect, test } from 'bun:test'
import { StdioTransport } from 'spaces-harness-broker-client'
import type { JsonRpcId } from 'spaces-harness-broker-protocol'
import { repoRoot, withTimeout } from './helpers'

// A fake broker that answers `broker.hello` and then, on `ping`, emits TWO
// responses for the same request id. The first matches the pending request; the
// second has no pending entry and must be surfaced through the debug sink
// (backlog harness-broker-client A9 — observability for unmatched responses).
const fakeBrokerScript = String.raw`
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'broker.hello') {
    write({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
    return
  }
  if (message.method === 'ping') {
    // First response resolves the pending request.
    write({ jsonrpc: '2.0', id: message.id, result: { pong: 1 } })
    // Duplicate response for the same id: no pending entry remains.
    write({ jsonrpc: '2.0', id: message.id, result: { pong: 2 } })
    // Response for an id that was never requested.
    write({ jsonrpc: '2.0', id: 'req_never_sent', result: { stray: true } })
    return
  }
})
`

describe('JsonRpcFramedChannel unmatched-response observability', () => {
  test('notifies the debug sink and counts responses with no pending request', async () => {
    const unmatched: JsonRpcId[] = []
    const transport = await StdioTransport.start({
      command: process.execPath,
      args: ['--eval', fakeBrokerScript],
      cwd: repoRoot,
      debug: {
        onUnmatchedResponse: (id) => {
          unmatched.push(id)
        },
      },
    })

    try {
      const result = await transport.request<{ pong: number }>('ping')
      expect(result).toEqual({ pong: 1 })

      // Give the duplicate + stray responses time to be ingested.
      await withTimeout(
        (async () => {
          while (unmatched.length < 2) {
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })(),
        1000,
        'unmatched responses were never surfaced to the debug sink'
      )

      expect(unmatched).toContain('req_never_sent')
      expect(transport.unmatchedResponseCount).toBeGreaterThanOrEqual(2)
    } finally {
      await transport.close()
    }
  })

  test('a healthy request/response exchange leaves the unmatched counter at zero', async () => {
    const transport = await StdioTransport.start({
      command: process.execPath,
      args: ['--eval', fakeBrokerScript],
      cwd: repoRoot,
    })

    try {
      await transport.request('broker.hello')
      expect(transport.unmatchedResponseCount).toBe(0)
    } finally {
      await transport.close()
    }
  })
})
