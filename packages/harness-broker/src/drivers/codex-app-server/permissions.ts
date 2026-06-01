import type {
  CodexAppServerDriverSpec,
  InputId,
  PermissionPolicy,
  PermissionRequestId,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'
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

// Bounds for the display-subject projection (CONTRACTS §7.9). The display
// subject is a small, human-readable summary persisted for audit — not the
// raw native payload.
const MAX_DISPLAY_STRING = 1024
const MAX_DISPLAY_ARRAY = 32

// Positive allowlist of safe subject fields per permission kind. Only these
// keys are projected into the display subject — everything else (e.g. an `env`
// map) is dropped by omission. This is a POSITIVE projection, not a scrub.
const SUBJECT_DISPLAY_FIELDS: Record<string, readonly string[]> = {
  command: ['command', 'cwd', 'reason'],
  file_change: ['path', 'paths', 'changes', 'reason'],
  tool: ['name', 'tool', 'toolName', 'reason'],
}
const DEFAULT_SUBJECT_FIELDS: readonly string[] = ['command', 'cwd', 'path', 'name', 'reason']

/** Bound a single value for display: truncate long strings, cap array length. */
function boundDisplayValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_DISPLAY_STRING ? `${value.slice(0, MAX_DISPLAY_STRING)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DISPLAY_ARRAY).map((item) => boundDisplayValue(item))
  }
  if (typeof value === 'object') {
    // Shallow, bounded projection of nested objects (e.g. a file-change entry):
    // keep primitive/string leaves only, never re-expand into arbitrary depth.
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
        out[key] = boundDisplayValue(child)
      }
    }
    return out
  }
  return undefined
}

/**
 * Build a BOUNDED display subject from a native Codex permission request
 * (CONTRACTS §7.9). This is a positive projection of known-safe fields for the
 * given permission kind — never a copy-everything-then-scrub. The raw native
 * payload is not persisted; only this bounded summary is emitted as
 * `subjectDisplay` and forwarded to the client as the request `subject`.
 */
export function buildSubjectDisplay(kind: string, params: unknown): Record<string, unknown> {
  // Malformed/non-object native payloads (string, number, array, null, …) have
  // no named fields to project. Return an empty bounded display object rather
  // than echoing the raw value — the positive allowlist is the ONLY way a value
  // reaches the display subject, so a payload with no allowed fields yields {}.
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return {}
  }
  const record = params as Record<string, unknown>
  const fields = SUBJECT_DISPLAY_FIELDS[kind] ?? DEFAULT_SUBJECT_FIELDS
  const display: Record<string, unknown> = {}
  for (const field of fields) {
    if (Object.hasOwn(record, field) && record[field] !== undefined) {
      display[field] = boundDisplayValue(record[field])
    }
  }
  return display
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
  const subjectDisplay = buildSubjectDisplay(kind, request.params)
  const deadlineMs = policy.timeoutMs

  // Audit: a permission decision was requested.
  ctx.emit(
    'permission.requested',
    {
      permissionRequestId,
      kind,
      subjectDisplay,
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
    // The bounded display subject — the same positive projection persisted for
    // audit. The raw native payload never crosses the broker→client boundary.
    subject: subjectDisplay,
    defaultDecision,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  }

  // Broker-owned lifecycle (C2): the broker holds the pending request until an
  // absolute deadline, survives controller disconnect, emits
  // `permission.resolved`, and returns the FINAL decision. The driver must not
  // impose its own timeout nor emit the resolution — just relay the decision.
  if (ctx.brokerOwnsPermissionLifecycle) {
    const decision = await ctx.requestPermission(params)
    return { decision: decision.decision === 'allow' ? 'approve' : 'decline' }
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
