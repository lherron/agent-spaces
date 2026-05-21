import { normalizeLaneRef } from './lane-ref.js'
import { parseScopeHandle, validateScopeHandle } from './scope-handle.js'
import { formatScopeRef, parseScopeRef, validateScopeRef } from './scope-ref.js'
import { parseSessionHandle } from './session-handle.js'
import type { LaneRef, ParsedScopeRef } from './types.js'

export type ResolvedScopeInput = {
  parsed: ParsedScopeRef
  scopeRef: string
  laneId: string
  laneRef: LaneRef
}

/**
 * Canonical default for task qualification when no explicit task is supplied.
 * User-facing resolvers fill missing taskId with this value so that scope refs
 * are always agent+project+task qualified.
 */
export const DEFAULT_PRIMARY_TASK_ID = 'primary'

export type ResolveQualifiedScopeOptions = {
  /** Lane id to apply when no `~lane` suffix is present (defaults to "main"). */
  defaultLaneId?: string
  /**
   * Fallback projectId when the input handle does not include one.
   * Callers typically pass `explicitOption ?? process.env.ASP_PROJECT ?? inferProjectIdFromCwd()`.
   */
  projectId?: string
  /** Fallback taskId when the input handle does not include one (and a project is present). */
  taskId?: string
  /**
   * Ultimate task default when nothing else fills it (and a project is present).
   * Defaults to "primary".
   */
  defaultTaskId?: string
}

function toLaneRef(defaultLaneId?: string): LaneRef {
  if (!defaultLaneId || defaultLaneId === 'main') {
    return 'main'
  }

  return normalizeLaneRef(
    defaultLaneId.startsWith('lane:') ? defaultLaneId : `lane:${defaultLaneId}`
  )
}

/**
 * Internal parser that returns the input's parsed form as-is — no canonical
 * task-qualification. Used by both `resolveScopeInput` and
 * `resolveQualifiedScopeInput` so the latter can run without recursing through
 * the exported, qualifying entrypoint.
 */
function parseScopeInput(input: string, defaultLaneId?: string): ResolvedScopeInput {
  if (input.includes('~')) {
    const session = parseSessionHandle(input)
    return {
      parsed: parseScopeRef(session.scopeRef),
      scopeRef: session.scopeRef,
      laneId: session.laneRef === 'main' ? 'main' : session.laneRef.slice(5),
      laneRef: session.laneRef,
    }
  }

  const laneRef = toLaneRef(defaultLaneId)

  const handleResult = validateScopeHandle(input)
  if (handleResult.ok) {
    const parsed = parseScopeHandle(input)
    return {
      parsed,
      scopeRef: formatScopeRef(parsed),
      laneId: laneRef === 'main' ? 'main' : laneRef.slice(5),
      laneRef,
    }
  }

  const refResult = validateScopeRef(input)
  if (refResult.ok) {
    return {
      parsed: parseScopeRef(input),
      scopeRef: input,
      laneId: laneRef === 'main' ? 'main' : laneRef.slice(5),
      laneRef,
    }
  }

  throw new Error(
    `Invalid scope input "${input}": expected a ScopeHandle, SessionHandle, or ScopeRef`
  )
}

/**
 * Resolve a scope input to a fully qualified ScopeRef.
 *
 * When the input includes a project, the result is always
 * agent+project+task-qualified — missing `taskId` is filled with `"primary"`
 * (see `resolveQualifiedScopeInput`). Bare agent inputs (`"cody"`,
 * `"agent:cody"`) remain `agent:<id>` because there is no project to attach a
 * task to.
 */
export function resolveScopeInput(input: string, defaultLaneId?: string): ResolvedScopeInput {
  return resolveQualifiedScopeInput(
    input,
    defaultLaneId !== undefined ? { defaultLaneId } : {}
  )
}

/**
 * User-facing resolver that canonicalizes shorthand to an agent+project+task
 * qualified ScopeRef.
 *
 * Resolution rules:
 *   1. Parse the input via `resolveScopeInput` (ScopeHandle, SessionHandle, or
 *      canonical ScopeRef).
 *   2. Preserve any explicit `agentId`, `projectId`, `taskId`, `roleName`, lane.
 *   3. If `projectId` is missing, fill from `opts.projectId`. Callers should
 *      compose this from explicit option → ASP_PROJECT → cwd inference.
 *   4. If `taskId` is missing AND a `projectId` is present, fill from
 *      `opts.taskId`, else `opts.defaultTaskId`, else `"primary"`.
 *   5. Role-without-task collapses to task-role with `primary` once filled —
 *      e.g. `cody@agent-spaces/reviewer` →
 *      `agent:cody:project:agent-spaces:task:primary:role:reviewer`.
 *
 * If no `projectId` can be determined, the result remains agent-only
 * (`agent:<id>`) — the caller decides whether that is fatal.
 */
export function resolveQualifiedScopeInput(
  input: string,
  opts: ResolveQualifiedScopeOptions = {}
): ResolvedScopeInput {
  const base = parseScopeInput(input, opts.defaultLaneId)
  const { agentId, roleName } = base.parsed
  let projectId = base.parsed.projectId
  let taskId = base.parsed.taskId

  if (projectId === undefined && opts.projectId !== undefined && opts.projectId !== '') {
    projectId = opts.projectId
  }

  if (taskId === undefined && projectId !== undefined) {
    taskId = opts.taskId ?? opts.defaultTaskId ?? DEFAULT_PRIMARY_TASK_ID
  }

  let scopeRef = `agent:${agentId}`
  if (projectId !== undefined) scopeRef += `:project:${projectId}`
  if (taskId !== undefined) scopeRef += `:task:${taskId}`
  if (roleName !== undefined) scopeRef += `:role:${roleName}`

  return {
    parsed: parseScopeRef(scopeRef),
    scopeRef,
    laneId: base.laneId,
    laneRef: base.laneRef,
  }
}
