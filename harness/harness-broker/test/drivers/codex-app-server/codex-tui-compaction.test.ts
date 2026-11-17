import { expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { inputIdFrom, invocationIdFrom } from '../../ids'
import {
  FakeCodexRpc,
  emitTurn,
  lease,
  origin,
  setupDriver,
  waitFor,
} from './codex-tui-transport-support'

test('T-13668: compaction before the queued user item binds submission _79 and releases the next input', async () => {
  const rpc = new FakeCodexRpc()
  const invocationId = invocationIdFrom('inv_compaction_replay')
  const run = await setupDriver(rpc, invocationId)
  // The incident had no attribution timeout. A test deadline must not mask the wedge.
  run.invocationSpec.process.limits = { startupTimeoutMs: 2_000 }
  const inputs: string[] = []
  rpc.onRequest = async (method, params) => {
    if (method === 'initialize') return {}
    if (method === 'hooks/list') return { data: [] }
    if (method === 'thread/start') return { thread: { id: 'thread_test' } }
    if (method === 'thread/queue/list') return { data: [], nextCursor: null }
    if (method === 'thread/queue/add') {
      const id = (params as { clientUserMessageId: string }).clientUserMessageId
      inputs.push(id)
      if (inputs.length > 1) queueMicrotask(() => emitTurn(rpc, 'turn_next', { clientId: id }))
      return { queuedSubmission: { id: '01a1e641-1561-7e53-b3e0-471cb7d69f3b' } }
    }
    throw new Error(`unexpected ${method}`)
  }
  try {
    await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
    const first = await run.broker.enqueue({
      invocationId,
      origin,
      body: 'EN-56132: submission _79',
    })
    await waitFor(() => inputs.length === 1, 'first queued input delivered')
    const turnId = '01a1e641-1561-7e53-b3e0-473fdba6c427'
    rpc.emit('turn/started', {
      threadId: 'thread_test',
      turn: { id: turnId, status: 'inProgress', items: [] },
    })
    // Shapes from Codex generate-ts --experimental: ThreadItem and ItemStartedNotification.
    const compaction = { type: 'contextCompaction', id: 'compact_79' }
    rpc.emit('item/started', { threadId: 'thread_test', turnId, item: compaction })
    rpc.emit('item/completed', { threadId: 'thread_test', turnId, item: compaction })
    rpc.emit('item/started', {
      threadId: 'thread_test',
      turnId,
      item: {
        type: 'userMessage',
        id: 'user_79',
        clientId: inputs[0],
        content: [{ type: 'text', text: 'EN-56132: submission _79' }],
      },
    })
    rpc.emit('turn/completed', {
      threadId: 'thread_test',
      turn: { id: turnId, status: 'completed', items: [] },
    })
    const second = await run.broker.enqueue({ invocationId, origin, body: 'next mail' })
    // Let the real driver's delivery promise and broker drain finish their microtasks.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    console.log(
      JSON.stringify({
        replay: '5732-5802',
        attribution: run.events.filter((e) => e.type === 'turn.attributed').map((e) => e.payload),
        queueAdds: inputs.length,
        executed: run.events.filter((e) => e.type === 'submission.executed').map((e) => e.payload),
      })
    )
    expect(inputs, 'the second input must reach Codex after the compaction turn').toHaveLength(2)
    await waitFor(
      () =>
        run.events.some(
          (e) => e.type === 'submission.executed' && e.payload.submissionId === second.submissionId
        ),
      'second input executes'
    )
    expect(
      run.events.find((e) => e.type === 'turn.attributed' && e.turnId === turnId)?.payload
    ).toMatchObject({ ownership: 'own', origin: 'broker', inputId: first.submissionId })
    expect(run.events.find((e) => e.type === 'user.message' && e.turnId === turnId)?.inputId).toBe(
      inputIdFrom(first.submissionId)
    )
    expect(
      run.events.find((e) => e.type === 'turn.completed' && e.turnId === turnId)?.inputId
    ).toBe(inputIdFrom(first.submissionId))
  } finally {
    await run.broker.stop({ invocationId, reason: 'test cleanup' })
    await run.broker.dispose({ invocationId })
    await rm(run.socketDir, { recursive: true, force: true })
  }
})

test.each([
  'left',
  'human-left',
  'held',
  'unreadable',
  'invalid-cursor',
  'paginated',
  'late-ack',
] as const)('T-13668: unbound input with queue state %s', async (state) => {
  const rpc = new FakeCodexRpc()
  const invocationId = invocationIdFrom(`inv_unbound_${state}`)
  const run = await setupDriver(rpc, invocationId)
  run.invocationSpec.process.limits = { startupTimeoutMs: 2_000 }
  const inputs: string[] = []
  let queueReads = 0
  let acknowledge: (() => void) | undefined
  rpc.onRequest = async (method, params) => {
    if (method === 'initialize') return {}
    if (method === 'hooks/list') return { data: [] }
    if (method === 'thread/start') return { thread: { id: 'thread_test' } }
    if (method === 'thread/queue/add') {
      const id = (params as { clientUserMessageId: string }).clientUserMessageId
      inputs.push(id)
      if (inputs.length > 1) queueMicrotask(() => emitTurn(rpc, 'turn_next', { clientId: id }))
      if (inputs.length === 1 && state === 'late-ack') {
        await new Promise<void>((resolve) => {
          acknowledge = resolve
        })
      }
      return { queuedSubmission: { id: `queued_${id}` } }
    }
    if (method === 'thread/queue/list') {
      queueReads += 1
      if (state === 'unreadable') throw new Error('queue unavailable')
      if (state === 'invalid-cursor') return { data: [] }
      if (state === 'paginated' && !(params as { cursor?: string }).cursor) {
        return { data: [], nextCursor: 'page2' }
      }
      return {
        data: ['held', 'paginated'].includes(state)
          ? [
              {
                id: `queued_${inputs[0]}`,
                clientUserMessageId: inputs[0],
                input: [{ type: 'text', text: 'unbound' }],
              },
            ]
          : [],
        nextCursor: null,
      }
    }
    throw new Error(`unexpected ${method}`)
  }
  try {
    await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
    const first = await run.broker.enqueue({ invocationId, origin, body: 'unbound' })
    await waitFor(() => inputs.length === 1, 'first input delivered')
    const second = await run.broker.enqueue({ invocationId, origin, body: 'next' })
    // A turn with no initiating user item must settle autonomous at completion.
    rpc.emit('turn/started', {
      threadId: 'thread_test',
      turn: { id: 'turn_unbound', status: 'inProgress', items: [] },
    })
    rpc.emit('item/started', {
      threadId: 'thread_test',
      turnId: 'turn_unbound',
      item: { type: 'contextCompaction', id: 'compact' },
    })
    expect(run.events.filter((e) => e.type === 'turn.attributed')).toHaveLength(0)
    if (state === 'human-left') {
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_unbound',
        item: {
          type: 'userMessage',
          id: 'human',
          clientId: null,
          content: [{ type: 'text', text: 'human input' }],
        },
      })
    }
    rpc.emit('turn/completed', {
      threadId: 'thread_test',
      turn: { id: 'turn_unbound', status: 'completed', items: [] },
    })
    acknowledge?.()
    await waitFor(() => queueReads > 0, 'completion reads native queue')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(
      run.events.find((e) => e.type === 'turn.attributed' && e.turnId === 'turn_unbound')?.payload
    ).toMatchObject({
      ownership: 'foreign',
      origin: state === 'human-left' ? 'human' : 'autonomous',
    })
    if (state === 'left' || state === 'human-left' || state === 'late-ack') {
      expect(
        run.events.find((e) => e.type === 'input.rejected' && e.inputId === first.submissionId)
          ?.payload
      ).toMatchObject({
        deliveryEvidence: 'possibly_written',
        reason: expect.stringContaining("left Codex's queue without an attributed turn"),
      })
      expect(inputs).toHaveLength(2)
      expect(
        run.events.some(
          (e) => e.type === 'submission.executed' && e.payload.submissionId === second.submissionId
        )
      ).toBe(true)
    } else {
      expect(inputs).toHaveLength(1)
      expect(run.events.filter((e) => e.type === 'input.rejected')).toHaveLength(0)
      if (state === 'paginated') expect(queueReads).toBe(2)
      // It really remains pending and can subsequently bind, not merely avoid rejection.
      emitTurn(rpc, 'turn_delayed', { clientId: inputs[0] ?? null })
      await waitFor(() => inputs.length === 2, 'later attribution releases the queue')
    }
    expect(run.events.filter((e) => e.type === 'invocation.failed')).toHaveLength(0)
  } finally {
    await run.broker.stop({ invocationId, reason: 'test cleanup' })
    await run.broker.dispose({ invocationId })
    await rm(run.socketDir, { recursive: true, force: true })
  }
})
