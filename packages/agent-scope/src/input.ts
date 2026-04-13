import { normalizeLaneRef } from './lane-ref.js'
import { parseScopeHandle, validateScopeHandle } from './scope-handle.js'
import { formatScopeRef, parseScopeRef, validateScopeRef } from './scope-ref.js'
import { parseSessionHandle } from './session-handle.js'
import type { LaneRef, ParsedScopeRef } from './types.js'

export type ResolvedScopeInput = {
  parsed: ParsedScopeRef
  scopeRef: string
  laneId: string
  laneRef: LaneRef
}

function toLaneRef(defaultLaneId?: string): LaneRef {
  if (!defaultLaneId || defaultLaneId === 'main') {
    return 'main'
  }

  return normalizeLaneRef(
    defaultLaneId.startsWith('lane:') ? defaultLaneId : `lane:${defaultLaneId}`
  )
}

export function resolveScopeInput(input: string, defaultLaneId?: string): ResolvedScopeInput {
  if (input.includes('~')) {
    const session = parseSessionHandle(input)
    return {
      parsed: parseScopeRef(session.scopeRef),
      scopeRef: session.scopeRef,
      laneId: session.laneRef === 'main' ? 'main' : session.laneRef.slice(5),
      laneRef: session.laneRef,
    }
  }

  const laneRef = toLaneRef(defaultLaneId)

  const handleResult = validateScopeHandle(input)
  if (handleResult.ok) {
    const parsed = parseScopeHandle(input)
    return {
      parsed,
      scopeRef: formatScopeRef(parsed),
      laneId: laneRef === 'main' ? 'main' : laneRef.slice(5),
      laneRef,
    }
  }

  const refResult = validateScopeRef(input)
  if (refResult.ok) {
    return {
      parsed: parseScopeRef(input),
      scopeRef: input,
      laneId: laneRef === 'main' ? 'main' : laneRef.slice(5),
      laneRef,
    }
  }

  throw new Error(
    `Invalid scope input "${input}": expected a ScopeHandle, SessionHandle, or ScopeRef`
  )
}
