import type { LaneRef } from './types.js'
import { TOKEN_MAX_LENGTH, TOKEN_MIN_LENGTH, TOKEN_PATTERN } from './types.js'

/**
 * Validate a lane ref string. Returns { ok: true } or { ok: false, error }.
 */
export function validateLaneRef(laneRef: string): { ok: true } | { ok: false; error: string } {
  if (laneRef === 'main') return { ok: true }

  if (!laneRef.startsWith('lane:')) {
    return { ok: false, error: 'LaneRef must be "main" or "lane:<laneId>"' }
  }

  const laneId = laneRef.slice(5)
  if (laneId.length < TOKEN_MIN_LENGTH || laneId.length > TOKEN_MAX_LENGTH) {
    return {
      ok: false,
      error: `laneId must be ${TOKEN_MIN_LENGTH}..${TOKEN_MAX_LENGTH} characters, got ${laneId.length}`,
    }
  }
  if (!TOKEN_PATTERN.test(laneId)) {
    return { ok: false, error: 'laneId contains invalid characters: must match [A-Za-z0-9._-]+' }
  }

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
