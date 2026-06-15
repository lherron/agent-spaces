import { laneIdFromRef, laneRefFromInput } from './lane-ref.js'
import { splitHandle, validateScopeHandle } from './scope-handle.js'
import { buildScopeRef, parseScopeRef, validateScopeRef } from './scope-ref.js'
import { parseSessionHandle } from './session-handle.js'
import type { LaneRef, ParsedScopeRef, ScopeFields } from './types.js'

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

/**
 * The component fields of a scope input, decomposed but not yet ref-built.
 * `projectId`/`taskId` may be absent — the project-deferred shorthand
 * (`alice:t1`) carries a task with no project, which is not a legal ScopeRef
 * until `resolveQualifiedScopeInput` fills the project. Keeping the parts raw
 * (rather than eagerly building a ref) is what lets that shorthand resolve.
 */
type ScopeInputParts = ScopeFields & {
  laneId: string
  laneRef: LaneRef
}

/**
 * Internal parser that decomposes the input (ScopeHandle, SessionHandle, or
 * canonical ScopeRef) into raw parts without canonical task-qualification and
 * without building a ScopeRef. Used by `resolveQualifiedScopeInput`, which fills
 * the project/task defaults and builds the ref once.
 */
function parseScopeInput(input: string, defaultLaneId?: string): ScopeInputParts {
  if (input.includes('~')) {
    const session = parseSessionHandle(input)
    const parsed = parseScopeRef(session.scopeRef)
    return {
      agentId: parsed.agentId,
      projectId: parsed.projectId,
      taskId: parsed.taskId,
      roleName: parsed.roleName,
      laneId: laneIdFromRef(session.laneRef),
      laneRef: session.laneRef,
    }
  }

  const laneRef = laneRefFromInput(defaultLaneId)
  const laneId = laneIdFromRef(laneRef)

  // ScopeRef is checked first: `agent:<id>` is a canonical ScopeRef (the agent
  // scope), and it also matches the project-deferred handle shorthand
  // (`<agentId>:<taskId>`). The ref meaning is the established one, so it wins.
  const refResult = validateScopeRef(input)
  if (refResult.ok) {
    const parsed = parseScopeRef(input)
    return {
      agentId: parsed.agentId,
      projectId: parsed.projectId,
      taskId: parsed.taskId,
      roleName: parsed.roleName,
      laneId,
      laneRef,
    }
  }

  const handleResult = validateScopeHandle(input)
  if (handleResult.ok) {
    return { ...splitHandle(input), laneId, laneRef }
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
  return resolveQualifiedScopeInput(input, defaultLaneId !== undefined ? { defaultLaneId } : {})
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
  const { agentId, roleName } = base
  let projectId = base.projectId
  let taskId = base.taskId

  if (projectId === undefined && opts.projectId !== undefined && opts.projectId !== '') {
    projectId = opts.projectId
  }

  if (taskId === undefined && projectId !== undefined) {
    taskId = opts.taskId ?? opts.defaultTaskId ?? DEFAULT_PRIMARY_TASK_ID
  }

  // A task with no project is not a legal scope. This is the project-deferred
  // shorthand (`alice:t1`) with no project resolvable from the caller — fail
  // loud with an actionable message rather than silently dropping the task.
  if (taskId !== undefined && projectId === undefined) {
    throw new Error(
      `Invalid scope input "${input}": task "${taskId}" requires a project; ` +
        `use "${agentId}@<project>:${taskId}", or set ASP_PROJECT / run from a project directory`
    )
  }

  const scopeRef = buildScopeRef({ agentId, projectId, taskId, roleName })

  return {
    parsed: parseScopeRef(scopeRef),
    scopeRef,
    laneId: base.laneId,
    laneRef: base.laneRef,
  }
}
