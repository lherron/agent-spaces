/**
 * muse-serve permission choice tests (T-08589, spike 5).
 *
 * Narrowest-scope choice selection with default-deny, exercised through
 * handleMuseApprovalRequest against a stub RPC peer.
 */
import { describe, expect, test } from 'bun:test'
import type { MuseServeDriverSpec, PermissionRequestId } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../driver'
import { handleMuseApprovalRequest } from './permissions'
import type { MusePermissionHandlerContext } from './permissions'
import type { MuseJsonRpcRequest, MuseRpcPeer } from './rpc-client'

const choices = [
  {
    choiceId: 'allow-session',
    decision: 'approvedForSession',
    label: 'Allow session',
    scope: 'session',
  },
  { choiceId: 'allow-once', decision: 'approved', label: 'Allow once', scope: 'turn' },
  { choiceId: 'deny-once', decision: 'denied', label: 'Deny', scope: 'turn' },
]

const approvalRequest = (): MuseJsonRpcRequest => ({
  jsonrpc: '2.0',
  id: 9001,
  method: 'approval/request',
  params: {
    approvalId: 'apr-1',
    availableChoices: choices,
    currentRequirementId: 'req-1',
    itemId: 'item-1',
    toolName: 'shell',
    turnId: 't1',
    sessionId: 's1',
  },
})

const stubRpc = (seen: Array<Record<string, unknown>>): MuseRpcPeer => ({
  sendRequest: async (_method: string, params?: unknown) => {
    seen.push((params ?? {}) as Record<string, unknown>)
    return {}
  },
  sendNotification: async () => undefined,
  close: () => undefined,
})

const handlerCtx = (
  mode: 'deny' | 'allow' | 'ask-client',
  overrides: Partial<DriverContext> = {}
): MusePermissionHandlerContext => ({
  ctx: {
    invocationId: 'inv_perm',
    clientCapabilities: {},
    emit: () => ({}) as never,
    emitEvent: () => ({}) as never,
    ...overrides,
  } as unknown as DriverContext,
  driver: { kind: 'muse-serve', permissionPolicy: { mode } } as MuseServeDriverSpec,
  currentTurnId: undefined,
  currentInputId: undefined,
  permissionRequestIds: {
    next: (invocationId: string) => `perm_${invocationId}_1` as PermissionRequestId,
  },
})

const emitted = () => {
  const requested: unknown[] = []
  const resolved: unknown[] = []
  return {
    requested,
    resolved,
    emit: {
      requested: (payload: unknown) => requested.push(payload),
      resolved: (payload: unknown) => resolved.push(payload),
      diagnostic: () => undefined,
    },
  }
}

describe('handleMuseApprovalRequest', () => {
  test('allow picks the narrowest approved choice', async () => {
    const seen: Array<Record<string, unknown>> = []
    const events = emitted()
    const receipt = await handleMuseApprovalRequest(
      approvalRequest(),
      stubRpc(seen),
      handlerCtx('allow'),
      events.emit
    )
    expect(receipt).toEqual({ presented: true })
    expect(seen[0]).toMatchObject({ approvalId: 'apr-1', choiceId: 'allow-once' })
    expect(events.resolved).toEqual([
      expect.objectContaining({ decision: 'allow', decidedBy: 'policy' }),
    ])
  })

  test('deny picks the denied choice', async () => {
    const seen: Array<Record<string, unknown>> = []
    const events = emitted()
    await handleMuseApprovalRequest(
      approvalRequest(),
      stubRpc(seen),
      handlerCtx('deny'),
      events.emit
    )
    expect(seen[0]).toMatchObject({ choiceId: 'deny-once' })
  })

  test('ask-client without a permission transport denies by policy', async () => {
    const seen: Array<Record<string, unknown>> = []
    const events = emitted()
    await handleMuseApprovalRequest(
      approvalRequest(),
      stubRpc(seen),
      handlerCtx('ask-client'),
      events.emit
    )
    expect(seen[0]).toMatchObject({ choiceId: 'deny-once' })
  })

  test('ask-client relays the client decision', async () => {
    const seen: Array<Record<string, unknown>> = []
    const events = emitted()
    await handleMuseApprovalRequest(
      approvalRequest(),
      stubRpc(seen),
      handlerCtx('ask-client', {
        brokerOwnsPermissionLifecycle: true,
        clientCapabilities: { permissionRequests: true },
        requestPermission: async () => ({ decision: 'allow' }),
      }),
      events.emit
    )
    expect(seen[0]).toMatchObject({ choiceId: 'allow-once' })
  })

  test('missing decision class fails the ask instead of approving', async () => {
    const seen: Array<Record<string, unknown>> = []
    const events = emitted()
    const denyOnly = {
      ...approvalRequest(),
      params: {
        ...(approvalRequest().params as Record<string, unknown>),
        availableChoices: [choices[2]],
      },
    }
    await expect(
      handleMuseApprovalRequest(denyOnly, stubRpc(seen), handlerCtx('allow'), events.emit)
    ).rejects.toThrow('no allow choice')
  })
})
