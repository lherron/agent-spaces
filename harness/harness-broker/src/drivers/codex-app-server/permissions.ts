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

/**
 * Allocates monotonically increasing `permissionRequestId` values for a single
 * invocation. Each invocation owns its own allocator (created via
 * {@link createPermissionRequestIdAllocator}), so the per-request counter is no
 * longer process-global shared state across concurrent invocations or test
 * cases — id sequences start independently per invocation.
 */
export interface PermissionRequestIdAllocator {
  next(invocationId: string): PermissionRequestId
}

export interface PermissionHandlerContext {
  ctx: DriverContext
  driver: CodexAppServerDriverSpec
  currentTurnId: TurnId | undefined
  currentInputId: InputId | undefined
  permissionRequestIds: PermissionRequestIdAllocator
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

/**
 * Create a fresh per-invocation `permissionRequestId` allocator. The counter is
 * encapsulated in the returned closure rather than living at module scope, so
 * separate invocations (and separate test cases) get independent id sequences.
 */
export function createPermissionRequestIdAllocator(): PermissionRequestIdAllocator {
  let counter = 0
  return {
    next(invocationId: string): PermissionRequestId {
      counter += 1
      return `perm_${invocationId}_${counter}` as PermissionRequestId
    },
  }
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
 * The permission ask, opened but not yet answered.
 *
 * Splitting the ask from the answer is what lets the driver commit the provider's
 * server->client request frame FIRST and mint `permission.requested` from inside
 * that record's normalization (T-07870 §4): the ask is provider evidence and now
 * names the record it came from, while the answer is a broker decision made
 * later, asynchronously, and says so.
 */
export interface OpenedPermissionRequest {
  permissionRequestId: PermissionRequestId
  kind: string
  subjectDisplay: Record<string, unknown>
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
  policy: PermissionPolicy
  request: JsonRpcRequest
}

/**
 * Classify and identify a permission ask WITHOUT emitting anything. Pure: the
 * caller decides where the resulting `permission.requested` payload is emitted
 * (and therefore what provenance it carries).
 */
export function openPermissionRequest(
  request: JsonRpcRequest,
  handlerCtx: PermissionHandlerContext
): OpenedPermissionRequest {
  const { ctx, driver } = handlerCtx
  const policy = driver.permissionPolicy ?? ({ mode: 'deny' } as PermissionPolicy)
  const policyWithDefault = policy as PermissionPolicy & { defaultDecision?: 'allow' | 'deny' }
  const kind = permissionKind(request.method)
  return {
    permissionRequestId: handlerCtx.permissionRequestIds.next(ctx.invocationId),
    kind,
    subjectDisplay: buildSubjectDisplay(kind, request.params),
    defaultDecision:
      policyWithDefault.defaultDecision ?? (policy.mode === 'allow' ? 'allow' : 'deny'),
    ...(policy.timeoutMs !== undefined ? { deadlineMs: policy.timeoutMs } : {}),
    policy,
    request,
  }
}

/** The `permission.requested` audit payload for an opened ask. */
export function permissionRequestedPayload(opened: OpenedPermissionRequest): {
  permissionRequestId: PermissionRequestId
  kind: string
  subjectDisplay: Record<string, unknown>
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
} {
  return {
    permissionRequestId: opened.permissionRequestId,
    kind: opened.kind,
    subjectDisplay: opened.subjectDisplay,
    defaultDecision: opened.defaultDecision,
    ...(opened.deadlineMs !== undefined ? { deadlineMs: opened.deadlineMs } : {}),
  }
}

/**
 * Answer an opened permission ask and return the provider-facing decision.
 *
 * Decision transport is JSON-RPC request/response (broker->client); the
 * `permission.resolved` event is audit only. There is no branch where a missing
 * default approves — default-deny everywhere.
 *
 * Modes:
 * - deny: resolve deny by policy.
 * - allow: resolve allow by policy.
 * - ask-client:
 *   - if the client did not negotiate `permissionRequests` (or no request
 *     transport is wired): emit a diagnostic and deny by policy.
 *   - otherwise ask the client via `ctx.requestPermission`, bounded by
 *     `timeoutMs`:
 *       - timeout -> defaultDecision (decidedBy `timeout`)
 *       - handler error -> defaultDecision (decidedBy `api`)
 *       - valid decision -> the client's decision (decidedBy `user`)
 *     where a missing defaultDecision means deny.
 *
 * `emitResolved` is supplied by the caller so the audit event carries the
 * caller's provenance: the answer is a BROKER decision that names the committed
 * request record it answers, never a provider-reported fact (T-07870 §4).
 */
export async function resolvePermissionRequest(
  opened: OpenedPermissionRequest,
  handlerCtx: PermissionHandlerContext,
  emit: {
    resolved: (payload: {
      permissionRequestId: PermissionRequestId
      decision: 'allow' | 'deny'
      decidedBy: 'policy' | 'user' | 'api' | 'timeout'
    }) => void
    diagnostic: (payload: { level: 'warn'; message: string; source: 'broker' }) => void
  }
): Promise<unknown> {
  const { ctx } = handlerCtx
  const { policy, permissionRequestId, defaultDecision } = opened
  const mode = policy.mode

  const resolve = (
    decision: 'allow' | 'deny',
    decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  ): { decision: 'approve' | 'decline' } => {
    emit.resolved({ permissionRequestId, decision, decidedBy })
    return { decision: decision === 'allow' ? 'approve' : 'decline' }
  }

  // mode: deny -> decline by policy
  if (mode === 'deny') {
    return resolve('deny', 'policy')
  }

  // mode: allow -> approve by policy
  if (mode === 'allow') {
    return resolve('allow', 'policy')
  }

  // mode: ask-client
  const clientCanHandlePermissions = ctx.clientCapabilities.permissionRequests === true
  if (!clientCanHandlePermissions || !ctx.requestPermission) {
    emit.diagnostic({
      level: 'warn',
      message:
        'permissionRequests capability not negotiated by client; denying by policy (default-deny)',
      source: 'broker',
    })
    return resolve('deny', 'policy')
  }

  const params: PermissionRequestParams = {
    invocationId: ctx.invocationId,
    ...(handlerCtx.currentTurnId !== undefined ? { turnId: handlerCtx.currentTurnId } : {}),
    permissionRequestId,
    kind: opened.kind,
    // The bounded display subject — the same positive projection persisted for
    // audit. The raw native payload never crosses the broker->client boundary.
    subject: opened.subjectDisplay,
    defaultDecision,
    ...(opened.deadlineMs !== undefined ? { deadlineMs: opened.deadlineMs } : {}),
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
