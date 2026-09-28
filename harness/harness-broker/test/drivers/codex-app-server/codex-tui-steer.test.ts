import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { CodexRpcError } from '../../../src/drivers/codex-app-server/rpc-client'
import {
  FakeCodexRpc,
  emitUserMessageItem,
  lease,
  origin,
  setupDriver,
  waitFor,
} from './codex-tui-transport-support'

describe('codex-tui steer', () => {
  test('confirms every distinct native steer item once without changing the turn owner', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_owned', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_owned',
            itemId: 'user_owner',
            clientId: queuedInputId,
            text: 'owning input',
          })
        })
        return { queuedSubmission: { id: 'queued_owned' } }
      }
      if (method === 'turn/steer') {
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_native_steers'
    const run = await setupDriver(rpc, invocationId, {}, true)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const owner = await run.broker.enqueue({
        invocationId,
        origin,
        body: 'owning input',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === owner.submissionId
          ),
        'owner should execute'
      )

      const first = await run.broker.steer({ invocationId, origin, body: 'identical text' })
      await waitFor(
        () => rpc.requests.filter((request) => request.method === 'turn/steer').length === 1,
        'first steer should reach Codex'
      )
      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_steer_first',
        clientId: first.submissionId,
        text: 'identical text',
      })
      const second = await run.broker.steer({ invocationId, origin, body: 'identical text' })
      await waitFor(
        () => rpc.requests.filter((request) => request.method === 'turn/steer').length === 2,
        'second steer should reach Codex'
      )
      const steerRequests = rpc.requests.filter((request) => request.method === 'turn/steer')
      expect(steerRequests).toHaveLength(2)
      expect(steerRequests.map((request) => request.params)).toMatchObject([
        {
          threadId: 'thread_test',
          expectedTurnId: 'turn_owned',
          clientUserMessageId: first.submissionId,
        },
        {
          threadId: 'thread_test',
          expectedTurnId: 'turn_owned',
          clientUserMessageId: second.submissionId,
        },
      ])
      expect(first.submissionId).not.toBe(second.submissionId)
      expect(run.events.filter((event) => event.type === 'submission.absorbed')).toHaveLength(1)

      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_human_later',
        text: 'human context',
      })
      // Provider replay and item/completed are not second landing evidence.
      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_steer_first',
        clientId: first.submissionId,
        text: 'identical text',
      })
      rpc.emit('item/completed', {
        threadId: 'thread_test',
        turnId: 'turn_owned',
        item: {
          id: 'user_steer_first',
          type: 'userMessage',
          clientId: first.submissionId,
          content: [{ type: 'text', text: 'identical text' }],
        },
      })
      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_steer_second',
        clientId: second.submissionId,
        text: 'identical text',
      })

      const absorptions = run.events.filter((event) => event.type === 'submission.absorbed')
      expect(absorptions).toHaveLength(2)
      expect(absorptions.map((event) => event.payload.submissionId)).toEqual([
        first.submissionId,
        second.submissionId,
      ])
      expect(absorptions.every((event) => event.turnId === 'turn_owned')).toBe(true)
      expect(
        run.events.filter(
          (event) => event.type === 'user.message' && event.payload.content === 'identical text'
        )
      ).toHaveLength(2)
      expect(
        run.events.find(
          (event) => event.type === 'user.message' && event.payload.content === 'human context'
        )?.inputId
      ).toBeUndefined()
      expect(
        run.events.filter(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_owned'
        )
      ).toMatchObject([
        {
          inputId: owner.submissionId,
          payload: { ownership: 'own', inputId: owner.submissionId, origin: 'broker' },
        },
      ])
      expect(absorptions[0]?.provenance).toMatchObject({ sourceKind: 'provider-jsonrpc' })
      expect(await run.broker.turnManifest({ invocationId, turnId: 'turn_owned' })).toMatchObject({
        submissionIds: [owner.submissionId, first.submissionId, second.submissionId],
      })
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('resolves a provider rollover at the steer actuation boundary', async () => {
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
            turn: { id: 'turn_observed_old', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_observed_old',
            itemId: 'user_observed_old',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_rollover' } }
      }
      if (method === 'turn/steer') {
        const steer = params as { clientUserMessageId: string; expectedTurnId: string }
        steerInputId = steer.clientUserMessageId
        expect(steer.expectedTurnId).toBe('turn_provider_current')
        return { turnId: 'turn_provider_current' }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    // The provider has already rolled, but the broker has only observed the
    // old turn. The fresh read is the deterministic EN-15497 race seam.
    rpc.threadTurnsListResponse = {
      data: [{ id: 'turn_provider_current', status: 'inProgress' }],
      nextCursor: null,
      backwardsCursor: null,
    }
    const invocationId = 'inv_codex_tui_steer_rollover'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_observed_old'
          ),
        'old observed turn should be attributed'
      )
      // The old local observation can close before a successor is surfaced to
      // the broker. `thread/turns/list` remains the authoritative actuation
      // fence, so a steer must not fall back to turn/start in this gap.
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_observed_old', status: 'completed', items: [] },
      })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.completed' && event.turnId === 'turn_observed_old'
          ),
        'local predecessor completion should be observed before the provider read'
      )

      const steer = await run.broker.steer({ invocationId, origin, body: 'roll with provider' })
      await waitFor(
        () => rpc.requests.some((request) => request.method === 'turn/steer'),
        'steer should reach Codex after fresh turn resolution'
      )
      expect(steerInputId).toBe(steer.submissionId)
      expect(
        rpc.requests.find((request) => request.method === 'thread/turns/list')?.params
      ).toEqual({
        threadId: 'thread_test',
        limit: 2,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      })
      expect(rpc.requests.some((request) => request.method === 'thread/read')).toBe(false)

      emitUserMessageItem(rpc, {
        turnId: 'turn_provider_current',
        itemId: 'user_rollover_steer',
        clientId: steer.submissionId,
        text: 'roll with provider',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.absorbed' &&
              event.payload.submissionId === steer.submissionId
          ),
        'native item should absorb the steer into the provider-selected turn'
      )
      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )?.turnId
      ).toBe('turn_provider_current')
      expect(
        run.events.filter(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )
      ).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('starts an own turn when steer arrives while the invocation is idle', async () => {
    const rpc = new FakeCodexRpc()
    let steerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        steerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_idle_steer', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_idle_steer',
            itemId: 'user_idle_steer',
            clientId: steerInputId,
            text: 'start from idle',
          })
        })
        return { queuedSubmission: { id: 'queued_idle_steer' } }
      }
      throw new Error(`unexpected request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_idle_steer'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const steer = await run.broker.steer({ invocationId, origin, body: 'start from idle' })
      await waitFor(
        () =>
          rpc.requests.some((request) => request.method === 'thread/queue/add') ||
          run.events.some(
            (event) =>
              event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
          ),
        'idle steer should either start or expose the regression'
      )

      expect(steerInputId).toBe(steer.submissionId)
      expect(rpc.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(0)
      expect(
        run.events.filter(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )
      ).toHaveLength(0)
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === steer.submissionId &&
              event.turnId === 'turn_idle_steer'
          ),
        'idle steer should execute as the initiating input of its own turn'
      )
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('starts an own turn when provider state becomes idle before steer actuation', async () => {
    const rpc = new FakeCodexRpc()
    let queueCount = 0
    let ownerInputId = ''
    let steerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queueCount += 1
        const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
        if (queueCount === 1) {
          ownerInputId = inputId
          queueMicrotask(() => {
            rpc.emit('turn/started', {
              threadId: 'thread_test',
              turn: { id: 'turn_locally_active', status: 'inProgress', items: [] },
            })
            emitUserMessageItem(rpc, {
              turnId: 'turn_locally_active',
              itemId: 'user_locally_active',
              clientId: ownerInputId,
              text: 'owner',
            })
          })
          return { queuedSubmission: { id: 'queued_owner' } }
        }
        steerInputId = inputId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_started_after_provider_idle', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_started_after_provider_idle',
            itemId: 'user_started_after_provider_idle',
            clientId: steerInputId,
            text: 'start after provider idle',
          })
        })
        return { queuedSubmission: { id: 'queued_provider_idle_steer' } }
      }
      throw new Error(`unexpected request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_provider_idle_steer'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_locally_active'
          ),
        'broker should still observe the predecessor as active'
      )
      rpc.threadTurnsListResponse = { data: [], nextCursor: null, backwardsCursor: null }

      const steer = await run.broker.steer({
        invocationId,
        origin,
        body: 'start after provider idle',
      })
      await waitFor(
        () =>
          queueCount === 2 ||
          run.events.some(
            (event) =>
              event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
          ),
        'provider-idle steer should either start or expose the regression'
      )

      expect(steerInputId).toBe(steer.submissionId)
      expect(rpc.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(0)
      expect(
        run.events.filter(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )
      ).toHaveLength(0)
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === steer.submissionId &&
              event.turnId === 'turn_started_after_provider_idle'
          ),
        'provider-idle steer should execute once as the new turn owner'
      )
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('retries typed pre-write turn mismatches through more than three list-to-steer rollovers', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    let turnsListCount = 0
    let steerCount = 0
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_before_actuation', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_before_actuation',
            itemId: 'user_before_actuation',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_actuation_rollover' } }
      }
      if (method === 'turn/steer') {
        steerCount += 1
        const steer = params as { clientUserMessageId: string; expectedTurnId: string }
        expect(steer.expectedTurnId).toBe(`turn_read_${steerCount}`)
        if (steerCount <= 4) {
          throw new CodexRpcError(-32000, 'expectedTurnId does not match the active turn', {
            code: 'turn_mismatch',
          })
        }
        return { turnId: `turn_read_${steerCount}` }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    rpc.threadTurnsListResponse = () => {
      turnsListCount += 1
      return {
        data: [
          {
            id: `turn_read_${turnsListCount}`,
            status: 'inProgress',
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      }
    }
    const invocationId = 'inv_codex_tui_steer_actuation_rollover'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () => run.events.some((event) => event.type === 'turn.attributed'),
        'locally observed turn should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'race the precondition' })
      await waitFor(() => steerCount === 5, 'typed mismatches should retry past three rollovers')
      expect(turnsListCount).toBe(5)
      expect(
        rpc.requests
          .filter((request) => request.method === 'turn/steer')
          .map((request) => (request.params as { clientUserMessageId: string }).clientUserMessageId)
      ).toEqual(Array(5).fill(steer.submissionId))

      emitUserMessageItem(rpc, {
        turnId: 'turn_read_5',
        itemId: 'user_after_actuation_rollover',
        clientId: steer.submissionId,
        text: 'race the precondition',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.absorbed' &&
              event.payload.submissionId === steer.submissionId
          ),
        'final provider-selected turn should absorb the one steer'
      )
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(1)
      expect(
        run.events.filter(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )
      ).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test.each([
    {
      name: 'malformed thread/turns/list response',
      readResponse: {},
    },
    {
      name: 'multiple-active-turn thread/turns/list response',
      readResponse: {
        data: [
          { id: 'turn_locally_active', status: 'inProgress' },
          { id: 'turn_other_active', status: 'inProgress' },
        ],
      },
    },
    {
      name: 'failed thread/turns/list request',
      readResponse: () => {
        throw new Error('thread/turns/list unavailable')
      },
    },
  ])('attempts best-effort steer for $name', async ({ name, readResponse }) => {
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
            turn: { id: 'turn_locally_active', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_locally_active',
            itemId: 'user_locally_active',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_best_effort' } }
      }
      if (method === 'turn/steer') {
        const steer = params as { clientUserMessageId: string; expectedTurnId: string }
        steerInputId = steer.clientUserMessageId
        expect(steer.expectedTurnId).toBe('turn_locally_active')
        queueMicrotask(() => {
          emitUserMessageItem(rpc, {
            turnId: 'turn_locally_active',
            itemId: `user_${steerInputId}`,
            clientId: steerInputId,
            text: 'best effort steer',
          })
        })
        return { turnId: 'turn_locally_active' }
      }
      throw new Error(`unexpected request: ${method}`)
    }
    rpc.threadTurnsListResponse = readResponse
    const invocationId = `inv_codex_tui_steer_${name.replaceAll(/[^a-z]+/g, '_')}`
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () => run.events.some((event) => event.type === 'turn.attributed'),
        'local active turn should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'best effort steer' })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.absorbed' &&
              event.payload.submissionId === steer.submissionId
          ),
        'best-effort steer should reach the locally observed active turn'
      )
      expect(steerInputId).toBe(steer.submissionId)
      expect(rpc.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(1)
      expect(
        run.events.filter(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )
      ).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })
})
