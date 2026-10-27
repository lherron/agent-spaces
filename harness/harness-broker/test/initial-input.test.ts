import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'
import { inputIdFrom, invocationIdFrom } from './ids'

const root = new URL('..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-05-20T19:30:00.000Z')

const scenarioSpec = (scenario: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom(`inv_initial_input_${scenario.replaceAll('-', '_')}`),
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: process.execPath,
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
  inputId: inputIdFrom('input_initial_1'),
  kind: 'user',
  content: [{ type: 'text', text: 'Initial input via start request.' }],
}

describe('initialInput on InvocationStartRequest', () => {
  test('start with initialInput runs started, ready, accepted, turn in order, identical to start then input', async () => {
    // First: start with initialInput
    const eventsWithInitial: InvocationEventEnvelope[] = []
    const broker1 = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => eventsWithInitial.push(event),
      now,
    })

    const spec1 = scenarioSpec('start-fresh-turn')
    const response = await broker1.start({
      spec: { ...spec1, invocationId: invocationIdFrom('inv_with_initial') },
      initialInput: userInput,
    })
    expect<string | undefined>(response.invocationId).toBe('inv_with_initial')

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let i = 0; i < 50 && !eventsWithInitial.some((e) => e.type === 'turn.completed'); i++) {
      await sleep(50)
    }

    // The initialInput run alone must order started -> ready -> input.accepted ->
    // turn.started -> turn.completed with strictly increasing seq, so the parity
    // check below cannot pass with both paths broken identically.
    const initialTypes = eventsWithInitial.map((e) => e.type)
    const startedIdx = initialTypes.indexOf('invocation.started')
    const readyIdx = initialTypes.indexOf('invocation.ready')
    const acceptedIdx = initialTypes.indexOf('input.accepted')
    const turnStartedIdx = initialTypes.indexOf('turn.started')
    const turnCompletedIdx = initialTypes.indexOf('turn.completed')
    expect(startedIdx).toBeGreaterThanOrEqual(0)
    expect(readyIdx).toBeGreaterThan(startedIdx)
    expect(acceptedIdx).toBeGreaterThan(readyIdx)
    expect(turnStartedIdx).toBeGreaterThan(acceptedIdx)
    expect(turnCompletedIdx).toBeGreaterThan(turnStartedIdx)
    for (let i = 1; i < eventsWithInitial.length; i++) {
      expect(eventsWithInitial[i]!.seq).toBeGreaterThan(eventsWithInitial[i - 1]!.seq)
    }

    // Second: start then separate input call
    const eventsSeparate: InvocationEventEnvelope[] = []
    const broker2 = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => eventsSeparate.push(event),
      now,
    })

    const spec2 = scenarioSpec('start-fresh-turn')
    await broker2.start({ spec: { ...spec2, invocationId: invocationIdFrom('inv_separate') } })
    await broker2.input({
      invocationId: invocationIdFrom('inv_separate'),
      input: userInput,
    })

    for (let i = 0; i < 50 && !eventsSeparate.some((e) => e.type === 'turn.completed'); i++) {
      await sleep(50)
    }

    // The delivery-acknowledged disposition races the fake provider's terminal
    // notification with its turn/start response, so it may land on either side
    // of the provider events. Its cardinality is invariant; the remaining
    // sequence must be identical for initial and separately-submitted input.
    expect(eventsWithInitial.filter((event) => event.type === 'submission.executed')).toHaveLength(
      1
    )
    expect(eventsSeparate.filter((event) => event.type === 'submission.executed')).toHaveLength(1)
    const typesWithInitial = eventsWithInitial
      .filter((event) => event.type !== 'submission.executed')
      .map((event) => event.type)
    const typesSeparate = eventsSeparate
      .filter((event) => event.type !== 'submission.executed')
      .map((event) => event.type)
    expect(typesWithInitial).toEqual(typesSeparate)

    await broker1.stop({ invocationId: invocationIdFrom('inv_with_initial'), reason: 'test done' })
    await broker2.stop({ invocationId: invocationIdFrom('inv_separate'), reason: 'test done' })
  })
})
