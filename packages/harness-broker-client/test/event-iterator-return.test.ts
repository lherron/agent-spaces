import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { EventIterator } from '../src/event-iterator'
import { InvocationEventHub } from '../src/invocation-event-hub'

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

  test('return() preserves de-dupe state so re-streaming still drops old seqs', async () => {
    const hub = new InvocationEventHub()
    const first = hub.stream('inv-2')
    hub.ingest(eventFor('inv-2', 1))

    // Drain the one buffered event, then abandon the stream.
    const drained = await first.next()
    expect(drained.done).toBe(false)
    await first.return()

    // Re-stream the same invocation. A replayed event at the already-surfaced
    // seq must still be suppressed by #lastEventSeq (return() must mirror drop(),
    // not dispose()).
    const second = hub.stream('inv-2')
    expect(second).not.toBe(first)
    hub.ingest(eventFor('inv-2', 1)) // duplicate seq -> dropped
    hub.ingest(eventFor('inv-2', 2)) // new seq -> surfaced

    const result = await second.next()
    expect(result.done).toBe(false)
    expect((result.value as InvocationEventEnvelope).seq).toBe(2)
  })

  test('return() fires the owner hook exactly once', async () => {
    const iterator = new EventIterator<number>()
    let fired = 0
    iterator.setOnReturn(() => {
      fired += 1
    })

    await iterator.return()
    await iterator.return()

    expect(fired).toBe(1)
  })
})
