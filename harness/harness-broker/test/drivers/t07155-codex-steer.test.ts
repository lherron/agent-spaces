import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createCodexAppServerDriver } from '../../src/drivers/codex-app-server/driver'

/**
 * T-07155 gate G3 — the codex-app-server driver's mid-turn steer.
 *
 * The driver's contract is deliberately narrow: apply the text to the ACTIVE
 * turn via `turn/steer`, or throw. A silent resolve would report a supervisor's
 * order as delivered when it was not, which is the failure this whole task
 * exists to remove.
 */

const root = new URL('../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-08-10T15:00:00.000Z')

const scenarioSpec = (scenario: string, invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, `${scenario}.ts`)],
    cwd: process.cwd(),
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 2000, turnTimeoutMs: 5000, stopGraceMs: 25 },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: {
    kind: 'codex-app-server',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
})

const userInput = (inputId: string, text: string) => ({
  inputId,
  kind: 'user' as const,
  content: [{ type: 'text' as const, text }],
})

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

describe('T-07155 codex-app-server steer', () => {
  test('G3: advertises steer support in busyPolicies', async () => {
    const broker = createBroker({ drivers: [createCodexAppServerDriver()], now })
    const spec = scenarioSpec('steer-active-turn', 'inv_t07155_codex_caps')
    const started = await broker.start({ spec })
    expect(started.capabilities.input.busyPolicies).toContain('steer')
    // The C-14234 correction: input.steer governs kind:'steer' and stays false.
    expect(started.capabilities.input.steer).toBe(false)
    await broker.stop({ invocationId: spec.invocationId! })
  })

  test('G3: steer sends turn/steer with expectedTurnId = the active turn and joins that turn', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('steer-active-turn', 'inv_t07155_codex_steer')
    const invocationId = spec.invocationId!
    await broker.start({ spec })

    await broker.input({ invocationId, input: userInput('input_active', 'do the long thing') })
    await waitFor(() => events.some((event) => event.type === 'turn.started'))

    const response = await broker.input({
      invocationId,
      input: userInput('input_urgent', 'STOP - do not push'),
      policy: { whenBusy: 'steer' },
    })

    expect(response).toMatchObject({
      inputId: 'input_urgent',
      accepted: true,
      disposition: 'attempted_steer',
    })
    // No turn of its own: the order joined the running turn.
    expect(response.turnId).toBeUndefined()

    // The fixture echoes the exact params the driver sent, so the precondition
    // and payload are asserted from the wire rather than the driver's internals.
    const echoOf = (): string | undefined =>
      events
        .map((event) => JSON.stringify(event.payload))
        .find((payload) => payload.includes('expectedTurnId'))
    await waitFor(() => echoOf() !== undefined)
    const echo = echoOf()
    expect(echo).toContain('turn_steer_1')
    expect(echo).toContain('STOP - do not push')

    await broker.stop({ invocationId })
  })

  test('G3: a refused turn/steer throws instead of silently reporting delivery', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('steer-rejected', 'inv_t07155_codex_steer_reject')
    const invocationId = spec.invocationId!
    await broker.start({ spec })

    await broker.input({ invocationId, input: userInput('input_active', 'work') })
    await waitFor(() => events.some((event) => event.type === 'turn.started'))

    const response = await broker.input({
      invocationId,
      input: userInput('input_urgent', 'STOP'),
      policy: { whenBusy: 'steer' },
    })

    // Rejected, and specifically NOT parked on the deferred queue.
    expect(response).toMatchObject({ accepted: false, disposition: 'rejected' })
    expect(events.filter((event) => event.type === 'input.queued')).toHaveLength(0)

    await broker.stop({ invocationId })
  })
})
