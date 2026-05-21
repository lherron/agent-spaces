import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'

const root = new URL('..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-05-20T19:00:00.000Z')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const scenarioSpec = (
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: `inv_timeout_${scenario.replaceAll('-', '_')}`,
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
    limits: {
      startupTimeoutMs: 25,
      turnTimeoutMs: 25,
      stopGraceMs: 25,
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

const userInput = {
  inputId: 'input_timeout_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Wait long enough to timeout.' }],
}

describe('Harness Broker timeout handling', () => {
  test('startupTimeoutMs emits invocation.failed with Timeout', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('slow-startup')

    const start = broker.start({ spec })
    await sleep(75)
    await broker.stop({ invocationId: spec.invocationId!, reason: 'test cleanup', graceMs: 25 })

    await expect(start).rejects.toMatchObject({ code: BrokerErrorCode.Timeout })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'invocation.failed',
        payload: expect.objectContaining({ code: 'Timeout' }),
      })
    )
  })

  test('turnTimeoutMs emits turn.failed with Timeout', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('slow-turn', {
      process: {
        ...scenarioSpec('slow-turn').process,
        limits: {
          startupTimeoutMs: 500,
          turnTimeoutMs: 25,
          stopGraceMs: 25,
        },
      },
    })
    await broker.start({ spec })

    const input = broker.input({ invocationId: spec.invocationId!, input: userInput })
    await sleep(75)
    await broker.stop({ invocationId: spec.invocationId!, reason: 'test cleanup', graceMs: 25 })

    await expect(input).rejects.toMatchObject({ code: BrokerErrorCode.Timeout })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.failed',
        payload: expect.objectContaining({ status: 'failed', code: 'Timeout' }),
      })
    )
  })

  test('stopGraceMs kills a non-exiting child and emits invocation.exited', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('stubborn-stop', {
      process: {
        ...scenarioSpec('stubborn-stop').process,
        limits: {
          startupTimeoutMs: 500,
          turnTimeoutMs: 25,
          stopGraceMs: 25,
        },
      },
    })
    await broker.start({ spec })
    const input = broker.input({ invocationId: spec.invocationId!, input: userInput })
    await sleep(25)

    const stopped = await broker.stop({
      invocationId: spec.invocationId!,
      reason: 'operator stop',
      graceMs: 25,
    })

    expect(stopped).toMatchObject({ accepted: true, state: 'exited' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'invocation.exited',
        payload: expect.objectContaining({ signal: 'SIGKILL' }),
      })
    )
    await expect(input).resolves.toMatchObject({ accepted: true })
  })
})
