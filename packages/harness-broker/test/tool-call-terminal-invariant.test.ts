import { describe, expect, test } from 'bun:test'
import {
  type HarnessInvocationSpec,
  type InvocationEventEnvelope,
  type InvocationInput,
  validateEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

// T-06550: the broker MUST guarantee that every `tool.call.started` gets EXACTLY
// ONE terminal (`tool.call.completed` | `tool.call.failed`). The burn-in-19
// post-mortem found ~430 calls across 4 runtimes where a call `started` and then
// vanished — no terminal (84 started vs 83 completed). The bracket lives at the
// invocation-manager emit seam (modelled on the T-04846 turn.started bracket), so
// it covers ALL FIVE producers (codex-app-server, claude-code-tmux, embedded SDK,
// codex-cli-tmux, pi-tui-tmux — every driver emits through the same central
// `emit`) plus teardown in ONE place. These tests drive the generic test-driver:
// what they pin is the producer-agnostic seam, not any single driver's mapping.

const now = () => new Date('2026-07-18T19:30:00.000Z')

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

const setup = async (invocationId: string) => {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({ suppressTurnStarted: true })
  const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })
  await broker.start({ spec: testSpec(invocationId) })
  return { broker, controller, events, invocationId }
}

const ofType = (events: InvocationEventEnvelope[], type: InvocationEventEnvelope['type']) =>
  events.filter((event) => event.type === type)

const seqOfFirst = (events: InvocationEventEnvelope[], type: InvocationEventEnvelope['type']) =>
  events.findIndex((event) => event.type === type)

/**
 * The core invariant expressed as a balance check: over the whole event stream
 * every `tool.call.started` is matched by exactly one terminal for its
 * toolCallId, and no terminal exists without a start.
 */
const assertExactlyOneTerminalPerStart = (events: InvocationEventEnvelope[]) => {
  const started = new Map<string, number>()
  const terminal = new Map<string, number>()
  for (const event of events) {
    const id = (event.payload as { toolCallId?: string } | undefined)?.toolCallId
    if (id === undefined) continue
    if (event.type === 'tool.call.started') started.set(id, (started.get(id) ?? 0) + 1)
    if (event.type === 'tool.call.completed' || event.type === 'tool.call.failed') {
      terminal.set(id, (terminal.get(id) ?? 0) + 1)
    }
  }
  for (const [id, startCount] of started) {
    expect(startCount).toBe(1)
    expect(terminal.get(id)).toBe(1)
  }
  // No orphan terminal (a terminal for a call that never started).
  for (const id of terminal.keys()) {
    expect(started.has(id)).toBe(true)
  }
}

describe('broker-guaranteed tool.call terminal bracket (T-06550)', () => {
  test('a normally-closed tool call is NOT re-synthesized at turn end', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_normal_close')
    await broker.input({ invocationId, input: userInput('input_1', 'go') })
    controller.startToolCall('call_ok', 'command')
    controller.completeToolCall('call_ok', 'command')
    controller.completeActiveTurn()
    await flushMicrotasks()

    assertExactlyOneTerminalPerStart(events)
    // Exactly one terminal, and it is the driver's own completed (not synthesized).
    expect(ofType(events, 'tool.call.completed')).toHaveLength(1)
    expect(ofType(events, 'tool.call.failed')).toHaveLength(0)
  })

  test('a call left open at turn end is synthesized as failed BEFORE the turn terminal', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_vanished_at_turn_end')
    await broker.input({ invocationId, input: userInput('input_1', 'go') })
    controller.startToolCall('call_vanished', 'command')
    // Turn completes without ever closing call_vanished — the vanished-call defect.
    controller.completeActiveTurn()
    await flushMicrotasks()

    assertExactlyOneTerminalPerStart(events)
    const failures = ofType(events, 'tool.call.failed')
    expect(failures).toHaveLength(1)
    const payload = failures[0]?.payload as Record<string, unknown>
    expect(payload['toolCallId']).toBe('call_vanished')
    expect(payload['code']).toBe('broker_unterminated_tool_call')
    expect(typeof payload['message']).toBe('string')
    // Provenance: broker-originated, machine-traceable.
    expect(failures[0]?.driver?.kind).toBe('broker')
    expect((payload['data'] as { synthesized?: boolean })?.synthesized).toBe(true)

    // Ordering: the synthesized terminal lands strictly before the turn terminal.
    expect(seqOfFirst(events, 'tool.call.failed')).toBeLessThan(
      seqOfFirst(events, 'turn.completed')
    )
    // The synthesized envelope is a valid contract event (message + code present).
    expect(() => validateEventEnvelope(failures[0])).not.toThrow()
  })

  test('turn-scoped synthesis leaves other turns’ calls untouched', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_turn_scoped')
    // Turn 1: open two calls, close one, leave one open at turn end.
    await broker.input({ invocationId, input: userInput('input_1', 'first') })
    controller.startToolCall('t1_closed', 'command')
    controller.startToolCall('t1_open', 'command')
    controller.completeToolCall('t1_closed', 'command')
    controller.completeActiveTurn()
    await flushMicrotasks()

    // Turn 2: open a call and close it normally.
    await broker.input({ invocationId, input: userInput('input_2', 'second') })
    controller.startToolCall('t2_ok', 'command')
    controller.completeToolCall('t2_ok', 'command')
    controller.completeActiveTurn()
    await flushMicrotasks()

    assertExactlyOneTerminalPerStart(events)
    const failures = ofType(events, 'tool.call.failed')
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { toolCallId?: string }).toolCallId).toBe('t1_open')
    // The turn-1 synthesis closed before turn-1's terminal — not turn-2's.
    const turnCompletions = events.filter((e) => e.type === 'turn.completed')
    expect(turnCompletions).toHaveLength(2)
    expect(seqOfFirst(events, 'tool.call.failed')).toBeLessThan(
      turnCompletions[0]?.seq ?? Number.POSITIVE_INFINITY
    )
  })

  test('provider death mid-tool-call synthesizes failed at invocation teardown', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_provider_death')
    await broker.input({ invocationId, input: userInput('input_1', 'go') })
    controller.startToolCall('call_dies', 'command')
    // Provider crashes mid-turn: invocation.failed with the tool call still open,
    // and no turn terminal ever fires.
    controller.crashProvider('harness stalled')
    await flushMicrotasks()

    assertExactlyOneTerminalPerStart(events)
    const failures = ofType(events, 'tool.call.failed')
    expect(failures).toHaveLength(1)
    const payload = failures[0]?.payload as Record<string, unknown>
    expect(payload['toolCallId']).toBe('call_dies')
    expect(payload['code']).toBe('broker_provider_teardown')
    // Synthesized terminal precedes the invocation.failed teardown event.
    expect(seqOfFirst(events, 'tool.call.failed')).toBeLessThan(
      seqOfFirst(events, 'invocation.failed')
    )
    expect(() => validateEventEnvelope(failures[0])).not.toThrow()
  })

  test('no synthesis, no spurious events when there are no open calls at teardown', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_no_open_calls')
    await broker.input({ invocationId, input: userInput('input_1', 'go') })
    controller.startToolCall('call_ok', 'command')
    controller.completeToolCall('call_ok', 'command')
    controller.crashProvider()
    await flushMicrotasks()

    // The only terminal is the driver's own completed; teardown adds nothing.
    expect(ofType(events, 'tool.call.failed')).toHaveLength(0)
    assertExactlyOneTerminalPerStart(events)
  })
})
