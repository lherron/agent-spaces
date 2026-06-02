import { laneIdFromRef, laneRefFromId, normalizeLaneRef } from './lane-ref.js'
import { validateScopeRef } from './scope-ref.js'
import type { SessionRef } from './types.js'

/** Canonical prefix used by the `lane:<laneId>` ref form. */
const LANE_PREFIX = 'lane:'

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

/**
 * Parse a canonical SessionRef string ("<scopeRef>/lane:<laneId>").
 *
 * Whitespace policy: surrounding whitespace is tolerated and trimmed uniformly
 * from each component — the whole input, the scopeRef segment, and the laneId —
 * before validation. This keeps a single, documented rule rather than trimming
 * only some segments. (The handle parsers do not trim; the ref form is the
 * canonical serialization and is the only parser that accepts surrounding
 * whitespace.)
 */
export function parseSessionRef(input: string): SessionRef {
  const normalized = input.trim()
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[1]?.startsWith(LANE_PREFIX)) {
    throw new Error('Invalid SessionRef: expected "<scopeRef>/lane:<laneRef>"')
  }

  const scopeRef = parts[0]?.trim() ?? ''
  const laneId = parts[1].slice(LANE_PREFIX.length).trim()
  if (scopeRef.length === 0 || laneId.length === 0) {
    throw new Error('Invalid SessionRef: scopeRef and laneRef are required')
  }

  return normalizeSessionRef({ scopeRef, laneRef: laneRefFromId(laneId) })
}

export function formatSessionRef(input: SessionRef): string {
  const normalized = normalizeSessionRef(input)
  const laneId = laneIdFromRef(normalized.laneRef)
  return `${normalized.scopeRef}/${LANE_PREFIX}${laneId}`
}
