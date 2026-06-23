import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

const now = () => new Date('2026-05-21T19:30:00.000Z')

// Drain is intentionally microtask-scheduled by the broker queue implementation.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

const testSpec = (
  overrides: Partial<HarnessInvocationSpec> = {},
  interaction: HarnessInvocationSpec['interaction'] = {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  }
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: 'inv_input_queue',
  harness: {
    frontend: 'test',
    provider: 'test',
    driver: 'test-driver',
  },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction,
  driver: {
    kind: 'test-driver',
  },
  ...overrides,
})

const userInput = (inputId: string | undefined, text: string): InvocationInput => ({
  ...(inputId === undefined ? {} : { inputId }),
  kind: 'user',
  content: [{ type: 'text', text }],
})

const nonUserInput = (kind: 'steer' | 'append_context', inputId: string): InvocationInput => ({
  inputId,
  kind,
  content: [{ type: 'text', text: kind }],
})

const eventPayload = <T extends Record<string, unknown>>(event: InvocationEventEnvelope): T =>
  event.payload as T

const inputEvents = (events: InvocationEventEnvelope[], type: InvocationEventEnvelope['type']) =>
  events.filter((event) => event.type === type)

const structuredResponse = (schema: Record<string, unknown>) =>
  ({
    kind: 'json_schema',
    schema,
  }) as unknown

const textResponse = () =>
  ({
    kind: 'text',
  }) as unknown

const setup = async (
  options: {
    invocationId?: string | undefined
    inputQueue?: 'fifo' | 'none' | undefined
    interactionMode?: 'headless' | 'interactive' | undefined
    inputCapabilities?: Partial<InvocationCapabilities['input']> | undefined
    finalResponseCapabilities?:
      | {
          jsonSchema: boolean
          perTurn: boolean
          strict: boolean
          parsedResult: boolean
        }
      | undefined
    maxInputQueueDepth?: number | undefined
    failInputIds?: string[] | undefined
    supportsSteer?: boolean | undefined
  } = {}
) => {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({
    failInputIds: options.failInputIds,
    inputCapabilities: options.inputCapabilities,
    supportsSteer: options.supportsSteer,
  })
  if (options.finalResponseCapabilities !== undefined) {
    const originalCapabilities = driver.capabilities.bind(driver)
    driver.capabilities = () =>
      ({
        ...originalCapabilities(),
        finalResponse: options.finalResponseCapabilities,
      }) as InvocationCapabilities
  }
  const brokerOptions: Parameters<typeof createBroker>[0] & {
    maxInputQueueDepth?: number | undefined
  } = {
    drivers: [driver],
    onEvent: (event) => events.push(event),
    now,
  }
  if (options.maxInputQueueDepth !== undefined) {
    brokerOptions.maxInputQueueDepth = options.maxInputQueueDepth
  }
  const broker = createBroker(brokerOptions)
  const spec = testSpec(
    { invocationId: options.invocationId ?? 'inv_input_queue' },
    {
      mode: options.interactionMode ?? 'headless',
      turnConcurrency: 'single',
      inputQueue: options.inputQueue ?? 'fifo',
    }
  )

  const startResponse = await broker.start({ spec })

  return { broker, controller, driver, events, invocationId: spec.invocationId!, startResponse }
}

describe('broker-owned FIFO input queue', () => {
  test('start and status compose queue capability from driver capability and FIFO spec', async () => {
    const { broker, driver, invocationId, startResponse } = await setup({
      invocationId: 'inv_queue_capability_composed',
    })

    expect(driver.capabilities().input.queue).toBe(true)
    expect(startResponse.capabilities.input.queue).toBe(true)
    await expect(broker.status({ invocationId })).resolves.toMatchObject({
      capabilities: { input: { queue: true } },
    })
  })

  test('queue composition keeps user input as a capability dependency', async () => {
    const { driver, startResponse } = await setup({
      invocationId: 'inv_queue_requires_user_capability',
      inputCapabilities: {
        user: false,
        queue: true,
      },
    })

    expect(driver.capabilities().input).toMatchObject({ user: false, queue: true })
    expect(startResponse.capabilities.input.queue).toBe(false)
  })

  test('ready user input starts immediately without input.queued', async () => {
    const { broker, events, invocationId } = await setup({ invocationId: 'inv_queue_ready_user' })

    await expect(
      broker.input({ invocationId, input: userInput('input_ready', 'start now') })
    ).resolves.toMatchObject({
      inputId: 'input_ready',
      accepted: true,
      disposition: 'started',
    })

    expect(inputEvents(events, 'input.queued')).toHaveLength(0)
  })

  test('JSON Schema response format is rejected before input.accepted when driver lacks support', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_structured_response_unsupported_input',
    })

    await expect(
      broker.input({
        invocationId,
        input: {
          ...userInput('input_schema_unsupported', 'return json'),
          responseFormat: structuredResponse({
            type: 'object',
            properties: { ok: { type: 'boolean' } },
          }),
        } as InvocationInput,
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })

    expect(inputEvents(events, 'input.accepted')).toHaveLength(0)
    expect(inputEvents(events, 'input.rejected').at(-1)).toMatchObject({
      inputId: 'input_schema_unsupported',
      payload: {
        inputId: 'input_schema_unsupported',
        reason: 'UnsupportedCapability: finalResponse.jsonSchema',
      },
    })
    expect(controller.inputs).toHaveLength(0)
  })

  test('JSON Schema initialInput is rejected before input.accepted when driver lacks support', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver()
    const broker = createBroker({
      drivers: [driver],
      onEvent: (event) => events.push(event),
      now,
    })

    await expect(
      broker.start({
        spec: testSpec({ invocationId: 'inv_structured_response_unsupported_initial' }),
        initialInput: {
          ...userInput('input_initial_schema_unsupported', 'return json'),
          responseFormat: structuredResponse({
            type: 'object',
            properties: { ok: { type: 'boolean' } },
          }),
        } as InvocationInput,
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })

    expect(inputEvents(events, 'input.accepted')).toHaveLength(0)
    expect(inputEvents(events, 'input.rejected')).toHaveLength(0)
    expect(controller.inputs).toHaveLength(0)
  })

  test('inputId idempotency fingerprints normalized responseFormat', async () => {
    const { broker, controller, invocationId } = await setup({
      invocationId: 'inv_structured_response_idempotency',
      finalResponseCapabilities: {
        jsonSchema: true,
        perTurn: true,
        strict: true,
        parsedResult: false,
      },
    })
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' }, count: { type: 'number' } },
      required: ['status', 'count'],
    }
    const reorderedSchema = {
      required: ['status', 'count'],
      properties: { count: { type: 'number' }, status: { type: 'string' } },
      additionalProperties: false,
      type: 'object',
    }

    const first = await broker.input({
      invocationId,
      input: {
        ...userInput('input_schema_replay', 'return json'),
        responseFormat: structuredResponse(schema),
      } as InvocationInput,
    })
    const replay = await broker.input({
      invocationId,
      input: {
        ...userInput('input_schema_replay', 'return json'),
        responseFormat: structuredResponse(reorderedSchema),
      } as InvocationInput,
    })
    const text = await broker.input({
      invocationId,
      input: {
        ...userInput('input_text_replay', 'return plain text'),
        responseFormat: textResponse(),
      } as InvocationInput,
      policy: { whenBusy: 'queue' },
    })
    const omitted = await broker.input({
      invocationId,
      input: userInput('input_text_replay', 'return plain text'),
      policy: { whenBusy: 'queue' },
    })

    expect(replay).toEqual(first)
    expect(omitted).toEqual(text)
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_schema_replay'])

    await expect(
      broker.input({
        invocationId,
        input: {
          ...userInput('input_schema_replay', 'return json'),
          responseFormat: structuredResponse({
            type: 'object',
            properties: { different: { type: 'boolean' } },
          }),
        } as InvocationInput,
      })
    ).rejects.toThrow('responseFormat')
  })

  test('turn_active user input with whenBusy reject rejects and emits input.rejected with original inputId', async () => {
    const { broker, events, invocationId } = await setup({ invocationId: 'inv_queue_reject' })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    await expect(
      broker.input({
        invocationId,
        input: userInput('input_rejected_original', 'reject while busy'),
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.InputRejected })

    expect(inputEvents(events, 'input.rejected').at(-1)).toMatchObject({
      inputId: 'input_rejected_original',
      payload: { inputId: 'input_rejected_original' },
    })
  })

  test('turn_active user input with FIFO queue policy is queued and remains pending', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_pending',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    await expect(
      broker.input({
        invocationId,
        input: userInput('input_queued', 'queue while busy'),
        policy: { whenBusy: 'queue' },
      })
    ).resolves.toMatchObject({
      inputId: 'input_queued',
      accepted: true,
      disposition: 'queued',
    })

    expect(inputEvents(events, 'input.queued').at(-1)).toMatchObject({
      inputId: 'input_queued',
      payload: { inputId: 'input_queued' },
    })
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_active'])
  })

  test('interactive driver with steer support attempts steer immediately instead of broker-queueing', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_interactive_attempted_steer',
      interactionMode: 'interactive',
      supportsSteer: true,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    const response = await broker.input({
      invocationId,
      input: userInput('input_attempted_steer', 'steer while busy'),
      policy: { whenBusy: 'queue' },
    })

    expect(response).toMatchObject({
      inputId: 'input_attempted_steer',
      accepted: true,
      disposition: 'attempted_steer',
    })
    expect(response.turnId).toBeUndefined()
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_active'])
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      'input_attempted_steer',
    ])
    expect(inputEvents(events, 'input.queued')).toHaveLength(0)
    expect(inputEvents(events, 'input.accepted').at(-1)).toMatchObject({
      inputId: 'input_attempted_steer',
      payload: { inputId: 'input_attempted_steer', disposition: 'attempted_steer' },
    })
  })

  test('replaying an attempted steer inputId does not write to the terminal twice', async () => {
    const { broker, controller, invocationId } = await setup({
      invocationId: 'inv_queue_interactive_attempted_steer_replay',
      interactionMode: 'interactive',
      supportsSteer: true,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    const request = {
      invocationId,
      input: userInput('input_attempted_steer_replay', 'steer once'),
      policy: { whenBusy: 'queue' as const },
    }

    const first = await broker.input(request)
    const replayed = await broker.input(request)

    expect(first).toEqual(replayed)
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      'input_attempted_steer_replay',
    ])
  })

  test('turn.completed drains the next queued input on a microtask', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_completed_drain',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    await broker.input({
      invocationId,
      input: userInput('input_after_completed', 'queued'),
      policy: { whenBusy: 'queue' },
    })

    controller.completeActiveTurn()
    await flushMicrotasks()

    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'input_after_completed',
    ])
    expect(inputEvents(events, 'turn.started').at(-1)).toMatchObject({
      inputId: 'input_after_completed',
    })
  })

  test('turn.failed drains the next queued input on a microtask', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_failed_drain',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    await broker.input({
      invocationId,
      input: userInput('input_after_failed', 'queued'),
      policy: { whenBusy: 'queue' },
    })

    controller.failActiveTurn()
    await flushMicrotasks()

    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'input_after_failed',
    ])
    expect(inputEvents(events, 'turn.started').at(-1)).toMatchObject({
      inputId: 'input_after_failed',
    })
  })

  test('turn.interrupted drains the next queued input on a microtask', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_interrupted_drain',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    await broker.input({
      invocationId,
      input: userInput('input_after_interrupted', 'queued'),
      policy: { whenBusy: 'queue' },
    })

    controller.interruptActiveTurn()
    await flushMicrotasks()

    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'input_after_interrupted',
    ])
    expect(inputEvents(events, 'turn.started').at(-1)).toMatchObject({
      inputId: 'input_after_interrupted',
    })
  })

  test('FIFO drain order is preserved across three queued inputs', async () => {
    const { broker, controller, invocationId } = await setup({ invocationId: 'inv_queue_fifo' })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    for (const id of ['a', 'b', 'c']) {
      await broker.input({
        invocationId,
        input: userInput(id, `queued ${id}`),
        policy: { whenBusy: 'queue' },
      })
    }

    for (let i = 0; i < 3; i += 1) {
      controller.completeActiveTurn()
      await flushMicrotasks()
    }

    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_active', 'a', 'b', 'c'])
  })

  test('inputQueue none with queue policy rejects with a stable structured reason', async () => {
    const { broker, invocationId } = await setup({
      invocationId: 'inv_queue_disabled',
      inputQueue: 'none',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    const response = await broker.input({
      invocationId,
      input: userInput('input_queue_disabled', 'queue disabled'),
      policy: { whenBusy: 'queue' },
    })

    expect(response).toMatchObject({
      inputId: 'input_queue_disabled',
      accepted: false,
      disposition: 'rejected',
    })
    expect(response.reason).toBeString()
    expect(response.reason).not.toHaveLength(0)
  })

  test('whenBusy reject preserves busy-turn rejection behavior', async () => {
    const { broker, invocationId } = await setup({ invocationId: 'inv_queue_reject_regression' })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    await expect(
      broker.input({
        invocationId,
        input: userInput('input_reject_regression', 'reject'),
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.InputRejected })
  })

  test('queue depth cap rejects the fourth queued input with queue_full and emits input.rejected', async () => {
    const { broker, events, invocationId } = await setup({
      invocationId: 'inv_queue_depth',
      maxInputQueueDepth: 3,
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    for (const id of ['queued_1', 'queued_2', 'queued_3']) {
      await expect(
        broker.input({
          invocationId,
          input: userInput(id, id),
          policy: { whenBusy: 'queue' },
        })
      ).resolves.toMatchObject({ inputId: id, disposition: 'queued' })
    }

    await expect(
      broker.input({
        invocationId,
        input: userInput('queued_4', 'too deep'),
        policy: { whenBusy: 'queue' },
      })
    ).resolves.toMatchObject({
      inputId: 'queued_4',
      accepted: false,
      disposition: 'rejected',
      reason: 'queue_full',
    })
    expect(inputEvents(events, 'input.rejected').at(-1)).toMatchObject({
      inputId: 'queued_4',
      payload: { inputId: 'queued_4', reason: 'queue_full' },
    })
  })

  test('stopping an invocation rejects queued inputs and leaves nothing to drain', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_stop_eviction',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    await broker.input({
      invocationId,
      input: userInput('queued_stop_1', 'queued 1'),
      policy: { whenBusy: 'queue' },
    })
    await broker.input({
      invocationId,
      input: userInput('queued_stop_2', 'queued 2'),
      policy: { whenBusy: 'queue' },
    })

    await broker.stop({ invocationId, reason: 'test stop' })
    await flushMicrotasks()

    const rejectedIds = inputEvents(events, 'input.rejected').map((event) => ({
      inputId: event.inputId,
      reason: eventPayload<{ reason: string }>(event).reason,
    }))
    expect(rejectedIds).toEqual([
      {
        inputId: 'queued_stop_1',
        reason: expect.stringMatching(/^invocation_(terminated|stopping)$/),
      },
      {
        inputId: 'queued_stop_2',
        reason: expect.stringMatching(/^invocation_(terminated|stopping)$/),
      },
    ])
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_active'])
  })

  test.each(['steer', 'append_context'] as const)(
    'queue policy rejects non-user queued input kind %s centrally',
    async (kind) => {
      const { broker, invocationId } = await setup({
        invocationId: `inv_queue_unsupported_${kind}`,
        inputCapabilities: {
          steer: true,
          appendContext: true,
        },
      })
      await broker.input({ invocationId, input: userInput('input_active', 'active') })

      await expect(
        broker.input({
          invocationId,
          input: nonUserInput(kind, `input_${kind}`),
          policy: { whenBusy: 'queue' },
        })
      ).resolves.toMatchObject({
        inputId: `input_${kind}`,
        accepted: false,
        disposition: 'rejected',
        reason: 'unsupported_input_kind_for_queue',
      })
    }
  )

  test('interrupt_then_apply busy policy is centrally rejected in v1', async () => {
    const { broker, invocationId } = await setup({
      invocationId: 'inv_queue_interrupt_then_apply',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    await expect(
      broker.input({
        invocationId,
        input: userInput('input_interrupt_then_apply', 'interrupt then apply'),
        policy: { whenBusy: 'interrupt_then_apply' },
      })
    ).resolves.toMatchObject({
      inputId: 'input_interrupt_then_apply',
      accepted: false,
      disposition: 'rejected',
      reason: 'unsupported_busy_policy',
    })
  })

  test('broker-assigned inputId is stable in response and input.accepted event', async () => {
    const { broker, events, invocationId } = await setup({
      invocationId: 'inv_queue_assigned_started',
    })

    const response = await broker.input({
      invocationId,
      input: userInput(undefined, 'assign an id'),
    })

    expect(response.inputId).toBeString()
    expect(response.inputId).not.toHaveLength(0)
    expect(inputEvents(events, 'input.accepted').at(-1)).toMatchObject({
      inputId: response.inputId,
      payload: { inputId: response.inputId },
    })
  })

  test('broker-assigned inputId is stable in response and input.queued event', async () => {
    const { broker, events, invocationId } = await setup({
      invocationId: 'inv_queue_assigned_queued',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    const response = await broker.input({
      invocationId,
      input: userInput(undefined, 'assign queued id'),
      policy: { whenBusy: 'queue' },
    })

    expect(response.inputId).toBeString()
    expect(inputEvents(events, 'input.queued').at(-1)).toMatchObject({
      inputId: response.inputId,
      payload: { inputId: response.inputId },
    })
  })

  test('broker-assigned inputId is stable in response and input.rejected event', async () => {
    const { broker, events, invocationId } = await setup({
      invocationId: 'inv_queue_assigned_rejected',
      inputQueue: 'none',
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })

    const response = await broker.input({
      invocationId,
      input: userInput(undefined, 'assign rejected id'),
      policy: { whenBusy: 'queue' },
    })

    expect(response.inputId).toBeString()
    expect(response.disposition).toBe('rejected')
    expect(inputEvents(events, 'input.rejected').at(-1)).toMatchObject({
      inputId: response.inputId,
      payload: { inputId: response.inputId },
    })
  })

  test('drain rejection for one queued input does not block later queued inputs', async () => {
    const { broker, controller, events, invocationId } = await setup({
      invocationId: 'inv_queue_drain_failure',
      failInputIds: ['queued_fails'],
    })
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    await broker.input({
      invocationId,
      input: userInput('queued_fails', 'fails before turn starts'),
      policy: { whenBusy: 'queue' },
    })
    await broker.input({
      invocationId,
      input: userInput('queued_after_failure', 'continues'),
      policy: { whenBusy: 'queue' },
    })

    controller.completeActiveTurn()
    await flushMicrotasks()

    expect(inputEvents(events, 'input.rejected').at(-1)).toMatchObject({
      inputId: 'queued_fails',
    })
    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'queued_after_failure',
    ])
    expect(inputEvents(events, 'turn.started').at(-1)).toMatchObject({
      inputId: 'queued_after_failure',
    })
  })
})
