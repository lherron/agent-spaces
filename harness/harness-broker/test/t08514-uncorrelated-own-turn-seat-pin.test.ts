import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const origin: SubmissionOrigin = { principalRef: 'agent:test', scopeRef: 'test@mobile' }

const spec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: { kind: 'test-driver' },
})

/**
 * T-08514: a queued own-turn delivery whose turn is never correlated back to it
 * must not pin the seat.
 *
 * Recorded shape (`astra@hrc-runtime:primary`, 2026-09-15, 84 minutes of total
 * mail loss): `codex-app-server` in TUI mode routes an enqueue to
 * `applyQueuedInput`, which awaits an attribution waiter that only resolves on
 * `ownership: own`. The turn carrying the body was attributed
 * `foreign`/`autonomous` 3ms after `turn.started`, so the waiter never resolved
 * and `applyInputNow` never returned — leaving `pendingOwnTurnSubmissionId` set
 * with neither its success path (`submission.executed`) nor its `catch` able to
 * clear it. `seatProbe` then reports `starting` for a `ready` invocation
 * forever, and `seatCanDispatch` accepts only `idle`/`absent`.
 *
 * The driver here declares NEITHER `cancelPendingOwnTurnOnForeignTurn` nor
 * `failPendingOwnTurnOnForeignTurn` and mints brackets as `observed`, exactly
 * like `codex-app-server`. Both existing recovery paths are gated on a
 * contesting turn id that such a driver never records, so a terminal turn is
 * the only boundary left that can release the seat.
 */
describe('T-08514 uncorrelated own-turn delivery must not pin the seat', () => {
  test('a terminal turn releases the slot when no contest was ever recorded', async () => {
    const events: InvocationEventEnvelope[] = []
    let releaseApplyInput: (() => void) | undefined
    const applyInputReached = new Promise<void>((resolve) => {
      releaseApplyInput = resolve
    })
    const { driver, controller } = createTestDriver({
      bracketMintingMode: 'observed',
      // Model the un-returning `applyQueuedInput`: the broker has handed the
      // body to the harness and is awaiting turn-start evidence that never
      // correlates. Deliberately never resolves, so neither the success path
      // nor the catch in applyAndEmit can clear the pending marker.
      beforeApplyInput: async () => {
        releaseApplyInput?.()
        await new Promise<never>(() => {})
      },
    })
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
    const invocationId = 'inv_t08514_seat_pin'
    await broker.start({ spec: spec(invocationId) })

    const submission = await broker.enqueue({
      invocationId,
      origin,
      body: 'mable 19:5xZ ACP consuming validation',
    })
    await applyInputReached
    await flush()

    // The seat is legitimately non-dispatchable while turn-start evidence may
    // still arrive: this is the double-dispatch guard doing its job.
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })

    // An observed turn runs and completes without ever correlating to the
    // submission — `turn.started` carries no inputId, and `source: 'observed'`
    // means observePendingOwnTurnStart is never consulted at all.
    const turnId = '01a0a672-432f-7080-8682-bf339b26eb7e' as const
    controller.emitRaw('turn.started', { turnId, source: 'observed' }, { turnId })
    await flush()
    controller.emitRaw('turn.completed', { turnId, status: 'completed' }, { turnId })
    await flush()

    // The terminal is the hard boundary: evidence correlating this submission
    // can no longer arrive on this turn, so the seat must accept mail again.
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })

    // Releasing the admission slot is INDEPENDENT of settling the input
    // (T-08204). The body may still execute on a later turn, so the submission
    // stays undisposed rather than being failed or marked lost.
    const disposition = events.find(
      (event) =>
        (event.type === 'submission.lost' ||
          event.type === 'submission.executed' ||
          event.type === 'submission.rejected') &&
        (event.payload as { submissionId?: string }).submissionId === submission.submissionId
    )
    expect(disposition).toBeUndefined()
    expect(events.some((event) => event.type === 'invocation.failed')).toBe(false)
  })
})
