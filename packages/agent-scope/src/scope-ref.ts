import type { ParsedScopeRef, ValidationResult } from './types.js'
import { validateToken } from './types.js'

function part(parts: string[], i: number): string {
  return parts[i] as string
}

/** Field set shared by the canonical ScopeRef builders. */
type ScopeRefFields = {
  agentId: string
  projectId?: string | undefined
  taskId?: string | undefined
  roleName?: string | undefined
}

/**
 * Single source of truth for assembling a canonical scope ref string from its
 * component fields. Each segment is appended only when its field is present.
 */
export function buildScopeRef(fields: ScopeRefFields): string {
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
 * Validate a scope ref string. Returns { ok: true } or { ok: false, error }.
 */
export function validateScopeRef(scopeRef: string): ValidationResult {
  const parts = scopeRef.split(':')

  // Must start with "agent:<agentId>"
  if (parts.length < 2 || parts[0] !== 'agent') {
    return { ok: false, error: 'ScopeRef must start with "agent:<agentId>"' }
  }

  const agentId = part(parts, 1)
  const agentErr = validateToken(agentId, 'agentId')
  if (agentErr) return { ok: false, error: agentErr }

  // agent:<agentId> — valid
  if (parts.length === 2) return { ok: true }

  // Must continue with "project:<projectId>"
  if (parts.length < 4 || parts[2] !== 'project') {
    return { ok: false, error: 'After "agent:<agentId>", expected "project:<projectId>"' }
  }

  const projectId = part(parts, 3)
  const projErr = validateToken(projectId, 'projectId')
  if (projErr) return { ok: false, error: projErr }

  // agent:<agentId>:project:<projectId> — valid
  if (parts.length === 4) return { ok: true }

  // Next segment must be "role" or "task"
  const nextKey = parts[4]
  if (nextKey === 'role') {
    // agent:<agentId>:project:<projectId>:role:<roleName>
    if (parts.length !== 6) {
      return { ok: false, error: 'Expected exactly "role:<roleName>" after project segment' }
    }
    const roleName = part(parts, 5)
    const roleErr = validateToken(roleName, 'roleName')
    if (roleErr) return { ok: false, error: roleErr }
    return { ok: true }
  }

  if (nextKey === 'task') {
    if (parts.length < 6) {
      return { ok: false, error: 'Expected "task:<taskId>" after project segment' }
    }
    const taskId = part(parts, 5)
    const taskErr = validateToken(taskId, 'taskId')
    if (taskErr) return { ok: false, error: taskErr }

    // agent:<agentId>:project:<projectId>:task:<taskId> — valid
    if (parts.length === 6) return { ok: true }

    // Must continue with "role:<roleName>"
    if (parts.length !== 8 || parts[6] !== 'role') {
      return { ok: false, error: 'After "task:<taskId>", expected "role:<roleName>"' }
    }
    const roleName = part(parts, 7)
    const roleErr = validateToken(roleName, 'roleName')
    if (roleErr) return { ok: false, error: roleErr }
    return { ok: true }
  }

  return {
    ok: false,
    error: `Unexpected segment "${nextKey}" after project; expected "role" or "task"`,
  }
}

/**
 * Parse a scope ref string into a structured ParsedScopeRef.
 * Throws if the scope ref is invalid.
 */
export function parseScopeRef(scopeRef: string): ParsedScopeRef {
  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    throw new Error(`Invalid ScopeRef "${scopeRef}": ${validation.error}`)
  }

  const parts = scopeRef.split(':')
  const agentId = part(parts, 1)

  if (parts.length === 2) {
    return { kind: 'agent', agentId, scopeRef }
  }

  const projectId = part(parts, 3)

  if (parts.length === 4) {
    return { kind: 'project', agentId, projectId, scopeRef }
  }

  const nextKey = part(parts, 4)

  if (nextKey === 'role') {
    const roleName = part(parts, 5)
    return { kind: 'project-role', agentId, projectId, roleName, scopeRef }
  }

  // nextKey === 'task'
  const taskId = part(parts, 5)

  if (parts.length === 6) {
    return { kind: 'project-task', agentId, projectId, taskId, scopeRef }
  }

  const roleName = part(parts, 7)
  return { kind: 'project-task-role', agentId, projectId, taskId, roleName, scopeRef }
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
