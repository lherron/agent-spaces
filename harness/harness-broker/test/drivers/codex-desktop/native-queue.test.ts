import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { CodexRpcError } from '../../../src/drivers/codex-app-server/rpc-client'
import type { CodexDesktopDriverOptions } from '../../../src/drivers/codex-desktop/driver'
import type { CodexDesktopQueueHelper } from '../../../src/drivers/codex-desktop/queue-helper'
import {
  type NativeQueueRow,
  noticeData,
  observerBroker,
  queueHarness,
  removeTempDirs,
  spec,
  tempDir,
  waitFor,
  withDriver,
} from './observer-harness'
import { itemRow, ownTurnRows, row, userMessage } from './rollout-rows'

afterEach(removeTempDirs)

/** Start an observer on an empty rollout with the given native queue helper. */
async function startDelivery(name: string, driver: CodexDesktopDriverOptions) {
  const dir = tempDir()
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, '')
  const invocationId = `inv-desktop-${name}` as InvocationId
  const { broker, events } = observerBroker({ captureDir: dir, driver })
  await broker.start({ spec: spec(path, invocationId) })
  return { path, invocationId, broker, events }
}

function hasNotice(events: InvocationEventEnvelope[], code: string): boolean {
  return events.some((event) => event.type === 'driver.notice' && event.payload.code === code)
}

function executed(events: InvocationEventEnvelope[], submissionId: string): boolean {
  return events.some(
    (event) => event.type === 'submission.executed' && event.payload.submissionId === submissionId
  )
}

function expired(events: InvocationEventEnvelope[], submissionId: string): boolean {
  return events.some(
    (event) => event.type === 'submission.expired' && event.payload.submissionId === submissionId
  )
}

describe('codex-desktop native queue delivery', () => {
  test('queues one native write, preserves human interleaving, and executes only on client-id rollout evidence', async () => {
    const native = queueHarness()
    const { path, invocationId, broker, events } = await startDelivery('queue', {
      openQueueHelper: native.openQueueHelper,
    })
    const origin = {
      principalRef: 'agent:sender',
      scopeRef: 'sender@agent-spaces:primary',
      envelopeId: 'EN-desktop-queue',
    }
    const first = await broker.enqueue({ invocationId, origin, body: 'first' })
    await waitFor(() => native.adds.length === 1)
    expect(noticeData(events, 'CODEX_DESKTOP_NATIVE_ATTEMPT_QUEUED')).toMatchObject({
      inputId: first.submissionId,
      clientUserMessageId: first.submissionId,
      nativeThreadId: 'thread-desktop',
      envelopeId: 'EN-desktop-queue',
      queuedSubmissionId: `native-${first.submissionId}`,
      attemptState: 'queued',
    })
    const second = await broker.enqueue({ invocationId, origin, body: 'second' })
    const listed = await broker.queueList({ invocationId })
    expect(listed.entries.map((entry) => entry.submissionId)).toEqual([second.submissionId])

    const humanTurn = [
      row({ type: 'task_started', turn_id: 'turn-human' }, 1),
      itemRow(
        'thread-desktop',
        'turn-human',
        userMessage('user-human', 'human-client', 'human interleaving'),
        2
      ),
      row({ type: 'task_complete', turn_id: 'turn-human' }, 3),
    ].join('')
    appendFileSync(path, humanTurn)
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-human' as never)
      )
    )
    expect(executed(events, first.submissionId)).toBe(false)
    expect(native.adds).toHaveLength(1)

    native.queue.splice(0, 1)
    appendFileSync(path, ownTurnRows('thread-desktop', 'turn-owned', first.submissionId, 10))
    await waitFor(() => executed(events, first.submissionId))
    await waitFor(() => native.adds.length === 2)
    expect(native.adds).toEqual([first.submissionId, second.submissionId])
  })

  test('carries a native fence across fresh invocation and capture identities until matching execution', async () => {
    const dir = tempDir()
    const path = join(dir, 'lost-ack.jsonl')
    const nativeAttemptStorePath = join(dir, 'stable-observer-state', 'native-attempts.db')
    writeFileSync(path, '')
    let queued: NativeQueueRow | undefined
    let adds = 0
    const cursors: Array<string | undefined> = []
    const openQueueHelper = async (): Promise<CodexDesktopQueueHelper> => ({
      async list(_threadId, cursor) {
        cursors.push(cursor)
        if (cursor === undefined) {
          return {
            data: [{ id: 'human-native', clientUserMessageId: 'human-client' }],
            nextCursor: 'page-2',
          }
        }
        return { data: queued === undefined ? [] : [queued], nextCursor: null }
      },
      async add(_threadId, _input, clientUserMessageId) {
        adds += 1
        queued = { id: 'native-lost-ack', clientUserMessageId }
        throw new Error('fault injection: helper died after native insert')
      },
      async delete() {
        return { deleted: false }
      },
      close() {},
    })
    const firstInvocationId = 'inv-desktop-lost-ack-a' as InvocationId
    const first = observerBroker({
      captureDir: join(dir, 'first-capture'),
      driver: { openQueueHelper },
    })
    await first.broker.start({
      spec: withDriver(spec(path, firstInvocationId), { nativeAttemptStorePath }),
    })
    const admitted = await first.broker.enqueue({
      invocationId: firstInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-lost-ack' },
      body: 'lost ack',
    })
    await waitFor(() => hasNotice(first.events, 'CODEX_DESKTOP_NATIVE_ATTEMPT_RECONCILED_QUEUED'))
    expect(adds).toBe(1)
    expect(cursors).toContain('page-2')
    await first.broker.stop({ invocationId: firstInvocationId, reason: 'restart fault injection' })
    await first.broker.dispose({ invocationId: firstInvocationId })

    const secondInvocationId = 'inv-desktop-lost-ack-b' as InvocationId
    const { broker: second, events: secondEvents } = observerBroker({
      captureDir: join(dir, 'replacement-capture'),
      driver: { openQueueHelper },
    })
    await second.start({
      spec: withDriver(spec(path, secondInvocationId), {
        nativeAttemptStorePath,
        recoveryBoundary: { committedProjections: [], appliedThroughSeq: 0, empty: true },
      }),
    })
    const expiring = await second.enqueue({
      invocationId: secondInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-expiring' },
      body: 'expires behind the native fence',
      ttlMs: 5,
    })
    await waitFor(() => expired(secondEvents, expiring.submissionId))
    const withdrawn = await second.enqueue({
      invocationId: secondInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-withdrawn' },
      body: 'withdrawn behind the native fence',
    })
    expect(
      await second.withdraw({ submissionId: withdrawn.submissionId, reason: 'outer terminal' })
    ).toEqual({ outcome: 'withdrawn' })
    const later = await second.enqueue({
      invocationId: secondInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-later' },
      body: 'must remain local',
    })
    await Bun.sleep(30)
    expect(adds).toBe(1)
    expect(
      (await second.queueList({ invocationId: secondInvocationId })).entries.map(
        (entry) => entry.submissionId
      )
    ).toEqual([later.submissionId])
    expect(admitted.submissionId).toBe('submission_inv-desktop-lost-ack-a_1')

    queued = undefined
    appendFileSync(path, ownTurnRows('thread-desktop', 'turn-old-executed', admitted.submissionId))
    await waitFor(() => adds === 2)
    expect(adds).toBe(2)
    expect(
      secondEvents.filter(
        (event) =>
          event.type === 'submission.executed' &&
          event.payload.submissionId === admitted.submissionId
      )
    ).toHaveLength(1)
    expect(executed(secondEvents, later.submissionId)).toBe(false)
    expect(queued?.clientUserMessageId).toBe(later.submissionId)
  })

  test('fences an absent possibly-written attempt and retries only a definitive rejection', async () => {
    const run = async (kind: 'indeterminate' | 'rejected') => {
      let adds = 0
      const openQueueHelper = async (): Promise<CodexDesktopQueueHelper> => ({
        async list() {
          return { data: [], nextCursor: null }
        },
        async add() {
          adds += 1
          if (kind === 'rejected' && adds === 1) {
            throw new CodexRpcError(-32602, 'native queue rejected')
          }
          if (kind === 'indeterminate') {
            throw new Error('fault injection: disconnected after write')
          }
          return { queuedSubmission: { id: 'native-retry' } }
        },
        async delete() {
          return { deleted: false }
        },
        close() {},
      })
      const { invocationId, broker, events } = await startDelivery(kind, { openQueueHelper })
      await broker.enqueue({
        invocationId,
        origin: { principalRef: 'agent:sender' },
        body: kind,
      })
      await waitFor(() => adds === 1)
      const second = await broker.enqueue({
        invocationId,
        origin: { principalRef: 'agent:sender' },
        body: 'second',
      })
      if (kind === 'rejected') await waitFor(() => adds === 2)
      else await Bun.sleep(30)
      return { adds, events, broker, invocationId, second }
    }

    const indeterminate = await run('indeterminate')
    expect(indeterminate.adds).toBe(1)
    expect(
      indeterminate.events.some(
        (event) => event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_INDETERMINATE'
      )
    ).toBe(true)
    expect(
      (await indeterminate.broker.queueList({ invocationId: indeterminate.invocationId })).entries
    ).toHaveLength(1)

    const rejected = await run('rejected')
    expect(rejected.adds).toBe(2)
    expect(
      rejected.events.some(
        (event) => event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_REJECTED'
      )
    ).toBe(true)
  })

  test('withdraw deletes only the owned native id while broker-local TTL expires independently', async () => {
    const native = queueHarness()
    const { path, invocationId, broker, events } = await startDelivery('cancel', {
      openQueueHelper: native.openQueueHelper,
    })
    const first = await broker.enqueue({
      invocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-cancel' },
      body: 'owned',
    })
    await waitFor(() => native.adds.length === 1)
    native.queue.push({ id: 'human-native', clientUserMessageId: 'human-client' })
    const expiring = await broker.enqueue({
      invocationId,
      origin: { principalRef: 'agent:sender' },
      body: 'expires broker-local',
      ttlMs: 5,
    })
    await waitFor(() => expired(events, expiring.submissionId))
    expect(native.adds).toHaveLength(1)
    expect(
      await broker.withdraw({ submissionId: first.submissionId, reason: 'envelope-terminal' })
    ).toEqual({
      outcome: 'withdrawn',
    })
    expect(native.deletes).toEqual([`native-${first.submissionId}`])
    expect(native.queue).toEqual([{ id: 'human-native', clientUserMessageId: 'human-client' }])

    appendFileSync(path, ownTurnRows('thread-desktop', 'turn-delete-race', first.submissionId, 20))
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'turn.attributed' &&
          event.turnId === ('turn-delete-race' as never) &&
          event.payload.ownership === 'own'
      )
    )
    expect(executed(events, first.submissionId)).toBe(false)
    expect(hasNotice(events, 'CODEX_DESKTOP_NATIVE_ATTEMPT_EXECUTED')).toBe(true)
  })

  test('surfaces bundled helper incompatibility and never falls back or writes', async () => {
    let opens = 0
    const { invocationId, broker, events } = await startDelivery('incompatible', {
      // Production poll cadence: incompatibility must surface without fast polling.
      pollIntervalMs: undefined,
      openQueueHelper: async () => {
        opens += 1
        throw new Error('experimental queue methods unavailable in bundled server')
      },
    })
    await broker.enqueue({
      invocationId,
      origin: { principalRef: 'agent:sender' },
      body: 'must not fall back',
    })
    await waitFor(() => hasNotice(events, 'CODEX_DESKTOP_DELIVERY_DEGRADED'))
    await waitFor(() => events.some((event) => event.type === 'submission.rejected'))
    expect(opens).toBe(1)
    expect(
      events.some(
        (event) =>
          event.type === 'submission.rejected' &&
          String(event.payload.reason).includes('bundled server')
      )
    ).toBe(true)
    expect(
      (await broker.status({ invocationId, probeLiveness: true })).liveness?.driver
    ).toMatchObject({ state: 'degraded' })
  })
})
