/**
 * MSP approval/user-input handling (T-08589, spike 5).
 *
 * Server-initiated `approval/request` is a must-answer presentation: the
 * response is a receipt only, and the decision travels separately as
 * `approval/decide {approvalId, choiceId, commandId}` guarded by the current
 * requirement id (schema + spike-5 findings, muse 1.3.0). Choice selection
 * prefers the narrowest approval scope; default-deny everywhere, mirroring
 * the codex permission module's decision lattice.
 */
import type {
  InputId,
  MuseServeDriverSpec,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequestId,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  buildSubjectDisplay,
  createPermissionRequestIdAllocator,
} from '../codex-app-server/permissions'
import type { PermissionRequestIdAllocator } from '../codex-app-server/permissions'
import type { DriverContext } from '../driver'
import { newMuseCommandId } from './command-id'
import type { MuseJsonRpcRequest, MuseRpcPeer } from './rpc-client'

export { createPermissionRequestIdAllocator }
export type { PermissionRequestIdAllocator }

export interface MuseApprovalChoice {
  choiceId: string
  decision: string
  label: string
  scope: string
  acceptsFeedback?: boolean | undefined
}

export interface MuseApprovalParams {
  approvalId: string
  availableChoices: MuseApprovalChoice[]
  toolName?: string | undefined
  turnId?: string | undefined
  subject?: unknown
  rawArgs?: string | undefined
}

const APPROVE_PREFERENCE = ['approved', 'approvedForSession', 'approvedPolicyAmendment']
const DENY_PREFERENCE = ['denied', 'deniedPolicyAmendment']

function pickChoice(
  choices: MuseApprovalChoice[],
  decision: 'allow' | 'deny'
): MuseApprovalChoice | undefined {
  const preference = decision === 'allow' ? APPROVE_PREFERENCE : DENY_PREFERENCE
  for (const wanted of preference) {
    const match = choices.find((choice) => choice.decision === wanted)
    if (match) return match
  }
  return undefined
}

function parseApprovalParams(request: MuseJsonRpcRequest): MuseApprovalParams | { error: string } {
  const params = request.params
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { error: 'approval/request params must be an object' }
  }
  const record = params as Record<string, unknown>
  if (typeof record['approvalId'] !== 'string') {
    return { error: 'approval/request params missing approvalId' }
  }
  const availableChoices = Array.isArray(record['availableChoices'])
    ? (record['availableChoices'] as MuseApprovalChoice[])
    : []
  return {
    approvalId: record['approvalId'] as string,
    availableChoices,
    ...(typeof record['toolName'] === 'string' ? { toolName: record['toolName'] } : {}),
    ...(typeof record['turnId'] === 'string' ? { turnId: record['turnId'] } : {}),
    ...(record['subject'] !== undefined ? { subject: record['subject'] } : {}),
    ...(typeof record['rawArgs'] === 'string' ? { rawArgs: record['rawArgs'] } : {}),
  }
}

export interface MusePermissionHandlerContext {
  ctx: DriverContext
  driver: MuseServeDriverSpec
  currentTurnId: TurnId | undefined
  currentInputId: InputId | undefined
  permissionRequestIds: PermissionRequestIdAllocator
}

export interface MusePermissionEmit {
  requested: (payload: {
    permissionRequestId: PermissionRequestId
    kind: string
    subjectDisplay: unknown
    defaultDecision: 'allow' | 'deny'
    deadlineMs?: number | undefined
  }) => void
  resolved: (payload: {
    permissionRequestId: PermissionRequestId
    decision: 'allow' | 'deny'
    decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  }) => void
  diagnostic: (payload: { level: 'warn'; message: string; source: 'broker' }) => void
}

/**
 * Handle one server-initiated `approval/request`. Returns the presentation
 * receipt for the request-response arm; the decision is delivered via
 * `approval/decide` before returning.
 */
export async function handleMuseApprovalRequest(
  request: MuseJsonRpcRequest,
  rpc: MuseRpcPeer,
  handlerCtx: MusePermissionHandlerContext,
  emit: MusePermissionEmit
): Promise<unknown> {
  const { ctx, driver } = handlerCtx
  const policy = driver.permissionPolicy ?? ({ mode: 'deny' } as PermissionPolicy)
  const parsed = parseApprovalParams(request)
  if ('error' in parsed) {
    throw new Error(parsed.error)
  }
  const policyWithDefault = policy as PermissionPolicy & { defaultDecision?: 'allow' | 'deny' }
  const defaultDecision: 'allow' | 'deny' =
    policyWithDefault.defaultDecision ?? (policy.mode === 'allow' ? 'allow' : 'deny')
  const permissionRequestId = handlerCtx.permissionRequestIds.next(ctx.invocationId)
  const subjectDisplay = buildSubjectDisplay(parsed.toolName ?? 'tool', {
    toolName: parsed.toolName,
    rawArgs: parsed.rawArgs,
    subject: parsed.subject,
  })

  emit.requested({
    permissionRequestId,
    kind: parsed.toolName ?? 'tool',
    subjectDisplay,
    defaultDecision,
    ...(policy.timeoutMs !== undefined ? { deadlineMs: policy.timeoutMs } : {}),
  })

  const decide = async (
    decision: 'allow' | 'deny',
    decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  ): Promise<unknown> => {
    const choice = pickChoice(parsed.availableChoices, decision)
    if (!choice) {
      emit.resolved({ permissionRequestId, decision: 'deny', decidedBy: 'api' })
      throw new Error(
        `muse-serve approval ${parsed.approvalId} offers no ${decision} choice; denying by omission is impossible, failing the ask`
      )
    }
    if (ctx.brokerOwnsPermissionLifecycle) {
      await rpc.sendRequest('approval/decide', {
        approvalId: parsed.approvalId,
        choiceId: choice.choiceId,
        commandId: newMuseCommandId(),
      })
      return { presented: true }
    }
    emit.resolved({ permissionRequestId, decision, decidedBy })
    await rpc.sendRequest('approval/decide', {
      approvalId: parsed.approvalId,
      choiceId: choice.choiceId,
      commandId: newMuseCommandId(),
    })
    return { presented: true }
  }

  if (policy.mode === 'deny') return decide('deny', 'policy')
  if (policy.mode === 'allow') return decide('allow', 'policy')

  const askClient = ctx.requestPermission
  if (!askClient || ctx.clientCapabilities.permissionRequests !== true) {
    emit.diagnostic({
      level: 'warn',
      message:
        'permissionRequests capability not negotiated by client; denying by policy (default-deny)',
      source: 'broker',
    })
    return decide('deny', 'policy')
  }

  const params: PermissionRequestParams = {
    invocationId: ctx.invocationId,
    ...(handlerCtx.currentTurnId !== undefined ? { turnId: handlerCtx.currentTurnId } : {}),
    permissionRequestId,
    kind: parsed.toolName ?? 'tool',
    subject: subjectDisplay,
    defaultDecision,
    ...(policy.timeoutMs !== undefined ? { deadlineMs: policy.timeoutMs } : {}),
  }

  if (ctx.brokerOwnsPermissionLifecycle) {
    const outcome: PermissionDecision = await askClient(params)
    return decide(outcome.decision === 'allow' ? 'allow' : 'deny', 'user')
  }

  const timeoutMs = policy.timeoutMs ?? 1000
  const outcome = await new Promise<
    { kind: 'value'; value: PermissionDecision } | { kind: 'timeout' } | { kind: 'error' }
  >((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    askClient(params)
      .then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ kind: 'value', value })
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ kind: 'error' })
        }
      )
      .catch(() => undefined)
  })
  if (outcome.kind === 'timeout') return decide(defaultDecision, 'timeout')
  if (outcome.kind === 'error') return decide(defaultDecision, 'api')
  return decide(outcome.value.decision === 'allow' ? 'allow' : 'deny', 'user')
}
