import { describe, expect, test } from 'bun:test'
import type {
  ClientCapabilities,
  CodexAppServerDriverSpec,
  InvocationEventEnvelope,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import {
  type PermissionHandlerContext,
  handlePermissionRequest,
} from '../../../src/drivers/codex-app-server/permissions'
import type { JsonRpcRequest } from '../../../src/drivers/codex-app-server/rpc-client'
import type { DriverContext } from '../../../src/drivers/driver'

const invocationId = 'inv_permission_contract'
const turnId = 'turn_permission_contract'
const inputId = 'input_permission_contract'
// Lives only in the request's `env` block — must NEVER appear in the bounded
// display subject, because `env` is not a projected field.
const rawSecret = 'sk-live-final-contract-secret'
// command/cwd ARE safe display fields and are positively projected.
const displayCommand = 'printf hello-from-contract'
const displayCwd = '/tmp/final-permission-contract'

const codexPermissionRequest: JsonRpcRequest = {
  jsonrpc: '2.0',
  id: 'perm_1',
  method: 'item/commandExecution/requestApproval',
  params: {
    command: displayCommand,
    cwd: displayCwd,
    env: {
      OPENAI_API_KEY: rawSecret,
    },
  },
}

type RequestPermissionHandler = (params: PermissionRequestParams) => Promise<PermissionDecision>

interface PermissionScenarioResult {
  response: unknown
  events: InvocationEventEnvelope[]
  permissionRequests: PermissionRequestParams[]
}

function permissionEvents(
  events: InvocationEventEnvelope[],
  type: InvocationEventEnvelope['type']
) {
  return events.filter((event) => event.type === type)
}

async function runPermissionScenario(options: {
  permissionPolicy: PermissionPolicy
  clientCapabilities?: ClientCapabilities | undefined
  requestPermission?: RequestPermissionHandler | undefined
}): Promise<PermissionScenarioResult> {
  const events: InvocationEventEnvelope[] = []
  const permissionRequests: PermissionRequestParams[] = []

  const ctx = {
    invocationId,
    clientCapabilities: options.clientCapabilities ?? {},
    emit(type, payload, extra) {
      const event = {
        invocationId,
        seq: events.length + 1,
        time: '2026-05-20T19:30:00.000Z',
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
    async requestPermission(params: PermissionRequestParams): Promise<PermissionDecision> {
      permissionRequests.push(params)
      if (!options.requestPermission) {
        throw new Error('requestPermission spy was called without a handler')
      }
      return options.requestPermission(params)
    },
  } satisfies DriverContext & { requestPermission: RequestPermissionHandler }

  const driver: CodexAppServerDriverSpec = {
    kind: 'codex-app-server',
    resumeFallback: 'start-fresh',
    permissionPolicy: options.permissionPolicy,
  }

  const response = await handlePermissionRequest(codexPermissionRequest, {
    ctx,
    driver,
    currentTurnId: turnId,
    currentInputId: inputId,
  } satisfies PermissionHandlerContext)

  return { response, events, permissionRequests }
}

describe('Codex app-server permission policies', () => {
  const policyCases: Array<{
    name: string
    permissionPolicy: PermissionPolicy
    expectedDecision: 'allow' | 'deny'
    expectedResponse: 'approve' | 'decline'
    expectedDefaultDecision: 'allow' | 'deny'
  }> = [
    {
      name: 'mode deny emits audit events and declines by policy',
      permissionPolicy: { mode: 'deny' },
      expectedDecision: 'deny',
      expectedResponse: 'decline',
      expectedDefaultDecision: 'deny',
    },
    {
      name: 'mode allow emits audit events and approves by policy',
      permissionPolicy: { mode: 'allow' },
      expectedDecision: 'allow',
      expectedResponse: 'approve',
      expectedDefaultDecision: 'allow',
    },
  ]

  for (const scenario of policyCases) {
    test(scenario.name, async () => {
      const { response, events, permissionRequests } = await runPermissionScenario({
        permissionPolicy: scenario.permissionPolicy,
      })

      expect(permissionRequests).toHaveLength(0)
      expect(response).toEqual({ decision: scenario.expectedResponse })
      expect(permissionEvents(events, 'permission.requested')).toHaveLength(1)
      expect(permissionEvents(events, 'permission.requested')[0]?.payload).toMatchObject({
        kind: 'command',
        defaultDecision: scenario.expectedDefaultDecision,
      })
      expect(permissionEvents(events, 'permission.resolved')).toHaveLength(1)
      expect(permissionEvents(events, 'permission.resolved')[0]?.payload).toMatchObject({
        decision: scenario.expectedDecision,
        decidedBy: 'policy',
      })
    })
  }

  test('mode ask-client without negotiated permissionRequests denies by policy with diagnostic', async () => {
    const { response, events, permissionRequests } = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 25 },
      clientCapabilities: { permissionRequests: false },
    })

    expect(permissionRequests).toHaveLength(0)
    expect(response).toEqual({ decision: 'decline' })
    expect(permissionEvents(events, 'permission.requested')).toHaveLength(1)
    expect(permissionEvents(events, 'permission.resolved')[0]?.payload).toMatchObject({
      decision: 'deny',
      decidedBy: 'policy',
    })
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

  const clientDecisionCases: Array<{
    name: string
    clientDecision: 'allow' | 'deny'
    expectedResponse: 'approve' | 'decline'
  }> = [
    {
      name: 'mode ask-client uses broker-to-client request transport and honors allow',
      clientDecision: 'allow',
      expectedResponse: 'approve',
    },
    {
      name: 'mode ask-client uses broker-to-client request transport and honors deny',
      clientDecision: 'deny',
      expectedResponse: 'decline',
    },
  ]

  for (const scenario of clientDecisionCases) {
    test(scenario.name, async () => {
      const { response, events, permissionRequests } = await runPermissionScenario({
        permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
        clientCapabilities: { permissionRequests: true },
        requestPermission: async () => ({ decision: scenario.clientDecision }),
      })

      expect(permissionRequests).toHaveLength(1)
      expect(permissionRequests[0]).toMatchObject({
        invocationId,
        turnId,
        kind: 'command',
        defaultDecision: 'deny',
      })
      expect(response).toEqual({ decision: scenario.expectedResponse })
      expect(permissionEvents(events, 'permission.resolved')[0]?.payload).toMatchObject({
        decision: scenario.clientDecision,
        decidedBy: 'user',
      })
      expect(
        events.some((event) => event.type === ('invocation.permission.request' as never))
      ).toBe(false)
    })
  }

  const timeoutCases: Array<{
    name: string
    permissionPolicy: PermissionPolicy
    expectedDecision: 'allow' | 'deny'
    expectedResponse: 'approve' | 'decline'
  }> = [
    {
      name: 'mode ask-client timeout applies defaultDecision allow',
      permissionPolicy: { mode: 'ask-client', timeoutMs: 5, defaultDecision: 'allow' },
      expectedDecision: 'allow',
      expectedResponse: 'approve',
    },
    {
      name: 'mode ask-client timeout applies defaultDecision deny',
      permissionPolicy: { mode: 'ask-client', timeoutMs: 5, defaultDecision: 'deny' },
      expectedDecision: 'deny',
      expectedResponse: 'decline',
    },
    {
      name: 'mode ask-client timeout without defaultDecision denies',
      permissionPolicy: { mode: 'ask-client', timeoutMs: 5 },
      expectedDecision: 'deny',
      expectedResponse: 'decline',
    },
  ]

  for (const scenario of timeoutCases) {
    test(scenario.name, async () => {
      const { response, events, permissionRequests } = await runPermissionScenario({
        permissionPolicy: scenario.permissionPolicy,
        clientCapabilities: { permissionRequests: true },
        requestPermission: async () => new Promise<PermissionDecision>(() => {}),
      })

      expect(permissionRequests).toHaveLength(1)
      expect(response).toEqual({ decision: scenario.expectedResponse })
      expect(permissionEvents(events, 'permission.resolved')[0]?.payload).toMatchObject({
        decision: scenario.expectedDecision,
        decidedBy: 'timeout',
      })
    })
  }

  test('mode ask-client handler failure without defaultDecision denies', async () => {
    const { response, events, permissionRequests } = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
      clientCapabilities: { permissionRequests: true },
      requestPermission: async () => {
        throw new Error('client handler failed')
      },
    })

    expect(permissionRequests).toHaveLength(1)
    expect(response).toEqual({ decision: 'decline' })
    expect(permissionEvents(events, 'permission.resolved')[0]?.payload).toMatchObject({
      decision: 'deny',
      decidedBy: 'api',
    })
  })

  test('mode ask-client has no optimistic approval path when no defaultDecision is configured', async () => {
    const { response, events, permissionRequests } = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
      clientCapabilities: { permissionRequests: true },
      requestPermission: async () => new Promise<PermissionDecision>(() => {}),
    })

    expect(permissionRequests).toHaveLength(1)
    expect(response).toEqual({ decision: 'decline' })
    expect(permissionEvents(events, 'permission.resolved')[0]?.payload).toMatchObject({
      decision: 'deny',
      decidedBy: 'timeout',
    })
  })

  test('permission.requested emits a bounded subjectDisplay that projects safe fields and omits env', async () => {
    const { events } = await runPermissionScenario({
      permissionPolicy: { mode: 'allow' },
    })

    const requested = permissionEvents(events, 'permission.requested')[0]
    const payload = requested?.payload as { subjectDisplay?: Record<string, unknown> }
    expect(payload).toHaveProperty('subjectDisplay')
    // Positive projection: the safe command/cwd fields are present...
    expect(payload.subjectDisplay).toEqual({
      command: displayCommand,
      cwd: displayCwd,
    })
    // ...and the `env` block is omitted entirely, so no env-derived secret leaks.
    expect(payload.subjectDisplay).not.toHaveProperty('env')
    expect(JSON.stringify(requested?.payload)).not.toContain(rawSecret)
  })

  test('subjectDisplay forwarded to the client matches the audited bounded subject', async () => {
    const { permissionRequests } = await runPermissionScenario({
      permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
      clientCapabilities: { permissionRequests: true },
      requestPermission: async () => ({ decision: 'allow' }),
    })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]?.subject).toEqual({
      command: displayCommand,
      cwd: displayCwd,
    })
    expect(JSON.stringify(permissionRequests[0])).not.toContain(rawSecret)
  })
})
