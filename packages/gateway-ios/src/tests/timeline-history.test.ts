import { describe, expect, it } from 'bun:test'
import type {
  HrcLifecycleEvent,
  HrcMessageFilter,
  HrcMessageRecord,
  HrcSessionRecord,
} from 'hrc-core'

import type { LocalLiveSource } from '../local-live-source.js'
import { createGatewayIosFetchHandler } from '../routes.js'
import { type TimelineHistoryClient, getTimelineHistoryPage } from '../timeline-history.js'

const SESSION_REF = 'agent:larry:project:agent-spaces:task:T-01332/lane:main'
const OTHER_SESSION_REF = 'agent:clod:project:agent-spaces:task:T-01332/lane:main'
const SCOPE_REF = 'agent:larry:project:agent-spaces:task:T-01332'
const OTHER_SCOPE_REF = 'agent:clod:project:agent-spaces:task:T-01332'

type MockClient = TimelineHistoryClient & {
  messageCalls: HrcMessageFilter[]
}

type MockLocalLiveSource = LocalLiveSource & {
  eventCalls: Array<{
    scopeRef: string
    laneRef: string
    beforeHrcSeq?: number | undefined
    limit?: number | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
  }>
}

function event(hrcSeq: number, sessionRef = SESSION_REF): HrcLifecycleEvent {
  const scopeRef = sessionRef === OTHER_SESSION_REF ? OTHER_SCOPE_REF : SCOPE_REF
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: `2026-04-30T10:00:${String(hrcSeq % 60).padStart(2, '0')}.000Z`,
    hostSessionId: sessionRef === OTHER_SESSION_REF ? 'host-other' : 'host-main',
    scopeRef,
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-main',
    runId: `run-${hrcSeq}`,
    category: 'turn',
    eventKind: 'turn.user_prompt',
    replayed: false,
    payload: {
      type: 'turn.user_prompt',
      messageId: `message-${hrcSeq}`,
      message: { role: 'user', content: `prompt ${hrcSeq}` },
    },
  }
}

function orderedEvent(hrcSeq: number): HrcLifecycleEvent {
  const item = event(hrcSeq)
  item.ts = `2026-04-30T10:${String(Math.floor(hrcSeq / 60)).padStart(2, '0')}:${String(
    hrcSeq % 60
  ).padStart(2, '0')}.000Z`
  return item
}

function message(messageSeq: number, sessionRef = SESSION_REF): HrcMessageRecord {
  return {
    messageSeq,
    messageId: `msg-${messageSeq}`,
    createdAt: `2026-04-30T10:01:${String(messageSeq % 60).padStart(2, '0')}.000Z`,
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef },
    rootMessageId: `msg-${messageSeq}`,
    body: `body ${messageSeq}`,
    bodyFormat: 'text/plain',
    execution: {
      state: 'accepted',
      sessionRef,
      hostSessionId: sessionRef === OTHER_SESSION_REF ? 'host-other' : 'host-main',
      generation: 1,
    },
  }
}

function session(overrides: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  return {
    hostSessionId: 'host-main',
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-04-30T10:00:00.000Z',
    updatedAt: '2026-04-30T10:00:00.000Z',
    ancestorScopeRefs: [],
    ...overrides,
  }
}

function createMockClient(input: {
  messagePages?: HrcMessageRecord[][] | undefined
  sessions?: HrcSessionRecord[] | undefined
}): MockClient {
  const messagePages = [...(input.messagePages ?? [])]
  const messageCalls: MockClient['messageCalls'] = []

  return {
    messageCalls,
    async listMessages(filter) {
      messageCalls.push(filter ?? {})
      return { messages: messagePages.shift() ?? [] }
    },
    async listSessions() {
      return input.sessions ?? [session()]
    },
  }
}

function createMockLocalLiveSource(events: HrcLifecycleEvent[]): MockLocalLiveSource {
  const eventCalls: MockLocalLiveSource['eventCalls'] = []

  return {
    eventCalls,
    async pollEvents() {
      return []
    },
    async pollMessages() {
      return []
    },
    async listEventsBefore(options) {
      eventCalls.push(options)
      return events
        .filter((item) => item.scopeRef === options.scopeRef && item.laneRef === options.laneRef)
        .filter(
          (item) =>
            options.hostSessionId === undefined || item.hostSessionId === options.hostSessionId
        )
        .filter(
          (item) => options.generation === undefined || item.generation === options.generation
        )
        .filter((item) => item.hrcSeq < options.beforeHrcSeq)
        .sort((a, b) => b.hrcSeq - a.hrcSeq)
        .slice(0, options.limit)
    },
  }
}

function historyUrl(query: string): URL {
  return new URL(`http://gateway.test/v1/history?${query}`)
}

describe('timeline history', () => {
  it('reverses descending event pages before reducing to chronological frames', async () => {
    const client = createMockClient({
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([event(103), event(102), event(101)])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=104&limit=3`)
    )

    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual([101, 102, 103])
    expect(page.oldestCursor.hrcSeq).toBe(101)
    expect(page.newestCursor.hrcSeq).toBe(103)
  })

  it('reports hasMoreBefore=true when older session events exist', async () => {
    const client = createMockClient({
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([event(103), event(102), event(101)])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=104&limit=2`)
    )

    expect(page.hasMoreBefore).toBe(true)
    expect(page.oldestCursor.hrcSeq).toBe(102)
    expect(page.newestCursor.hrcSeq).toBe(103)
  })

  it('reports hasMoreBefore=false at the start of history', async () => {
    const client = createMockClient({
      messagePages: [[], []],
    })
    const localLiveSource = createMockLocalLiveSource([event(100)])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=101&limit=1`)
    )

    expect(page.frames).toHaveLength(1)
    expect(page.hasMoreBefore).toBe(false)
  })

  it('does not leak lifecycle events from other sessions', async () => {
    const client = createMockClient({
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([
      event(202, OTHER_SESSION_REF),
      event(201),
      event(200, OTHER_SESSION_REF),
    ])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=203&limit=3`)
    )

    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual([201])
    expect(page.oldestCursor.hrcSeq).toBe(201)
    expect(page.newestCursor.hrcSeq).toBe(201)
  })

  it('honors limit=1', async () => {
    const client = createMockClient({
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([event(302), event(301)])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=303&limit=1`)
    )

    expect(page.frames).toHaveLength(1)
    expect(page.frames[0]!.lastHrcSeq).toBe(302)
  })

  it('returns the latest event window when more events than the limit exist', async () => {
    const client = createMockClient({
      messagePages: [[], []],
    })
    const localLiveSource = createMockLocalLiveSource(
      Array.from({ length: 100 }, (_, index) => orderedEvent(index + 1))
    )

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&limit=50`)
    )

    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 51)
    )
    expect(page.oldestCursor.hrcSeq).toBe(51)
    expect(page.newestCursor.hrcSeq).toBe(100)
    expect(page.hasMoreBefore).toBe(true)
  })

  it('pages to the latest events strictly below beforeHrcSeq', async () => {
    const client = createMockClient({
      messagePages: [[], []],
    })
    const localLiveSource = createMockLocalLiveSource(
      Array.from({ length: 100 }, (_, index) => orderedEvent(index + 1))
    )

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=75&limit=10`)
    )

    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 65)
    )
    expect(page.oldestCursor.hrcSeq).toBe(65)
    expect(page.newestCursor.hrcSeq).toBe(74)
    expect(localLiveSource.eventCalls[0]).toMatchObject({ beforeHrcSeq: 75, limit: 10 })
    expect(page.hasMoreBefore).toBe(true)
  })

  it('returns empty frames and false hasMoreBefore when before the start', async () => {
    const client = createMockClient({
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=1&limit=50`)
    )

    expect(page.frames).toEqual([])
    expect(page.oldestCursor).toEqual({ hrcSeq: 0, messageSeq: 0 })
    expect(page.newestCursor).toEqual({ hrcSeq: 0, messageSeq: 0 })
    expect(page.hasMoreBefore).toBe(false)
  })

  it('queries messages with sessionRef and beforeMessageSeq', async () => {
    const client = createMockClient({
      messagePages: [[message(12), message(11)], [message(10)]],
    })
    const localLiveSource = createMockLocalLiveSource([])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeMessageSeq=13&limit=2`)
    )

    expect(page.oldestCursor.messageSeq).toBe(11)
    expect(page.newestCursor.messageSeq).toBe(12)
    expect(page.hasMoreBefore).toBe(true)
    expect(client.messageCalls[0]).toEqual({
      hostSessionId: 'host-main',
      generation: 1,
      order: 'desc',
    })
  })

  it('filters history by hostSessionId when sibling generations share a sessionRef', async () => {
    const hostA = event(501)
    const hostB = event(502)
    hostB.hostSessionId = 'host-sibling'
    hostB.generation = 2

    const msgA = message(31)
    const msgB = message(32)
    msgB.execution.hostSessionId = 'host-sibling'
    msgB.execution.generation = 2

    const client = createMockClient({
      messagePages: [[msgB, msgA], []],
    })
    const localLiveSource = createMockLocalLiveSource([hostB, hostA])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(
        `sessionRef=${encodeURIComponent(SESSION_REF)}&hostSessionId=host-main&generation=1&limit=10`
      )
    )

    expect(page.frames.some((frame) => frame.lastHrcSeq === 501)).toBe(true)
    expect(page.frames.some((frame) => frame.lastHrcSeq === 502)).toBe(false)
    expect(localLiveSource.eventCalls[0]).toMatchObject({
      hostSessionId: 'host-main',
      generation: 1,
    })
    expect(client.messageCalls[0]).toMatchObject({ hostSessionId: 'host-main', generation: 1 })
  })

  it('resolves absent hostSessionId to active latest generation for that sessionRef', async () => {
    const oldEvent = event(601)
    oldEvent.hostSessionId = 'host-old'
    oldEvent.generation = 1
    const latestEvent = event(602)
    latestEvent.hostSessionId = 'host-latest'
    latestEvent.generation = 3

    const client = createMockClient({
      sessions: [
        session({ hostSessionId: 'host-old', generation: 1, status: 'inactive' }),
        session({ hostSessionId: 'host-latest', generation: 3, status: 'active' }),
      ],
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([latestEvent, oldEvent])

    const page = await getTimelineHistoryPage(
      client,
      localLiveSource,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&limit=10`)
    )

    expect(localLiveSource.eventCalls[0]).toMatchObject({
      hostSessionId: 'host-latest',
      generation: 3,
    })
    expect(client.messageCalls[0]).toMatchObject({ hostSessionId: 'host-latest', generation: 3 })
    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual([602])
  })

  it('registers GET /v1/history in the route table', async () => {
    const client = createMockClient({
      messagePages: [[]],
    })
    const localLiveSource = createMockLocalLiveSource([event(401)])
    const fetch = createGatewayIosFetchHandler({
      hrcClient: client as unknown as Parameters<
        typeof createGatewayIosFetchHandler
      >[0]['hrcClient'],
      localLiveSource,
      gatewayId: 'ios-test',
    })

    const response = await fetch(
      new Request(
        `http://gateway.test/v1/history?sessionRef=${encodeURIComponent(
          SESSION_REF
        )}&beforeHrcSeq=402&limit=1`
      )
    )
    const payload = (await response.json()) as { frames: Array<{ lastHrcSeq: number }> }

    expect(response.status).toBe(200)
    expect(payload.frames.map((frame) => frame.lastHrcSeq)).toEqual([401])
  })
})
