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
import type { LocalLiveSource } from '../local-live-source.js'

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
  watchCalls?: Array<{
    fromSeq?: number | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
  }>
  watchMessageCalls?: Array<{
    filter?: {
      afterSeq?: number | undefined
      hostSessionId?: string | undefined
      generation?: number | undefined
    }
  }>
}

type FakeLocalLiveSourceOptions = {
  events: HrcLifecycleEvent[]
  messages: HrcMessageRecord[]
  /** If set, delay emitting events until this promise resolves. */
  eventDelay?: Promise<void>
  /** If set, delay emitting messages until this promise resolves. */
  messageDelay?: Promise<void>
  eventPollCalls?: Array<{
    afterSeq: number
    hostSessionId?: string | undefined
    generation?: number | undefined
  }>
  messagePollCalls?: Array<{
    afterSeq: number
    hostSessionId?: string | undefined
    generation?: number | undefined
  }>
}

function createFakeHrcClient(options: FakeHrcClientOptions): EventPumpHrcClient {
  return {
    watch(opts) {
      options.watchCalls?.push({
        ...(opts?.fromSeq !== undefined ? { fromSeq: opts.fromSeq } : {}),
        hostSessionId: opts?.hostSessionId,
        generation: opts?.generation,
      })
      return emptyAsyncIterable<HrcLifecycleEvent>()
    },

    watchMessages(opts) {
      options.watchMessageCalls?.push({ filter: opts?.filter })
      return emptyAsyncIterable<HrcMessageRecord>()
    },
  }
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          return { done: true, value: undefined } as IteratorResult<T>
        },
      }
    },
  }
}

function createFakeLocalLiveSource(options: FakeLocalLiveSourceOptions): LocalLiveSource {
  return {
    async pollEvents(afterSeq, filter) {
      options.eventPollCalls?.push({ afterSeq, ...filter })
      if (options.eventDelay) await options.eventDelay
      return options.events
        .filter((event) => event.hrcSeq > afterSeq)
        .filter(
          (event) =>
            filter.hostSessionId === undefined || event.hostSessionId === filter.hostSessionId
        )
        .filter(
          (event) => filter.generation === undefined || event.generation === filter.generation
        )
    },

    async pollMessages(afterSeq, filter) {
      options.messagePollCalls?.push({ afterSeq, ...filter })
      if (options.messageDelay) await options.messageDelay
      return options.messages
        .filter((message) => message.messageSeq > afterSeq)
        .filter(
          (message) =>
            filter.hostSessionId === undefined ||
            message.execution.hostSessionId === filter.hostSessionId
        )
        .filter(
          (message) =>
            filter.generation === undefined || message.execution.generation === filter.generation
        )
    },
  }
}

const SESSION_REF = 'agent:cody:project:agent-spaces/lane:main'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('event-pump', () => {
  test('fresh HRC cursor starts local live tail at seq 0 without HTTP watch', async () => {
    const watchCalls: FakeHrcClientOptions['watchCalls'] = []
    const eventPollCalls: FakeLocalLiveSourceOptions['eventPollCalls'] = []
    const abortController = new AbortController()
    const client = createFakeHrcClient({ watchCalls })
    const localLiveSource = createFakeLocalLiveSource({
      events: [],
      messages: [],
      eventPollCalls,
    })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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

    await new Promise((r) => setTimeout(r, 50))
    abortController.abort()
    await pumpPromise

    expect(watchCalls).toHaveLength(0)
    expect(eventPollCalls[0]?.afterSeq).toBe(0)
  })

  test('snapshot arrives before any live events', async () => {
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)]
    const messages: HrcMessageRecord[] = []

    const received: Array<{ type: string; hrcSeq?: number }> = []

    const abortController = new AbortController()

    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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
    const events = [liveEvent]
    const messages = [liveMessage]
    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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

    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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

  test('cancel: local polling pump exits on abort', async () => {
    const abortController = new AbortController()

    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({
      events: [makeEvent(1)],
      messages: [makeMessage(1)],
    })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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
  })

  test('session filtering: only events for the requested session are emitted', async () => {
    const events = [
      makeEvent(1, { scopeRef: 'agent:cody:project:agent-spaces', laneRef: 'main' }),
      makeEvent(2, { scopeRef: 'agent:larry:project:wrkq', laneRef: 'main' }), // Different session
      makeEvent(3, { scopeRef: 'agent:cody:project:agent-spaces', laneRef: 'main' }),
    ]

    const received: number[] = []
    const abortController = new AbortController()

    const messages: HrcMessageRecord[] = []
    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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

  test('hostSessionId and generation filter events, messages, and local source options', async () => {
    const watchCalls: FakeHrcClientOptions['watchCalls'] = []
    const watchMessageCalls: FakeHrcClientOptions['watchMessageCalls'] = []
    const eventPollCalls: FakeLocalLiveSourceOptions['eventPollCalls'] = []
    const messagePollCalls: FakeLocalLiveSourceOptions['messagePollCalls'] = []
    const events = [
      makeEvent(1, { hostSessionId: 'host-selected', generation: 2 }),
      makeEvent(2, { hostSessionId: 'host-sibling', generation: 2 }),
      makeEvent(3, { hostSessionId: 'host-selected', generation: 1 }),
    ]
    const messages = [
      makeMessage(1, {
        execution: { state: 'accepted', hostSessionId: 'host-selected', generation: 2 },
      }),
      makeMessage(2, {
        execution: { state: 'accepted', hostSessionId: 'host-sibling', generation: 2 },
      }),
      makeMessage(3, {
        execution: { state: 'accepted', hostSessionId: 'host-selected', generation: 1 },
      }),
    ]

    const receivedEvents: number[] = []
    const receivedMessages: number[] = []
    const abortController = new AbortController()
    const client = createFakeHrcClient({ watchCalls, watchMessageCalls })
    const localLiveSource = createFakeLocalLiveSource({
      events,
      messages,
      eventPollCalls,
      messagePollCalls,
    })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
      sessionRef: SESSION_REF,
      hostSessionId: 'host-selected',
      generation: 2,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,
      async buildSnapshot() {
        return { hrcSeq: 0, messageSeq: 0 }
      },
      onEvent(event) {
        receivedEvents.push(event.hrcSeq)
      },
      onMessage(message) {
        receivedMessages.push(message.messageSeq)
      },
    })

    await new Promise((r) => setTimeout(r, 100))
    abortController.abort()
    await pumpPromise

    expect(receivedEvents).toEqual([1])
    expect(receivedMessages).toEqual([1])
    expect(watchCalls).toHaveLength(0)
    expect(watchMessageCalls).toHaveLength(0)
    expect(eventPollCalls[0]).toMatchObject({
      hostSessionId: 'host-selected',
      generation: 2,
    })
    expect(messagePollCalls[0]).toMatchObject({
      hostSessionId: 'host-selected',
      generation: 2,
    })
  })

  test('eventFilter predicate is applied on top of session filtering', async () => {
    const events = [
      makeEvent(1, { category: 'turn', eventKind: 'turn.started' }),
      makeEvent(2, { category: 'session', eventKind: 'session.created' }),
      makeEvent(3, { category: 'turn', eventKind: 'turn.completed' }),
    ]

    const received: number[] = []
    const abortController = new AbortController()

    const messages: HrcMessageRecord[] = []
    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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

  test('local live tail continues after simulated HTTP follow death window', async () => {
    const lateEvent = makeEvent(25)
    const lateMessage = makeMessage(12)
    let eventPolls = 0
    let messagePolls = 0

    const client = createFakeHrcClient({})
    const localLiveSource: LocalLiveSource = {
      async pollEvents(afterSeq) {
        eventPolls += 1
        return eventPolls >= 8 && lateEvent.hrcSeq > afterSeq ? [lateEvent] : []
      },
      async pollMessages(afterSeq) {
        messagePolls += 1
        return messagePolls >= 10 && lateMessage.messageSeq > afterSeq ? [lateMessage] : []
      },
    }

    const receivedEvents: number[] = []
    const receivedMessages: number[] = []
    const abortController = new AbortController()

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
      sessionRef: SESSION_REF,
      fromHrcSeq: 0,
      fromMessageSeq: 0,
      signal: abortController.signal,
      async buildSnapshot() {
        return { hrcSeq: 0, messageSeq: 0 }
      },
      onEvent(event) {
        receivedEvents.push(event.hrcSeq)
      },
      onMessage(message) {
        receivedMessages.push(message.messageSeq)
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 80))
    abortController.abort()
    await pumpPromise

    expect(eventPolls).toBeGreaterThanOrEqual(8)
    expect(messagePolls).toBeGreaterThanOrEqual(10)
    expect(receivedEvents).toEqual([25])
    expect(receivedMessages).toEqual([12])
  })

  test('high-water is tracked correctly across events and messages', async () => {
    const events = [makeEvent(10), makeEvent(20)]
    const messages = [makeMessage(5), makeMessage(15)]

    const abortController = new AbortController()

    const client = createFakeHrcClient({})
    const localLiveSource = createFakeLocalLiveSource({ events, messages })

    const pumpPromise = runEventPump({
      hrcClient: client,
      localLiveSource,
      livePollIntervalMs: 5,
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
