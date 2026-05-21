import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'

const root = new URL('..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-05-20T19:30:00.000Z')

const scenarioSpec = (scenario: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: `inv_initial_input_${scenario.replaceAll('-', '_')}`,
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, `${scenario}.ts`)],
    cwd: process.cwd(),
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 250 },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'codex-app-server',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
})

const userInput: InvocationInput = {
  inputId: 'input_initial_1',
  kind: 'user',
  content: [{ type: 'text', text: 'Initial input via start request.' }],
}

describe('initialInput on InvocationStartRequest', () => {
  test('start with initialInput emits correct event sequence without separate input() call', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    const spec = scenarioSpec('start-fresh-turn')
    const response = await broker.start({ spec, initialInput: userInput })

    expect(response.invocationId).toBe(spec.invocationId)

    // Wait for turn to complete (fake-codex completes synchronously after turn/start)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'turn.completed'); i++) {
      await sleep(50)
    }

    const eventTypes = events.map((e) => e.type)

    // Must see the full event sequence
    expect(eventTypes).toContain('invocation.started')
    expect(eventTypes).toContain('invocation.ready')
    expect(eventTypes).toContain('input.accepted')
    expect(eventTypes).toContain('turn.started')
    expect(eventTypes).toContain('turn.completed')

    // Correct ordering: started -> ready -> input.accepted -> turn.started -> turn.completed
    const startedIdx = eventTypes.indexOf('invocation.started')
    const readyIdx = eventTypes.indexOf('invocation.ready')
    const acceptedIdx = eventTypes.indexOf('input.accepted')
    const turnStartedIdx = eventTypes.indexOf('turn.started')
    const turnCompletedIdx = eventTypes.indexOf('turn.completed')

    expect(readyIdx).toBeGreaterThan(startedIdx)
    expect(acceptedIdx).toBeGreaterThan(readyIdx)
    expect(turnStartedIdx).toBeGreaterThan(acceptedIdx)
    expect(turnCompletedIdx).toBeGreaterThan(turnStartedIdx)

    // Sequence numbers should be monotonically increasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
    }

    // Clean up
    await broker.stop({ invocationId: spec.invocationId!, reason: 'test done' })
  })

  test('start without initialInput preserves existing behavior (no input events)', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    const spec = scenarioSpec('start-fresh-turn')
    const response = await broker.start({ spec })

    expect(response.invocationId).toBe(spec.invocationId)
    expect(response.state).toBe('ready')

    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('invocation.started')
    expect(eventTypes).toContain('invocation.ready')
    expect(eventTypes).not.toContain('input.accepted')
    expect(eventTypes).not.toContain('turn.started')

    await broker.stop({ invocationId: spec.invocationId!, reason: 'test done' })
  })

  test('initialInput event ordering matches equivalent start + input flow', async () => {
    // First: start with initialInput
    const eventsWithInitial: InvocationEventEnvelope[] = []
    const broker1 = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => eventsWithInitial.push(event),
      now,
    })

    const spec1 = scenarioSpec('start-fresh-turn')
    await broker1.start({ spec: { ...spec1, invocationId: 'inv_with_initial' }, initialInput: userInput })

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let i = 0; i < 50 && !eventsWithInitial.some((e) => e.type === 'turn.completed'); i++) {
      await sleep(50)
    }

    // Second: start then separate input call
    const eventsSeparate: InvocationEventEnvelope[] = []
    const broker2 = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => eventsSeparate.push(event),
      now,
    })

    const spec2 = scenarioSpec('start-fresh-turn')
    await broker2.start({ spec: { ...spec2, invocationId: 'inv_separate' } })
    await broker2.input({
      invocationId: 'inv_separate',
      input: userInput,
    })

    for (let i = 0; i < 50 && !eventsSeparate.some((e) => e.type === 'turn.completed'); i++) {
      await sleep(50)
    }

    // Both should have the same event type sequence
    const typesWithInitial = eventsWithInitial.map((e) => e.type)
    const typesSeparate = eventsSeparate.map((e) => e.type)
    expect(typesWithInitial).toEqual(typesSeparate)
  })
})
