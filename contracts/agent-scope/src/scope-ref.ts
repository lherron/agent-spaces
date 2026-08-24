import type { ParsedScopeRef, ScopeFields, ValidationResult } from './types.js'
import { validateToken } from './types.js'

/**
 * Single source of truth for assembling a canonical scope ref string from its
 * component fields. Each segment is appended only when its field is present.
 */
export function buildScopeRef(fields: ScopeFields): string {
  let ref = `agent:${fields.agentId}`

  if (fields.projectId !== undefined) {
    ref += `:project:${fields.projectId}`
  }

  if (fields.taskId !== undefined) {
    ref += `:task:${fields.taskId}`
  }

  if (fields.roleName !== undefined) {
    ref += `:role:${fields.roleName}`
  }

  return ref
}

/**
 * Single grammar walker for ScopeRef: validates the segment structure and, on
 * success, returns the decoded `ParsedScopeRef` so callers need not re-walk.
 * Returns `{ error }` with the canonical message on any structural violation.
 *
 * Sole owner of the ScopeRef grammar — both `validateScopeRef` and
 * `parseScopeRef` delegate here, so the segment positions and error wording are
 * encoded exactly once.
 */
function tryParseScopeRef(scopeRef: string): ParsedScopeRef | { error: string } {
  const parts = scopeRef.split(':')

  // Must start with "agent:<agentId>"
  if (parts.length < 2 || parts[0] !== 'agent') {
    return { error: 'ScopeRef must start with "agent:<agentId>"' }
  }

  const agentId = parts[1] as string

  const agentErr = validateToken(agentId, 'agentId')
  if (agentErr) return { error: agentErr }

  // agent:<agentId> — valid
  if (parts.length === 2) return { kind: 'agent', agentId, scopeRef }

  // Must continue with "project:<projectId>"
  if (parts.length < 4 || parts[2] !== 'project') {
    return { error: 'After "agent:<agentId>", expected "project:<projectId>"' }
  }

  const projectId = parts[3] as string

  const projectErr = validateToken(projectId, 'projectId')
  if (projectErr) return { error: projectErr }

  // agent:<agentId>:project:<projectId> — valid
  if (parts.length === 4) return { kind: 'project', agentId, projectId, scopeRef }

  // Next segment must be "role" or "task"
  const nextKey = parts[4]
  if (nextKey === 'role') {
    // agent:<agentId>:project:<projectId>:role:<roleName>
    if (parts.length !== 6) {
      return { error: 'Expected exactly "role:<roleName>" after project segment' }
    }
    const roleName = parts[5] as string
    const roleErr = validateToken(roleName, 'roleName')
    if (roleErr) return { error: roleErr }
    return { kind: 'project-role', agentId, projectId, roleName, scopeRef }
  }

  if (nextKey === 'task') {
    if (parts.length < 6) {
      return { error: 'Expected "task:<taskId>" after project segment' }
    }
    const taskId = parts[5] as string
    const taskErr = validateToken(taskId, 'taskId')
    if (taskErr) return { error: taskErr }

    // agent:<agentId>:project:<projectId>:task:<taskId> — valid
    if (parts.length === 6) return { kind: 'project-task', agentId, projectId, taskId, scopeRef }

    // Must continue with "role:<roleName>"
    if (parts.length !== 8 || parts[6] !== 'role') {
      return { error: 'After "task:<taskId>", expected "role:<roleName>"' }
    }
    const roleName = parts[7] as string
    const roleErr = validateToken(roleName, 'roleName')
    if (roleErr) return { error: roleErr }
    return { kind: 'project-task-role', agentId, projectId, taskId, roleName, scopeRef }
  }

  return {
    error: `Unexpected segment "${nextKey}" after project; expected "role" or "task"`,
  }
}

/**
 * Validate a scope ref string. Returns { ok: true } or { ok: false, error }.
 */
export function validateScopeRef(scopeRef: string): ValidationResult {
  const result = tryParseScopeRef(scopeRef)
  return 'error' in result ? { ok: false, error: result.error } : { ok: true }
}

/**
 * Parse a scope ref string into a structured ParsedScopeRef.
 * Throws if the scope ref is invalid.
 */
export function parseScopeRef(scopeRef: string): ParsedScopeRef {
  const result = tryParseScopeRef(scopeRef)
  if ('error' in result) {
    throw new Error(`Invalid ScopeRef "${scopeRef}": ${result.error}`)
  }
  return result
}

/**
 * Format a ParsedScopeRef back into its canonical string form.
 */
export function formatScopeRef(parsed: ParsedScopeRef): string {
  return buildScopeRef(parsed)
}

/**
 * Return the ancestor scope refs from least-specific to most-specific.
 */
export function ancestorScopeRefs(scopeRef: string): string[] {
  const { agentId, projectId, taskId, roleName } = parseScopeRef(scopeRef)
  const ancestors: string[] = []

  // Always include agent level
  ancestors.push(buildScopeRef({ agentId }))

  if (projectId !== undefined) {
    ancestors.push(buildScopeRef({ agentId, projectId }))
  }

  if (taskId !== undefined) {
    ancestors.push(buildScopeRef({ agentId, projectId, taskId }))
  }

  if (roleName !== undefined) {
    // The full ref with role is always the most specific
    ancestors.push(scopeRef)
  }

  return ancestors
}
