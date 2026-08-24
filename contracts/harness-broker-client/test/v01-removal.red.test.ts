/**
 * Ph6 RED tests: harness-broker-client v0.1 rejection (T-01867)
 *
 * Asserts the TARGET end state where the client REJECTS a broker that responds
 * with protocolVersion 'harness-broker/0.1'.
 * Tests FAIL today (client passes through v0.1 responses without error) and
 * pass after Ph6 adds response validation to BrokerClient.hello().
 */
import { describe, expect, test } from 'bun:test'
import type {
  BrokerJsonRpcTransport,
  JsonRpcNotification,
  JsonRpcRequest,
} from 'spaces-harness-broker-client'
import { BrokerClient } from 'spaces-harness-broker-client'

/** Minimal mock transport that returns a fixed reply for every request method. */
class FixedReplyTransport implements BrokerJsonRpcTransport {
  constructor(private readonly replies: Record<string, unknown>) {}

  async request<T>(method: string, _params?: unknown): Promise<T> {
    if (!(method in this.replies)) throw new Error(`unexpected request: ${method}`)
    return this.replies[method] as T
  }
  onNotification(_h: (n: JsonRpcNotification) => void): void {}
  onRequest(_h: (r: JsonRpcRequest) => Promise<unknown>): void {}
  onClose(_h: () => void): void {}
  async close(): Promise<void> {}
}

describe('Ph6 red: BrokerClient rejects harness-broker/0.1 hello response (T-01867)', () => {
  test('hello() throws when broker responds with protocolVersion harness-broker/0.1', async () => {
    // RED today: BrokerClient.hello() is a raw passthrough — it returns the broker's
    // response without validating the negotiated protocolVersion.
    const transport = new FixedReplyTransport({
      'broker.hello': {
        brokerInfo: { name: 'harness-broker', version: '0.1.0' },
        protocolVersion: 'harness-broker/0.1',
        capabilities: {
          transports: ['stdio-jsonrpc-ndjson'],
          invocationLifecycle: {
            start: true,
            stop: true,
            status: true,
            attach: false,
            events: false,
          },
        },
        drivers: [],
      },
    })
    const client = BrokerClient.fromTransport(transport)

    await expect(
      client.hello({
        clientInfo: { name: 'harness-broker-client-test', version: '0.1.0' },
        protocolVersions: ['harness-broker/0.2'],
      })
    ).rejects.toThrow()
  })

  test('hello() succeeds when broker responds with protocolVersion harness-broker/0.2', async () => {
    // This is the positive guard — v0.2 response should not throw after the fix
    const transport = new FixedReplyTransport({
      'broker.hello': {
        brokerInfo: { name: 'harness-broker', version: '0.2.0' },
        protocolVersion: 'harness-broker/0.2',
        capabilities: {
          transports: ['unix-jsonrpc-ndjson'],
          invocationLifecycle: {
            start: true,
            stop: true,
            status: true,
            attach: true,
            events: true,
          },
        },
        drivers: [],
      },
    })
    const client = BrokerClient.fromTransport(transport)

    // GREEN today and after fix — valid v0.2 response should resolve
    await expect(
      client.hello({
        clientInfo: { name: 'harness-broker-client-test', version: '0.1.0' },
        protocolVersions: ['harness-broker/0.2'],
      })
    ).resolves.toMatchObject({ protocolVersion: 'harness-broker/0.2' })
  })
})
