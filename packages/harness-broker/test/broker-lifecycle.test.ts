import { describe, expect, test } from 'bun:test'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { Driver } from '../src/drivers/driver'
import { createNoopDriver } from '../src/drivers/noop-driver'
import { noopCapabilities, noopSpec } from './helpers'

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
})
