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
  test('recorded priming turn stays foreign until matching transcript evidence arrives', async () => {
    const { broker, controller, events } = await setup(fixture.source.invocationId, {
      bracketMintingMode: 'harness-evidence',
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

    const deliveredExecutions = events.filter(
      (event) =>
        event.type === 'submission.executed' && event.payload.submissionId === admitted.submissionId
    )
    expect(deliveredExecutions).toHaveLength(1)
    expect(deliveredExecutions[0]).toMatchObject({
      inputId: admitted.submissionId,
      turnId: recordedMatchingStart.turnId,
      payload: {
        submissionId: admitted.submissionId,
        turnId: recordedMatchingStart.turnId,
      },
    })

    expect(
      await broker.turnManifest({
        invocationId: fixture.source.invocationId,
        turnId: recordedForeignStart.turnId as TurnId,
      })
    ).not.toMatchObject({ submissionIds: expect.arrayContaining([admitted.submissionId]) })
    expect(
      await broker.turnManifest({
        invocationId: fixture.source.invocationId,
        turnId: recordedMatchingStart.turnId as TurnId,
      })
    ).toMatchObject({ submissionIds: [admitted.submissionId] })
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
