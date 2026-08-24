import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { DriverContext } from '../src/drivers/driver'
import { createTestDriver } from '../src/testing/test-driver'

const now = () => new Date('2026-07-24T19:30:00.000Z')
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

const testSpec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: { kind: 'test-driver' },
})

const userInput = (inputId: string, text: string): InvocationInput => ({
  inputId,
  kind: 'user',
  content: [{ type: 'text', text }],
})

const turnTerminals = (events: InvocationEventEnvelope[], turnId: TurnId) =>
  events.filter(
    (event) =>
      event.turnId === turnId &&
      (event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted')
  )

describe('broker-central turn-terminal idempotency', () => {
  test('error/completion race delivers a queued input once, replays its inputId, and preserves FIFO recovery', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver({ suppressTurnStarted: true })
    let driverContext: DriverContext | undefined
    const originalStart = driver.start.bind(driver)
    driver.start = async (spec, context) => {
      driverContext = context
      return originalStart(spec, context)
    }

    const invocationId = 'inv_terminal_error_completion_queue'
    const broker = createBroker({
      drivers: [driver],
      onEvent: (event) => events.push(event),
      now,
    })
    await broker.start({ spec: testSpec(invocationId) })

    await broker.input({
      invocationId,
      input: userInput('input_active', 'active turn'),
    })
    const failedTurnId = controller.activeTurnId!
    const queuedRequest = {
      invocationId,
      input: userInput('input_queued_once', 'queued once'),
      policy: { whenBusy: 'queue' as const },
    }
    const originalQueuedResponse = await broker.input(queuedRequest)
    await broker.input({
      invocationId,
      input: userInput('input_queued_second', 'queued second'),
      policy: { whenBusy: 'queue' },
    })

    controller.failActiveTurn('broker capacity error')
    driverContext!.emit(
      'turn.completed',
      {
        turnId: failedTurnId,
        status: 'completed',
        finalOutput: 'late completion after recovery',
      },
      { turnId: failedTurnId, inputId: 'input_active' }
    )

    // The sender's retry uses the same inputId. Existing input idempotency must
    // replay the original response without creating a second queue item.
    await expect(broker.input(queuedRequest)).resolves.toEqual(originalQueuedResponse)
    await flushMicrotasks()

    expect(turnTerminals(events, failedTurnId).map((event) => event.type)).toEqual(['turn.failed'])
    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'input_queued_once',
    ])

    // Normal completion advances exactly one FIFO position; the second queued
    // message is neither lost nor pulled forward by the duplicate terminal.
    const firstQueuedTurnId = controller.activeTurnId!
    controller.completeActiveTurn('first queued input completed')
    await flushMicrotasks()
    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'input_queued_once',
      'input_queued_second',
    ])
    expect(turnTerminals(events, firstQueuedTurnId)).toHaveLength(1)

    // Recovery to the normal ready/apply path remains intact after the queue
    // drains and each completed turn still contributes one terminal.
    const secondQueuedTurnId = controller.activeTurnId!
    controller.completeActiveTurn('second queued input completed')
    await flushMicrotasks()
    expect(turnTerminals(events, secondQueuedTurnId)).toHaveLength(1)

    await expect(
      broker.input({
        invocationId,
        input: userInput('input_recovery', 'post-error recovery'),
      })
    ).resolves.toMatchObject({
      inputId: 'input_recovery',
      accepted: true,
      disposition: 'started',
    })
    expect(controller.inputs.map((input) => input.inputId)).toEqual([
      'input_active',
      'input_queued_once',
      'input_queued_second',
      'input_recovery',
    ])
  })
})
