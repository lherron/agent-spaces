import { describe, expect, test } from 'bun:test'
import {
  BrokerErrorCode,
  conservativeDefaultLifecyclePolicyOverlay,
  lifecyclePolicyHash,
} from 'spaces-harness-broker-protocol'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { Driver } from '../src/drivers/driver'
import { createNoopDriver } from '../src/drivers/noop-driver'
import { createTestDriver } from '../src/testing/test-driver'
import { noopCapabilities, noopSpec } from './helpers'

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

const createTestBroker = () =>
  createBroker({
    drivers: [createNoopDriver({ terminal: 'exited' })],
    now: () => new Date('2026-05-20T18:00:00.000Z'),
  })

describe('broker lifecycle', () => {
  test('broker.hello returns negotiated version, drivers, and capabilities', async () => {
    const broker = createTestBroker()

    await expect(
      broker.hello({
        clientInfo: { name: 'phase-1-test' },
        protocolVersions: ['harness-broker/0.1'],
        capabilities: { permissionRequests: false },
      })
    ).resolves.toMatchObject({
      brokerInfo: { name: 'harness-broker' },
      protocolVersion: 'harness-broker/0.1',
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
      },
      drivers: [
        {
          kind: 'noop-driver',
          available: true,
          capabilities: noopCapabilities,
        },
      ],
    })
  })

  test('broker.health returns status and active invocation count', async () => {
    const broker = createTestBroker()

    await expect(broker.health({})).resolves.toEqual({
      status: 'ok',
      activeInvocations: 0,
    })

    await broker.start({ spec: noopSpec() })

    await expect(broker.health({})).resolves.toEqual({
      status: 'ok',
      activeInvocations: 1,
    })
  })

  test('invocation.status on an unknown id fails with UnknownInvocation', async () => {
    const broker = createTestBroker()

    await expect(broker.status({ invocationId: 'missing' })).rejects.toMatchObject({
      code: BrokerErrorCode.UnknownInvocation,
    })
  })

  test('single-invocation broker rejects a second active invocation', async () => {
    const broker = createTestBroker()

    await expect(
      broker.start({ spec: noopSpec({ invocationId: 'inv_one' }) })
    ).resolves.toMatchObject({
      invocationId: 'inv_one',
      state: 'ready',
    })

    await expect(
      broker.start({ spec: noopSpec({ invocationId: 'inv_two' }) })
    ).rejects.toMatchObject({
      code: BrokerErrorCode.InvalidInvocationState,
    })
  })

  test('invocation.start validates the request before invoking a driver', async () => {
    let startCalls = 0
    const driver: Driver = {
      kind: 'noop-driver',
      version: 'test',
      capabilities: () => noopCapabilities,
      start: async () => {
        startCalls += 1
        return { ok: true }
      },
      applyInputNow: async () => ({}),
      interrupt: async () => ({ accepted: false, effect: 'unsupported' }),
      stop: async () => ({ accepted: true, state: 'exited' }),
      dispose: async () => {},
    }
    const broker = createBroker({ drivers: [driver] })

    await expect(
      broker.start({
        spec: noopSpec(),
        initialInput: { kind: 'bogus', content: [{ type: 'text', text: 'hello' }] } as never,
      })
    ).rejects.toMatchObject({
      code: -32602,
      data: { issues: expect.any(Array) },
    })
    expect(startCalls).toBe(0)
  })

  test('invocation.dispose succeeds after terminal state', async () => {
    const broker = createTestBroker()
    await broker.start({ spec: noopSpec({ invocationId: 'inv_dispose' }) })
    await broker.stop({ invocationId: 'inv_dispose', reason: 'test complete' })

    await expect(broker.dispose({ invocationId: 'inv_dispose' })).resolves.toEqual({
      disposed: true,
    })
    await expect(broker.status({ invocationId: 'inv_dispose' })).resolves.toMatchObject({
      invocationId: 'inv_dispose',
      state: 'disposed',
    })
  })

  test('each invocation emits exactly one terminal invocation event', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createNoopDriver({ terminal: 'failed' })],
      onEvent: (event) => events.push(event),
      now: () => new Date('2026-05-20T18:00:00.000Z'),
    })

    await broker.start({ spec: noopSpec({ invocationId: 'inv_terminal' }) })
    await broker.stop({ invocationId: 'inv_terminal', reason: 'terminal uniqueness' })

    const terminalEvents = events.filter(
      (event) => event.type === 'invocation.exited' || event.type === 'invocation.failed'
    )
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]).toMatchObject({
      invocationId: 'inv_terminal',
      type: 'invocation.failed',
    })
  })

  test('invocation.ready event payload is { state: "ready" }', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createNoopDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    await broker.start({ spec: noopSpec({ invocationId: 'inv_ready_payload' }) })

    const ready = events.find((event) => event.type === 'invocation.ready')
    expect(ready?.payload).toEqual({ state: 'ready' })
  })

  test('accepts an explicit conservative lifecycle overlay and reports policy hash separately', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createNoopDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_noop_default')
    const startRequest = { spec: noopSpec({ invocationId: 'inv_lifecycle_default' }) }
    const startRequestBytesBefore = JSON.stringify(startRequest)

    const response = await broker.start(startRequest, undefined, undefined, lifecyclePolicy)

    expect(JSON.stringify(startRequest)).toBe(startRequestBytesBefore)
    expect(response.acceptedLifecyclePolicy).toEqual({
      policyId: lifecyclePolicy.policyId,
      policyHash: lifecyclePolicy.policyHash,
      retentionMode: 'keep-alive',
      harnessRecoveryMode: 'none',
      turnRetryMode: 'none',
    })
    expect(events.map((event) => event.type)).toEqual([
      'lifecycle.policy.accepted',
      'invocation.started',
      'invocation.ready',
    ])
    expect(events[0]?.payload).toMatchObject({ policyHash: lifecyclePolicy.policyHash })
    expect(events[1]?.payload).not.toHaveProperty('policyHash')
    expect(events[1]?.payload).not.toHaveProperty('harnessGeneration')
  })

  test('omitted lifecycle overlay preserves the legacy startup event stream', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createNoopDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    const response = await broker.start({
      spec: noopSpec({ invocationId: 'inv_lifecycle_omitted' }),
    })

    expect(response.acceptedLifecyclePolicy).toBeUndefined()
    expect(events.map((event) => event.type)).toEqual(['invocation.started', 'invocation.ready'])
  })

  test('rejects unsupported lifecycle modes without downgrading', async () => {
    const broker = createBroker({ drivers: [createNoopDriver()], now })
    const policy = conservativeDefaultLifecyclePolicyOverlay('policy_unsupported')
    const unsupported = {
      ...policy,
      retention: {
        mode: 'idle-ttl' as const,
        idleTtlMs: 1000,
        retire: {
          mode: 'driver-retire' as const,
          graceMs: 100,
          onTimeout: 'fail-invocation' as const,
        },
      },
    }
    unsupported.policyHash = lifecyclePolicyHash(unsupported)

    await expect(
      broker.start(
        { spec: noopSpec({ invocationId: 'inv_lifecycle_unsupported' }) },
        undefined,
        undefined,
        unsupported
      )
    ).rejects.toMatchObject({
      code: BrokerErrorCode.BrokerLifecyclePolicyUnsupported,
      data: {
        code: 'broker-lifecycle-policy-unsupported',
        missing: expect.arrayContaining(['retention.idle-ttl']),
      },
    })
  })

  test('dispose emits invocation.disposed exactly once and is idempotent', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createNoopDriver({ terminal: 'exited' })],
      onEvent: (event) => events.push(event),
      now,
    })
    await broker.start({ spec: noopSpec({ invocationId: 'inv_disposed_once' }) })
    await broker.stop({ invocationId: 'inv_disposed_once' })

    await expect(broker.dispose({ invocationId: 'inv_disposed_once' })).resolves.toEqual({
      disposed: true,
    })
    await expect(broker.dispose({ invocationId: 'inv_disposed_once' })).resolves.toEqual({
      disposed: true,
    })

    const disposed = events.filter((event) => event.type === 'invocation.disposed')
    expect(disposed).toHaveLength(1)
    expect(disposed[0]?.payload).toEqual({ disposed: true })
  })

  test('status reflects currentTurnId during an active turn and clears it after completion', async () => {
    const { driver, controller } = createTestDriver()
    const broker = createBroker({ drivers: [driver], now })
    await broker.start({ spec: testDriverSpec('inv_status_turn') })
    await broker.input({ invocationId: 'inv_status_turn', input: userInput('in_1') })

    const active = await broker.status({ invocationId: 'inv_status_turn' })
    expect(active.state).toBe('turn_active')
    expect(active.currentTurnId).toBe(controller.activeTurnId!)

    controller.completeActiveTurn()

    const idle = await broker.status({ invocationId: 'inv_status_turn' })
    expect(idle.state).toBe('ready')
    expect(idle.currentTurnId).toBeUndefined()
  })

  test('status exposes child process pid reported via invocation.started', async () => {
    const driver: Driver = {
      kind: 'pid-driver',
      version: 'test',
      capabilities: () => noopCapabilities,
      start: async (_spec, ctx) => {
        ctx.emit('invocation.started', {
          pid: 4242,
          command: 'pid-driver',
          args: [],
          cwd: '/work',
        })
        ctx.emit('invocation.ready', { state: 'ready' })
        return { ok: true }
      },
      applyInputNow: async () => ({}),
      interrupt: async () => ({ accepted: false, effect: 'unsupported' }),
      stop: async () => ({ accepted: true, state: 'exited' }),
      dispose: async () => {},
    }
    const broker = createBroker({ drivers: [driver], now })
    const spec: HarnessInvocationSpec = {
      ...testDriverSpec('inv_pid'),
      harness: { frontend: 'pid', provider: 'pid', driver: 'pid-driver' },
      driver: { kind: 'pid-driver' },
    }
    await broker.start({ spec })

    const status = await broker.status({ invocationId: 'inv_pid' })
    expect(status.process).toMatchObject({ pid: 4242 })
  })
})
