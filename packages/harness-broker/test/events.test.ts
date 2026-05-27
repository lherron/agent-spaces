import { describe, expect, test } from 'bun:test'
import { validateEventEnvelope } from 'spaces-harness-broker-protocol'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { Driver } from '../src/drivers/driver'
import { createInvocationEventSequencer } from '../src/events'
import { createTestDriver } from '../src/testing/test-driver'
import { noopCapabilities } from './helpers'

const now = () => new Date('2026-05-20T18:00:00.000Z')

const testDriverSpec = (invocationId: string): HarnessInvocationSpec => ({
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

const userInput = (inputId: string) => ({
  inputId,
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'go' }],
})

describe('invocation event sequencing', () => {
  test('seq is monotonic per invocation and starts at 1', () => {
    const sequencer = createInvocationEventSequencer({
      now: () => new Date('2026-05-20T18:00:00.000Z'),
    })

    expect([
      sequencer.next('inv_a', 'invocation.started', {}),
      sequencer.next('inv_a', 'invocation.ready', {}),
      sequencer.next('inv_b', 'invocation.started', {}),
    ]).toMatchObject([{ seq: 1 }, { seq: 2 }, { seq: 1 }])
  })

  test('event envelope includes invocationId', () => {
    const sequencer = createInvocationEventSequencer({
      now: () => new Date('2026-05-20T18:00:00.000Z'),
    })

    expect(sequencer.next('inv_with_id', 'invocation.ready', {})).toMatchObject({
      invocationId: 'inv_with_id',
      seq: 1,
      time: '2026-05-20T18:00:00.000Z',
      type: 'invocation.ready',
      payload: {},
    })
  })

  test('correlation is echoed verbatim and never interpreted', () => {
    const correlation = {
      'client.session': 'runtime-123',
      phase: 'opaque-client-value',
      seq: 'not-a-broker-seq',
    }
    const sequencer = createInvocationEventSequencer({
      now: () => new Date('2026-05-20T18:00:00.000Z'),
      correlation,
    })

    const event = sequencer.next('inv_corr', 'driver.notice', { message: 'notice' })

    expect(event.correlation).toEqual(correlation)
    expect(event.seq).toBe(1)
    expect(event.type).toBe('driver.notice')
  })
})

describe('final-contract event payloads', () => {
  test('every manager-emitted event validates and seq increments exactly once per event', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver()
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })

    await broker.start({ spec: testDriverSpec('inv_validate_stream') })
    await broker.input({ invocationId: 'inv_validate_stream', input: userInput('in_1') })
    controller.completeActiveTurn()
    await broker.stop({ invocationId: 'inv_validate_stream' })
    await broker.dispose({ invocationId: 'inv_validate_stream' })

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(() => validateEventEnvelope(event)).not.toThrow()
    }
    // seq increments exactly once per emitted event (single invocation → 1..N).
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    // invocation.disposed appears exactly once and terminates the stream.
    expect(events.filter((event) => event.type === 'invocation.disposed')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('invocation.disposed')
  })

  test('a failed turn emits turn.failed (not turn.completed status=failed) and clears currentTurnId', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver()
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })

    await broker.start({ spec: testDriverSpec('inv_turn_failed') })
    await broker.input({ invocationId: 'inv_turn_failed', input: userInput('in_1') })
    controller.failActiveTurn('boom')

    const failed = events.filter((event) => event.type === 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.payload).toMatchObject({ message: 'boom' })
    expect((failed[0]?.payload as { turnId?: string }).turnId).toBeDefined()
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false)

    const status = await broker.status({ invocationId: 'inv_turn_failed' })
    expect(status.currentTurnId).toBeUndefined()
    expect(status.state).toBe('ready')
  })

  test('maxEventBytes truncates an oversized event and emits a follow-on diagnostic, seq once per event', async () => {
    const events: InvocationEventEnvelope[] = []
    const big = 'x'.repeat(10_000)
    const driver: Driver = {
      kind: 'big-event-driver',
      version: 'test',
      capabilities: () => noopCapabilities,
      start: async (_spec, ctx) => {
        ctx.emit('invocation.started', { command: 'big', args: [], cwd: '/work' })
        ctx.emit('invocation.ready', { state: 'ready' })
        // Oversized event — far beyond the configured maxEventBytes budget.
        ctx.emit(
          'assistant.message.delta',
          { messageId: 'm1', text: big },
          { turnId: 'turn_big' as never }
        )
        return { ok: true }
      },
      applyInputNow: async () => ({}),
      interrupt: async () => ({ accepted: false, effect: 'unsupported' }),
      stop: async () => ({ accepted: true, state: 'exited' }),
      dispose: async () => {},
    }
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })
    const spec: HarnessInvocationSpec = {
      ...testDriverSpec('inv_max_bytes'),
      harness: { frontend: 'big', provider: 'big', driver: 'big-event-driver' },
      driver: { kind: 'big-event-driver' },
      process: {
        command: 'big',
        args: [],
        cwd: process.cwd(),
        harnessTransport: { kind: 'pipes' },
        limits: { maxEventBytes: 512 },
      },
    }
    await broker.start({ spec })

    const delta = events.find((event) => event.type === 'assistant.message.delta')
    expect(delta?.payload).toMatchObject({ messageId: 'm1', text: '[TRUNCATED]' })

    // The truncation diagnostic is emitted as its own broker event immediately after.
    const deltaIndex = events.findIndex((event) => event.type === 'assistant.message.delta')
    const diagnostic = events[deltaIndex + 1]
    expect(diagnostic?.type).toBe('diagnostic')
    expect(diagnostic?.payload).toMatchObject({ source: 'broker', level: 'warn' })

    // seq still increments exactly once per emitted event — no double counting.
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    // No raw oversized content leaked into the serialized stream.
    expect(events.map((event) => JSON.stringify(event)).join('\n')).not.toContain(big)
  })
})
