import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { SUBMISSION_TERMINAL_TYPES } from '../../../src/invocation-constants'
import { invocationIdFrom, turnIdFrom } from '../../ids'
import {
  FakeCodexRpc,
  emitTurn,
  emitUserMessageItem,
  lease,
  origin,
  setupDriver,
  waitFor,
} from './codex-tui-transport-support'

/**
 * T-13687: codex-tui delivery returns at Codex's queue acknowledgement and
 * never waits on attribution; the broker's observed-mode slot rules and the
 * event path settle every submission exactly once.
 */

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

function terminalsFor(events: InvocationEventEnvelope[], submissionId: string): string[] {
  return events
    .filter(
      (event) =>
        SUBMISSION_TERMINAL_TYPES.has(event.type) &&
        (event.payload as { submissionId?: string }).submissionId === submissionId
    )
    .map((event) => event.type)
}

function terminalOf(events: InvocationEventEnvelope[], submissionId: string, type: string) {
  return events.find(
    (event) =>
      event.type === type &&
      (event.payload as { submissionId?: string }).submissionId === submissionId
  )
}

type Handler = (method: string, params: unknown) => unknown | Promise<unknown>

/** A Codex fake that acknowledges queue/add without starting any turn. */
function queueOnlyCodex(rpc: FakeCodexRpc, extra: Handler = () => undefined) {
  const queued: string[] = []
  rpc.onRequest = async (method, params) => {
    const handled = await extra(method, params)
    if (handled !== undefined) return handled
    if (method === 'initialize') return {}
    if (method === 'hooks/list') return { data: [] }
    if (method === 'thread/start') return { thread: { id: 'thread_test' } }
    if (method === 'thread/queue/list') return { data: [], nextCursor: null }
    if (method === 'thread/queue/add') {
      const id = (params as { clientUserMessageId: string }).clientUserMessageId
      queued.push(id)
      return { queuedSubmission: { id: `queued_${id}` } }
    }
    throw new Error(`unexpected ${method}`)
  }
  return queued
}

function startTurn(rpc: FakeCodexRpc, turnId: string): void {
  rpc.emit('turn/started', {
    threadId: 'thread_test',
    turn: { id: turnId, status: 'inProgress', items: [] },
  })
}

function completeTurn(rpc: FakeCodexRpc, turnId: string): void {
  rpc.emit('turn/completed', {
    threadId: 'thread_test',
    turn: { id: turnId, status: 'completed', items: [] },
  })
}

async function cleanup(run: Awaited<ReturnType<typeof setupDriver>>, invocationId: string) {
  await run.broker.stop({ invocationId: invocationIdFrom(invocationId), reason: 'test cleanup' })
  await run.broker.dispose({ invocationId: invocationIdFrom(invocationId) })
  await rm(run.socketDir, { recursive: true, force: true })
}

describe('T-13687 A: codex-tui delivery returns at the queue acknowledgement', () => {
  test('delivery returns before any turn exists, and the user item later binds it executed', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc)
    const id = 'inv_tui_delivery_returns'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      // The legacy input door awaits the driver call itself: before T-13687
      // this awaited attribution and never returned without a turn.
      const response = await run.broker.input({
        invocationId,
        input: { kind: 'user', content: [{ type: 'text', text: 'deliver me' }] },
      })
      expect(response).toMatchObject({ accepted: true, disposition: 'started' })
      expect(response.turnId).toBeUndefined()
      expect(queued).toEqual([response.inputId])
      expect(run.events.filter((event) => event.type === 'turn.started')).toHaveLength(0)
      expect(terminalsFor(run.events, response.inputId)).toEqual([])
      expect((await run.broker.seatProbe({ invocationId })).seat.state).toBe('starting')

      startTurn(rpc, 'turn_bound')
      emitUserMessageItem(rpc, {
        turnId: 'turn_bound',
        itemId: 'user_bound',
        clientId: response.inputId,
        text: 'deliver me',
      })
      expect(terminalOf(run.events, response.inputId, 'submission.executed')).toMatchObject({
        turnId: 'turn_bound',
        payload: { turnId: 'turn_bound' },
      })
      completeTurn(rpc, 'turn_bound')
      await settle()
      expect(terminalsFor(run.events, response.inputId)).toEqual(['submission.executed'])
    } finally {
      await cleanup(run, id)
    }
  })

  test('the bound turn manifest lists the submission when read through seat.probe', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc)
    const id = 'inv_tui_delivery_manifest'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const submission = await run.broker.enqueue({ invocationId, origin, body: 'manifest' })
      await waitFor(() => queued.length === 1, 'queue/add reaches Codex')
      startTurn(rpc, 'turn_manifest')
      // Before its user item the turn is observed and lists nothing.
      expect((await run.broker.seatProbe({ invocationId })).seat).toMatchObject({
        state: 'turn-observed',
        turnId: 'turn_manifest',
      })
      emitUserMessageItem(rpc, {
        turnId: 'turn_manifest',
        itemId: 'user_manifest',
        clientId: submission.submissionId,
        text: 'manifest',
      })

      // HRC's active_turn_submissions: seat.probe gives the turn, turn.manifest its submissions.
      const probe = await run.broker.seatProbe({ invocationId })
      expect(probe.seat).toMatchObject({ state: 'turn-active', turnId: 'turn_manifest' })
      const probedTurnId = (probe.seat as { turnId: string }).turnId
      const manifest = await run.broker.turnManifest({
        invocationId,
        turnId: turnIdFrom(probedTurnId),
      })
      expect(manifest.submissionIds).toEqual([submission.submissionId])

      completeTurn(rpc, 'turn_manifest')
      await settle()
      expect(terminalsFor(run.events, submission.submissionId)).toEqual(['submission.executed'])
    } finally {
      await cleanup(run, id)
    }
  })

  test('turnTimeoutMs bounds nothing on the codex-tui path', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc)
    const id = 'inv_tui_delivery_no_turn_timeout'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    run.invocationSpec.process.limits = { startupTimeoutMs: 2_000, turnTimeoutMs: 25 }
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const submission = await run.broker.enqueue({ invocationId, origin, body: 'slow' })
      await waitFor(() => queued.length === 1, 'queue/add reaches Codex')
      startTurn(rpc, 'turn_slow')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      for (const type of [
        'turn.failed',
        'submission.lost',
        'invocation.failed',
        'input.rejected',
      ]) {
        expect(run.events.filter((event) => event.type === type)).toHaveLength(0)
      }
      emitUserMessageItem(rpc, {
        turnId: 'turn_slow',
        itemId: 'user_slow',
        clientId: submission.submissionId,
        text: 'slow',
      })
      completeTurn(rpc, 'turn_slow')
      await settle()
      expect(terminalsFor(run.events, submission.submissionId)).toEqual(['submission.executed'])
    } finally {
      await cleanup(run, id)
    }
  })
})

describe('T-13687 steer: always injects, never queues behind or refuses a busy seat', () => {
  /** Answer turn/steer for the turn it names and report its native user item. */
  const steerAnswers =
    (rpc: FakeCodexRpc): Handler =>
    (method, params) => {
      if (method !== 'turn/steer') return undefined
      const steer = params as { expectedTurnId: string; clientUserMessageId: string }
      queueMicrotask(() =>
        emitUserMessageItem(rpc, {
          turnId: steer.expectedTurnId,
          itemId: `steer_${steer.clientUserMessageId}`,
          clientId: steer.clientUserMessageId,
          text: 'steer body',
        })
      )
      return { turnId: steer.expectedTurnId }
    }

  test('a steer during an unattributed turn with an own-turn input pending lands as turn/steer', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc, steerAnswers(rpc))
    const id = 'inv_tui_steer_unattributed'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const pending = await run.broker.enqueue({ invocationId, origin, body: 'queued first' })
      await waitFor(() => queued.length === 1, 'queue/add reaches Codex')
      // The compaction-first shape: a turn runs before any item names its owner.
      startTurn(rpc, 'turn_compacting')
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_compacting',
        item: { type: 'contextCompaction', id: 'compact' },
      })
      expect((await run.broker.seatProbe({ invocationId })).seat.state).toBe('turn-observed')

      const steer = await run.broker.steer({ invocationId, origin, body: 'steer body' })
      expect(steer.admission).toBe('admitted')
      await waitFor(
        () => terminalOf(run.events, steer.submissionId, 'submission.absorbed') !== undefined,
        'steer is absorbed into the running turn'
      )
      expect(
        rpc.requests.filter((request) => request.method === 'turn/steer').map((r) => r.params)
      ).toMatchObject([
        { expectedTurnId: 'turn_compacting', clientUserMessageId: steer.submissionId },
      ])
      expect(queued).toEqual([pending.submissionId])

      // The queued input's own user item still binds the turn after the steer.
      emitUserMessageItem(rpc, {
        turnId: 'turn_compacting',
        itemId: 'user_pending',
        clientId: pending.submissionId,
        text: 'queued first',
      })
      completeTurn(rpc, 'turn_compacting')
      await settle()
      expect(
        terminalOf(run.events, steer.submissionId, 'submission.absorbed')?.payload
      ).toMatchObject({
        submissionId: steer.submissionId,
        turnId: 'turn_compacting',
      })
      expect(terminalsFor(run.events, steer.submissionId)).toEqual(['submission.absorbed'])
      expect(terminalsFor(run.events, pending.submissionId)).toEqual(['submission.executed'])
      expect(run.events.filter((event) => event.type === 'input.rejected')).toHaveLength(0)
      // The delayed initiating attribution keeps the steer the turn already carried.
      expect(
        (
          await run.broker.turnManifest({ invocationId, turnId: turnIdFrom('turn_compacting') })
        ).submissionIds
          .slice()
          .sort()
      ).toEqual([pending.submissionId, steer.submissionId].slice().sort())
    } finally {
      await cleanup(run, id)
    }
  })

  test('C: a steer in the pending window waits for the own turn to start, then lands as turn/steer', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc, steerAnswers(rpc))
    const id = 'inv_tui_steer_pending_window'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const pending = await run.broker.enqueue({ invocationId, origin, body: 'own turn' })
      await waitFor(() => queued.length === 1, 'queue/add reaches Codex')
      expect((await run.broker.seatProbe({ invocationId })).seat.state).toBe('starting')

      const steer = await run.broker.steer({ invocationId, origin, body: 'steer body' })
      expect(steer.admission).toBe('admitted')
      await settle()
      // Waiting: Codex has no turn to steer into, and the steer neither
      // queues behind the pending input nor is refused busy.
      expect(rpc.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(0)
      expect(queued).toEqual([pending.submissionId])
      expect(terminalsFor(run.events, steer.submissionId)).toEqual([])
      expect(run.events.filter((event) => event.type === 'input.rejected')).toHaveLength(0)

      startTurn(rpc, 'turn_own')
      emitUserMessageItem(rpc, {
        turnId: 'turn_own',
        itemId: 'user_own',
        clientId: pending.submissionId,
        text: 'own turn',
      })
      await waitFor(
        () => terminalOf(run.events, steer.submissionId, 'submission.absorbed') !== undefined,
        'steer lands on the own turn once it starts'
      )
      expect(
        rpc.requests.filter((request) => request.method === 'turn/steer').map((r) => r.params)
      ).toMatchObject([{ expectedTurnId: 'turn_own', clientUserMessageId: steer.submissionId }])
      completeTurn(rpc, 'turn_own')
      await settle()

      expect(queued).toEqual([pending.submissionId])
      expect(
        (
          await run.broker.turnManifest({ invocationId, turnId: turnIdFrom('turn_own') })
        ).submissionIds
          .slice()
          .sort()
      ).toEqual([pending.submissionId, steer.submissionId].slice().sort())
      expect(
        terminalOf(run.events, steer.submissionId, 'submission.absorbed')?.payload
      ).toMatchObject({
        submissionId: steer.submissionId,
        turnId: 'turn_own',
      })
      expect(terminalsFor(run.events, steer.submissionId)).toEqual(['submission.absorbed'])
      expect(terminalsFor(run.events, pending.submissionId)).toEqual(['submission.executed'])
      expect(
        run.events.find(
          (event) => event.type === 'input.accepted' && event.inputId === steer.submissionId
        )?.payload
      ).toMatchObject({ disposition: 'attempted_steer' })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'input.rejected' ||
            (event.type === 'diagnostic' && JSON.stringify(event.payload).includes('busy'))
        )
      ).toHaveLength(0)
    } finally {
      await cleanup(run, id)
    }
  })

  test('C: a steer still waiting when the invocation closes is refused not_written', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc, steerAnswers(rpc))
    const id = 'inv_tui_steer_pending_window_closed'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const pending = await run.broker.enqueue({ invocationId, origin, body: 'own turn' })
      await waitFor(() => queued.length === 1, 'queue/add reaches Codex')
      const steer = await run.broker.steer({ invocationId, origin, body: 'steer body' })
      await settle()
      await run.broker.stop({ invocationId, reason: 'closing' })
      await waitFor(
        () => terminalsFor(run.events, steer.submissionId).length > 0,
        'waiting steer settles at close'
      )
      expect(
        run.events.find(
          (event) => event.type === 'input.rejected' && event.inputId === steer.submissionId
        )?.payload
      ).toMatchObject({ deliveryEvidence: 'not_written' })
      expect(terminalsFor(run.events, steer.submissionId)).toEqual(['submission.rejected'])
      expect(terminalsFor(run.events, pending.submissionId)).toHaveLength(1)
      expect(rpc.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(0)
    } finally {
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('a steer to an idle seat after an interrupt starts an own turn via queue/add plus queue/start', async () => {
    const rpc = new FakeCodexRpc()
    const queued = queueOnlyCodex(rpc, (method) =>
      method === 'thread/queue/start' ? {} : undefined
    )
    const id = 'inv_tui_steer_idle_queue_start'
    const invocationId = invocationIdFrom(id)
    const run = await setupDriver(rpc, id)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      // An interrupted turn pauses Codex's queue: the next own turn needs queue/start.
      emitTurn(rpc, 'turn_human', { clientId: null, terminal: 'interrupted' })
      await settle()

      const steer = await run.broker.steer({ invocationId, origin, body: 'from idle' })
      await waitFor(() => queued.length === 1, 'idle steer falls back to an own turn')
      await waitFor(
        () => rpc.requests.some((request) => request.method === 'thread/queue/start'),
        'paused queue is started explicitly'
      )
      expect(
        rpc.requests
          .filter(
            (request) =>
              request.method.startsWith('thread/queue/') || request.method === 'turn/steer'
          )
          .filter((request) => request.method !== 'thread/queue/list')
          .map((request) => request.method)
      ).toEqual(['thread/queue/add', 'thread/queue/start'])
      expect(
        rpc.requests.find((request) => request.method === 'thread/queue/start')?.params
      ).toMatchObject({ queuedSubmissionId: `queued_${steer.submissionId}` })
      expect(
        run.events.find(
          (event) => event.type === 'input.accepted' && event.inputId === steer.submissionId
        )?.payload
      ).toMatchObject({ disposition: 'started' })

      emitTurn(rpc, 'turn_from_idle', { clientId: steer.submissionId })
      await settle()
      expect(
        terminalOf(run.events, steer.submissionId, 'submission.executed')?.payload
      ).toMatchObject({
        submissionId: steer.submissionId,
        turnId: 'turn_from_idle',
      })
      expect(terminalsFor(run.events, steer.submissionId)).toEqual(['submission.executed'])
    } finally {
      await cleanup(run, id)
    }
  })
})
