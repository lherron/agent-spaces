import { buildScopeRef, parseScopeRef } from './scope-ref.js'
import type { ParsedScopeRef, ValidationResult } from './types.js'
import { validateTokenField } from './types.js'

/**
 * ScopeHandle grammar:
 *   <agentId> [":" <taskId>] | <agentId> "@" <projectId> [":" <taskId>] ["/" <roleName>]
 *
 * The bare `<agentId>:<taskId>` form (no "@") is the project-deferred shorthand:
 * the project is filled later by `resolveQualifiedScopeInput` from the caller's
 * ASP_PROJECT / cwd. A task with no project is not a legal ScopeRef on its own,
 * so `parseScopeHandle("alice:t1")` throws — only the resolver, once it has a
 * project, can complete it.
 *
 * Examples:
 *   alice                   → agent:alice
 *   alice:t1                → (deferred) resolver fills project: agent:alice:project:<P>:task:t1
 *   alice@demo              → agent:alice:project:demo
 *   alice@demo:t1           → agent:alice:project:demo:task:t1
 *   alice@demo/reviewer     → agent:alice:project:demo:role:reviewer
 *   alice@demo:t1/reviewer  → agent:alice:project:demo:task:t1:role:reviewer
 */

/** Structural decomposition of a scope handle, prior to token validation. */
type HandleParts = {
  agentId: string
  projectId?: string | undefined
  taskId?: string | undefined
  roleName?: string | undefined
}

/**
 * Split a scope handle into its component tokens without validating them.
 * Single source of truth for the handle grammar, reused by both
 * `validateScopeHandle` and `parseScopeHandle`.
 */
export function splitHandle(handle: string): HandleParts {
  const atIdx = handle.indexOf('@')

  // No "@": agent-only, or the project-deferred `<agentId>:<taskId>` shorthand.
  // Role ("/") is only meaningful after "@", so it is not parsed here — a "/"
  // in this form lands in the token and is rejected by validation.
  if (atIdx === -1) {
    const colonIdx = handle.indexOf(':')
    if (colonIdx === -1) {
      return { agentId: handle }
    }
    return {
      agentId: handle.slice(0, colonIdx),
      taskId: handle.slice(colonIdx + 1),
    }
  }

  // Split off role first: everything after the first "/" in the project portion.
  let main = handle
  let roleName: string | undefined

  const afterAt = handle.slice(atIdx + 1)
  const slashIdx = afterAt.indexOf('/')
  if (slashIdx !== -1) {
    roleName = afterAt.slice(slashIdx + 1)
    main = handle.slice(0, atIdx + 1 + slashIdx)
  }

  // Parse main: agentId "@" projectId [":" taskId]
  const agentId = main.slice(0, atIdx)
  const projectPart = main.slice(atIdx + 1)

  const colonIdx = projectPart.indexOf(':')
  if (colonIdx === -1) {
    return { agentId, projectId: projectPart, roleName }
  }

  return {
    agentId,
    projectId: projectPart.slice(0, colonIdx),
    taskId: projectPart.slice(colonIdx + 1),
    roleName,
  }
}

/**
 * Validate a scope handle string. Returns { ok: true } or { ok: false, error }.
 */
export function validateScopeHandle(handle: string): ValidationResult {
  if (handle.length === 0) {
    return { ok: false, error: 'ScopeHandle must not be empty' }
  }

  const { agentId, projectId, taskId, roleName } = splitHandle(handle)

  const agentResult = validateTokenField(agentId, 'agentId')
  if (!agentResult.ok) return agentResult

  if (projectId !== undefined) {
    const projResult = validateTokenField(projectId, 'projectId')
    if (!projResult.ok) return projResult
  }

  if (taskId !== undefined) {
    const taskResult = validateTokenField(taskId, 'taskId')
    if (!taskResult.ok) return taskResult
  }

  if (roleName !== undefined) {
    const roleResult = validateTokenField(roleName, 'roleName')
    if (!roleResult.ok) return roleResult
  }

  return { ok: true }
}

/**
 * Parse a scope handle string into a structured ParsedScopeRef.
 * Throws if the handle is invalid.
 */
export function parseScopeHandle(handle: string): ParsedScopeRef {
  const validation = validateScopeHandle(handle)
  if (!validation.ok) {
    throw new Error(`Invalid ScopeHandle "${handle}": ${validation.error}`)
  }

  // Reuse the validated split; build the canonical ref and parse it to derive
  // the ParsedScopeRef (kind, etc.).
  return parseScopeRef(buildScopeRef(splitHandle(handle)))
}

/**
 * Format a ParsedScopeRef into its shorthand handle form.
 * Exact inverse of parseScopeHandle.
 */
export function formatScopeHandle(parsed: ParsedScopeRef): string {
  let handle = parsed.agentId

  if (parsed.projectId !== undefined) {
    handle += `@${parsed.projectId}`
  }

  if (parsed.taskId !== undefined) {
    handle += `:${parsed.taskId}`
  }

  if (parsed.roleName !== undefined) {
    handle += `/${parsed.roleName}`
  }

  return handle
}
