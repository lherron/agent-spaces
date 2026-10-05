/** Drive the codex-app-server driver against a scripted fake Codex from test/fixtures/fake-codex. */
import { expect } from 'bun:test'
import { join, resolve } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'
import type { EventLedger } from '../../../src/event-ledger'

const root = new URL('../../..', import.meta.url).pathname
export const fixtureDir = join(root, 'test/fixtures/fake-codex')
export const goldenDir = join(root, 'testdata/codex-app-server/v0')

/**
 * The anchor the goldens' `<cwd>/…` paths are relative to (T-07994).
 *
 * It is the REPO root resolved from this file, not `process.cwd()`: a golden
 * redacted against the process's working directory only reproduces from the one
 * directory it was recorded in, so `bun test` from `harness/harness-broker/`
 * failed the ten path-bearing cases that pass from the repo root. Resolving it
 * from `import.meta.url` makes the redaction — and the spawn cwd the goldens
 * record — a property of the checkout rather than of how the suite was invoked.
 */
export const repoRoot = resolve(root, '../..')

export const now = () => new Date('2026-05-20T18:00:00.000Z')

export const scenarioSpec = (
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: `inv_${scenario.replaceAll('-', '_')}`,
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: process.execPath,
    args: [join(fixtureDir, `${scenario}.ts`), '--literal', '$NO_EXPAND', '*.ts'],
    cwd: repoRoot,
    lockedEnv: {
      CODEX_HOME: '/tmp/harness-broker-codex-home',
      ASP_RED_TEST_VALUE: 'red-test-secret-value',
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: {
      startupTimeoutMs: 5000,
      turnTimeoutMs: 5000,
      stopGraceMs: 500,
    },
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
  ...overrides,
})

export const userInput = {
  inputId: 'input_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Please respond.' }],
}

export const eventTypes = (events: InvocationEventEnvelope[]) => events.map((event) => event.type)

export const eventDump = (events: InvocationEventEnvelope[]) =>
  `events:\n${events.map((event) => JSON.stringify(event)).join('\n')}`

export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate(), message).toBe(true)
}

/** Wait until any event satisfies `predicate`, failing with the event dump. */
export function waitForEvent(
  events: InvocationEventEnvelope[],
  predicate: (event: InvocationEventEnvelope) => boolean
): Promise<void> {
  return waitFor(() => events.some(predicate), eventDump(events))
}

/** A broker with only the codex-app-server driver at the fixed test clock, recording events. */
export function appServerBroker(options: { eventLedger?: EventLedger } = {}) {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [createCodexAppServerDriver()],
    ...(options.eventLedger !== undefined ? { eventLedger: options.eventLedger } : {}),
    onEvent: (event) => events.push(event),
    now,
  })
  return { broker, events }
}

/** Start `scenario` and submit the one user input; does not wait for the turn. */
export async function startScenario(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
) {
  const { broker, events } = appServerBroker()
  const spec = scenarioSpec(scenario, overrides)

  await broker.start({ spec })
  await broker.input({
    invocationId: spec.invocationId ?? '',
    input: userInput,
    policy: { whenBusy: 'reject' },
  })
  return { broker, events, invocationId: spec.invocationId ?? '' }
}

/** Start `scenario`, submit one input, and wait for the first terminal or warning. */
export async function runScenario(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): Promise<InvocationEventEnvelope[]> {
  const { events } = await startScenario(scenario, overrides)
  await waitForEvent(
    events,
    (event) =>
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'invocation.failed' ||
      event.type === 'invocation.exited' ||
      event.type === 'capture.warning'
  )
  return events
}
