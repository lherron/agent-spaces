import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

const now = () => new Date('2026-07-10T09:00:00.000Z')

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

const testSpec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
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
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'test-driver',
  },
})

const userInput = (inputId: string, text: string): InvocationInput => ({
  inputId,
  kind: 'user',
  content: [{ type: 'text', text }],
})

/**
 * T-06088 regression: consumers must observe events in seq order.
 *
 * The turn-terminal emit used to run the queue drain synchronously from its
 * state projection BEFORE its own onEvent delivery, so a queued input's
 * input.accepted/user.message (seq N+1, N+2) reached the wire before the
 * turn.completed that freed the runtime (seq N). Downstream monotonic-seq
 * dedup (harness-broker-client InvocationEventHub) then dropped the terminal
 * as a duplicate — the active run's caller never learned its turn ended.
 */
describe('event delivery order', () => {
  test('turn terminal is delivered before the drained queued input events', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver()
    const broker = createBroker({
      drivers: [driver],
      onEvent: (event) => events.push(event),
      now,
    })
    const invocationId = 'inv_event_order_queued_drain'
    await broker.start({ spec: testSpec(invocationId) })

    await expect(
      broker.input({ invocationId, input: userInput('input_active', 'first turn') })
    ).resolves.toMatchObject({ inputId: 'input_active', disposition: 'started' })

    await expect(
      broker.input({
        invocationId,
        input: userInput('input_queued', 'second turn'),
        policy: { whenBusy: 'queue' },
      })
    ).resolves.toMatchObject({ inputId: 'input_queued', disposition: 'queued' })

    controller.completeActiveTurn('first turn done')
    await flushMicrotasks()

    const deliveredSeqs = events.map((event) => event.seq)
    expect(deliveredSeqs).toEqual([...deliveredSeqs].sort((a, b) => a - b))

    const terminalIndex = events.findIndex((event) => event.type === 'turn.completed')
    const drainedAcceptIndex = events.findIndex(
      (event) =>
        event.type === 'input.accepted' &&
        (event.payload as { inputId?: string }).inputId === 'input_queued'
    )
    expect(terminalIndex).toBeGreaterThanOrEqual(0)
    expect(drainedAcceptIndex).toBeGreaterThanOrEqual(0)
    expect(terminalIndex).toBeLessThan(drainedAcceptIndex)

    // The queued input still drains: its turn starts after the terminal.
    expect(controller.inputs).toHaveLength(2)
  })

  test('queue eviction on stop is delivered after invocation.stopping', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver()
    const broker = createBroker({
      drivers: [driver],
      onEvent: (event) => events.push(event),
      now,
    })
    const invocationId = 'inv_event_order_evict'
    await broker.start({ spec: testSpec(invocationId) })

    await broker.input({ invocationId, input: userInput('input_active', 'first turn') })
    await broker.input({
      invocationId,
      input: userInput('input_parked', 'never runs'),
      policy: { whenBusy: 'queue' },
    })
    void controller
    await broker.stop({ invocationId })
    await flushMicrotasks()

    const deliveredSeqs = events.map((event) => event.seq)
    expect(deliveredSeqs).toEqual([...deliveredSeqs].sort((a, b) => a - b))

    const stoppingIndex = events.findIndex((event) => event.type === 'invocation.stopping')
    const evictedIndex = events.findIndex(
      (event) =>
        event.type === 'input.rejected' &&
        (event.payload as { inputId?: string }).inputId === 'input_parked'
    )
    expect(stoppingIndex).toBeGreaterThanOrEqual(0)
    expect(evictedIndex).toBeGreaterThanOrEqual(0)
    expect(stoppingIndex).toBeLessThan(evictedIndex)
  })
})
