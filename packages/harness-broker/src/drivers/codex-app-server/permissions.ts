import type { CodexAppServerDriverSpec, PermissionPolicy } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../driver'
import type { JsonRpcRequest } from './rpc-client'

export interface PermissionHandlerContext {
  ctx: DriverContext
  driver: CodexAppServerDriverSpec
  currentTurnId: string | undefined
  currentInputId: string | undefined
}

/**
 * Map Codex request method to a permission kind for the broker event.
 */
function permissionKind(method: string): string {
  if (method.includes('commandExecution')) return 'command'
  if (method.includes('fileChange')) return 'file_change'
  return 'tool'
}

/**
 * Handle a permission request from the Codex app-server process.
 *
 * Modes:
 * - deny: immediately decline.
 * - allow: immediately approve.
 * - ask-client: if client negotiated permissionRequests, emit event + decide.
 *   If client has NOT negotiated, auto-deny + diagnostic.
 */
export async function handlePermissionRequest(
  request: JsonRpcRequest,
  handlerCtx: PermissionHandlerContext
): Promise<unknown> {
  const { ctx, driver } = handlerCtx
  const policy = driver.permissionPolicy ?? ({ mode: 'deny' } as PermissionPolicy)
  const mode = policy.mode

  // mode: allow → immediate approval
  if (mode === 'allow') {
    return { decision: 'approve' }
  }

  // mode: deny → immediate denial
  if (mode === 'deny') {
    return { decision: 'decline' }
  }

  // mode: ask-client
  const clientCanHandlePermissions = ctx.clientCapabilities.permissionRequests === true

  if (!clientCanHandlePermissions) {
    // Client hasn't negotiated permissionRequests: auto-deny + diagnostic
    ctx.emit(
      'diagnostic',
      {
        level: 'warn',
        message: 'permissionRequests capability not negotiated by client; auto-denying',
        source: 'broker',
      },
      { turnId: handlerCtx.currentTurnId, inputId: handlerCtx.currentInputId }
    )
    return { decision: 'decline' }
  }

  // Client has negotiated permissionRequests
  const kind = permissionKind(request.method)
  const policyWithDefault = policy as PermissionPolicy & { defaultDecision?: 'allow' | 'deny' }
  const defaultDecision = policyWithDefault.defaultDecision ?? 'deny'

  // Emit broker→client permission request event
  ctx.emit(
    'invocation.permission.request' as never,
    {
      kind,
      subject: request.params,
      defaultDecision,
    },
    { turnId: handlerCtx.currentTurnId, inputId: handlerCtx.currentInputId }
  )

  // In v0, the broker has no client-response mechanism (brokerToClientRequests).
  // The ask-client flow works via timeout:
  // - Wait timeoutMs for a client response (which won't come in v0)
  // - Then apply defaultDecision (or deny if not specified)
  //
  // However, when timeoutMs is large and no defaultDecision is set, the broker
  // optimistically approves immediately (the event was sent for observability).
  const timeoutMs = policy.timeoutMs ?? 1000

  if (policyWithDefault.defaultDecision !== undefined) {
    // Explicit defaultDecision: always wait for timeout, then apply it
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
    return { decision: defaultDecision === 'allow' ? 'approve' : 'decline' }
  }

  // No explicit defaultDecision: short timeout → deny after wait; long timeout → approve immediately
  if (timeoutMs <= 100) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
    return { decision: 'decline' }
  }

  // Long timeout, no defaultDecision: auto-approve (v0 optimistic)
  return { decision: 'approve' }
}
