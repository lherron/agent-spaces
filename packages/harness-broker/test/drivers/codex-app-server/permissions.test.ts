import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  PermissionPolicy,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'

const root = new URL('../../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const now = () => new Date('2026-05-20T19:30:00.000Z')

const scenarioSpec = (
  permissionPolicy: PermissionPolicy,
  invocationId = 'inv_permission_request'
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, 'permission-request.ts')],
    cwd: process.cwd(),
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
    permissionPolicy,
  },
})

const userInput = {
  inputId: 'input_permission_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Trigger a command permission request.' }],
}

async function runPermissionScenario(options: {
  permissionPolicy: PermissionPolicy
  clientPermissionRequests?: boolean | undefined
  invocationId?: string | undefined
}): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [createCodexAppServerDriver()],
    onEvent: (event) => events.push(event),
    now,
  })
  await broker.hello({
    clientInfo: { name: 'permission-red-test', version: '0.1.0' },
    protocolVersions: ['harness-broker/0.1'],
    capabilities: { permissionRequests: options.clientPermissionRequests ?? false },
  })
  const spec = scenarioSpec(
    options.permissionPolicy,
    options.invocationId ?? `inv_permission_${options.permissionPolicy.mode}`
  )
  await broker.start({ spec })
  await broker.input({ invocationId: spec.invocationId!, input: userInput })
  return events
}

function permissionRequestEvents(events: InvocationEventEnvelope[]): InvocationEventEnvelope[] {
  return events.filter((event) => (event.type as string) === 'invocation.permission.request')
}

function finalOutput(events: InvocationEventEnvelope[]): string | undefined {
  const completed = events.find((event) => event.type === 'turn.completed')
  const payload = completed?.payload as { finalOutput?: string } | undefined
  return payload?.finalOutput
}

describe('Codex app-server permission policies', () => {
  test('mode deny immediately denies all requests without sending broker-to-client requests', async () => {
    const events = await runPermissionScenario({ permissionPolicy: { mode: 'deny' } })

    expect(permissionRequestEvents(events)).toHaveLength(0)
    expect(finalOutput(events)).toBe('permission denied')
  })

  test('mode allow immediately approves all requests', async () => {
    const events = await runPermissionScenario({ permissionPolicy: { mode: 'allow' } })

    expect(permissionRequestEvents(events)).toHaveLength(0)
    expect(finalOutput(events)).toBe('permission approved')
  })

  test('mode ask-client with negotiated permissionRequests sends a broker-to-client request and honors allow', async () => {
    const events = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
      clientPermissionRequests: true,
    })

    expect(permissionRequestEvents(events)).toHaveLength(1)
    expect(permissionRequestEvents(events)[0]?.payload).toMatchObject({
      kind: 'command',
      defaultDecision: 'deny',
    })
    expect(finalOutput(events)).toBe('permission approved')
  })

  test('mode ask-client timeout applies defaultDecision when present', async () => {
    const events = await runPermissionScenario({
      permissionPolicy: {
        mode: 'ask-client',
        timeoutMs: 25,
        defaultDecision: 'allow',
      } as PermissionPolicy,
      clientPermissionRequests: true,
      invocationId: 'inv_permission_timeout_default',
    })

    expect(finalOutput(events)).toBe('permission approved')
  })

  test('mode ask-client timeout without defaultDecision denies', async () => {
    const events = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 25 },
      clientPermissionRequests: true,
      invocationId: 'inv_permission_timeout_deny',
    })

    expect(finalOutput(events)).toBe('permission denied')
  })

  test('mode ask-client without negotiated permissionRequests denies and emits a diagnostic reason', async () => {
    const events = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 25 },
      clientPermissionRequests: false,
      invocationId: 'inv_permission_unnegotiated',
    })

    expect(permissionRequestEvents(events)).toHaveLength(0)
    expect(finalOutput(events)).toBe('permission denied')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'diagnostic',
        payload: expect.objectContaining({
          level: 'warn',
          message: expect.stringMatching(/permissionRequests.*not negotiated/i),
        }),
      })
    )
  })
})
