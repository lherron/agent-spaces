import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { invocationIdFrom, turnIdFrom } from '../../ids'
import {
  FakeCodexRpc,
  emitUserMessageItem,
  lease,
  origin,
  setupDriver,
  waitFor,
} from './codex-tui-transport-support'

describe('codex-tui steer races and autonomous turns', () => {
  test('keeps before-await steer identity when a foreign turn races the RPC response', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    let steerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_original', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_original',
            itemId: 'user_original',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_original' } }
      }
      if (method === 'turn/steer') {
        const steer = params as { clientUserMessageId: string; expectedTurnId: string }
        steerInputId = steer.clientUserMessageId
        rpc.emit('turn/started', {
          threadId: 'thread_test',
          turn: { id: 'turn_foreign', status: 'inProgress', items: [] },
        })
        emitUserMessageItem(rpc, {
          turnId: 'turn_foreign',
          itemId: 'user_foreign',
          text: 'foreign input',
        })
        return { turnId: steer.expectedTurnId }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = invocationIdFrom('inv_codex_tui_steer_identity_race')
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_original'
          ),
        'original turn should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'race steer' })
      await waitFor(
        () => rpc.requests.some((request) => request.method === 'turn/steer'),
        'steer should reach Codex'
      )
      expect(steerInputId).toBe(steer.submissionId)
      emitUserMessageItem(rpc, {
        turnId: 'turn_original',
        itemId: 'user_race_steer',
        clientId: steer.submissionId,
        text: 'race steer',
      })

      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toMatchObject({ turnId: 'turn_original' })
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_original'
        )?.payload
      ).toMatchObject({ ownership: 'own', inputId: ownerInputId })
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_foreign'
        )?.payload
      ).toMatchObject({ ownership: 'foreign', origin: 'human' })
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('fails a mismatched steer response open into an own turn', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputCount = 0
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queuedInputCount += 1
        const turnId = queuedInputCount === 1 ? 'turn_mismatch' : 'turn_mismatch_fallback'
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: turnId, status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId,
            itemId: `user_${turnId}`,
            clientId: inputId,
            text: queuedInputCount === 1 ? 'owner' : 'mismatched response',
          })
        })
        return { queuedSubmission: { id: `queued_mismatch_${queuedInputCount}` } }
      }
      if (method === 'turn/steer') return { turnId: 'turn_wrong_response' }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = invocationIdFrom('inv_codex_tui_steer_response_mismatch')
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_mismatch'
          ),
        'owner should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'mismatched response' })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === steer.submissionId &&
              event.turnId === 'turn_mismatch_fallback'
          ),
        'mismatched response should fail open into an own turn'
      )
      expect(
        run.events.find(
          (event) => event.type === 'input.accepted' && event.payload.inputId === steer.submissionId
        )?.payload
      ).toMatchObject({ disposition: 'started' })
      expect(
        run.events.find(
          (event) =>
            event.type === 'diagnostic' &&
            event.payload.message.includes('conflicts with the armed turn identity')
        )?.payload
      ).toMatchObject({
        data: {
          inputId: steer.submissionId,
          expectedTurnId: 'turn_mismatch',
          responseTurnId: 'turn_wrong_response',
          nativeContextEntryObserved: false,
        },
      })
      expect(
        run.events.filter(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )
      ).toHaveLength(0)
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('fences late target evidence from the fail-open own-turn attribution', async () => {
    const rpc = new FakeCodexRpc()
    let fallbackInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        fallbackInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        return { queuedSubmission: { id: 'queued_fail_open' } }
      }
      if (method === 'turn/steer') {
        return new Promise<never>(() => undefined)
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = invocationIdFrom('inv_codex_tui_interrupted_steer')
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      rpc.emit('turn/started', {
        threadId: 'thread_test',
        turn: { id: 'turn_interrupted_steer', status: 'inProgress', items: [] },
      })
      const steer = await run.broker.steer({ invocationId, origin, body: 'late steer' })
      await waitFor(
        () => rpc.requests.some((request) => request.method === 'turn/steer'),
        'steer should reach Codex'
      )
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_interrupted_steer', status: 'interrupted', items: [] },
      })
      await waitFor(
        () => fallbackInputId === steer.submissionId,
        'unconfirmed steer should enqueue the same submission for an own turn'
      )

      emitUserMessageItem(rpc, {
        turnId: 'turn_interrupted_steer',
        itemId: 'late_retired_target_item',
        clientId: steer.submissionId,
        text: 'late steer',
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.executed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)
      expect(
        run.events.find(
          (event) => event.type === 'user.message' && event.payload.content === 'late steer'
        )?.inputId
      ).toBeUndefined()

      rpc.emit('turn/started', {
        threadId: 'thread_test',
        turn: { id: 'turn_fail_open', status: 'inProgress', items: [] },
      })
      emitUserMessageItem(rpc, {
        turnId: 'turn_fail_open',
        itemId: 'user_turn_fail_open',
        clientId: steer.submissionId,
        text: 'late steer',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === steer.submissionId &&
              event.turnId === 'turn_fail_open'
          ),
        'only the fallback turn should execute the submission'
      )
      expect(
        run.events.find(
          (event) => event.type === 'input.accepted' && event.payload.inputId === steer.submissionId
        )?.payload
      ).toMatchObject({ disposition: 'started' })
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('clears pending steer correlation on provider death without fabricating landing', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_provider_death', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_provider_death',
            itemId: 'user_provider_death_owner',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_provider_death' } }
      }
      if (method === 'turn/steer') {
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = invocationIdFrom('inv_codex_tui_provider_death_steer')
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_provider_death'
          ),
        'owner should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'lost with process' })
      await waitFor(
        () => rpc.requests.some((request) => request.method === 'turn/steer'),
        'steer should reach Codex'
      )
      rpc.fail(new Error('provider process died'))
      await waitFor(
        () => run.events.some((event) => event.type === 'invocation.exited'),
        'provider death should terminate the invocation'
      )
      emitUserMessageItem(rpc, {
        turnId: 'turn_provider_death',
        itemId: 'user_impossible_after_death',
        clientId: steer.submissionId,
        text: 'lost with process',
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test.each([false, true])(
    'fails an ambiguous RPC error open unless native evidence already landed nativeFirst=%s',
    async (nativeFirst) => {
      const rpc = new FakeCodexRpc()
      let steerInputId = ''
      let queuedInputCount = 0
      rpc.onRequest = async (method, params) => {
        if (method === 'initialize') return {}
        if (method === 'hooks/list') return { data: [] }
        if (method === 'thread/start') return { thread: { id: 'thread_test' } }
        if (method === 'thread/queue/add') {
          const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
          queuedInputCount += 1
          const turnId = queuedInputCount === 1 ? 'turn_rpc_failure' : 'turn_rpc_fallback'
          queueMicrotask(() => {
            rpc.emit('turn/started', {
              threadId: 'thread_test',
              turn: { id: turnId, status: 'inProgress', items: [] },
            })
            emitUserMessageItem(rpc, {
              turnId,
              itemId: `user_${turnId}`,
              clientId: inputId,
              text: queuedInputCount === 1 ? 'owner' : 'uncertain steer',
            })
          })
          return { queuedSubmission: { id: `queued_rpc_${queuedInputCount}` } }
        }
        if (method === 'turn/steer') {
          steerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
          if (nativeFirst) {
            emitUserMessageItem(rpc, {
              turnId: 'turn_rpc_failure',
              itemId: 'user_before_rpc_failure',
              clientId: steerInputId,
              text: 'uncertain steer',
            })
          }
          throw new Error('simulated RPC response failure')
        }
        throw new Error(`unhandled fake RPC request: ${method}`)
      }
      const invocationId = invocationIdFrom(`inv_codex_tui_rpc_failure_${nativeFirst}`)
      const run = await setupDriver(rpc, invocationId)
      try {
        await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
        await run.broker.enqueue({ invocationId, origin, body: 'owner' })
        await waitFor(
          () =>
            run.events.some(
              (event) => event.type === 'turn.attributed' && event.turnId === 'turn_rpc_failure'
            ),
          'owner should be attributed'
        )
        const steer = await run.broker.steer({ invocationId, origin, body: 'uncertain steer' })
        await waitFor(
          () => rpc.requests.some((request) => request.method === 'turn/steer'),
          'steer should reach Codex'
        )
        expect(steerInputId).toBe(steer.submissionId)
        expect(rpc.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(1)

        if (nativeFirst) {
          await waitFor(
            () =>
              run.events.some(
                (event) =>
                  event.type === 'input.accepted' && event.payload.inputId === steer.submissionId
              ),
            'native confirmation should preserve the steer despite the RPC error'
          )
          expect(
            run.events.find(
              (event) =>
                event.type === 'diagnostic' &&
                event.payload.message.includes('failed after native context entry')
            )?.payload
          ).toMatchObject({ data: { inputId: steer.submissionId } })
          expect(
            run.events.filter(
              (event) =>
                event.type === 'submission.absorbed' &&
                event.payload.submissionId === steer.submissionId
            )
          ).toHaveLength(1)
          expect(queuedInputCount).toBe(1)
        } else {
          await waitFor(
            () =>
              run.events.some(
                (event) =>
                  event.type === 'submission.executed' &&
                  event.payload.submissionId === steer.submissionId &&
                  event.turnId === 'turn_rpc_fallback'
              ),
            'ambiguous RPC failure should fail open into an own turn'
          )
          expect(queuedInputCount).toBe(2)
          expect(
            run.events.filter(
              (event) =>
                event.type === 'submission.absorbed' &&
                event.payload.submissionId === steer.submissionId
            )
          ).toHaveLength(0)
        }
        expect(
          run.events.filter(
            (event) =>
              event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
          )
        ).toHaveLength(0)
      } finally {
        await run.broker.stop({ invocationId, reason: 'test cleanup' })
        await run.broker.dispose({ invocationId })
        await rm(run.socketDir, { recursive: true, force: true })
      }
    }
  )

  test('attributes autonomous and itemless turns before output or terminal events', async () => {
    const rpc = new FakeCodexRpc()
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'turn/steer') {
        return {
          turnId: (params as { expectedTurnId: string }).expectedTurnId,
        }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_attribution')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      rpc.emit('turn/started', {
        threadId: 'thread_test',
        turn: { id: 'turn_goal', status: 'inProgress', items: [] },
      })
      expect(
        (
          await run.broker.seatProbe({
            invocationId: invocationIdFrom('inv_codex_tui_attribution'),
          })
        ).seat
      ).toEqual({ state: 'turn-observed', turnId: turnIdFrom('turn_goal') })
      expect(
        await run.broker.steer({
          invocationId: invocationIdFrom('inv_codex_tui_attribution'),
          origin,
          body: 'mid-turn before attribution',
        })
      ).toMatchObject({ admission: 'admitted' })
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_goal',
        item: { id: 'goal_agent', type: 'agentMessage', text: '' },
      })
      const goalAttribution = run.events.find(
        (event) => event.type === 'turn.attributed' && event.turnId === 'turn_goal'
      )
      const goalOutput = run.events.findIndex(
        (event) => event.type === 'assistant.message.started' && event.turnId === 'turn_goal'
      )
      expect(goalAttribution?.payload).toMatchObject({
        ownership: 'foreign',
        origin: 'autonomous',
      })
      expect(run.events.indexOf(goalAttribution as InvocationEventEnvelope)).toBeLessThan(
        goalOutput
      )
      expect(
        await run.broker.steer({
          invocationId: invocationIdFrom('inv_codex_tui_attribution'),
          origin,
          body: 'land after attribution',
        })
      ).toMatchObject({ admission: 'admitted' })
      expect(rpc.requests.find((request) => request.method === 'turn/steer')?.params).toMatchObject(
        {
          expectedTurnId: 'turn_goal',
        }
      )
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_goal', status: 'completed', items: [] },
      })

      rpc.emit('turn/started', {
        threadId: 'thread_test',
        turn: { id: 'turn_itemless', status: 'inProgress', items: [] },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_itemless', status: 'failed', items: [] },
      })
      const unknownIndex = run.events.findIndex(
        (event) => event.type === 'turn.attributed' && event.turnId === 'turn_itemless'
      )
      const terminalIndex = run.events.findIndex(
        (event) =>
          event.turnId === 'turn_itemless' &&
          ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
      )
      expect(run.events[unknownIndex]?.payload).toMatchObject({
        ownership: 'unknown',
        origin: 'unknown',
      })
      expect(unknownIndex).toBeGreaterThanOrEqual(0)
      expect(unknownIndex).toBeLessThan(terminalIndex)
      expect(
        await run.broker.turnManifest({
          invocationId: invocationIdFrom('inv_codex_tui_attribution'),
          turnId: turnIdFrom('turn_itemless'),
        })
      ).toMatchObject({ policy: 'open' })
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_attribution'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: invocationIdFrom('inv_codex_tui_attribution') })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test.each(['native-terminal', 'app-server-error', 'turn-timeout', 'rpc-close'] as const)(
    'attributes an itemless pending turn unknown before %s and fails correlation closed',
    async (terminalPath) => {
      const rpc = new FakeCodexRpc()
      let pendingInputId = ''
      rpc.onRequest = async (method, params) => {
        if (method === 'initialize') return {}
        if (method === 'hooks/list') return { data: [] }
        if (method === 'thread/start') return { thread: { id: 'thread_test' } }
        if (method === 'thread/queue/add') {
          pendingInputId = (params as { clientUserMessageId: string }).clientUserMessageId
          setTimeout(
            () =>
              rpc.emit('turn/started', {
                threadId: 'thread_test',
                turn: { id: 'turn_itemless_pending', status: 'inProgress', items: [] },
              }),
            0
          )
          return { queuedSubmission: { id: 'queued_itemless_pending' } }
        }
        throw new Error(`unhandled fake RPC request: ${method}`)
      }
      const invocationId = invocationIdFrom(`inv_codex_tui_itemless_${terminalPath}`)
      const run = await setupDriver(rpc, invocationId)
      if (terminalPath === 'turn-timeout') {
        run.invocationSpec.process.limits = { startupTimeoutMs: 2_000, turnTimeoutMs: 25 }
      }
      try {
        await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
        const queued = await run.broker.enqueue({ invocationId, origin, body: 'pending' })
        await waitFor(
          () =>
            run.events.some(
              (event) => event.type === 'turn.started' && event.turnId === 'turn_itemless_pending'
            ),
          'itemless turn should start'
        )

        if (terminalPath === 'native-terminal') {
          rpc.emit('turn/completed', {
            threadId: 'thread_test',
            turn: { id: 'turn_itemless_pending', status: 'failed', items: [] },
          })
        } else if (terminalPath === 'app-server-error') {
          rpc.emit('error', { message: 'synthetic app-server error', code: 'synthetic_error' })
        } else if (terminalPath === 'rpc-close') {
          rpc.fail(new Error('synthetic websocket close'))
        }

        await waitFor(
          () =>
            run.events.some(
              (event) =>
                event.type === 'submission.lost' &&
                event.payload.submissionId === queued.submissionId
            ),
          'pending submission should be lost after unknown terminal'
        )
        await waitFor(
          () => run.events.some((event) => event.type === 'invocation.failed'),
          'unknown correlation should fail the invocation'
        )

        const unknownIndex = run.events.findIndex(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_itemless_pending'
        )
        const terminalIndex = run.events.findIndex(
          (event) =>
            event.turnId === 'turn_itemless_pending' &&
            ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
        )
        expect(run.events[unknownIndex]).toMatchObject({
          payload: { ownership: 'unknown', origin: 'unknown' },
        })
        expect(run.events[unknownIndex]?.inputId).toBeUndefined()
        expect(unknownIndex).toBeGreaterThanOrEqual(0)
        expect(terminalIndex).toBeGreaterThan(unknownIndex)
        expect(run.events[terminalIndex]?.inputId).toBeUndefined()
        expect(
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === queued.submissionId
          )
        ).toBe(false)
        expect(
          await run.broker.turnManifest({
            invocationId,
            turnId: turnIdFrom('turn_itemless_pending'),
          })
        ).toMatchObject({ policy: 'open', submissionIds: [] })
        expect(pendingInputId).toBe(queued.submissionId)
      } finally {
        await run.broker.stop({ invocationId, reason: 'test cleanup' })
        await run.broker.dispose({ invocationId })
        await rm(run.socketDir, { recursive: true, force: true })
      }
    }
  )

  test('refuses approval policies other than never before opening a transport', async () => {
    const rpc = new FakeCodexRpc()
    const run = await setupDriver(rpc, 'inv_codex_tui_approval', {
      approvalPolicy: 'on-request' as never,
    })
    try {
      await expect(
        run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      ).rejects.toThrow(/approvalPolicy=never/)
      expect(rpc.requests).toHaveLength(0)
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'diagnostic',
          payload: expect.objectContaining({
            message: 'Codex TUI cannot attach while app-server approvals are enabled',
          }),
        })
      )
    } finally {
      await run.driver.dispose()
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })
})
