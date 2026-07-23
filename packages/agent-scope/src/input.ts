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
 * Environment variable used as the operator-level task default.
 * Explicit input and option defaults take precedence over this value.
 */
export const ASP_DEFAULT_TASK_ENV = 'ASP_DEFAULT_TASK'

/**
 * Canonical final fallback for task qualification when no explicit task,
 * option default, or environment default is supplied.
 */
export const DEFAULT_PRIMARY_TASK_ID = 'primary'

function envDefaultTask(): string | undefined {
  const value = process.env[ASP_DEFAULT_TASK_ENV]?.trim()
  return value === '' ? undefined : value
}

export type ResolveQualifiedScopeOptions = {
  /** Lane id to apply when no `~lane` suffix is present (defaults to "main"). */
  defaultLaneId?: string
  /**
   * Fallback projectId when the input handle does not include one.
   * Callers typically pass `explicitOption ?? process.env.ASP_PROJECT ?? inferProjectIdFromCwd()`.
   */
  projectId?: string
  /**
   * Fallback taskId when the input handle does not include one (and a project is present).
   * Takes precedence over `defaultTaskId` and `ASP_DEFAULT_TASK`.
   */
  taskId?: string
  /**
   * Caller-supplied task default when neither the input nor `taskId` fills it
   * (and a project is present). Takes precedence over `ASP_DEFAULT_TASK`.
   */
  defaultTaskId?: string
  /**
   * Role default applied only when the parsed input carries a task and omits a role.
   * Explicit roles always take precedence.
   */
  defaultRoleName?: string
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
 * agent+project+task-qualified — missing `taskId` is filled from
 * `ASP_DEFAULT_TASK`, then `"primary"` (see `resolveQualifiedScopeInput`).
 * Bare agent inputs (`"cody"`, `"agent:cody"`) remain `agent:<id>` because
 * there is no project to attach a task to.
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
 *      `opts.taskId`, else `opts.defaultTaskId`, else a non-empty trimmed
 *      `ASP_DEFAULT_TASK`, else `"primary"`.
 *   5. Role-without-task collapses to task-role once the configured default is
 *      filled — with no overrides, `cody@agent-spaces/reviewer` becomes
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
  const { agentId } = base
  let projectId = base.projectId
  let taskId = base.taskId
  let roleName = base.roleName

  if (base.taskId !== undefined && base.roleName === undefined) {
    roleName = opts.defaultRoleName
  }

  if (projectId === undefined && opts.projectId !== undefined && opts.projectId !== '') {
    projectId = opts.projectId
  }

  if (taskId === undefined && projectId !== undefined) {
    taskId = opts.taskId ?? opts.defaultTaskId ?? envDefaultTask() ?? DEFAULT_PRIMARY_TASK_ID
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
