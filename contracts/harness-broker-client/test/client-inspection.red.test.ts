import { describe, expect, test } from 'bun:test'

import { BrokerClient, type BrokerJsonRpcTransport } from 'spaces-harness-broker-client'
import type {
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
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

  test('captureRelease round-trips through invocation.capture.release', async () => {
    // T-07863: the fenced RPC existed on the broker server and in the protocol,
    // but the CLIENT had no method for it and `#transport` is private — so a
    // fenced BrokerClient (HRC's) could not release a halted capture cursor at
    // all. This pins the passthrough that closes that gap.
    const request: InvocationCaptureReleaseRequest = {
      invocationId: 'inv_client_capture_release',
      rawRecordId: 'raw_000123',
      disposition: 'ignored-known',
      note: 'reviewed: cosmetic',
    }
    const response: InvocationCaptureReleaseResponse = {
      released: true,
      invocationId: 'inv_client_capture_release',
      rawRecordId: 'raw_000123',
      disposition: 'ignored-known',
      releasedSeq: 42,
      resumedRecords: 2,
      capture: { state: 'open', deferredCount: 0 },
    }
    const transport = new RecordingTransport({ 'invocation.capture.release': response })
    const client = BrokerClient.fromTransport(transport)

    await expect(client.captureRelease(request)).resolves.toBe(response)
    // Verbatim: the client is a typed passthrough, and an operator disposition
    // is exactly the payload that must not be reshaped on its way to the ledger.
    expect(transport.calls).toEqual([{ method: 'invocation.capture.release', params: request }])
    expect(transport.calls[0]?.params).toBe(request)
  })

  test('captureRelease forwards an operator-authored normalized-as unchanged', async () => {
    const request: InvocationCaptureReleaseRequest = {
      invocationId: 'inv_client_capture_normalized',
      rawRecordId: 'raw_000124',
      disposition: 'normalized-as',
      normalizedAs: {
        type: 'submission.cancelled',
        payload: { submissionId: 's1', reason: 'recalled' },
      },
    }
    const response: InvocationCaptureReleaseResponse = {
      released: true,
      invocationId: 'inv_client_capture_normalized',
      rawRecordId: 'raw_000124',
      disposition: 'normalized',
      releasedSeq: 43,
      normalizedSeq: 44,
      resumedRecords: 0,
      capture: { state: 'open', deferredCount: 0 },
    }
    const transport = new RecordingTransport({ 'invocation.capture.release': response })
    const client = BrokerClient.fromTransport(transport)

    await expect(client.captureRelease(request)).resolves.toBe(response)
    expect(
      (transport.calls[0]?.params as InvocationCaptureReleaseRequest | undefined)?.normalizedAs
    ).toBe(request.normalizedAs)
  })
})
