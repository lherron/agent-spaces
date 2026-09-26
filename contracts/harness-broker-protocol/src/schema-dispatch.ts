import type { ValidationIssue } from './errors.js'
import { validateInvocationInputShape } from './schema-shapes.js'
import { TMUX_SURFACE_DRIVER_KINDS, isDriverKindIn, validateSpec } from './schemas.js'
import type { SchemaRecord } from './schemas.js'
import { validateTmuxPaneIds } from './tmux-ids.js'
import {
  asRecord,
  joinPath,
  makeIssue,
  optionalBoolean,
  optionalString,
  requireTrue,
} from './validation-primitives.js'

// tmux id shape rules (regexes + validators) live in ./tmux-ids.

/**
 * Spec §3.3 dispatch-time contract: a `claude-code-tmux` / `codex-cli-tmux` /
 * `pi-tui-tmux` / `agent-harness-tmux`
 * dispatch MUST carry a runtime-owned terminal surface on the dispatch
 * envelope. The compiled profile emits launch INTENT only — the concrete
 * tmux server socket and pane are runtime allocations supplied by HRC (or
 * the pre-HRC harness stand-in) at dispatch time. The driver attaches to
 * this socket / pane; it never owns the server.
 *
 * Two shapes are accepted during the Phase A→D migration:
 *
 *   - NEW: `runtime.terminalSurface` carries a full `tmux-pane` lease with
 *     pane coordinates and an `allowedOps` capability scope. Driver code
 *     (Phase C/D) reads ONLY this field.
 *   - LEGACY: `runtime.tmux.socketPath` is a bare runtime-owned tmux server
 *     socket. Accepted unchanged for backward compatibility.
 *
 * If BOTH are present, `terminalSurface` wins at runtime (downstream
 * consumers prefer the lease); the protocol layer accepts both without
 * raising a conflict issue, leaving the wire format permissive during
 * migration. NO stdout/stderr deprecation diagnostics are emitted — broker
 * stdio is the wire protocol.
 */
export function validateDispatchRuntime(
  dispatchRequest: Record<string, unknown>,
  dispatchPath: string,
  issues: ValidationIssue[]
): void {
  const startRequest = asRecord(dispatchRequest['startRequest'])
  const driverKind = asRecord(asRecord(startRequest?.['spec'])?.['harness'])?.['driver']
  const runtimePath = joinPath(dispatchPath, 'runtime')
  const runtime = asRecord(dispatchRequest['runtime'])
  if (dispatchRequest['runtime'] !== undefined && !runtime) {
    issues.push(makeIssue(runtimePath, 'invalid_type', 'runtime must be an object'))
    return
  }

  // `tmux` is computed once: when present-but-not-an-object the legacy block
  // emits its issue and returns; past that point `tmux` is either undefined or
  // a valid record, so the driver-kind shim check below can reuse it.
  let tmux: SchemaRecord | undefined
  if (runtime?.['tmux'] !== undefined) {
    tmux = asRecord(runtime['tmux'])
    if (!tmux) {
      issues.push(
        makeIssue(joinPath(runtimePath, 'tmux'), 'invalid_type', 'tmux must be an object')
      )
      return
    }
    if (typeof tmux['socketPath'] !== 'string' || tmux['socketPath'].length === 0) {
      issues.push(
        makeIssue(
          joinPath(runtimePath, 'tmux.socketPath'),
          'required',
          'runtime tmux socketPath must be a non-empty string'
        )
      )
    }
  }

  // Validate `runtime.terminalSurface` whenever it is present, regardless of
  // driver kind. (Protocol layer rejects malformed leases up-front.)
  const terminalSurfaceRaw = runtime?.['terminalSurface']
  if (terminalSurfaceRaw !== undefined) {
    // Called for its side effect of emitting lease issues; the boolean return
    // is not consumed here (the detailed issues already cover any rejection).
    validateTerminalSurfaceLease(
      terminalSurfaceRaw,
      joinPath(runtimePath, 'terminalSurface'),
      issues
    )
  }
  optionalBoolean(
    runtime?.['terminalSurfaceRequired'],
    joinPath(runtimePath, 'terminalSurfaceRequired'),
    issues
  )

  if (!isDriverKindIn(TMUX_SURFACE_DRIVER_KINDS, driverKind)) {
    return
  }

  const legacyShimSatisfied =
    !!tmux && typeof tmux['socketPath'] === 'string' && tmux['socketPath'].length > 0

  if (!legacyShimSatisfied && terminalSurfaceRaw === undefined) {
    issues.push(
      makeIssue(
        joinPath(runtimePath, 'terminalSurface'),
        'required',
        `${driverKind} dispatch requires either runtime.terminalSurface (tmux-pane lease) or legacy runtime.tmux.socketPath`
      )
    )
    return
  }

  // If neither the legacy shim nor a well-formed lease is present, the
  // detailed lease issues already emitted by validateTerminalSurfaceLease
  // cover the rejection. No extra issue needed.
}

/**
 * Validate a `runtime.terminalSurface` pane lease. Returns true when the
 * lease shape is well-formed (kind/ownership/ids/allowedOps all valid).
 * Issues are pushed onto the shared list; the boolean is for callers that
 * need to know whether downstream tmux drivers can rely on the lease.
 */
function validateTerminalSurfaceLease(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): boolean {
  const surface = asRecord(value)
  if (!surface) {
    issues.push(makeIssue(basePath, 'invalid_type', 'terminalSurface must be an object'))
    return false
  }

  let ok = true

  if (surface['kind'] !== 'tmux-pane') {
    issues.push(
      makeIssue(
        joinPath(basePath, 'kind'),
        'invalid_literal',
        "terminalSurface.kind must be 'tmux-pane'"
      )
    )
    ok = false
  }
  if (surface['ownership'] !== 'hrc') {
    issues.push(
      makeIssue(
        joinPath(basePath, 'ownership'),
        'invalid_literal',
        "terminalSurface.ownership must be 'hrc'"
      )
    )
    ok = false
  }

  const socketPath = surface['socketPath']
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    issues.push(
      makeIssue(
        joinPath(basePath, 'socketPath'),
        'required',
        'terminalSurface.socketPath must be a non-empty string'
      )
    )
    ok = false
  }

  ok = validateTmuxPaneIds(surface, basePath, 'terminalSurface', issues) && ok

  optionalString(surface['sessionName'], joinPath(basePath, 'sessionName'), issues)
  optionalString(surface['windowName'], joinPath(basePath, 'windowName'), issues)

  const allowedOps = asRecord(surface['allowedOps'])
  const allowedOpsPath = joinPath(basePath, 'allowedOps')
  if (!allowedOps) {
    issues.push(makeIssue(allowedOpsPath, 'required', 'terminalSurface.allowedOps is required'))
    ok = false
  } else {
    requireTrue(allowedOps['inspect'], joinPath(allowedOpsPath, 'inspect'), issues)
    requireTrue(allowedOps['sendInput'], joinPath(allowedOpsPath, 'sendInput'), issues)
    requireTrue(allowedOps['sendInterrupt'], joinPath(allowedOpsPath, 'sendInterrupt'), issues)
    optionalBoolean(allowedOps['capture'], joinPath(allowedOpsPath, 'capture'), issues)
    optionalBoolean(allowedOps['resize'], joinPath(allowedOpsPath, 'resize'), issues)
    if (
      allowedOps['inspect'] !== true ||
      allowedOps['sendInput'] !== true ||
      allowedOps['sendInterrupt'] !== true
    ) {
      ok = false
    }
  }

  return ok
}

/**
 * Validate the body of an invocation start request: a spec, an optional
 * initialInput, and the absence of any stale runtime/lifecycle overlay. Used by
 * both the top-level start-request validator (basePath `''`) and the nested
 * `startRequest` field of a dispatch request (basePath `'…startRequest'`). All
 * issue paths are derived from `basePath` so the two callers produce identical
 * {@link ValidationIssue.path} strings.
 */
export function validateStartRequestBody(
  record: Record<string, unknown>,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateSpec(record['spec'], issues, joinPath(basePath, 'spec'))
  if (record['initialInput'] !== undefined) {
    validateInvocationInputShape(record['initialInput'], joinPath(basePath, 'initialInput'), issues)
  }
  rejectStaleStartRequestRuntime(record, basePath, issues)
}

function rejectStaleStartRequestRuntime(
  startRequest: Record<string, unknown>,
  startPath: string,
  issues: ValidationIssue[]
): void {
  if (Object.hasOwn(startRequest, 'runtime')) {
    issues.push(
      makeIssue(
        joinPath(startPath, 'runtime'),
        'stale_runtime_overlay',
        'startRequest.runtime is no longer accepted; put runtime on the InvocationDispatchRequest envelope'
      )
    )
  }
  if (Object.hasOwn(startRequest, 'lifecyclePolicy')) {
    issues.push(
      makeIssue(
        joinPath(startPath, 'lifecyclePolicy'),
        'stale_lifecycle_overlay',
        'startRequest.lifecyclePolicy is not accepted; put lifecyclePolicy on the InvocationDispatchRequest envelope'
      )
    )
  }
}
