/**
 * Tests for the shared event-pump module.
 *
 * Uses a fake HrcClient with controllable timing to verify:
 * 1. Snapshot arrives BEFORE any live event.
 * 2. Race condition: events arriving during snapshot construction are buffered
 *    and delivered after the snapshot exactly once.
 * 3. Cancel test: both async iterators are cancelled on AbortController.abort().
 * 4. Dedup: items at or below the snapshot high-water are NOT re-emitted.
 * 5. Session filtering: only events for the requested session are emitted.
 */

import { describe, expect, test } from 'bun:test'

import type { HrcLifecycleEvent, HrcMessageRecord } from 'hrc-core'
import { type EventPumpHrcClient, runEventPump } from '../event-pump.js'

// ---------------------------------------------------------------------------
// Test helpers: fake HRC client with controllable event/message streams
// ---------------------------------------------------------------------------

function makeEvent(hrcSeq: number, overrides?: Partial<HrcLifecycleEvent>): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date().toISOString(),
    hostSessionId: 'host-1',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.started',
    replayed: false,
    payload: { seq: hrcSeq },
    ...overrides,
  }
}

function makeMessage(messageSeq: number, overrides?: Partial<HrcMessageRecord>): HrcMessageRecord {
  return {
    messageSeq,
    messageId: `msg-${messageSeq}`,
    createdAt: new Date().toISOString(),
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: 'agent:cody:project:agent-spaces/lane:main' },
    rootMessageId: `msg-${messageSeq}`,
    body: `test message ${messageSeq}`,
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
    ...overrides,
  }
}

type FakeHrcClientOptions = {
  events: HrcLifecycleEvent[]
  messages: HrcMessageRecord[]
  /** If set, delay emitting events until this promise resolves. */
  eventDelay?: Promise<void>
  /** If set, delay emitting messages until this promise resolves. */
  messageDelay?: Promise<void>
  /** Tracked: whether the event iterator was properly consumed/cancelled. */
  eventIteratorCancelled?: { value: boolean }
  /** Tracked: whether the message iterator was properly consumed/cancelled. */
  messageIteratorCancelled?: { value: boolean }
}

function createFakeHrcClient(options: FakeHrcClientOptions): EventPumpHrcClient {
  return {
    async *watch(opts) {
      try {
        if (options.eventDelay) await options.eventDelay
        for (const event of options.events) {
          if (opts?.signal?.aborted) return
          yield event
        }
        // Keep alive until signal abort if follow=true
        if (opts?.follow) {
          await new Promise<void>((_resolve, _reject) => {
            const onAbort = () => {
              opts?.signal?.removeEventListener('abort', onAbort)
              _resolve()
            }
            if (opts?.signal?.aborted) {
              _resolve()
              return
            }
            opts?.signal?.addEventListener('abort', onAbort)
          })
        }
      } finally {
        if (options.eventIteratorCancelled) {
          options.eventIteratorCancelled.value = true
        }
      }
    },

    async *watchMessages(opts) {
      try {
        if (options.messageDelay) await options.messageDelay
        for (const message of options.messages) {
          if (opts?.signal?.aborted) return
          yield message
        }
        if (opts?.follow) {
          await new Promise<void>((_resolve) => {
            const onAbort = () => {
              opts?.signal?.removeEventListener('abort', onAbort)
              _resolve()
            }
            if (opts?.signal?.aborted) {
              _resolve()
              return
            }
            opts?.signal?.addEventListener('abort', onAbort)
          })
        }
      } finally {
        if (options.messageIteratorCancelled) {
          options.messageIteratorCancelled.value = true
        }
      }
    },
  }
}

const SESSION_REF = 'agent:cody:project:agent-spaces/lane:main'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('event-pump', () => {
  test('snapshot arrives before any live events', async () => {
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)]
    const messages: HrcMessageRecord[] = []

    const received: Array<{ type: string; hrcSeq?: number }> = []

    const abortController = new AbortController()

    const client = createFakeHrcClient({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,

      async buildSnapshot() {
        received.push({ type: 'snapshot' })
        return { hrcSeq: 0, messageSeq: 0 }
      },

      onEvent(event) {
        received.push({ type: 'event', hrcSeq: event.hrcSeq })
      },

      onMessage() {},
    })

    // Wait a bit for the pump to process, then abort
    await new Promise((r) => setTimeout(r, 100))
    abortController.abort()
    await pumpPromise

    // Snapshot must be first
    expect(received.length).toBeGreaterThan(0)
    expect(received[0]?.type).toBe('snapshot')

    // All events must come after the snapshot
    const eventEntries = received.filter((r) => r.type === 'event')
    const snapshotIndex = received.findIndex((r) => r.type === 'snapshot')
    for (const entry of eventEntries) {
      expect(received.indexOf(entry)).toBeGreaterThan(snapshotIndex)
    }
  })

  test('race: events arriving during snapshot are buffered and delivered after snapshot exactly once', async () => {
    // This event will be buffered because it arrives while the snapshot is building
    const liveEvent = makeEvent(5)
    const liveMessage = makeMessage(3)

    const received: Array<{ type: string; seq?: number }> = []

    const abortController = new AbortController()

    // Events arrive immediately (before snapshot resolves)
    const client = createFakeHrcClient({
      events: [liveEvent],
      messages: [liveMessage],
    })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,

      async buildSnapshot() {
        // Simulate slow snapshot construction
        await new Promise((r) => setTimeout(r, 50))
        received.push({ type: 'snapshot' })
        // Return high-water of 0 so all buffered items pass
        return { hrcSeq: 0, messageSeq: 0 }
      },

      onEvent(event) {
        received.push({ type: 'event', seq: event.hrcSeq })
      },

      onMessage(message) {
        received.push({ type: 'message', seq: message.messageSeq })
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    abortController.abort()
    await pumpPromise

    // Snapshot must be first
    expect(received[0]?.type).toBe('snapshot')

    // Event with seq=5 must appear after snapshot exactly once
    const eventEntries = received.filter((r) => r.type === 'event' && r.seq === 5)
    expect(eventEntries.length).toBe(1)

    // Message with seq=3 must appear after snapshot exactly once
    const messageEntries = received.filter((r) => r.type === 'message' && r.seq === 3)
    expect(messageEntries.length).toBe(1)
  })

  test('dedup: items at or below snapshot high-water are not re-emitted', async () => {
    // Events 1-3 are in the snapshot. Event 3 also arrives via the live pump.
    const events = [makeEvent(2), makeEvent(3)]
    const messages: HrcMessageRecord[] = []

    const received: Array<{ type: string; hrcSeq?: number }> = []

    const abortController = new AbortController()

    const client = createFakeHrcClient({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,

      async buildSnapshot() {
        await new Promise((r) => setTimeout(r, 30))
        received.push({ type: 'snapshot' })
        // Snapshot covers up to hrcSeq 3
        return { hrcSeq: 3, messageSeq: 0 }
      },

      onEvent(event) {
        received.push({ type: 'event', hrcSeq: event.hrcSeq })
      },

      onMessage() {},
    })

    await new Promise((r) => setTimeout(r, 200))
    abortController.abort()
    await pumpPromise

    // Events 2 and 3 should NOT be emitted (they're ≤ snapshot high-water of 3)
    const eventEntries = received.filter((r) => r.type === 'event')
    expect(eventEntries.length).toBe(0)
  })

  test('cancel: both iterators are cancelled on abort', async () => {
    const eventCancelled = { value: false }
    const messageCancelled = { value: false }

    const abortController = new AbortController()

    const client = createFakeHrcClient({
      events: [makeEvent(1)],
      messages: [makeMessage(1)],
      eventIteratorCancelled: eventCancelled,
      messageIteratorCancelled: messageCancelled,
    })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,

      async buildSnapshot() {
        return { hrcSeq: 0, messageSeq: 0 }
      },

      onEvent() {},
      onMessage() {},
    })

    // Wait for pumps to start, then abort
    await new Promise((r) => setTimeout(r, 50))
    abortController.abort()

    const result = await pumpPromise

    expect(result.cancelled).toBe(true)
    expect(eventCancelled.value).toBe(true)
    expect(messageCancelled.value).toBe(true)
  })

  test('session filtering: only events for the requested session are emitted', async () => {
    const events = [
      makeEvent(1, { scopeRef: 'agent:cody:project:agent-spaces', laneRef: 'main' }),
      makeEvent(2, { scopeRef: 'agent:larry:project:wrkq', laneRef: 'main' }), // Different session
      makeEvent(3, { scopeRef: 'agent:cody:project:agent-spaces', laneRef: 'main' }),
    ]

    const received: number[] = []
    const abortController = new AbortController()

    const client = createFakeHrcClient({ events, messages: [] })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,

      async buildSnapshot() {
        return { hrcSeq: 0, messageSeq: 0 }
      },

      onEvent(event) {
        received.push(event.hrcSeq)
      },

      onMessage() {},
    })

    await new Promise((r) => setTimeout(r, 100))
    abortController.abort()
    await pumpPromise

    // Only events for our session should be emitted (seq 1 and 3)
    expect(received).toEqual([1, 3])
  })

  test('eventFilter predicate is applied on top of session filtering', async () => {
    const events = [
      makeEvent(1, { category: 'turn', eventKind: 'turn.started' }),
      makeEvent(2, { category: 'session', eventKind: 'session.created' }),
      makeEvent(3, { category: 'turn', eventKind: 'turn.completed' }),
    ]

    const received: number[] = []
    const abortController = new AbortController()

    const client = createFakeHrcClient({ events, messages: [] })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,
      eventFilter: (event) => event.category === 'turn',

      async buildSnapshot() {
        return { hrcSeq: 0, messageSeq: 0 }
      },

      onEvent(event) {
        received.push(event.hrcSeq)
      },

      onMessage() {},
    })

    await new Promise((r) => setTimeout(r, 100))
    abortController.abort()
    await pumpPromise

    // Only turn events (seq 1 and 3)
    expect(received).toEqual([1, 3])
  })

  test('high-water is tracked correctly across events and messages', async () => {
    const events = [makeEvent(10), makeEvent(20)]
    const messages = [makeMessage(5), makeMessage(15)]

    const abortController = new AbortController()

    const client = createFakeHrcClient({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,

      async buildSnapshot() {
        return { hrcSeq: 0, messageSeq: 0 }
      },

      onEvent() {},
      onMessage() {},
    })

    await new Promise((r) => setTimeout(r, 100))
    abortController.abort()

    const result = await pumpPromise
    expect(result.highWater.hrcSeq).toBe(20)
    expect(result.highWater.messageSeq).toBe(15)
  })
})
