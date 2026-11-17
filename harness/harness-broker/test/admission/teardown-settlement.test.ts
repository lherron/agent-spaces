import { describe, expect, test } from 'bun:test'
import { SUBMISSION_TERMINAL_TYPES } from '../../src/invocation-constants'
import { eventsFor, eventsForSubmission, flush, origin, setup } from './fixture'

/** Every submission terminal event about one submission. */
function terminalsFor(
  events: Awaited<ReturnType<typeof setup>>['events'],
  submissionId: string
): string[] {
  return events
    .filter(
      (event) =>
        SUBMISSION_TERMINAL_TYPES.has(event.type) &&
        (event.payload as { submissionId?: string }).submissionId === submissionId
    )
    .map((event) => event.type)
}

describe('T-13687 B: invocation teardown settles every submission', () => {
  test('a possibly_written delivery left undisposed gets exactly one submission.lost at exit', async () => {
    const run = await setup('inv_teardown_possibly_written', {
      beforeApplyInput: async () => {
        throw Object.assign(new Error('paste failed after the first byte'), {
          deliveryEvidence: 'possibly_written' as const,
        })
      },
    })
    const queued = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'may have reached the pane',
    })
    await flush()
    await flush()

    // The failed attempt is reported once and the fate stays open.
    expect(
      eventsFor(run.events, 'input.rejected').filter(
        (event) => event.payload.inputId === queued.submissionId
      )
    ).toMatchObject([{ payload: { deliveryEvidence: 'possibly_written' } }])
    expect(terminalsFor(run.events, queued.submissionId)).toEqual([])
    expect((await run.broker.seatProbe({ invocationId: run.invocationId })).seat.state).toBe('idle')

    await run.broker.stop({ invocationId: run.invocationId, reason: 'test teardown' })
    await flush()

    expect(eventsForSubmission(run.events, 'submission.lost', queued.submissionId)).toMatchObject([
      { payload: { submissionId: queued.submissionId, reason: 'teardown' } },
    ])
    expect(terminalsFor(run.events, queued.submissionId)).toEqual(['submission.lost'])
    const exitIndex = run.events.findIndex((event) => event.type === 'invocation.exited')
    const lostIndex = run.events.findIndex(
      (event) =>
        event.type === 'submission.lost' && event.payload.submissionId === queued.submissionId
    )
    // HRC's first completion wins: the lost must precede the invocation end.
    expect(lostIndex).toBeGreaterThanOrEqual(0)
    expect(exitIndex).toBeGreaterThan(lostIndex)
  })

  test('the pending own turn is lost and never-handed-over inputs are cancelled, all before exit', async () => {
    // A harness-evidence driver whose turn never starts keeps the delivered
    // body in the own-turn slot until teardown.
    const run = await setup('inv_teardown_pending_own_turn', {
      bracketMintingMode: 'harness-evidence',
      suppressTurnStarted: true,
    })
    const delivered = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'handed to the driver',
    })
    await flush()
    expect((await run.broker.seatProbe({ invocationId: run.invocationId })).seat.state).toBe(
      'starting'
    )
    const held = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'never handed over',
    })
    await flush()
    expect(run.controller.inputs.map((input) => input.inputId as string | undefined)).toEqual([
      delivered.submissionId,
    ])

    await run.broker.stop({ invocationId: run.invocationId, reason: 'test teardown' })
    await flush()

    expect(terminalsFor(run.events, delivered.submissionId)).toEqual(['submission.lost'])
    expect(
      eventsForSubmission(run.events, 'submission.lost', delivered.submissionId)[0]?.payload
    ).toEqual({ submissionId: delivered.submissionId, reason: 'teardown' })
    expect(terminalsFor(run.events, held.submissionId)).toEqual(['submission.cancelled'])
    const exitIndex = run.events.findIndex(
      (event) => event.type === 'invocation.exited' || event.type === 'invocation.failed'
    )
    expect(exitIndex).toBeGreaterThanOrEqual(0)
    for (const id of [delivered.submissionId, held.submissionId]) {
      const terminalIndex = run.events.findIndex(
        (event) =>
          SUBMISSION_TERMINAL_TYPES.has(event.type) &&
          (event.payload as { submissionId?: string }).submissionId === id
      )
      expect(terminalIndex).toBeGreaterThanOrEqual(0)
      expect(terminalIndex).toBeLessThan(exitIndex)
    }
  })

  test('teardown leaves already-settled submissions with their single terminal', async () => {
    const run = await setup('inv_teardown_settled')
    const executed = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'runs to completion',
    })
    await flush()
    run.controller.completeActiveTurn()
    await flush()
    const active = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'still running at teardown',
    })
    await flush()

    await run.broker.stop({ invocationId: run.invocationId, reason: 'test teardown' })
    await flush()

    expect(terminalsFor(run.events, executed.submissionId)).toEqual(['submission.executed'])
    // Its own-turn delivery already disposed it; teardown adds nothing.
    expect(terminalsFor(run.events, active.submissionId)).toEqual(['submission.executed'])
    expect(eventsFor(run.events, 'submission.lost')).toHaveLength(0)
  })
})
