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

export function parseSessionRef(input: string): SessionRef {
  const normalized = input.trim()
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[1]?.startsWith('lane:')) {
    throw new Error('Invalid SessionRef: expected "<scopeRef>/lane:<laneRef>"')
  }

  const scopeRef = parts[0]?.trim() ?? ''
  const laneId = parts[1].slice('lane:'.length).trim()
  if (scopeRef.length === 0 || laneId.length === 0) {
    throw new Error('Invalid SessionRef: scopeRef and laneRef are required')
  }

  return normalizeSessionRef({ scopeRef, laneRef: laneId === 'main' ? 'main' : `lane:${laneId}` })
}

export function formatSessionRef(input: SessionRef): string {
  const normalized = normalizeSessionRef(input)
  const laneId = normalized.laneRef.startsWith('lane:')
    ? normalized.laneRef.slice('lane:'.length)
    : normalized.laneRef
  return `${normalized.scopeRef}/lane:${laneId}`
}
