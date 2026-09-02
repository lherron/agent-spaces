import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import {
  createQueueDrawer,
  shortPrincipal,
  shortSubmissionId,
} from '../../../src/drivers/codex-app-server/queue-drawer'

let seq = 0
function event(
  type: string,
  payload: unknown,
  time = '2026-09-02T18:00:00.000Z'
): InvocationEventEnvelope {
  seq += 1
  return {
    invocationId: 'inv-test',
    seq,
    time,
    type,
    payload,
  } as unknown as InvocationEventEnvelope
}

const requested = (id: string, principalRef: string, cls = 'queue'): InvocationEventEnvelope =>
  event('admission.requested', { submissionId: id, class: cls, origin: { principalRef } })

const enqueued = (id: string, position: number, time?: string): InvocationEventEnvelope =>
  event('queue.enqueued', { submissionId: id, class: 'queue', position, ttlMs: 1_800_000 }, time)

describe('the queue drawer folds the broker queue (T-07906)', () => {
  test('an entry appears on enqueue, labelled by the admission origin', () => {
    const drawer = createQueueDrawer()
    drawer.observe(requested('submission_inv-a_7', 'agent:lance'))
    expect(drawer.observe(enqueued('submission_inv-a_7', 0))).toBe(true)

    expect(drawer.entries()).toEqual([
      {
        submissionId: 'submission_inv-a_7',
        principal: 'lance',
        class: 'queue',
        position: 0,
        enqueuedAtMs: Date.parse('2026-09-02T18:00:00.000Z'),
        ttlMs: 1_800_000,
      },
    ])
  })

  test('every terminal disposition drains the entry', () => {
    for (const type of [
      'submission.executed',
      'submission.absorbed',
      'submission.rejected',
      'submission.expired',
      'submission.withdrawn',
      'submission.cancelled',
      'queue.cancelled',
      'queue.expired',
      'queue.withdrawn',
    ]) {
      const drawer = createQueueDrawer()
      drawer.observe(requested('submission_inv-a_7', 'agent:lance'))
      drawer.observe(enqueued('submission_inv-a_7', 0))
      expect(drawer.observe(event(type, { submissionId: 'submission_inv-a_7' }))).toBe(true)
      expect(drawer.entries()).toEqual([])
    }
  })

  test('entries are ordered by the broker position, and a jump reorders them', () => {
    const drawer = createQueueDrawer()
    for (const [id, principal, position] of [
      ['submission_inv-a_7', 'agent:lance', 0],
      ['submission_inv-a_8', 'agent:cody', 1],
      ['submission_inv-a_9', 'agent:daedalus', 2],
    ] as const) {
      drawer.observe(requested(id, principal))
      drawer.observe(enqueued(id, position))
    }
    expect(drawer.entries().map((entry) => entry.principal)).toEqual(['lance', 'cody', 'daedalus'])

    expect(
      drawer.observe(
        event('queue.jumped', {
          submissionId: 'submission_inv-a_9',
          fromPosition: 2,
          toPosition: -1,
          principalRef: 'agent:lance',
        })
      )
    ).toBe(true)
    expect(drawer.entries().map((entry) => entry.principal)).toEqual(['daedalus', 'lance', 'cody'])
  })

  test('a jump for a submission the drawer never saw changes nothing', () => {
    const drawer = createQueueDrawer()
    expect(
      drawer.observe(
        event('queue.jumped', { submissionId: 'unknown', fromPosition: 3, toPosition: 0 })
      )
    ).toBe(false)
    expect(drawer.entries()).toEqual([])
  })

  test('the invocation ending clears the drawer: nothing waits on a dead harness', () => {
    const drawer = createQueueDrawer()
    drawer.observe(requested('submission_inv-a_7', 'agent:lance'))
    drawer.observe(enqueued('submission_inv-a_7', 0))
    expect(drawer.observe(event('invocation.exited', { exitCode: 0 }))).toBe(true)
    expect(drawer.entries()).toEqual([])
  })

  test('an enqueue with no admission origin still renders, as unknown', () => {
    const drawer = createQueueDrawer()
    drawer.observe(enqueued('submission_inv-a_7', 0))
    expect(drawer.entries()[0]?.principal).toBe('unknown')
  })

  test('a steer or exclusive submission is never remembered: it cannot enqueue', () => {
    const drawer = createQueueDrawer()
    drawer.observe(requested('submission_inv-a_7', 'agent:lance', 'steer'))
    drawer.observe(requested('submission_inv-a_8', 'agent:cody', 'exclusive'))
    // If they had been remembered, this enqueue would inherit the wrong label.
    drawer.observe(enqueued('submission_inv-a_7', 0))
    expect(drawer.entries()[0]?.principal).toBe('unknown')
  })
})

describe('drawer identifiers are the informative half only', () => {
  test('a submission id renders as its counter — the invocation half is constant', () => {
    expect(shortSubmissionId('submission_inv-07f801f8-dd0f-48bb-8765-92b7acbe16e4_6')).toBe('#6')
    expect(shortSubmissionId('input_5a5ba67f0d48fddc6f1d4cced90')).toBe('5a5ba67f…')
  })

  test('a principal ref renders as the actor, not the scope it is sitting in', () => {
    expect(shortPrincipal('agent:cody:project:hrc-runtime')).toBe('cody')
    expect(shortPrincipal('agent:lance')).toBe('lance')
    expect(shortPrincipal('system:hrc')).toBe('system:hrc')
    expect(shortPrincipal('')).toBe('unknown')
  })
})
