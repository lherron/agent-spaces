import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { ListMessagesResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-server-backwards-paging-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('GET /v1/events backwards paging', () => {
  it('returns newest events before beforeHrcSeq using the requested limit', async () => {
    const scopeRef = 'agent:test:project:backwards-events'
    fixture.seedSession('hsid-back-events', scopeRef)
    const db = openHrcDatabase(fixture.dbPath)
    const inserted = []
    try {
      for (let i = 0; i < 12; i++) {
        inserted.push(
          db.hrcEvents.append({
            ts: fixture.now(),
            hostSessionId: 'hsid-back-events',
            scopeRef,
            laneRef: 'default',
            generation: 1,
            category: 'turn',
            eventKind: `turn.${i}`,
            payload: {},
          })
        )
      }
    } finally {
      db.close()
    }

    server = await createHrcServer(fixture.serverOpts())
    const beforeHrcSeq = inserted[11]!.hrcSeq
    const res = await fixture.fetchSocket(`/v1/events?beforeHrcSeq=${beforeHrcSeq}&limit=10`)
    expect(res.status).toBe(200)

    const rows = parseNdjson(await res.text())
    expect(rows.map((row) => row['hrcSeq'])).toEqual(
      inserted
        .slice(1, 11)
        .map((event) => event.hrcSeq)
        .reverse()
    )
  })

  it('rejects requests that mix fromSeq and beforeHrcSeq', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const res = await fixture.fetchSocket('/v1/events?fromSeq=1&beforeHrcSeq=10')
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/messages/query backwards paging', () => {
  it('passes beforeSeq and sessionRef through to the message repository', async () => {
    const sessionRef = 'agent:cody:project:agent-spaces/lane:main'
    const otherSessionRef = 'agent:clod:project:agent-spaces/lane:main'
    const db = openHrcDatabase(fixture.dbPath)
    const inserted = []
    try {
      for (let i = 0; i < 5; i++) {
        inserted.push(
          db.messages.insert({
            messageId: `srv-session-a-${i}`,
            kind: 'dm',
            phase: 'oneway',
            from: { kind: 'entity', entity: 'human' },
            to: { kind: 'session', sessionRef },
            body: `session a ${i}`,
            execution: { sessionRef },
          })
        )
      }
      db.messages.insert({
        messageId: 'srv-session-b-0',
        kind: 'dm',
        phase: 'oneway',
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: otherSessionRef },
        body: 'session b 0',
        execution: { sessionRef: otherSessionRef },
      })
    } finally {
      db.close()
    }

    server = await createHrcServer(fixture.serverOpts())
    const res = await fixture.postJson('/v1/messages/query', {
      beforeSeq: inserted[4]!.messageSeq,
      sessionRef,
      order: 'desc',
      limit: 2,
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as ListMessagesResponse
    expect(body.messages.map((message) => message.messageId)).toEqual([
      'srv-session-a-3',
      'srv-session-a-2',
    ])
  })
})
