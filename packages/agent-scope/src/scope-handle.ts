import { buildScopeRef, parseScopeRef } from './scope-ref.js'
import type { ParsedScopeRef, ValidationResult } from './types.js'
import { validateToken } from './types.js'

/**
 * ScopeHandle grammar:
 *   <agentId> ["@" <projectId> [":" <taskId>] ["/" <roleName>]]
 *
 * Examples:
 *   alice                   → agent:alice
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
function splitHandle(handle: string): HandleParts {
  // Split off role first: everything after the first "/" in the project portion.
  // Role delimiter "/" is only meaningful after "@".
  let main = handle
  let roleName: string | undefined

  const atIdx = handle.indexOf('@')
  if (atIdx !== -1) {
    const afterAt = handle.slice(atIdx + 1)
    const slashIdx = afterAt.indexOf('/')
    if (slashIdx !== -1) {
      roleName = afterAt.slice(slashIdx + 1)
      main = handle.slice(0, atIdx + 1 + slashIdx)
    }
  }

  // Parse main: agentId ["@" projectId [":" taskId]]
  if (atIdx === -1) {
    return { agentId: main, roleName }
  }

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

  const agentErr = validateToken(agentId, 'agentId')
  if (agentErr) return { ok: false, error: agentErr }

  if (projectId !== undefined) {
    const projErr = validateToken(projectId, 'projectId')
    if (projErr) return { ok: false, error: projErr }
  }

  if (taskId !== undefined) {
    const taskErr = validateToken(taskId, 'taskId')
    if (taskErr) return { ok: false, error: taskErr }
  }

  if (roleName !== undefined) {
    const roleErr = validateToken(roleName, 'roleName')
    if (roleErr) return { ok: false, error: roleErr }
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
