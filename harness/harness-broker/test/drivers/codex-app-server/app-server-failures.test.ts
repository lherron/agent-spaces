import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import {
  appServerBroker,
  eventDump,
  eventTypes,
  runScenario,
  scenarioSpec,
  startScenario,
  waitFor,
  waitForEvent,
} from './fake-codex-scenario'
import { expectGolden } from './golden-events'

// Startup and turn failures, including native `error` notifications, which the
// driver dispositions itself before the event mapper sees them.

const ofType = (events: InvocationEventEnvelope[], type: string) =>
  events.filter((event) => event.type === type)

// T-09238: willRetry:true is codex saying "still working on this turn".
const retryDiagnostics = (events: InvocationEventEnvelope[]) =>
  events.filter(
    (event) =>
      event.type === 'diagnostic' &&
      (event.payload as { data?: { willRetry?: boolean } }).data?.willRetry === true
  )

describe('Codex app-server startup failures', () => {
  test('maps startup error notification to diagnostic and terminal invocation.failed', async () => {
    const { broker, events } = appServerBroker()
    await expect(broker.start({ spec: scenarioSpec('startup-error') })).rejects.toMatchObject({
      code: BrokerErrorCode.HarnessError,
    })
    await expectGolden('startup-error', events)
  })

  test('keeps a retryable startup error terminal', async () => {
    const { broker, events } = appServerBroker()
    await expect(
      broker.start({ spec: scenarioSpec('startup-retryable-error') })
    ).rejects.toMatchObject({
      code: BrokerErrorCode.HarnessError,
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'invocation.failed',
        payload: expect.objectContaining({ retryable: true }),
      })
    )
    expect(events.some((event) => event.type === 'invocation.ready')).toBe(false)
  })

  test('rejects an unsupported initialize protocol version with a terminal invocation.failed', async () => {
    const { broker, events } = appServerBroker()
    await expect(
      broker.start({ spec: scenarioSpec('handshake-unsupported') })
    ).rejects.toMatchObject({ code: BrokerErrorCode.HarnessError })
    // No invocation.started / ready: handshake validation fails before they emit.
    expect(events.map((event) => event.type)).toEqual(['invocation.failed'])
    expect(events[0]?.payload).toMatchObject({
      message: expect.stringContaining('Unsupported Codex app-server protocol version'),
    })
  })

  test('maps a process exit during startup to a terminal invocation.failed', async () => {
    const { broker, events } = appServerBroker()
    await expect(broker.start({ spec: scenarioSpec('exit-during-startup') })).rejects.toMatchObject(
      { code: BrokerErrorCode.HarnessError }
    )
    expect(events.map((event) => event.type)).toEqual(['invocation.failed'])
    expect(events.some((event) => event.type === 'invocation.started')).toBe(false)
  })
})

describe('Codex app-server turn error notifications', () => {
  describe('T-08557 retryable reconnect notifications', () => {
    test('keeps one retryable error diagnostic until Codex completes the turn', async () => {
      const events = await runScenario('turn-error-rate-limit')
      expect(ofType(events, 'diagnostic')).toHaveLength(1)
      // Codex reports this completion with status=failed, which intentionally
      // normalizes to turn.failed. Its finalOutput proves that terminal came
      // from turn/completed rather than the reconnect diagnostic.
      expect(ofType(events, 'turn.completed')).toHaveLength(0)
      expect(ofType(events, 'turn.failed')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            status: 'failed',
            finalOutput: 'Too many requests',
          }),
        }),
      ])
      expect(ofType(events, 'invocation.failed')).toHaveLength(0)
    })

    test('keeps the recorded reconnect sequence live through completion', async () => {
      const { broker, events, invocationId } = await startScenario('turn-error-reconnect-completes')
      await waitFor(() => ofType(events, 'diagnostic').length === 3, eventDump(events))

      expect((await broker.seatProbe({ invocationId })).seat).toMatchObject({
        state: 'turn-active',
        turnId: 'turn_1',
      })

      await waitForEvent(events, (event) => event.type === 'turn.completed')
      expect(ofType(events, 'turn.completed')).toHaveLength(1)
      expect(ofType(events, 'turn.failed')).toHaveLength(0)
      expect(ofType(events, 'invocation.failed')).toHaveLength(0)
      expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })
    })
  })

  test.each([
    {
      scenario: 'turn-error-server-overloaded',
      message: 'Selected model is at capacity',
      code: 'serverOverloaded',
      retryable: false,
      reason: undefined,
    },
    {
      scenario: 'turn-error-auth',
      message: 'Authentication failed',
      code: 'authenticationFailed',
      retryable: false,
      reason: 'authentication',
    },
  ])(
    'correlates and preserves $scenario error notification details',
    async ({ scenario, message, code, retryable, reason }) => {
      const events = await runScenario(scenario)
      await waitForEvent(events, (event) => event.type === 'turn.failed')
      const diagnostic = events.find((event) => event.type === 'diagnostic')
      const failed = events.find((event) => event.type === 'turn.failed')

      expect(diagnostic).toMatchObject({
        turnId: 'turn_1',
        payload: {
          level: 'error',
          message,
          data: expect.objectContaining({
            code,
            willRetry: retryable,
          }),
        },
      })
      expect(failed).toMatchObject({
        turnId: 'turn_1',
        payload: {
          turnId: 'turn_1',
          message,
          code,
          data: expect.objectContaining({
            turnId: 'turn_1',
            willRetry: retryable,
          }),
          retryable,
          ...(reason !== undefined ? { reason } : {}),
        },
      })
      expect(ofType(events, 'turn.failed')).toHaveLength(1)
      expect(events.some((event) => event.type === 'invocation.failed')).toBe(false)
    }
  )

  test('a willRetry error is a diagnostic; the turn fails only from codex turn/completed', async () => {
    const events = await runScenario('turn-error-rate-limit')
    await Bun.sleep(50)

    expect(retryDiagnostics(events)).toHaveLength(1)
    const failed = ofType(events, 'turn.failed')
    expect(failed).toHaveLength(1)
    expect((failed[0]?.payload as { retryable?: boolean }).retryable).not.toBe(true)
    expect(events.some((event) => event.type === 'invocation.failed')).toBe(false)
  })

  test('retries then a final willRetry:false error fail the turn once, with the final message', async () => {
    const events = await runScenario('turn-error-retry-then-exhausted')
    await Bun.sleep(50)

    expect(
      retryDiagnostics(events).map((event) => (event.payload as { message: string }).message)
    ).toEqual(['Reconnecting... 2/5', 'Reconnecting... 3/5'])
    const failed = ofType(events, 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      turnId: 'turn_1',
      payload: { message: 'unexpected status 401 Unauthorized', retryable: false },
    })
    expect(events.some((event) => event.type === 'invocation.failed')).toBe(false)
  })

  test('retries that codex recovers from leave the turn to complete normally', async () => {
    const events = await runScenario('turn-error-retry-then-recovered')
    await Bun.sleep(50)

    expect(retryDiagnostics(events)).toHaveLength(2)
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true)
    expect(events.some((event) => event.type === 'turn.failed')).toBe(false)
    expect(events.some((event) => event.type === 'invocation.failed')).toBe(false)
  })
})

describe('Codex app-server transport and process death', () => {
  test('classifies a fatal mid-turn RPC protocol error with correlated durable terminals', async () => {
    const events = await runScenario('mid-turn-rpc-protocol-error')
    await waitForEvent(events, (event) => event.type === 'invocation.failed')

    const diagnostic = events.find(
      (event) =>
        event.type === 'diagnostic' &&
        (event.payload as { data?: { code?: string } }).data?.code === 'codex_rpc_protocol_error'
    )
    expect(diagnostic).toMatchObject({
      turnId: 'turn_1',
      payload: {
        level: 'error',
        data: {
          code: 'codex_rpc_protocol_error',
          fatal: true,
        },
      },
    })
    expect(ofType(events, 'turn.failed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn.failed')).toMatchObject({
      turnId: 'turn_1',
      payload: {
        message: expect.stringContaining('Failed to parse JSON-RPC message'),
        code: 'codex_rpc_protocol_error',
        retryable: false,
        reason: 'transport-error',
      },
    })
    expect(ofType(events, 'invocation.failed')).toHaveLength(1)
    expect(events.some((event) => event.type === 'invocation.exited')).toBe(false)
  })

  test('provider death preserves diagnostic, tool bracket, and terminal ordering', async () => {
    const events = await runScenario('provider-death-open-tool')
    await waitForEvent(events, (event) => event.type === 'invocation.exited')
    const types = eventTypes(events)
    const diagnosticIndex = events.findIndex(
      (event) =>
        event.type === 'diagnostic' &&
        (event.payload as { data?: { code?: string } }).data?.code === 'codex_process_exit'
    )
    const toolFailureIndex = types.indexOf('tool.call.failed')
    const turnFailureIndex = types.indexOf('turn.failed')
    const invocationExitIndex = types.indexOf('invocation.exited')

    expect(diagnosticIndex).toBeGreaterThanOrEqual(0)
    expect(events[diagnosticIndex]).toMatchObject({
      turnId: 'turn_1',
      payload: {
        level: 'error',
        data: { code: 'codex_process_exit', exitCode: 42, signal: null },
      },
    })
    expect(ofType(events, 'tool.call.started')).toHaveLength(1)
    expect(ofType(events, 'tool.call.failed')).toHaveLength(1)
    expect(events[toolFailureIndex]).toMatchObject({
      turnId: 'turn_1',
      payload: {
        toolCallId: 'cmd_open',
        code: 'broker_unterminated_tool_call',
      },
    })
    expect(ofType(events, 'turn.failed')).toHaveLength(1)
    expect(events[turnFailureIndex]).toMatchObject({
      payload: {
        message: 'Harness process exited during active turn',
        code: 'codex_process_exit',
        data: { exitCode: 42, signal: null },
      },
    })
    expect(diagnosticIndex).toBeLessThan(toolFailureIndex)
    expect(toolFailureIndex).toBeLessThan(turnFailureIndex)
    expect(turnFailureIndex).toBeLessThan(invocationExitIndex)
  })
})
