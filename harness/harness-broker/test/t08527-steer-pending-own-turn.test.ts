import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InputId,
  InvocationEventEnvelope,
  InvocationInput,
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
 * T-08527: the whole point of a steer is that it lands mid-turn. A steer to a
 * busy harness is injected immediately — never held for a later moment and
 * never refused `busy`. The pending-own-turn window (a queued delivery handed
 * to the host, whose turn has not been reported yet; ~100 ms live on Arris) is
 * a busy harness.
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
  let releaseDelivery: (() => void) | undefined
  driver.applyInputNow = async (input) => {
    delivered.push(input)
    await new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
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
  }
}

describe('T-08527 a steer to a busy harness is injected immediately', () => {
  test('while a queued delivery awaits its turn, before the host reports it', async () => {
    const { broker, controller, events, invocationId, delivered } =
      await arrisLikeSetup('inv_t08527_pending')

    const queued = await broker.enqueue({ invocationId, origin, body: 'queued turn body' })
    await flush()
    expect(delivered.map((input) => input.inputId)).toEqual([queued.submissionId as InputId])
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })

    const steer = await broker.steer({ invocationId, origin, body: 'single-shot steer' })
    expect(steer.admission).toBe('admitted')
    await flush()

    // Injected now, in the window — not deferred to turn start, not refused.
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      steer.submissionId as InputId,
    ])
    expect(
      events.find(
        (event) =>
          event.type === 'input.accepted' &&
          event.inputId === steer.submissionId &&
          (event.payload as { disposition?: string }).disposition === 'attempted_steer'
      )
    ).toBeDefined()
    expect(events.filter((event) => event.type === 'admission.rejected')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'submission.rejected')).toHaveLength(0)
    // The steer never became a turn of its own: the queued delivery still owns
    // the pending slot.
    expect(delivered).toHaveLength(1)
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })
  })

  test('repeated single-shot steers in the window are all injected', async () => {
    const { broker, controller, invocationId } = await arrisLikeSetup('inv_t08527_repeat')
    await broker.enqueue({ invocationId, origin, body: 'queued' })
    await flush()
    const first = await broker.steer({ invocationId, origin, body: 'first' })
    const second = await broker.steer({ invocationId, origin, body: 'second' })
    await flush()
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      first.submissionId as InputId,
      second.submissionId as InputId,
    ])
  })

  test('exclusive keeps its busy refusal in the same window', async () => {
    const { broker, invocationId } = await arrisLikeSetup('inv_t08527_exclusive')
    await broker.enqueue({ invocationId, origin, body: 'queued' })
    await flush()
    const invoked = await broker.invoke({ invocationId, origin, body: 'exclusive' })
    expect(invoked).toMatchObject({ admission: 'rejected', reason: 'busy' })
  })
})
