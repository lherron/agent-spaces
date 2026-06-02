/** Regex pattern for valid identifier tokens */
export const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/

/** Min/max length for identifier tokens */
export const TOKEN_MIN_LENGTH = 1
export const TOKEN_MAX_LENGTH = 64

/** Result of a validation routine: either ok, or an explanatory error string. */
export type ValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Validate a single identifier token against the length and charset rules.
 * Returns an error string when invalid, or `undefined` when valid.
 */
export function validateToken(value: string, label: string): string | undefined {
  if (value.length < TOKEN_MIN_LENGTH || value.length > TOKEN_MAX_LENGTH) {
    return `${label} must be ${TOKEN_MIN_LENGTH}..${TOKEN_MAX_LENGTH} characters, got ${value.length}`
  }
  if (!TOKEN_PATTERN.test(value)) {
    return `${label} contains invalid characters: must match [A-Za-z0-9._-]+`
  }
  return undefined
}

export type ScopeKind = 'agent' | 'project' | 'project-role' | 'project-task' | 'project-task-role'

export type ParsedScopeRef = {
  kind: ScopeKind
  agentId: string
  projectId?: string
  taskId?: string
  roleName?: string
  scopeRef: string
}

export type LaneRef = 'main' | `lane:${string}`

export type SessionRef = {
  scopeRef: string
  laneRef: LaneRef
}
