import { parseScopeRef } from './scope-ref.js'
import type { ParsedScopeRef } from './types.js'
import { TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH, TOKEN_PATTERN } from './types.js'

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

function validateToken(value: string, label: string): string | undefined {
  if (value.length < TOKEN_MIN_LENGTH || value.length > TOKEN_MAX_LENGTH) {
    return `${label} must be ${TOKEN_MIN_LENGTH}..${TOKEN_MAX_LENGTH} characters, got ${value.length}`
  }
  if (!TOKEN_PATTERN.test(value)) {
    return `${label} contains invalid characters: must match [A-Za-z0-9._-]+`
  }
  return undefined
}

/**
 * Validate a scope handle string. Returns { ok: true } or { ok: false, error }.
 */
export function validateScopeHandle(handle: string): { ok: true } | { ok: false; error: string } {
  if (handle.length === 0) {
    return { ok: false, error: 'ScopeHandle must not be empty' }
  }

  // Split off role first: everything after the last "/" in the project portion
  let main = handle
  let roleName: string | undefined

  // Role delimiter "/" only valid after "@"
  const atIdx = handle.indexOf('@')
  if (atIdx !== -1) {
    const afterAt = handle.slice(atIdx + 1)
    const slashIdx = afterAt.indexOf('/')
    if (slashIdx !== -1) {
      roleName = afterAt.slice(slashIdx + 1)
      main = handle.slice(0, atIdx + 1 + slashIdx)
    }
  }

  // Now parse main: agentId ["@" projectId [":" taskId]]
  let agentId: string
  let projectId: string | undefined
  let taskId: string | undefined

  if (atIdx === -1) {
    agentId = main
  } else {
    agentId = main.slice(0, atIdx)
    const projectPart = main.slice(atIdx + 1)

    const colonIdx = projectPart.indexOf(':')
    if (colonIdx === -1) {
      projectId = projectPart
    } else {
      projectId = projectPart.slice(0, colonIdx)
      taskId = projectPart.slice(colonIdx + 1)
    }
  }

  // Validate each token
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

  // Split off role
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
  let agentId: string
  let projectId: string | undefined
  let taskId: string | undefined

  if (atIdx === -1) {
    agentId = main
  } else {
    agentId = main.slice(0, atIdx)
    const projectPart = main.slice(atIdx + 1)

    const colonIdx = projectPart.indexOf(':')
    if (colonIdx === -1) {
      projectId = projectPart
    } else {
      projectId = projectPart.slice(0, colonIdx)
      taskId = projectPart.slice(colonIdx + 1)
    }
  }

  // Build canonical scope ref and parse it to get the ParsedScopeRef
  let scopeRef = `agent:${agentId}`
  if (projectId !== undefined) scopeRef += `:project:${projectId}`
  if (taskId !== undefined) scopeRef += `:task:${taskId}`
  if (roleName !== undefined) scopeRef += `:role:${roleName}`

  return parseScopeRef(scopeRef)
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
