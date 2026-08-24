import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

/**
 * T-07155 stage 2 — `whenBusy: 'steer'` busy-input policy.
 *
 * Gates G1, G2, G4, G16, G19 from the approved spec. The point of the policy is
 * that a supervisor order reaches a BUSY worker inside its running turn instead
 * of draining after it, and that it fails typed rather than silently degrading
 * into the deferred tail queue when it cannot.
 */

const now = () => new Date('2026-08-10T15:00:00.000Z')

const testSpec = (
  invocationId: string,
  interaction: HarnessInvocationSpec['interaction']
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction,
  driver: { kind: 'test-driver' },
})

const userInput = (inputId: string, text: string) => ({
  inputId,
  kind: 'user' as const,
  content: [{ type: 'text' as const, text }],
})

const setup = async (
  options: {
    invocationId?: string | undefined
    supportsSteer?: boolean | undefined
    mode?: 'headless' | 'interactive' | undefined
    inputQueue?: 'none' | 'fifo' | undefined
  } = {}
) => {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({ supportsSteer: options.supportsSteer })
  const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })
  const spec = testSpec(options.invocationId ?? 'inv_t07155', {
    mode: options.mode ?? 'headless',
    turnConcurrency: 'single',
    inputQueue: options.inputQueue ?? 'fifo',
  })
  const startResponse = await broker.start({ spec })
  return {
    broker,
    controller,
    events,
    invocationId: spec.invocationId!,
    startResponse,
    capabilities: startResponse.capabilities as InvocationCapabilities,
  }
}

const inputEvents = (events: InvocationEventEnvelope[], type: string) =>
  events.filter((event) => event.type === type)

describe('T-07155 whenBusy: steer', () => {
  // G1 — the headline behaviour: a HEADLESS busy invocation steers rather than
  // queueing. This is the exact case that queued supervisor stop-orders for
  // 62-99 minutes across four incidents.
  test('G1: busy headless invocation with a steer-capable driver applies the input to the active turn', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_t07155_g1',
      supportsSteer: true,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'long running work') })

    const response = await broker.input({
      invocationId,
      input: userInput('input_urgent', 'STOP - do not push'),
      policy: { whenBusy: 'steer' },
    })

    expect(response).toMatchObject({
      inputId: 'input_urgent',
      accepted: true,
      disposition: 'attempted_steer',
    })
    // A steer joins the ACTIVE turn, so it must not mint a turn of its own.
    expect(response.turnId).toBeUndefined()
    // It went to the driver's steer path, not the turn-start path...
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual(['input_urgent'])
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_active'])
    // ...and nothing was parked on the FIFO drain queue.
    expect(inputEvents(events, 'input.queued')).toHaveLength(0)
    expect(inputEvents(events, 'input.accepted').at(-1)).toMatchObject({
      inputId: 'input_urgent',
      payload: { inputId: 'input_urgent', disposition: 'attempted_steer' },
    })
  })

  // G2 — fail closed. The whole design rests on an urgent order never being
  // silently downgraded into a deferred one.
  test('G2: steer against a driver without applySteerNow is rejected, never enqueued', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_t07155_g2',
      supportsSteer: false,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'long running work') })

    const response = await broker.input({
      invocationId,
      input: userInput('input_urgent', 'STOP - do not push'),
      policy: { whenBusy: 'steer' },
    })

    expect(response).toMatchObject({
      inputId: 'input_urgent',
      accepted: false,
      disposition: 'rejected',
      reason: 'steer_not_supported',
    })
    expect(controller.steeredInputs).toHaveLength(0)
    // The critical assertion: NOT parked on the queue as a consolation prize.
    expect(inputEvents(events, 'input.queued')).toHaveLength(0)
    expect(inputEvents(events, 'input.rejected').at(-1)).toMatchObject({
      payload: { inputId: 'input_urgent', reason: 'steer_not_supported' },
    })
  })

  test('G2b: a non-user input kind under steer never reaches the driver steer path', async () => {
    const { broker, controller, invocationId } = await setup({
      invocationId: 'inv_t07155_g2b',
      supportsSteer: true,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'work') })

    // The capability gate for the distinct append_context/steer input KINDS runs
    // ahead of busy-policy dispatch, so this is refused before the policy is
    // consulted. Either way the invariant under test holds: only user input is
    // ever written into an active turn.
    await expect(
      broker.input({
        invocationId,
        input: { ...userInput('input_ctx', 'context'), kind: 'append_context' as const },
        policy: { whenBusy: 'steer' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })
    expect(controller.steeredInputs).toHaveLength(0)
  })

  // G4 — the regression fence. `queue` is the default path every existing
  // caller uses; this change must not perturb it in either interaction mode.
  test('G4: whenBusy queue still enqueues on headless', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_t07155_g4_headless',
      supportsSteer: true,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'work') })

    const response = await broker.input({
      invocationId,
      input: userInput('input_queued', 'follow up'),
      policy: { whenBusy: 'queue' },
    })

    expect(response).toMatchObject({ accepted: true, disposition: 'queued' })
    expect(controller.steeredInputs).toHaveLength(0)
    expect(inputEvents(events, 'input.queued')).toHaveLength(1)
  })

  test('G4b: whenBusy queue still write-through steers on interactive', async () => {
    const { broker, controller, invocationId } = await setup({
      invocationId: 'inv_t07155_g4_interactive',
      supportsSteer: true,
      mode: 'interactive',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'work') })

    const response = await broker.input({
      invocationId,
      input: userInput('input_steered', 'steer'),
      policy: { whenBusy: 'queue' },
    })

    expect(response).toMatchObject({ accepted: true, disposition: 'attempted_steer' })
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual(['input_steered'])
  })

  // G19 — the negotiation signal HRC gates on. A long-lived broker process
  // survives HRC restarts, so the client must be able to ask THIS process what
  // it can do rather than assume an installed upgrade reached it.
  test('G19: busyPolicies advertises steer iff the driver implements applySteerNow', async () => {
    const capable = await setup({ invocationId: 'inv_t07155_g19_yes', supportsSteer: true })
    expect(capable.capabilities.input.busyPolicies).toEqual(['reject', 'queue', 'steer'])

    const incapable = await setup({ invocationId: 'inv_t07155_g19_no', supportsSteer: false })
    expect(incapable.capabilities.input.busyPolicies).toEqual(['reject', 'queue'])
  })

  // G16 — the C-14234 correction, fenced. `input.steer` governs the distinct
  // kind:'steer' input and is NOT the busy-steer signal; this work must not
  // quietly redefine it.
  test('G16: input.steer capability is unchanged and still governs kind:steer', async () => {
    const { broker, capabilities, invocationId } = await setup({
      invocationId: 'inv_t07155_g16',
      supportsSteer: true,
    })
    expect(capabilities.input.steer).toBe(false)

    await broker.input({ invocationId, input: userInput('input_active', 'work') })
    await expect(
      broker.input({
        invocationId,
        input: { ...userInput('input_kind_steer', 'x'), kind: 'steer' as const },
        policy: { whenBusy: 'steer' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })
  })

  // An idle invocation is not the steer path's business: the manager applies
  // input immediately and the policy never runs.
  test('idle invocation under steer policy starts a normal turn', async () => {
    const { broker, controller, invocationId } = await setup({
      invocationId: 'inv_t07155_idle',
      supportsSteer: true,
    })

    const response = await broker.input({
      invocationId,
      input: userInput('input_first', 'hello'),
      policy: { whenBusy: 'steer' },
    })

    expect(response).toMatchObject({ accepted: true, disposition: 'started' })
    expect(controller.steeredInputs).toHaveLength(0)
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_first'])
  })
})
