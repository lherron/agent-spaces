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

const pendingInputFixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, 'fixtures/pending-input-cancelled-inv-d604db0e.events.json'),
    'utf8'
  )
) as PrimingMisattributionFixture & {
  source: PrimingMisattributionFixture['source'] & {
    foreignTurnId: string
    ownTurnId: string
  }
}

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
   * T-08204 — the pipelined-cancellation defect, replayed from the recording.
   *
   * PROVENANCE: `pending-input-cancelled-inv-d604db0e.events.json`, mechanically
   * extracted from the HRC-RETAINED broker envelopes for
   * inv-d604db0e-8b54-4c86-96e2-23c80b95b4a6 (Astra's read-only export of
   * broker_invocation_events, 1136 rows). These are HRC-retained projections —
   * the broker raw capture directory var/run/hrc/bipc/1ad39b1a6611 was reaped
   * on 2026-09-07 and no longer exists.
   *
   * Recorded broker window (fixture.recordedWindow, audit only):
   *   808-811  _10 admitted, enqueued, applied            12:10:38.624
   *   812      turn _17 starts, source hook-observed, NO inputId
   *   813-814  turn _17 executes the HUMAN's own submission and its user row
   *   861      turn _17 completes
   *   862      _10 cancelled 'merged-into-foreign-turn'   12:14:06.590  <-- DEFECT
   *   867      turn _16 starts naming _10                 12:14:08.105
   *   868      turn _16 carries the _10 body
   *
   * Native corroboration: the Claude session JSONL (f0a873b3-native-claude.jsonl)
   * records the _10 body as a `user` row at 12:14:08.040Z — 1.45s AFTER the
   * broker had already declared it cancelled, and 65ms before seq 867. The body
   * was never lost; it sat in Claude's queue for 207.9s while an unrelated human
   * turn ran, then executed.
   *
   * Only the DRIVER-emitted rows are replayed. Seq 862 is broker output, not
   * driver input, so its absence from the replayed stream is the point: with the
   * inferred cancellation removed, nothing settles _10 at turn _17's terminal and
   * its own later evidence disposes it exactly once.
   */
  test('T-08204: the recorded foreign turn neither cancels nor loses the pending input', async () => {
    const { broker, controller, events } = await setup(pendingInputFixture.source.invocationId, {
      bracketMintingMode: 'harness-evidence',
      cancelPendingOwnTurnOnForeignTurn: true,
      suppressTurnStarted: true,
    })

    const admitted = await broker.enqueue({
      invocationId: pendingInputFixture.source.invocationId,
      origin,
      body: pendingInputFixture.deliveredContent,
    })
    await flush()

    // The recording is the 10th submission of a long-lived invocation; a fresh
    // broker mints _1. Map the recorded identity onto the minted one so the
    // replayed native evidence names the submission actually under test. Only
    // the id is substituted — ordering, types, turn ids and bodies are verbatim.
    const recordedId = pendingInputFixture.source.submissionId
    const remap = (value: string | null | undefined): string | null | undefined =>
      value === recordedId ? admitted.submissionId : value
    for (const event of pendingInputFixture.events) {
      const payload = event.payload as Record<string, unknown>
      replayDriverRecord(controller, {
        ...event,
        inputId: remap(event.inputId) ?? null,
        payload: {
          ...payload,
          ...(typeof payload['inputId'] === 'string'
            ? { inputId: remap(payload['inputId'] as string) }
            : {}),
          ...(typeof payload['submissionId'] === 'string'
            ? { submissionId: remap(payload['submissionId'] as string) }
            : {}),
        },
      })
    }
    await flush()

    // The unrelated human turn ran its OWN submission and settled nothing of ours.
    const foreignStart = events.find(
      (event) =>
        event.type === 'turn.started' && event.turnId === pendingInputFixture.source.foreignTurnId
    )
    expect(foreignStart?.inputId).toBeUndefined()
    expect(
      events.filter(
        (event) =>
          (event.type === 'submission.cancelled' || event.type === 'submission.lost') &&
          (event.payload as { submissionId?: string }).submissionId === admitted.submissionId
      )
    ).toHaveLength(0)

    // _10's own native evidence disposes it exactly once, on its own turn.
    expect(
      events.filter(
        (event) =>
          event.type === 'submission.executed' &&
          event.payload.submissionId === admitted.submissionId
      )
    ).toHaveLength(1)
    expect(
      await broker.turnManifest({
        invocationId: pendingInputFixture.source.invocationId,
        turnId: pendingInputFixture.source.ownTurnId as TurnId,
      })
    ).toMatchObject({ submissionIds: expect.arrayContaining([admitted.submissionId]) })
    expect(
      await broker.turnManifest({
        invocationId: pendingInputFixture.source.invocationId,
        turnId: pendingInputFixture.source.foreignTurnId as TurnId,
      })
    ).not.toMatchObject({ submissionIds: expect.arrayContaining([admitted.submissionId]) })
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
