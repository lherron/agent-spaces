import { describe, expect, test } from 'bun:test'

import { BrokerClient, type BrokerJsonRpcTransport } from 'spaces-harness-broker-client'
import type {
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  InvocationEventType,
  InvocationEventsSinceResponse,
  JsonRpcNotification,
  JsonRpcRequest,
} from 'spaces-harness-broker-protocol'

class RecordingTransport implements BrokerJsonRpcTransport {
  calls: Array<{ method: string; params?: unknown }> = []

  constructor(private readonly replies: Record<string, unknown>) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (!(method in this.replies)) {
      throw new Error(`unexpected request: ${method}`)
    }
    return this.replies[method] as T
  }

  onNotification(_handler: (notification: JsonRpcNotification) => void): void {}
  onRequest(_handler: (request: JsonRpcRequest) => Promise<unknown>): void {}
  onClose(_handler: () => void): void {}
  async close(): Promise<void> {}
}

describe('BrokerClient inspection passthroughs (T-01852 red)', () => {
  test('listInvocations round-trips through broker.listInvocations', async () => {
    // T-01852: the broker read model landed in P2; the public client must expose
    // the same JSON-RPC method without reshaping the request or response.
    const request: BrokerListInvocationsRequest = { includeDisposed: true, probeLiveness: true }
    const response: BrokerListInvocationsResponse = {
      invocations: [
        {
          invocationId: 'inv_client_inspection',
          state: 'ready',
          driver: 'codex-app-server',
          startedAt: '2026-06-03T21:00:00.000Z',
          lastActivityAt: '2026-06-03T21:00:01.000Z',
          currentSeq: 3,
          liveness: { mode: 'cached', checkedAt: '2026-06-03T21:00:02.000Z' },
        },
      ],
    }
    const transport = new RecordingTransport({ 'broker.listInvocations': response })
    const client = BrokerClient.fromTransport(transport) as BrokerClient & {
      listInvocations(req: BrokerListInvocationsRequest): Promise<BrokerListInvocationsResponse>
    }

    await expect(client.listInvocations(request)).resolves.toBe(response)
    expect(transport.calls).toEqual([{ method: 'broker.listInvocations', params: request }])
  })

  test('eventsSince forwards request.types unchanged', async () => {
    // T-01852: event filtering belongs to the broker. The client is a typed
    // passthrough and must preserve the caller's exact event type array.
    const types: InvocationEventType[] = ['turn.completed', 'permission.resolved']
    const response: InvocationEventsSinceResponse = {
      events: [],
      currentSeq: 9,
      retentionFloorSeq: 2,
    }
    const transport = new RecordingTransport({ 'invocation.eventsSince': response })
    const client = BrokerClient.fromTransport(transport)

    await expect(
      client.eventsSince({ invocationId: 'inv_client_events_filter', afterSeq: 2, types })
    ).resolves.toBe(response)
    expect(transport.calls).toEqual([
      {
        method: 'invocation.eventsSince',
        params: { invocationId: 'inv_client_events_filter', afterSeq: 2, types },
      },
    ])
    expect(
      (transport.calls[0]?.params as { types?: InvocationEventType[] | undefined } | undefined)
        ?.types
    ).toBe(types)
  })
})
