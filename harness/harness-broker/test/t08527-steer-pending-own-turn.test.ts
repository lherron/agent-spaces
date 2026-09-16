import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InputId,
  InvocationEventEnvelope,
  InvocationInput,
  SubmissionOrigin,
  TurnId,
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
 * T-08527: steer is best effort. A steer that arrives after a queued delivery
 * was handed to the host but before the host reports its turn (the
 * pending-own-turn window, ~100 ms live on Arris) must be held and applied in
 * that turn — never refused `busy`.
 *
 * The driver models arris-resident: observed brackets, strict steer semantics,
 * a queue write that returns a receipt without a turn id, and execution
 * confirmed on own attribution.
 */
async function arrisLikeSetup(invocationId: string) {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({
    bracketMintingMode: 'observed',
    admissionClasses: ['queue', 'steer', 'exclusive'],
    supportsSteer: true,
  })
  Object.defineProperty(driver, 'steerNeverStartsTurn', { value: true })
  Object.defineProperty(driver, 'confirmsSubmissionExecutionOnOwnAttribution', { value: true })
  const delivered: InvocationInput[] = []
  let failNextDelivery: Error | undefined
  let releaseDelivery: (() => void) | undefined
  driver.applyInputNow = async (input) => {
    delivered.push(input)
    await new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    if (failNextDelivery !== undefined) throw failNextDelivery
    return {}
  }
  const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
  await broker.start({ spec: spec(invocationId) })
  return {
    broker,
    controller,
    events,
    invocationId,
    delivered,
    releaseDelivery: () => releaseDelivery?.(),
    failDelivery: (error: Error) => {
      failNextDelivery = error
      releaseDelivery?.()
    },
    hostTurnStarted(turnId: TurnId, inputId?: InputId) {
      controller.emitRaw(
        'turn.started',
        { turnId, source: 'observed', ...(inputId !== undefined ? { inputId } : {}) },
        { turnId, ...(inputId !== undefined ? { inputId } : {}) }
      )
      controller.emitRaw(
        'turn.attributed',
        inputId !== undefined
          ? { turnId, ownership: 'own', origin: 'broker', inputId }
          : { turnId, ownership: 'foreign', origin: 'autonomous' },
        { turnId, ...(inputId !== undefined ? { inputId } : {}) }
      )
    },
  }
}

const bySubmission = (events: InvocationEventEnvelope[], submissionId: string) =>
  events.filter(
    (event) =>
      (event.payload as { submissionId?: string; inputId?: string } | undefined)?.submissionId ===
        submissionId ||
      (event.payload as { inputId?: string } | undefined)?.inputId === submissionId
  )

describe('T-08527 steer during the pending-own-turn window', () => {
  test('is admitted, held, and applied in the pending turn once it attributes', async () => {
    const run = await arrisLikeSetup('inv_t08527_hold')
    const { broker, controller, events, invocationId } = run

    const queued = await broker.enqueue({ invocationId, origin, body: 'queued turn body' })
    await flush()
    expect(run.delivered.map((input) => input.inputId)).toEqual([queued.submissionId])
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })

    const steer = await broker.steer({ invocationId, origin, body: 'single-shot steer' })
    expect(steer.admission).toBe('admitted')
    await flush()
    // Held: nothing reaches the host before the pending turn exists.
    expect(controller.steeredInputs).toHaveLength(0)
    expect(
      events.some(
        (event) =>
          event.type === 'diagnostic' &&
          (event.payload as { kind?: string }).kind === 'steer_held_for_pending_own_turn'
      )
    ).toBe(true)

    run.releaseDelivery()
    await flush()
    expect(controller.steeredInputs).toHaveLength(0)

    const turnId = 'turn_t08527_pending' as TurnId
    run.hostTurnStarted(turnId, queued.submissionId as InputId)
    await flush()

    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      steer.submissionId as InputId,
    ])
    // Ordering: the queued delivery's turn started and executed before the
    // held steer was attempted, and the steer targeted that same turn.
    const seqOf = (predicate: (event: InvocationEventEnvelope) => boolean) =>
      events.find(predicate)?.seq ?? Number.POSITIVE_INFINITY
    const started = seqOf((event) => event.type === 'turn.started' && event.turnId === turnId)
    const executed = seqOf(
      (event) =>
        event.type === 'submission.executed' &&
        (event.payload as { submissionId: string }).submissionId === queued.submissionId
    )
    const steerAccepted = seqOf(
      (event) =>
        event.type === 'input.accepted' &&
        event.inputId === steer.submissionId &&
        (event.payload as { disposition?: string }).disposition === 'attempted_steer'
    )
    expect(started).toBeLessThan(executed)
    expect(executed).toBeLessThan(steerAccepted)
    expect(steerAccepted).toBeLessThan(Number.POSITIVE_INFINITY)
    expect((await broker.seatProbe({ invocationId })).seat).toMatchObject({
      state: 'turn-active',
      turnId,
    })
    expect(events.filter((event) => event.type === 'admission.rejected')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'submission.rejected')).toHaveLength(0)
  })

  test('several held steers land in arrival order', async () => {
    const run = await arrisLikeSetup('inv_t08527_fifo')
    const { broker, controller, invocationId } = run
    const queued = await broker.enqueue({ invocationId, origin, body: 'queued' })
    await flush()
    const first = await broker.steer({ invocationId, origin, body: 'first' })
    const second = await broker.steer({ invocationId, origin, body: 'second' })
    run.releaseDelivery()
    await flush()
    run.hostTurnStarted('turn_t08527_fifo' as TurnId, queued.submissionId as InputId)
    await flush()
    await flush()
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      first.submissionId as InputId,
      second.submissionId as InputId,
    ])
  })

  test('is rejected busy, naming the cause, when the pending delivery fails', async () => {
    const run = await arrisLikeSetup('inv_t08527_delivery_failed')
    const { broker, controller, events, invocationId } = run
    const queued = await broker.enqueue({ invocationId, origin, body: 'will fail' })
    await flush()
    const steer = await broker.steer({ invocationId, origin, body: 'orphaned steer' })
    expect(steer.admission).toBe('admitted')
    run.failDelivery(Object.assign(new Error('host refused'), { deliveryEvidence: 'not_written' }))
    await flush()
    await flush()

    expect(controller.steeredInputs).toHaveLength(0)
    expect(bySubmission(events, steer.submissionId).map((event) => event.type)).toContain(
      'submission.rejected'
    )
    expect(
      events.find(
        (event) =>
          event.type === 'submission.rejected' &&
          (event.payload as { submissionId: string }).submissionId === steer.submissionId
      )?.payload
    ).toMatchObject({ reason: 'busy:pending-turn-delivery-failed' })
    expect(queued.admission).toBe('admitted')
  })

  test('is rejected busy when the pending delivery is released uncorrelated (T-08514 shape)', async () => {
    const run = await arrisLikeSetup('inv_t08527_uncorrelated')
    const { broker, controller, events, invocationId } = run
    await broker.enqueue({ invocationId, origin, body: 'never correlates' })
    await flush()
    const steer = await broker.steer({ invocationId, origin, body: 'orphaned steer' })
    run.releaseDelivery()
    await flush()

    const foreign = 'turn_t08527_foreign' as TurnId
    run.hostTurnStarted(foreign)
    await flush()
    expect(controller.steeredInputs).toHaveLength(0)
    controller.emitRaw(
      'turn.completed',
      { turnId: foreign, status: 'completed' },
      { turnId: foreign }
    )
    await flush()

    expect(controller.steeredInputs).toHaveLength(0)
    expect(
      events.find(
        (event) =>
          event.type === 'submission.rejected' &&
          (event.payload as { submissionId: string }).submissionId === steer.submissionId
      )?.payload
    ).toMatchObject({ reason: 'busy:pending-turn-uncorrelated' })
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })
  })

  test('a held steer can be withdrawn before it lands', async () => {
    const run = await arrisLikeSetup('inv_t08527_withdraw')
    const { broker, controller, invocationId } = run
    const queued = await broker.enqueue({ invocationId, origin, body: 'queued' })
    await flush()
    const steer = await broker.steer({ invocationId, origin, body: 'changed my mind' })
    expect(await broker.withdraw({ submissionId: steer.submissionId, reason: 'operator' })).toEqual(
      { outcome: 'withdrawn' }
    )
    run.releaseDelivery()
    await flush()
    run.hostTurnStarted('turn_t08527_withdraw' as TurnId, queued.submissionId as InputId)
    await flush()
    expect(controller.steeredInputs).toHaveLength(0)
  })

  test('exclusive keeps its busy refusal in the same window', async () => {
    const run = await arrisLikeSetup('inv_t08527_exclusive')
    const { broker, invocationId } = run
    await broker.enqueue({ invocationId, origin, body: 'queued' })
    await flush()
    const invoked = await broker.invoke({ invocationId, origin, body: 'exclusive' })
    expect(invoked).toMatchObject({ admission: 'rejected', reason: 'busy' })
  })
})
