import { describe, expect, it } from 'bun:test'
import type {
  InvocationEventEnvelope,
  InvocationId,
  JsonRpcNotification,
} from 'spaces-harness-broker-protocol'
import { BrokerClient } from '../src/client'
import { InvocationEventHub } from '../src/invocation-event-hub'
import type {
  BrokerJsonRpcTransport,
  CloseHandler,
  NotificationHandler,
  RequestHandler,
} from '../src/transport'

const invocationId = 'inv_dropped_event' as InvocationId

function event(seq: number): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: `2026-07-24T00:00:${String(seq).padStart(2, '0')}.000Z`,
    type: 'diagnostic',
    payload: { level: 'info', message: `event ${seq}` },
  }
}

class NotificationTransport implements BrokerJsonRpcTransport {
  #notificationHandler: NotificationHandler | undefined

  async request<T>(_method: string, _params?: unknown): Promise<T> {
    throw new Error('request not expected')
  }

  onNotification(handler: NotificationHandler): void {
    this.#notificationHandler = handler
  }

  onRequest(_handler: RequestHandler): void {}
  onClose(_handler: CloseHandler): void {}
  async close(): Promise<void> {}

  emit(envelope: InvocationEventEnvelope): void {
    this.#notificationHandler?.({
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: envelope,
    } as JsonRpcNotification)
  }
}

describe('InvocationEventHub dropped-event observability', () => {
  it('reports a backward-seq drop while preserving the monotonic stream', async () => {
    const dropped: Array<{ event: InvocationEventEnvelope; lastSeq: number }> = []
    const hub = new InvocationEventHub({
      onDroppedEvent(droppedEvent, lastSeq) {
        dropped.push({ event: droppedEvent, lastSeq })
      },
    })
    const stream = hub.stream(invocationId)[Symbol.asyncIterator]()

    hub.ingest(event(5))
    expect((await stream.next()).value?.seq).toBe(5)

    const backward = event(4)
    hub.ingest(backward)

    expect(dropped).toEqual([{ event: backward, lastSeq: 5 }])
    hub.dispose(invocationId)
    expect((await stream.next()).done).toBe(true)
  })

  it('never lets a dropped-event observer break event ingest', () => {
    const hub = new InvocationEventHub({
      onDroppedEvent() {
        throw new Error('observer failure')
      },
    })

    hub.ingest(event(5))
    expect(() => hub.ingest(event(4))).not.toThrow()
  })

  it('threads onDroppedEvent through BrokerClient options', async () => {
    const transport = new NotificationTransport()
    const dropped: Array<{ seq: number; lastSeq: number }> = []
    const client = BrokerClient.fromTransport(transport, {
      onDroppedEvent(droppedEvent, lastSeq) {
        dropped.push({ seq: droppedEvent.seq, lastSeq })
      },
    })
    const stream = client.streamInvocationEvents(invocationId)[Symbol.asyncIterator]()

    transport.emit(event(5))
    expect((await stream.next()).value?.seq).toBe(5)
    transport.emit(event(4))

    expect(dropped).toEqual([{ seq: 4, lastSeq: 5 }])
    await client.close()
  })
})
