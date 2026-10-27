import { describe, expect, test } from 'bun:test'
import type {
  ClientCapabilities,
  CodexAppServerDriverSpec,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventType,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import {
  type PermissionHandlerContext,
  createPermissionRequestIdAllocator,
  openPermissionRequest,
  permissionRequestedPayload,
  resolvePermissionRequest,
} from '../../../src/drivers/codex-app-server/permissions'
import type { JsonRpcRequest } from '../../../src/drivers/codex-app-server/rpc-client'
import type { DriverContext } from '../../../src/drivers/driver'
import { inputIdFrom, invocationIdFrom, turnIdFrom } from '../../ids'
import { startScenario, waitForEvent } from './fake-codex-scenario'

const invocationId = invocationIdFrom('inv_permission_contract')
const turnId = turnIdFrom('turn_permission_contract')
const inputId = inputIdFrom('input_permission_contract')
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

type EmitExtra = Parameters<DriverContext['emitEvent']>[1]

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
  request?: JsonRpcRequest | undefined
  permissionRequestIds?: PermissionHandlerContext['permissionRequestIds'] | undefined
}): Promise<PermissionScenarioResult> {
  const events: InvocationEventEnvelope[] = []
  const permissionRequests: PermissionRequestParams[] = []

  function emitEvent<K extends InvocationEventType>(
    event: InvocationEventFor<K>,
    extra?: EmitExtra
  ): InvocationEventEnvelope<K>
  function emitEvent(event: InvocationEvent, extra?: EmitExtra): InvocationEventEnvelope {
    const envelope = {
      invocationId,
      seq: events.length + 1,
      time: '2026-05-20T19:30:00.000Z',
      ...event,
      ...extra,
    } as InvocationEventEnvelope
    events.push(envelope)
    return envelope
  }

  const ctx = {
    invocationId,
    clientCapabilities: options.clientCapabilities ?? {},
    emit: (type, payload, extra) => emitEvent({ type, payload }, extra),
    emitEvent,
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

  const handlerCtx: PermissionHandlerContext = {
    ctx,
    driver,
    currentTurnId: turnId,
    currentInputId: inputId,
    permissionRequestIds: options.permissionRequestIds ?? createPermissionRequestIdAllocator(),
  }
  // The ask and the answer are separate seams under T-07870 (the driver commits
  // the provider's request frame between them). This composes them exactly as
  // the driver does, minus the capture gate, so the audit contract below is
  // asserted over the same emissions a live invocation produces.
  const extra = { turnId, inputId }
  const opened = openPermissionRequest(options.request ?? codexPermissionRequest, handlerCtx)
  ctx.emit('permission.requested', permissionRequestedPayload(opened), extra)
  const response = await resolvePermissionRequest(opened, handlerCtx, {
    resolved: (payload) => ctx.emit('permission.resolved', payload, extra),
    diagnostic: (payload) => ctx.emit('diagnostic', payload, extra),
  })

  return { response, events, permissionRequests }
}

describe('Codex app-server permission policies', () => {
  // Policy deny/allow through the real broker against the permission-request
  // fake Codex: the answer Codex receives is echoed back as the command result.
  test.each([
    {
      mode: 'deny' as const,
      decision: 'deny',
      answer: 'decline',
      finalOutput: 'permission denied',
    },
    {
      mode: 'allow' as const,
      decision: 'allow',
      answer: 'approve',
      finalOutput: 'permission approved',
    },
  ])(
    'policy $mode answers Codex $answer by policy without asking the client and audits both events',
    async ({ mode, decision, answer, finalOutput }) => {
      const { broker, events, invocationId } = await startScenario('permission-request', {
        invocationId: invocationIdFrom(`inv_permission_policy_${mode}`),
        driver: { kind: 'codex-app-server', permissionPolicy: { mode } },
      })
      try {
        await waitForEvent(events, (event) => event.type === 'turn.completed')
        expect(permissionEvents(events, 'permission.requested')).toHaveLength(1)
        expect(permissionEvents(events, 'permission.requested')[0]?.payload).toMatchObject({
          kind: 'command',
          defaultDecision: decision,
        })
        expect(
          permissionEvents(events, 'permission.resolved').map((event) => event.payload)
        ).toEqual([expect.objectContaining({ decision, decidedBy: 'policy' })])
        expect(permissionEvents(events, 'tool.call.completed')[0]?.payload).toMatchObject({
          result: { decision: answer },
        })
        expect(permissionEvents(events, 'turn.completed')[0]?.payload).toMatchObject({
          finalOutput,
        })
      } finally {
        await broker.stop({ invocationId, reason: 'test cleanup' })
      }
    }
  )

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

  // Refactor A4: the permissionRequestId counter is now per-invocation (owned by
  // a `PermissionRequestIdAllocator`) instead of a process-global module
  // variable. Two independent allocators must each start their id sequence at 1,
  // so concurrent invocations / separate test cases no longer share counter
  // state.
  test('separate permissionRequestId allocators produce independent id sequences', async () => {
    const firstAllocator = createPermissionRequestIdAllocator()
    const secondAllocator = createPermissionRequestIdAllocator()

    const firstA = await runPermissionScenario({
      permissionPolicy: { mode: 'allow' },
      permissionRequestIds: firstAllocator,
    })
    const firstB = await runPermissionScenario({
      permissionPolicy: { mode: 'allow' },
      permissionRequestIds: firstAllocator,
    })
    const second = await runPermissionScenario({
      permissionPolicy: { mode: 'allow' },
      permissionRequestIds: secondAllocator,
    })

    const idOf = (result: PermissionScenarioResult): string =>
      (
        permissionEvents(result.events, 'permission.requested')[0]?.payload as {
          permissionRequestId: string
        }
      ).permissionRequestId

    // The first allocator increments across calls.
    expect(idOf(firstA)).toBe(`perm_${invocationId}_1`)
    expect(idOf(firstB)).toBe(`perm_${invocationId}_2`)
    // The second allocator starts fresh, independent of the first.
    expect(idOf(second)).toBe(`perm_${invocationId}_1`)
  })

  // Regression: malformed native payloads (non-object / array) must NOT leak the
  // raw value into subjectDisplay. The positive allowlist is the only path to
  // the display subject, so a payload with no allowed fields yields {} — never
  // an echo of the native value. (Q3 / CONTRACTS §7.9)
  test.each([
    {
      row: 'a raw string',
      secret: 'sk-live-nonobject-emitted-secret',
      params: (secret: string) => secret,
    },
    {
      row: 'an array',
      secret: 'sk-live-array-emitted-secret',
      params: (secret: string) => [secret, { command: 'rm -rf /' }],
    },
  ])(
    'permission.requested emits an empty subjectDisplay for $row native payload',
    async ({ secret, params }) => {
      const { events, permissionRequests } = await runPermissionScenario({
        permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
        clientCapabilities: { permissionRequests: true },
        requestPermission: async () => ({ decision: 'allow' }),
        request: {
          jsonrpc: '2.0',
          id: 'perm_malformed',
          method: 'item/commandExecution/requestApproval',
          params: params(secret) as unknown as JsonRpcRequest['params'],
        },
      })

      const requested = permissionEvents(events, 'permission.requested')[0]
      const payload = requested?.payload as { subjectDisplay?: unknown }
      expect(payload.subjectDisplay).toEqual({})
      // No raw payload value persisted for audit nor forwarded to the client.
      expect(JSON.stringify(requested?.payload)).not.toContain(secret)
      expect(JSON.stringify(permissionRequests[0])).not.toContain(secret)
      expect(JSON.stringify(requested?.payload)).not.toContain('rm -rf /')
      expect(JSON.stringify(permissionRequests[0])).not.toContain('rm -rf /')
    }
  )
})
