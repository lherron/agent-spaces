import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

const now = () => new Date('2026-09-16T23:49:00.000Z')

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
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
  driver: { kind: 'test-driver' },
})

const input: InvocationInput = {
  inputId: 'input_reconnect',
  kind: 'user',
  content: [{ type: 'text', text: 'continue after reconnect' }],
}

describe('T-08557 retryable invocation failures', () => {
  test('preserves ready and active seats while non-retryable failures remain terminal', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver()
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })
    const invocationId = 'inv_t08557_retryable_failure'
    await broker.start({ spec: spec(invocationId) })

    controller.emitRaw('invocation.failed', {
      message: 'Codex is reconnecting',
      code: 'responseStreamDisconnected',
      retryable: true,
    })
    expect(events.filter((event) => event.type === 'invocation.failed')).toHaveLength(1)
    expect((await broker.status({ invocationId })).state).toBe('ready')
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })

    await broker.input({ invocationId, input })
    expect((await broker.status({ invocationId })).state).toBe('turn_active')
    controller.startToolCall('call_reconnecting', 'command')
    controller.emitRaw('invocation.failed', {
      message: 'Codex is reconnecting again',
      code: 'responseStreamDisconnected',
      retryable: true,
    })
    expect((await broker.status({ invocationId })).state).toBe('turn_active')
    expect((await broker.seatProbe({ invocationId })).seat).toMatchObject({ state: 'turn-active' })
    expect(events.filter((event) => event.type === 'tool.call.failed')).toHaveLength(0)

    controller.completeToolCall('call_reconnecting', 'command')
    controller.completeActiveTurn('reconnected completion')
    expect((await broker.status({ invocationId })).state).toBe('ready')
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })

    controller.emitRaw('invocation.failed', {
      message: 'Codex stopped retrying',
      retryable: false,
    })
    expect((await broker.status({ invocationId })).state).toBe('failed')
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'terminal' })
  })
})
