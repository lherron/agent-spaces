import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { BrokerClient } from '../src/client'
import { InvocationEventHub } from '../src/invocation-event-hub'
import { NotificationTransport } from './helpers'

// Locks the fix: EventIterator.return() (a `for await … of` break / early
// return) must deregister the iterator's stream from the owning
// InvocationEventHub. A stream left registered after the consumer walks away is
// a slow leak across many short-lived attaches.

const eventFor = (invocationId: string, seq: number): InvocationEventEnvelope =>
  ({
    invocationId,
    seq,
    type: 'lifecycle',
    payload: {},
  }) as unknown as InvocationEventEnvelope

describe('EventIterator.return() hub deregistration', () => {
  test('hub no longer holds the iterator stream after return()', async () => {
    const hub = new InvocationEventHub()
    const stream = hub.stream('inv-1')

    // The hub caches the live stream: a second stream() before return() yields
    // the SAME instance (the registration we are about to leak).
    expect(hub.stream('inv-1')).toBe(stream)

    // Consumer abandons the stream (e.g. `for await … of` break).
    await stream.return()

    // After return(), the hub must have forgotten that stream: a fresh stream()
    // produces a NEW iterator instance rather than re-handing the abandoned one.
    const next = hub.stream('inv-1')
    expect(next).not.toBe(stream)
  })

  test('breaking out of a client event stream and re-streaming still drops already-delivered seqs', async () => {
    const transport = new NotificationTransport()
    const client = BrokerClient.fromTransport(transport)
    const invocationId = 'inv-2' as InvocationId
    const first = client.streamInvocationEvents(invocationId)[Symbol.asyncIterator]()
    transport.emit(eventFor(invocationId, 1))

    // Drain the one delivered event, then abandon the stream (for-await break).
    const drained = await first.next()
    expect((drained.value as InvocationEventEnvelope).seq).toBe(1)
    await first.return?.()

    // Re-stream the same invocation. A replayed event at the already-surfaced
    // seq must still be suppressed (return() mirrors drop(), not dispose()).
    const second = client.streamInvocationEvents(invocationId)[Symbol.asyncIterator]()
    expect(second).not.toBe(first)
    transport.emit(eventFor(invocationId, 1)) // duplicate seq -> dropped
    transport.emit(eventFor(invocationId, 2)) // new seq -> surfaced

    const result = await second.next()
    expect(result.done).toBe(false)
    expect((result.value as InvocationEventEnvelope).seq).toBe(2)
    await client.close()
  })
})
