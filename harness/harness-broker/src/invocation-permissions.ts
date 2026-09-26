import type {
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'
import { DEFAULT_PERMISSION_TIMEOUT_MS } from './invocation-constants'
import type {
  EmitFn,
  Invocation,
  InvocationManagerOptions,
  PermissionDecidedBy,
} from './invocation-model'

export interface InvocationPermissionsDeps {
  emit: EmitFn
  now: () => Date
  onPermissionRequest: InvocationManagerOptions['onPermissionRequest']
}

export function createInvocationPermissions(deps: InvocationPermissionsDeps) {
  const { emit, now, onPermissionRequest } = deps

  // ---------------------------------------------------------------------------
  // Broker-owned permission lifecycle (C2)
  // ---------------------------------------------------------------------------
  /**
   * Register a broker-owned pending permission request and return a promise that
   * resolves with the FINAL decision. Unlike the JSON-RPC request promise, this
   * pending state is broker-held: it survives controller disconnect and is
   * retained until an absolute `deadlineAt`. It settles exactly once — by the
   * connected client's response (`user`), a reconnected controller's respond
   * (`user`), or deadline expiry applying `defaultDecision` (`timeout`). The
   * `permission.resolved` audit event is emitted on settlement. A failed/closed
   * broker→client request does NOT settle the pending request; it stays pending
   * until the deadline or a respond.
   */
  function brokerRequestPermission(
    inv: Invocation,
    params: PermissionRequestParams
  ): Promise<PermissionDecision> {
    const defaultDecision = params.defaultDecision
    const timeoutMs = params.deadlineMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    const deadlineAt = new Date(now().getTime() + timeoutMs).toISOString()
    const extra = {
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(inv.currentInputId !== undefined ? { inputId: inv.currentInputId } : {}),
    }

    return new Promise<PermissionDecision>((resolveDriver) => {
      let settled = false

      const settle = (decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inv.pendingPermissions.delete(params.permissionRequestId)
        inv.settledPermissions.set(params.permissionRequestId, {
          decision,
          expired: decidedBy === 'timeout',
        })
        emit(
          inv,
          'permission.resolved',
          { permissionRequestId: params.permissionRequestId, decision, decidedBy },
          extra
        )
        resolveDriver({ decision })
      }

      // setTimeout/onPermissionRequest are async, so `timer` is always assigned
      // before `settle` (which reads it) can run.
      const timer = setTimeout(() => settle(defaultDecision, 'timeout'), timeoutMs)

      inv.pendingPermissions.set(params.permissionRequestId, {
        params,
        defaultDecision,
        deadlineAt,
        settle,
      })

      // Ask the connected controller. A response settles by `user`; a rejection
      // (controller disconnect / handler error) is intentionally ignored so the
      // request stays pending until the deadline or a reconnect respond.
      if (onPermissionRequest !== undefined) {
        onPermissionRequest(params).then(
          (decision) => settle(decision.decision === 'allow' ? 'allow' : 'deny', 'user'),
          () => {}
        )
      }
    })
  }

  /** Settle, replay, or refuse a controller permission response (C2). */
  function permissionRespond(
    inv: Invocation,
    req: InvocationPermissionRespondRequest
  ): InvocationPermissionRespondResponse {
    const pending = inv.pendingPermissions.get(req.permissionRequestId)
    if (pending !== undefined) {
      // Settle the broker-owned pending request: emits permission.resolved and
      // resolves the driver's awaiting decision.
      pending.settle(req.decision, 'user')
      return {
        status: 'accepted',
        permissionRequestId: req.permissionRequestId,
        decision: req.decision,
      }
    }

    const settled = inv.settledPermissions.get(req.permissionRequestId)
    if (settled === undefined) {
      throw new BrokerError(
        BrokerErrorCode.UnknownPermissionRequest,
        `Unknown permission request: ${req.permissionRequestId}`,
        { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId }
      )
    }

    // Settled by deadline expiry — a respond can no longer take effect.
    if (settled.expired) {
      throw new BrokerError(
        BrokerErrorCode.PermissionResponseExpired,
        `Permission request already expired: ${req.permissionRequestId}`,
        { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId }
      )
    }

    // Already answered: replay the original decision, or conflict on a mismatch.
    if (settled.decision === req.decision) {
      return {
        status: 'duplicate',
        permissionRequestId: req.permissionRequestId,
        originalDecision: settled.decision,
      }
    }
    throw new BrokerError(
      BrokerErrorCode.PermissionResponseConflict,
      `Permission request already decided ${settled.decision}; cannot change to ${req.decision}`,
      {
        invocationId: req.invocationId,
        permissionRequestId: req.permissionRequestId,
        originalDecision: settled.decision,
        attemptedDecision: req.decision,
      }
    )
  }

  return { brokerRequestPermission, permissionRespond }
}
