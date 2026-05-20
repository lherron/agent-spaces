import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'

const root = new URL('../../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const goldenDir = join(root, 'testdata/codex-app-server/v0')

const now = () => new Date('2026-05-20T18:00:00.000Z')

const scenarioSpec = (
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
    command: Bun.execPath,
    args: [join(fixtureDir, `${scenario}.ts`), '--literal', '$NO_EXPAND', '*.ts'],
    cwd: process.cwd(),
    env: {
      CODEX_HOME: '/tmp/harness-broker-codex-home',
      SECRET_TOKEN: 'red-test-secret-value',
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

const userInput = {
  inputId: 'input_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Please respond.' }],
}

function normalizeEvent(event: InvocationEventEnvelope): InvocationEventEnvelope {
  return JSON.parse(
    JSON.stringify(event, (key, value) => {
      if (key === 'time') return '<time>'
      if (key === 'pid') return '<pid>'
      if (key === 'durationMs') return '<durationMs>'
      return value
    })
  ) as InvocationEventEnvelope
}

async function expectGolden(scenario: string, events: InvocationEventEnvelope[]): Promise<void> {
  const actual = `${events.map((event) => JSON.stringify(normalizeEvent(event))).join('\n')}\n`
  const expected = await readFile(join(goldenDir, `${scenario}.golden.jsonl`), 'utf8')
  expect(actual).toBe(expected)
}

async function runScenario(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [createCodexAppServerDriver()],
    onEvent: (event) => events.push(event),
    now,
  })
  const spec = scenarioSpec(scenario, overrides)

  await broker.start({ spec })
  await broker.input({
    invocationId: spec.invocationId ?? '',
    input: userInput,
    policy: { whenBusy: 'reject' },
  })

  return events
}

describe('Codex app-server driver red scenarios', () => {
  test('starts a fresh thread and completes a turn', async () => {
    const events = await runScenario('start-fresh-turn')
    await expectGolden('start-fresh-turn', events)
  })

  test('resumes an existing thread and completes a turn', async () => {
    const events = await runScenario('resume-existing-turn', {
      continuation: { provider: 'codex', kind: 'thread', key: 'thread_existing' },
      driver: {
        kind: 'codex-app-server',
        resumeThreadId: 'thread_existing',
        resumeFallback: 'fail',
      },
    })
    await expectGolden('resume-existing-turn', events)
  })

  test('falls back to a fresh thread when resume target is missing and fallback is start-fresh', async () => {
    const events = await runScenario('resume-missing-start-fresh', {
      driver: {
        kind: 'codex-app-server',
        resumeThreadId: 'thread_missing',
        resumeFallback: 'start-fresh',
      },
    })
    await expectGolden('resume-missing-start-fresh', events)
  })

  test('fails startup when resume target is missing and fallback is fail', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    await expect(
      broker.start({
        spec: scenarioSpec('resume-missing-fail', {
          driver: {
            kind: 'codex-app-server',
            resumeThreadId: 'thread_missing',
            resumeFallback: 'fail',
          },
        }),
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.HarnessError })
    await expectGolden('resume-missing-fail', events)
  })

  test('maps assistant message deltas and final message content', async () => {
    const events = await runScenario('assistant-deltas')
    await expectGolden('assistant-deltas', events)
  })

  test('maps command, file change, MCP tool, web search, and image view items to tool events', async () => {
    const events = await runScenario('tool-calls')
    await expectGolden('tool-calls', events)
  })

  test('maps token usage updates', async () => {
    const events = await runScenario('usage-update')
    await expectGolden('usage-update', events)
  })

  test.todo('permission request policies are Phase 3 scope per T-01544')

  test('maps startup error notification to diagnostic and terminal invocation.failed', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    await expect(broker.start({ spec: scenarioSpec('startup-error') })).rejects.toMatchObject({
      code: BrokerErrorCode.HarnessError,
    })
    await expectGolden('startup-error', events)
  })

  test('maps child exit during an active turn to turn.failed and invocation.exited', async () => {
    const events = await runScenario('exit-during-turn')
    await expectGolden('exit-during-turn', events)
  })

  test('stops an active invocation with graceful child termination', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('stop-active')
    await broker.start({ spec })
    await broker.input({ invocationId: 'inv_stop_active', input: userInput })
    await broker.stop({
      invocationId: 'inv_stop_active',
      reason: 'operator stop',
      graceMs: 500,
    })
    await expectGolden('stop-active', events)
  })

  test('rejects unsupported steer, append_context, and turn interrupt operations', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('unsupported-controls')
    await broker.start({ spec })

    await expect(
      broker.input({
        invocationId: 'inv_unsupported_controls',
        input: { ...userInput, inputId: 'steer_1', kind: 'steer' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })

    await expect(
      broker.input({
        invocationId: 'inv_unsupported_controls',
        input: { ...userInput, inputId: 'append_1', kind: 'append_context' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })

    await expect(
      broker.interrupt({
        invocationId: 'inv_unsupported_controls',
        scope: 'turn',
        reason: 'red test',
      })
    ).resolves.toEqual({
      accepted: false,
      effect: 'unsupported',
      reason: 'Codex app-server v0 does not support turn interrupt',
    })

    await expectGolden('unsupported-controls', events)
  })
})

describe('Codex app-server process behavior red tests', () => {
  test('spawns exact argv without shell expansion', async () => {
    const events = await runScenario('argv-exact')
    const started = events.find((event) => event.type === 'invocation.started')
    expect(started?.payload).toMatchObject({
      command: Bun.execPath,
      args: [join(fixtureDir, 'argv-exact.ts'), '--literal', '$NO_EXPAND', '*.ts'],
      cwd: process.cwd(),
    })
  })

  test('missing cwd fails with ResourceError before spawning', async () => {
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      now,
    })
    await expect(
      broker.start({
        spec: scenarioSpec('start-fresh-turn', {
          process: {
            ...scenarioSpec('start-fresh-turn').process,
            cwd: join(process.cwd(), 'does-not-exist-for-harness-broker-red-test'),
          },
        }),
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.ResourceError })
  })

  test('does not leak env values into invocation.started or other event payloads', async () => {
    const events = await runScenario('start-fresh-turn')
    const eventJson = JSON.stringify(events)
    expect(eventJson).not.toContain('red-test-secret-value')
    expect(eventJson).not.toContain('/tmp/harness-broker-codex-home')
  })
})
