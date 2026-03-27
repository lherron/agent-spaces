/** Regex pattern for valid identifier tokens */
export const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/

/** Min/max length for identifier tokens */
export const TOKEN_MIN_LENGTH = 1
export const TOKEN_MAX_LENGTH = 64

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
