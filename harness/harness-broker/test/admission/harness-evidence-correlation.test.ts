import { describe, expect, test } from 'bun:test'
import {
  codexPromptCorrelation,
  eventsFor,
  eventsForSubmission,
  flush,
  origin,
  setup,
} from './fixture'

describe('broker admission API: harness-evidence delivery correlation', () => {
  test('harness-evidence delivery reserves the seat until each observed turn starts', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_evidence_fifo',
      { bracketMintingMode: 'harness-evidence', suppressTurnStarted: true }
    )

    const queued = await Promise.all(
      ['one', 'two', 'three'].map((body) => broker.enqueue({ invocationId, origin, body }))
    )
    await flush()

    expect(controller.inputs).toHaveLength(1)
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })
    expect((await broker.queueList({ invocationId })).entries).toHaveLength(2)

    for (let index = 0; index < queued.length; index += 1) {
      expect(controller.activeInput?.inputId).toBe(queued[index]?.submissionId)
      controller.observeActiveTurnStart()
      await flush()
      controller.completeActiveTurn()
      await flush()
    }

    expect(controller.inputs.map((input) => input.inputId)).toEqual(
      queued.map((submission) => submission.submissionId)
    )
    expect(eventsFor(events, 'submission.executed')).toHaveLength(3)
  })

  test('a foreign turn terminal releases the slot without settling the input', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_evidence_foreign_turn',
      {
        bracketMintingMode: 'harness-evidence',
        cancelPendingOwnTurnOnForeignTurn: true,
        suppressTurnStarted: true,
      }
    )

    const pending = await broker.invoke({ invocationId, origin, body: 'broker delivery' })
    await flush()
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })

    const foreignTurnId = 'turn_foreign' as const
    controller.emitRaw(
      'turn.started',
      { turnId: foreignTurnId, source: 'hook-observed' },
      { turnId: foreignTurnId }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: foreignTurnId, status: 'completed', finalOutput: 'human turn complete' },
      { turnId: foreignTurnId }
    )
    await flush()

    // T-08204: the terminal of an uncorrelated turn is evidence about THAT
    // turn, never about our body. Claude queues an injected input while a turn
    // runs and executes it later, so nothing may be settled here.
    expect(eventsForSubmission(events, 'submission.cancelled', pending.submissionId)).toHaveLength(
      0
    )
    expect(eventsForSubmission(events, 'submission.lost', pending.submissionId)).toHaveLength(0)
    // The admission slot IS released, so the seat keeps accepting input.
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })

    // ...and the still-undisposed input can be settled by its own later
    // native evidence.
    controller.emitRaw(
      'submission.executed',
      { submissionId: pending.submissionId, turnId: 'turn_own' },
      { turnId: 'turn_own', inputId: pending.submissionId }
    )
    await flush()
    expect(eventsForSubmission(events, 'submission.executed', pending.submissionId)).toHaveLength(1)
  })

  test('non-Claude harness evidence may correlate after an unowned turn terminal', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_non_claude_late_evidence',
      {
        bracketMintingMode: 'harness-evidence',
        suppressTurnStarted: true,
      }
    )

    const pending = await broker.invoke({ invocationId, origin, body: 'codex delivery' })
    await flush()
    controller.emitRaw(
      'turn.started',
      { turnId: 'turn_unowned', source: 'hook-observed' },
      { turnId: 'turn_unowned' }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: 'turn_unowned', status: 'completed' },
      { turnId: 'turn_unowned' }
    )
    await flush()

    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })
    expect(
      eventsFor(events, 'submission.cancelled').some(
        (event) => event.payload.submissionId === pending.submissionId
      )
    ).toBe(false)

    controller.observeActiveTurnStart()
    controller.completeActiveTurn()
    await flush()
    expect(
      eventsFor(events, 'submission.executed').some(
        (event) => event.payload.submissionId === pending.submissionId
      )
    ).toBe(true)
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })
  })

  test('Codex prompt evidence correlates and drains consecutive submissions FIFO', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_codex_prompt_correlation',
      {
        bracketMintingMode: 'harness-evidence',
        suppressTurnStarted: true,
        failPendingOwnTurnOnForeignTurn: true,
        correlatePendingOwnTurnStart: codexPromptCorrelation,
      }
    )

    const first = await broker.enqueue({ invocationId, origin, body: 'first codex prompt' })
    const second = await broker.enqueue({ invocationId, origin, body: 'second codex prompt' })
    await flush()
    expect(controller.inputs).toHaveLength(1)

    const firstTurn = 'turn_codex_first' as const
    controller.emitRaw(
      'turn.started',
      { turnId: firstTurn, source: 'hook-observed', prompt: 'first codex prompt' },
      { turnId: firstTurn }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: firstTurn, status: 'completed', finalOutput: 'first done' },
      { turnId: firstTurn }
    )
    await flush()

    expect(controller.inputs).toHaveLength(2)
    const secondTurn = 'turn_codex_second' as const
    controller.emitRaw(
      'turn.started',
      { turnId: secondTurn, source: 'hook-observed', prompt: 'second codex prompt' },
      { turnId: secondTurn }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: secondTurn, status: 'completed', finalOutput: 'second done' },
      { turnId: secondTurn }
    )
    await flush()

    expect(eventsFor(events, 'turn.started').map((event) => [event.turnId, event.inputId])).toEqual(
      [
        [firstTurn, first.submissionId],
        [secondTurn, second.submissionId],
      ]
    )
    expect(eventsFor(events, 'submission.executed').map((event) => event.payload)).toEqual([
      { submissionId: first.submissionId, turnId: firstTurn },
      { submissionId: second.submissionId, turnId: secondTurn },
    ])
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })
  })

  test('Codex unmatched terminal loses the submission and fails without same-seat drain', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_codex_correlation_lost',
      {
        bracketMintingMode: 'harness-evidence',
        suppressTurnStarted: true,
        failPendingOwnTurnOnForeignTurn: true,
        correlatePendingOwnTurnStart: codexPromptCorrelation,
      }
    )

    const pending = await broker.enqueue({ invocationId, origin, body: 'broker delivery' })
    const held = await broker.enqueue({ invocationId, origin, body: 'must use a fresh seat' })
    await flush()
    const foreignTurn = 'turn_codex_foreign' as const
    controller.emitRaw(
      'turn.started',
      { turnId: foreignTurn, source: 'hook-observed', prompt: 'operator prompt' },
      { turnId: foreignTurn }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: foreignTurn, status: 'completed', finalOutput: 'operator done' },
      { turnId: foreignTurn }
    )
    await flush()

    expect(controller.inputs).toHaveLength(1)
    expect(eventsFor(events, 'submission.lost')).toHaveLength(1)
    expect(eventsFor(events, 'submission.lost')[0]).toMatchObject({
      turnId: foreignTurn,
      inputId: pending.submissionId,
      payload: { submissionId: pending.submissionId, reason: 'turn-correlation-lost' },
    })
    expect(eventsFor(events, 'invocation.failed')).toHaveLength(1)
    expect(eventsFor(events, 'invocation.failed')[0]?.payload).toMatchObject({
      code: 'submission_correlation_lost',
      reason: 'submission-correlation-lost',
      retryable: false,
    })
    expect(
      eventsFor(events, 'submission.cancelled').some(
        (event) => event.payload.submissionId === held.submissionId
      )
    ).toBe(true)
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'terminal' })
  })
})
