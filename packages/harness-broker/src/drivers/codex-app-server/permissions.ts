import type {
  CodexAppServerDriverSpec,
  InputId,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequestId,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { redactPermissionSubject } from '../../security/redaction'
import type { DriverContext } from '../driver'
import type { JsonRpcRequest } from './rpc-client'

export interface PermissionHandlerContext {
  ctx: DriverContext
  driver: CodexAppServerDriverSpec
  currentTurnId: TurnId | undefined
  currentInputId: InputId | undefined
}

/**
 * Map Codex request method to a permission kind for the broker event.
 */
function permissionKind(method: string): string {
  if (method.includes('commandExecution')) return 'command'
  if (method.includes('fileChange')) return 'file_change'
  return 'tool'
}

let permissionRequestCounter = 0

function nextPermissionRequestId(invocationId: string): PermissionRequestId {
  permissionRequestCounter += 1
  return `perm_${invocationId}_${permissionRequestCounter}` as PermissionRequestId
}

type RaceOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' }
  | { kind: 'error'; error: unknown }

/**
 * Race a promise against a timeout, reporting which arm settled first.
 * Distinguishes timeout from rejection so the caller can map them to distinct
 * audit decisions (`timeout` vs `api`). The broker owns this timeout — it is
 * the authoritative deadline that produces `decidedBy: 'timeout'`.
 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceOutcome<T>> {
  return new Promise<RaceOutcome<T>>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: 'value', value })
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: 'error', error })
      }
    )
  })
}

/**
 * Handle a permission request from the Codex app-server process.
 *
 * Decision transport is JSON-RPC request/response (broker→client); the
 * `permission.requested` / `permission.resolved` events are audit only. There
 * is no branch where a missing default approves — default-deny everywhere.
 *
 * Modes:
 * - deny: resolve deny by policy.
 * - allow: resolve allow by policy.
 * - ask-client:
 *   - if the client did not negotiate `permissionRequests` (or no request
 *     transport is wired): emit a diagnostic and deny by policy.
 *   - otherwise ask the client via `ctx.requestPermission`, bounded by
 *     `timeoutMs`:
 *       - timeout → defaultDecision (decidedBy `timeout`)
 *       - handler error → defaultDecision (decidedBy `api`)
 *       - valid decision → the client's decision (decidedBy `user`)
 *     where a missing defaultDecision means deny.
 */
export async function handlePermissionRequest(
  request: JsonRpcRequest,
  handlerCtx: PermissionHandlerContext
): Promise<unknown> {
  const { ctx, driver } = handlerCtx
  const policy = driver.permissionPolicy ?? ({ mode: 'deny' } as PermissionPolicy)
  const mode = policy.mode
  const extra = { turnId: handlerCtx.currentTurnId, inputId: handlerCtx.currentInputId }

  const policyWithDefault = policy as PermissionPolicy & { defaultDecision?: 'allow' | 'deny' }
  const defaultDecision: 'allow' | 'deny' =
    policyWithDefault.defaultDecision ?? (mode === 'allow' ? 'allow' : 'deny')

  const kind = permissionKind(request.method)
  const permissionRequestId = nextPermissionRequestId(ctx.invocationId)
  const subjectRedacted = redactPermissionSubject(request.params)
  const deadlineMs = policy.timeoutMs

  // Audit: a permission decision was requested.
  ctx.emit(
    'permission.requested',
    {
      permissionRequestId,
      kind,
      subjectRedacted,
      defaultDecision,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    },
    extra
  )

  const resolve = (
    decision: 'allow' | 'deny',
    decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  ): { decision: 'approve' | 'decline' } => {
    ctx.emit('permission.resolved', { permissionRequestId, decision, decidedBy }, extra)
    return { decision: decision === 'allow' ? 'approve' : 'decline' }
  }

  // mode: deny → decline by policy
  if (mode === 'deny') {
    return resolve('deny', 'policy')
  }

  // mode: allow → approve by policy
  if (mode === 'allow') {
    return resolve('allow', 'policy')
  }

  // mode: ask-client
  const clientCanHandlePermissions = ctx.clientCapabilities.permissionRequests === true
  if (!clientCanHandlePermissions || !ctx.requestPermission) {
    ctx.emit(
      'diagnostic',
      {
        level: 'warn',
        message:
          'permissionRequests capability not negotiated by client; denying by policy (default-deny)',
        source: 'broker',
      },
      extra
    )
    return resolve('deny', 'policy')
  }

  const params: PermissionRequestParams = {
    invocationId: ctx.invocationId,
    ...(handlerCtx.currentTurnId !== undefined ? { turnId: handlerCtx.currentTurnId } : {}),
    permissionRequestId,
    kind,
    // Never carry env secrets across the broker→client request boundary.
    subject: subjectRedacted,
    defaultDecision,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  }

  const timeoutMs = policy.timeoutMs ?? 1000
  const outcome = await raceWithTimeout(ctx.requestPermission(params), timeoutMs)

  if (outcome.kind === 'timeout') {
    return resolve(defaultDecision, 'timeout')
  }
  if (outcome.kind === 'error') {
    return resolve(defaultDecision, 'api')
  }

  const decision = outcome.value.decision === 'allow' ? 'allow' : 'deny'
  return resolve(decision, 'user')
}
