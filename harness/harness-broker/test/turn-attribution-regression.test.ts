import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EventProvenance,
  HarnessInvocationSpec,
  InputId,
  InvocationEventEnvelope,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { TestDriverController } from '../src/testing/test-driver'
import { createTestDriver } from '../src/testing/test-driver'

interface RecordedEvent {
  seq: number
  type: InvocationEventType
  inputId: string | null
  turnId: string | null
  payload: Record<string, unknown>
  driver: { kind: string; rawType: string } | null
  provenance: EventProvenance
}

interface PrimingMisattributionFixture {
  source: {
    runtimeId: string
    invocationId: string
    submissionId: string
    envelopeId: string
    recordedAt: string
    note: string
  }
  deliveredContent: string
  events: RecordedEvent[]
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, 'fixtures/priming-turn-misattribution-inv-f3755740.events.json'),
    'utf8'
  )
) as PrimingMisattributionFixture

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const origin = {
  principalRef: 'agent:chief',
  scopeRef: 'chief@hcs:T-07894',
  envelopeId: fixture.source.envelopeId,
}

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

async function setup(invocationId: string, options: Parameters<typeof createTestDriver>[0]) {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver(options)
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event) => events.push(event),
  })
  await broker.start({ spec: spec(invocationId) })
  return { broker, controller, events }
}

function replayDriverRecord(controller: TestDriverController, event: RecordedEvent): void {
  if (event.driver === null) return
  // The durable envelope's top-level inputId is the manager's output. The
  // driver's emitted inputId is preserved in the recorded payload: absent on
  // the foreign priming hook (seq 10), present on the matching transcript row
  // (seq 23). Replaying from payload therefore recreates the pre-manager fact.
  const emittedInputId =
    typeof event.payload['inputId'] === 'string' ? (event.payload['inputId'] as InputId) : undefined
  controller.emitRaw(event.type, event.payload, {
    ...(event.turnId !== null ? { turnId: event.turnId as TurnId } : {}),
    ...(emittedInputId !== undefined ? { inputId: emittedInputId } : {}),
    driver: event.driver,
    provenance: event.provenance,
  })
}

describe('pending submission attribution across foreign turns (T-07915)', () => {
  test('a recorded foreign turn terminal releases the slot and keeps the late evidence', async () => {
    const { broker, controller, events } = await setup(fixture.source.invocationId, {
      bracketMintingMode: 'harness-evidence',
      cancelPendingOwnTurnOnForeignTurn: true,
      suppressTurnStarted: true,
    })

    const admitted = await broker.enqueue({
      invocationId: fixture.source.invocationId,
      origin,
      body: fixture.deliveredContent,
      ttlMs: 1_800_000,
    })
    await flush()
    expect(admitted.submissionId).toBe(fixture.source.submissionId)

    for (const event of fixture.events) replayDriverRecord(controller, event)

    const recordedForeignStart = fixture.events.find((event) => event.seq === 10)
    const recordedMatchingStart = fixture.events.find((event) => event.seq === 23)
    if (recordedForeignStart?.turnId == null || recordedMatchingStart?.turnId == null) {
      throw new Error('recorded turn ids missing from T-07915 fixture')
    }

    const foreignStart = events.find(
      (event) => event.type === 'turn.started' && event.turnId === recordedForeignStart.turnId
    )
    expect(foreignStart?.inputId).toBeUndefined()

    // T-08204 corrected projection: the unrelated turn's terminal settles
    // NOTHING, and the delivery's own later native evidence survives to
    // dispose it exactly once.
    expect(
      events.filter(
        (event) =>
          event.type === 'submission.cancelled' &&
          event.payload.submissionId === admitted.submissionId
      )
    ).toHaveLength(0)
    const deliveredExecutions = events.filter(
      (event) =>
        event.type === 'submission.executed' && event.payload.submissionId === admitted.submissionId
    )
    expect(deliveredExecutions).toHaveLength(1)

    // The foreign turn never claims the body...
    expect(
      await broker.turnManifest({
        invocationId: fixture.source.invocationId,
        turnId: recordedForeignStart.turnId as TurnId,
      })
    ).not.toMatchObject({ submissionIds: expect.arrayContaining([admitted.submissionId]) })
    // ...and the turn that actually ran it does.
    expect(
      await broker.turnManifest({
        invocationId: fixture.source.invocationId,
        turnId: recordedMatchingStart.turnId as TurnId,
      })
    ).toMatchObject({ submissionIds: expect.arrayContaining([admitted.submissionId]) })
  })

  /**
   * T-08204 — the pipelined-cancellation defect, in the exact recorded order.
   *
   * PROVENANCE: transcribed from wrkq comment C-19923, which recorded this
   * window verbatim from the durable ledger of
   * inv-d604db0e-8b54-4c86-96e2-23c80b95b4a6 (native session f0a873b3, runtime
   * bipc 1ad39b1a6611). That runtime's bipc directory has since been reaped, so
   * this is a transcription of the recorded sequence, NOT a mechanical
   * extraction from a surviving ndjson. Sequence numbers, turn ids and the
   * 207.9s wall-clock gap are as recorded:
   *
   *   811 input.accepted       _10                       12:10:38.624
   *   862 submission.cancelled _10 merged-into-foreign-turn (turn _17)
   *                                                      12:14:06.590
   *   867 turn.started         inputId=_10 (turn _16)    12:14:08.105
   *
   * The cancellation at 862 is what this task removes: the terminal of turn
   * _17 says nothing about _10's body, and _10 executed 1.5s later. The
   * defect cascaded — the turn contesting submission N was the turn submission
   * N-1 had started (_10/_11/_12/_13 at 862/875/888/949).
   */
  test('T-08204: an uncorrelated turn terminal neither cancels nor loses the pending input', async () => {
    const invocationId = 'inv-d604db0e-8b54-4c86-96e2-23c80b95b4a6'
    const { broker, controller, events } = await setup(invocationId, {
      bracketMintingMode: 'harness-evidence',
      cancelPendingOwnTurnOnForeignTurn: true,
      suppressTurnStarted: true,
    })

    const admitted = await broker.enqueue({
      invocationId,
      origin,
      body: 'injected body that Claude queued behind a human turn',
    })
    await flush()

    // seq 862's cause: a turn the broker cannot correlate to _10 terminates
    // while _10 is still sitting in Claude's native queue.
    const foreignTurnId = `turn_${invocationId}_17`
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

    // Nothing may be settled by that terminal — no cancellation, and no
    // elapsed-time loss either.
    const settledAtForeignTerminal = events.filter(
      (event) =>
        (event.type === 'submission.cancelled' || event.type === 'submission.lost') &&
        (event.payload as { submissionId?: string }).submissionId === admitted.submissionId
    )
    expect(settledAtForeignTerminal).toHaveLength(0)
    // The seat is free again, so a later input is never blocked.
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })

    // seq 867: Claude dequeues the body and names it. Its own evidence settles
    // it exactly once, and is no longer suppressed by a first guess.
    const ownTurnId = `turn_${invocationId}_16`
    controller.emitRaw(
      'turn.started',
      { turnId: ownTurnId, source: 'hook-observed', inputId: admitted.submissionId },
      { turnId: ownTurnId, inputId: admitted.submissionId }
    )
    controller.emitRaw(
      'submission.executed',
      { submissionId: admitted.submissionId, turnId: ownTurnId },
      { turnId: ownTurnId, inputId: admitted.submissionId }
    )
    await flush()

    expect(
      events.filter(
        (event) =>
          event.type === 'submission.executed' &&
          event.payload.submissionId === admitted.submissionId
      )
    ).toHaveLength(1)
    expect(await broker.turnManifest({ invocationId, turnId: ownTurnId as TurnId })).toMatchObject({
      submissionIds: expect.arrayContaining([admitted.submissionId]),
    })
  })

  test('delivery-acknowledged drivers retain pending-input stamping', async () => {
    let releaseDelivery: (() => void) | undefined
    let markDeliveryEntered: (() => void) | undefined
    const deliveryEntered = new Promise<void>((resolve) => {
      markDeliveryEntered = resolve
    })
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    const invocationId = 'inv_delivery_acknowledged_stamp'
    const { broker, controller, events } = await setup(invocationId, {
      bracketMintingMode: 'delivery-acknowledged',
      suppressTurnStarted: true,
      beforeApplyInput: async () => {
        markDeliveryEntered?.()
        await deliveryGate
      },
    })

    const admitted = await broker.enqueue({ invocationId, origin, body: 'delivery ack input' })
    await deliveryEntered
    controller.emitRaw(
      'turn.started',
      { turnId: 'turn_delivery_acknowledged', source: 'hook-observed' },
      { turnId: 'turn_delivery_acknowledged' as TurnId }
    )

    expect(
      events.find(
        (event) => event.type === 'turn.started' && event.turnId === 'turn_delivery_acknowledged'
      )?.inputId
    ).toBe(admitted.submissionId)

    releaseDelivery?.()
    await flush()
  })
})
