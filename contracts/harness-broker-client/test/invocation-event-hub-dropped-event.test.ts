import { describe, expect, it } from 'bun:test'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { BrokerClient } from '../src/client'
import { NotificationTransport } from './helpers'

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

describe('BrokerClient dropped-event observability', () => {
  it('a backward seq is reported to onDroppedEvent and never reaches the stream', async () => {
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
    transport.emit(event(6))

    expect(dropped).toEqual([{ seq: 4, lastSeq: 5 }])
    // The stream stays monotonic: seq 4 was swallowed, so 6 is the next value.
    expect((await stream.next()).value?.seq).toBe(6)
    await client.close()
  })

  it('a throwing onDroppedEvent observer does not stop later events from being delivered', async () => {
    const transport = new NotificationTransport()
    const client = BrokerClient.fromTransport(transport, {
      onDroppedEvent() {
        throw new Error('observer failure')
      },
    })
    const stream = client.streamInvocationEvents(invocationId)[Symbol.asyncIterator]()

    transport.emit(event(5))
    expect((await stream.next()).value?.seq).toBe(5)
    expect(() => transport.emit(event(4))).not.toThrow()
    transport.emit(event(6))

    expect((await stream.next()).value?.seq).toBe(6)
    await client.close()
  })
})
