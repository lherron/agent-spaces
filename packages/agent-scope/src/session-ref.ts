import { normalizeLaneRef } from './lane-ref.js'
import { validateScopeRef } from './scope-ref.js'
import type { SessionRef } from './types.js'

/**
 * Normalize a session ref from scope + optional lane inputs.
 * Validates the scopeRef and normalizes the laneRef (defaulting to "main").
 */
export function normalizeSessionRef(input: { scopeRef: string; laneRef?: string }): SessionRef {
  const validation = validateScopeRef(input.scopeRef)
  if (!validation.ok) {
    throw new Error(`Invalid ScopeRef "${input.scopeRef}": ${validation.error}`)
  }

  return {
    scopeRef: input.scopeRef,
    laneRef: normalizeLaneRef(input.laneRef),
  }
}
