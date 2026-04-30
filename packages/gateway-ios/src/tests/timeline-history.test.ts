import { describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent, HrcMessageFilter, HrcMessageRecord } from 'hrc-core'

import { createGatewayIosFetchHandler } from '../routes.js'
import { getTimelineHistoryPage, type TimelineHistoryClient } from '../timeline-history.js'

const SESSION_REF = 'agent:larry:project:agent-spaces:task:T-01332/lane:main'
const OTHER_SESSION_REF = 'agent:clod:project:agent-spaces:task:T-01332/lane:main'
const SCOPE_REF = 'agent:larry:project:agent-spaces:task:T-01332'
const OTHER_SCOPE_REF = 'agent:clod:project:agent-spaces:task:T-01332'

type MockClient = TimelineHistoryClient & {
  watchCalls: Array<{ beforeHrcSeq?: number | undefined; limit?: number | undefined }>
  messageCalls: HrcMessageFilter[]
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
    execution: { state: 'accepted', sessionRef },
  }
}

function asyncEvents(events: HrcLifecycleEvent[]): AsyncIterable<HrcLifecycleEvent> {
  return (async function* () {
    for (const item of events) yield item
  })()
}

function createMockClient(input: {
  eventPages?: HrcLifecycleEvent[][] | undefined
  messagePages?: HrcMessageRecord[][] | undefined
}): MockClient {
  const eventPages = [...(input.eventPages ?? [])]
  const messagePages = [...(input.messagePages ?? [])]
  const watchCalls: MockClient['watchCalls'] = []
  const messageCalls: MockClient['messageCalls'] = []

  return {
    watchCalls,
    messageCalls,
    watch(options) {
      watchCalls.push({
        beforeHrcSeq: options?.beforeHrcSeq,
        limit: options?.limit,
      })
      return asyncEvents(eventPages.shift() ?? [])
    },
    async listMessages(filter) {
      messageCalls.push(filter ?? {})
      return { messages: messagePages.shift() ?? [] }
    },
  }
}

function historyUrl(query: string): URL {
  return new URL(`http://gateway.test/v1/history?${query}`)
}

describe('timeline history', () => {
  it('reverses descending event pages before reducing to chronological frames', async () => {
    const client = createMockClient({
      eventPages: [[event(103), event(102), event(101)], []],
      messagePages: [[]],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=104&limit=3`)
    )

    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual([101, 102, 103])
    expect(page.oldestCursor.hrcSeq).toBe(101)
    expect(page.newestCursor.hrcSeq).toBe(103)
  })

  it('reports hasMoreBefore=true when older session events exist', async () => {
    const client = createMockClient({
      eventPages: [[event(103), event(102)], [event(101)]],
      messagePages: [[]],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=104&limit=2`)
    )

    expect(page.hasMoreBefore).toBe(true)
    expect(page.oldestCursor.hrcSeq).toBe(102)
    expect(page.newestCursor.hrcSeq).toBe(103)
  })

  it('reports hasMoreBefore=false at the start of history', async () => {
    const client = createMockClient({
      eventPages: [[event(100)], []],
      messagePages: [[], []],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=101&limit=1`)
    )

    expect(page.frames).toHaveLength(1)
    expect(page.hasMoreBefore).toBe(false)
  })

  it('does not leak lifecycle events from other sessions', async () => {
    const client = createMockClient({
      eventPages: [[event(202, OTHER_SESSION_REF), event(201), event(200, OTHER_SESSION_REF)], []],
      messagePages: [[]],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=203&limit=3`)
    )

    expect(page.frames.map((frame) => frame.lastHrcSeq)).toEqual([201])
    expect(page.oldestCursor.hrcSeq).toBe(201)
    expect(page.newestCursor.hrcSeq).toBe(201)
  })

  it('honors limit=1', async () => {
    const client = createMockClient({
      eventPages: [[event(302), event(301)], []],
      messagePages: [[]],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=303&limit=1`)
    )

    expect(page.frames).toHaveLength(1)
    expect(page.frames[0]!.lastHrcSeq).toBe(302)
  })

  it('returns empty frames and false hasMoreBefore when before the start', async () => {
    const client = createMockClient({
      eventPages: [[]],
      messagePages: [[]],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(`sessionRef=${encodeURIComponent(SESSION_REF)}&beforeHrcSeq=1&limit=50`)
    )

    expect(page.frames).toEqual([])
    expect(page.oldestCursor).toEqual({ hrcSeq: 0, messageSeq: 0 })
    expect(page.newestCursor).toEqual({ hrcSeq: 0, messageSeq: 0 })
    expect(page.hasMoreBefore).toBe(false)
  })

  it('queries messages with sessionRef and beforeMessageSeq', async () => {
    const client = createMockClient({
      eventPages: [[], []],
      messagePages: [[message(12), message(11)], [message(10)]],
    })

    const page = await getTimelineHistoryPage(
      client,
      historyUrl(
        `sessionRef=${encodeURIComponent(SESSION_REF)}&beforeMessageSeq=13&limit=2`
      )
    )

    expect(page.oldestCursor.messageSeq).toBe(11)
    expect(page.newestCursor.messageSeq).toBe(12)
    expect(page.hasMoreBefore).toBe(true)
    expect(client.messageCalls[0]).toEqual({
      sessionRef: SESSION_REF,
      order: 'desc',
      limit: 2,
      beforeSeq: 13,
    })
  })

  it('registers GET /v1/history in the route table', async () => {
    const client = createMockClient({
      eventPages: [[event(401)], []],
      messagePages: [[]],
    })
    const fetch = createGatewayIosFetchHandler({
      hrcClient: client as unknown as Parameters<typeof createGatewayIosFetchHandler>[0]['hrcClient'],
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
