import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'

const root = new URL('..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-05-20T19:15:00.000Z')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const scenarioSpec = (scenario: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: `inv_input_${scenario.replaceAll('-', '_')}`,
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
    limits: { startupTimeoutMs: 1000, turnTimeoutMs: 1000, stopGraceMs: 25 },
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

const userInput = {
  inputId: 'input_user_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Start a turn.' }],
}

describe('Invocation input policy', () => {
  test('kind steer with whenBusy reject is rejected as UnsupportedCapability', async () => {
    const broker = createBroker({ drivers: [createCodexAppServerDriver()], now })
    const spec = scenarioSpec('start-fresh-turn')
    await broker.start({ spec })

    await expect(
      broker.input({
        invocationId: spec.invocationId!,
        input: { ...userInput, inputId: 'steer_1', kind: 'steer' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })
  })

  test('kind append_context is rejected as UnsupportedCapability', async () => {
    const broker = createBroker({ drivers: [createCodexAppServerDriver()], now })
    const spec = scenarioSpec('start-fresh-turn')
    await broker.start({ spec })

    await expect(
      broker.input({
        invocationId: spec.invocationId!,
        input: { ...userInput, inputId: 'append_1', kind: 'append_context' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })
  })

  test('two simultaneous user inputs reject the second while a turn is active', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('slow-turn')
    await broker.start({ spec })

    const first = broker.input({ invocationId: spec.invocationId!, input: userInput })
    for (let i = 0; i < 20 && !events.some((event) => event.type === 'turn.started'); i += 1) {
      await sleep(10)
    }

    await expect(
      broker.input({
        invocationId: spec.invocationId!,
        input: { ...userInput, inputId: 'input_user_2' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.InputRejected })

    await broker.stop({ invocationId: spec.invocationId!, reason: 'test cleanup', graceMs: 25 })
    await expect(first).resolves.toMatchObject({ accepted: true, disposition: 'started' })
  })
})
