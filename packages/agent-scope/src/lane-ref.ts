import type { LaneRef, ValidationResult } from './types.js'
import { validateToken } from './types.js'

/** Canonical prefix used by the `lane:<laneId>` ref form. */
const LANE_PREFIX = 'lane:'

/**
 * Validate a lane ref string. Returns { ok: true } or { ok: false, error }.
 */
export function validateLaneRef(laneRef: string): ValidationResult {
  if (laneRef === 'main') return { ok: true }

  if (!laneRef.startsWith(LANE_PREFIX)) {
    return { ok: false, error: 'LaneRef must be "main" or "lane:<laneId>"' }
  }

  const laneId = laneRef.slice(LANE_PREFIX.length)
  const laneErr = validateToken(laneId, 'laneId')
  if (laneErr) return { ok: false, error: laneErr }

  return { ok: true }
}

/**
 * Normalize a lane ref string. Omitted or undefined normalizes to "main".
 */
export function normalizeLaneRef(laneRef?: string): LaneRef {
  if (laneRef === undefined || laneRef === 'main') return 'main'

  const validation = validateLaneRef(laneRef)
  if (!validation.ok) {
    throw new Error(`Invalid LaneRef "${laneRef}": ${validation.error}`)
  }

  return laneRef as LaneRef
}

/**
 * Extract the bare lane id from a LaneRef. Returns "main" for the main lane,
 * otherwise the portion after the "lane:" prefix.
 */
export function laneIdFromRef(laneRef: LaneRef): string {
  return laneRef === 'main' ? 'main' : laneRef.slice(LANE_PREFIX.length)
}

/**
 * Build a LaneRef from a bare lane id. "main" maps to the main lane; any other
 * id is wrapped as "lane:<laneId>".
 */
export function laneRefFromId(laneId: string): LaneRef {
  return laneId === 'main' ? 'main' : `${LANE_PREFIX}${laneId}`
}
