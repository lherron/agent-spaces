import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

// T-04846: the broker MUST guarantee exactly one `turn.started` for every
// DELIVERED input (input.accepted / disposition:'started'), synthesized from
// applyInputNow's returned turnId — NOT dependent on a driver/hook start. The
// live incident (smokey@agent-spaces:T-04829) was an idle claude-code-tmux
// dispatch where the Claude UserPromptSubmit hook never fired, so the turn body
// + terminal orphaned with no open bracket and HRC reaped the run failed.

const now = () => new Date('2026-06-16T19:30:00.000Z')

// Drain is intentionally microtask-scheduled by the broker queue implementation.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

const testSpec = (
  invocationId: string,
  interaction: HarnessInvocationSpec['interaction'] = {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  }
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

const userInput = (inputId: string, text: string): InvocationInput => ({
  inputId,
  kind: 'user',
  content: [{ type: 'text', text }],
})

const setup = async (
  invocationId: string,
  options: {
    suppressTurnStarted?: boolean
    interactionMode?: 'headless' | 'interactive'
    supportsSteer?: boolean
  } = {}
) => {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({
    suppressTurnStarted: options.suppressTurnStarted,
    supportsSteer: options.supportsSteer,
  })
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event) => events.push(event),
    now,
  })
  const spec = testSpec(invocationId, {
    mode: options.interactionMode ?? 'headless',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  })
  await broker.start({ spec })
  return { broker, controller, events, invocationId }
}

const ofType = (events: InvocationEventEnvelope[], type: InvocationEventEnvelope['type']) =>
  events.filter((event) => event.type === type)

const BODY_OR_TERMINAL = new Set<InvocationEventEnvelope['type']>([
  'user.message',
  'assistant.message',
  'tool.call.started',
  'tool.call.completed',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
])

describe('broker-guaranteed turn.started bracket (T-04846)', () => {
  test('delivered IDLE input with NO driver/hook start still emits exactly one turn.started before any body/terminal', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_idle_no_hook', {
      suppressTurnStarted: true,
    })

    await broker.input({ invocationId, input: userInput('input_idle', 'do the thing') })
    // Body/terminal arrive only AFTER delivery — model the harness completing.
    controller.completeActiveTurn()
    await flushMicrotasks()

    const starts = ofType(events, 'turn.started')
    expect(starts).toHaveLength(1)
    // Synthesized from the delivered input's turnId, provenance-visible.
    expect(starts[0]?.payload).toMatchObject({ source: 'broker-delivery' })
    expect(starts[0]?.turnId).toBeDefined()
    expect((starts[0]?.payload as { turnId?: string }).turnId).toBe(starts[0]?.turnId)

    // Ordering: the (single) turn.started strictly precedes the first body or
    // terminal event in the projected stream.
    const startSeq = events.findIndex((e) => e.type === 'turn.started')
    const firstBodySeq = events.findIndex((e) => BODY_OR_TERMINAL.has(e.type))
    expect(startSeq).toBeGreaterThanOrEqual(0)
    expect(firstBodySeq).toBeGreaterThan(startSeq)
  })

  test('queued-then-drained input also emits exactly one broker-delivery turn.started', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_drain_no_hook', {
      suppressTurnStarted: true,
    })

    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    await broker.input({
      invocationId,
      input: userInput('input_queued', 'queued while busy'),
      policy: { whenBusy: 'queue' },
    })

    // Finish the active turn → drains the queued input through the SAME
    // applyAndEmit path, which must guarantee its bracket too.
    controller.completeActiveTurn()
    await flushMicrotasks()
    controller.completeActiveTurn()
    await flushMicrotasks()

    const starts = ofType(events, 'turn.started')
    expect(starts).toHaveLength(2)
    expect(
      starts.every((s) => (s.payload as { source?: string }).source === 'broker-delivery')
    ).toBe(true)
    // The drained start is attributed to the queued input.
    expect(starts.at(-1)).toMatchObject({ inputId: 'input_queued' })
  })

  test('attempted_steer does NOT emit a synthetic turn.started', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_steer_no_start', {
      interactionMode: 'interactive',
      supportsSteer: true,
      suppressTurnStarted: true,
    })

    // First input opens the active turn (one broker-delivery start).
    await broker.input({ invocationId, input: userInput('input_active', 'active') })
    // Second input while busy is an attempted steer — must NOT open a turn.
    const response = await broker.input({
      invocationId,
      input: userInput('input_steer', 'steer text'),
      policy: { whenBusy: 'queue' },
    })

    expect(response).toMatchObject({ disposition: 'attempted_steer' })
    expect(controller.steeredInputs.map((i) => i.inputId)).toEqual(['input_steer'])
    // Exactly one start total — the steer added none.
    expect(ofType(events, 'turn.started')).toHaveLength(1)
    expect(
      ofType(events, 'turn.started').every(
        (s) => (s.payload as { source?: string }).source === 'broker-delivery'
      )
    ).toBe(true)
  })

  test('no double-start when the driver/hook ALSO observes the start (dedupe by turnId)', async () => {
    // Default test-driver emits its own turn.started in applyInputNow (models a
    // hook-observed start). The broker also synthesizes from the returned
    // turnId — emit() must dedupe so the turn opens exactly once.
    const { broker, controller, events, invocationId } = await setup('inv_dedupe_double_observe')

    await broker.input({ invocationId, input: userInput('input_dedupe', 'go') })
    controller.completeActiveTurn()
    await flushMicrotasks()

    const starts = ofType(events, 'turn.started')
    expect(starts).toHaveLength(1)
    // The hook-observed start landed first (during applyInputNow) and won, so
    // its payload carries no broker-delivery provenance.
    expect((starts[0]?.payload as { source?: string }).source).toBeUndefined()
    // And there is exactly one terminal closing that single bracket.
    expect(ofType(events, 'turn.completed')).toHaveLength(1)
  })
})
