import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createCodexAppServerDriver } from '../../src/drivers/codex-app-server/driver'

const root = new URL('../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-05-20T19:45:00.000Z')

const RED_SECRET = 'hb-red-secret-value-17a1'
const RED_TOKEN = 'hb-red-bearer-token-88b2'
const ATTACHMENT_BYTES = 'RAW_ATTACHMENT_BYTES_SHOULD_NOT_APPEAR'

const scenarioSpec = (
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: `inv_redaction_${scenario.replaceAll('-', '_')}`,
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, `${scenario}.ts`)],
    cwd: process.cwd(),
    env: {
      CODEX_HOME: '/tmp/harness-broker-redaction-codex-home',
      HB_RED_SECRET: RED_SECRET,
      HB_BEARER_TOKEN: RED_TOKEN,
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 1000, turnTimeoutMs: 1000, stopGraceMs: 50 },
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
  inputId: 'input_redaction_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Exercise event redaction.' }],
}

async function runScenario(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {},
  input = userInput
): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [createCodexAppServerDriver()],
    onEvent: (event) => events.push(event),
    now,
  })
  const spec = scenarioSpec(scenario, overrides)
  await broker.start({ spec })
  await broker.input({ invocationId: spec.invocationId!, input })
  return events
}

function serializedEventStream(events: InvocationEventEnvelope[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

function escapedRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('Harness Broker event redaction', () => {
  test('invocation.started payload contains pid, command, args, and cwd only', async () => {
    const events = await runScenario('start-fresh-turn')
    const started = events.find((event) => event.type === 'invocation.started')

    expect(Object.keys((started?.payload ?? {}) as Record<string, unknown>).sort()).toEqual([
      'args',
      'command',
      'cwd',
      'pid',
    ])
  })

  test('env values never appear in serialized event JSON under any Codex fake scenario', async () => {
    const scenarioEvents = await Promise.all([
      runScenario('start-fresh-turn'),
      runScenario('resume-existing-turn', {
        continuation: { provider: 'codex', kind: 'thread', key: 'thread_existing' },
        driver: {
          kind: 'codex-app-server',
          resumeThreadId: 'thread_existing',
          resumeFallback: 'fail',
          permissionPolicy: { mode: 'deny' },
        },
      }),
      runScenario('resume-missing-start-fresh', {
        driver: {
          kind: 'codex-app-server',
          resumeThreadId: 'thread_missing',
          resumeFallback: 'start-fresh',
          permissionPolicy: { mode: 'deny' },
        },
      }),
      runScenario('assistant-deltas'),
      runScenario('tool-calls'),
      runScenario('usage-update'),
      runScenario('permission-request'),
      runScenario('exit-during-turn'),
      runScenario('leaky-diagnostic'),
    ])
    const eventStream = serializedEventStream(scenarioEvents.flat())
    const forbiddenValues = [RED_SECRET, RED_TOKEN, '/tmp/harness-broker-redaction-codex-home']

    for (const value of forbiddenValues) {
      expect(eventStream).not.toMatch(new RegExp(escapedRegexLiteral(value)))
    }
  })

  test('authorization headers and bearer tokens are redacted in diagnostic events', async () => {
    const events = await runScenario('leaky-diagnostic')
    const diagnosticJson = serializedEventStream(
      events.filter((event) => event.type === 'diagnostic')
    )

    expect(diagnosticJson).not.toMatch(/Authorization:\s*Bearer\s+\S+/i)
    expect(diagnosticJson).not.toMatch(/[A-Za-z0-9-]*Token:\s*\S+/i)
    expect(diagnosticJson).not.toMatch(/Bearer\s+hb-red-bearer-token-88b2/i)
  })

  test('attachment binary content is never emitted; only paths are visible', async () => {
    const attachmentPath = join(
      process.cwd(),
      'packages/harness-broker/testdata/redaction-image.bin'
    )
    const events = await runScenario(
      'attachment-echo',
      {},
      {
        inputId: 'input_attachment_1',
        kind: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Inspect attached image.' },
          { type: 'local_image' as const, path: attachmentPath },
        ],
      }
    )
    const eventStream = serializedEventStream(events)

    expect(eventStream).toContain(attachmentPath)
    expect(eventStream).not.toContain(ATTACHMENT_BYTES)
  })
})
