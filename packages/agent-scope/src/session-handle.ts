import { formatScopeHandle, parseScopeHandle } from './scope-handle.js'
import { parseScopeRef } from './scope-ref.js'
import type { SessionRef } from './types.js'

/**
 * SessionHandle grammar:
 *   <ScopeHandle> ["~" <laneId>]
 *
 * When ~lane is absent, laneRef defaults to "main".
 * formatSessionHandle elides ~main (outputs just the scope handle).
 */

/**
 * Parse a session handle string into a SessionRef.
 * Throws if the handle is invalid.
 */
export function parseSessionHandle(handle: string): SessionRef {
  const tildeIdx = handle.indexOf('~')

  let scopePart: string
  let laneId: string | undefined

  if (tildeIdx === -1) {
    scopePart = handle
  } else {
    scopePart = handle.slice(0, tildeIdx)
    laneId = handle.slice(tildeIdx + 1)
  }

  // Parse the scope portion to get the canonical scopeRef
  const parsed = parseScopeHandle(scopePart)

  return {
    scopeRef: parsed.scopeRef,
    laneRef: laneId === undefined || laneId === 'main' ? 'main' : `lane:${laneId}`,
  }
}

/**
 * Format a SessionRef back into its shorthand handle form.
 * Elides ~main suffix.
 */
export function formatSessionHandle(ref: SessionRef): string {
  const parsed = parseScopeRef(ref.scopeRef)
  const scopeHandle = formatScopeHandle(parsed)

  if (ref.laneRef === 'main') {
    return scopeHandle
  }

  // Extract lane id from "lane:<laneId>"
  const laneId = ref.laneRef.slice(5)
  return `${scopeHandle}~${laneId}`
}
