import type { UnifiedSessionEvent } from 'spaces-execution'

import { CodedError } from './client-support.js'
import type { InFlightRunContext } from './run-tracker.js'
import { type EventEmitter, type EventPayload, mapContentToText } from './session-events.js'
import type { AgentSpacesError, RunResult, RunTurnNonInteractiveResponse } from './types.js'

export function toAgentSpacesError(
  error: unknown,
  code?: AgentSpacesError['code']
): AgentSpacesError {
  const message = error instanceof Error ? error.message : String(error)
  const errorCode = code ?? (error instanceof CodedError ? error.code : undefined)
  const details: Record<string, unknown> = {}
  if (error instanceof Error && error.stack) {
    details['stack'] = error.stack
  }
  return {
    message,
    ...(errorCode ? { code: errorCode } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}

/**
 * Identity fields of a turn response (everything except `result`). Carried into
 * {@link emitTurnFailure} so the failure path returns the same provider/frontend/
 * model/continuation/resolvedBundle shape as the success path.
 */
export type TurnResponseBase = Omit<RunTurnNonInteractiveResponse, 'result'>

/**
 * Emit the canonical turn-failure event pair (`state:error` then `complete`) and
 * return the assembled failure response. Centralizes the shotgun-surgery-prone
 * "build failure RunResult → emit state:error → emit complete → return base+result"
 * triple that was hand-copied across the turn implementations.
 */
export async function emitTurnFailure(
  eventEmitter: EventEmitter,
  base: TurnResponseBase,
  error: AgentSpacesError
): Promise<RunTurnNonInteractiveResponse> {
  const result: RunResult = { success: false, error }
  await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
  await eventEmitter.emit({ type: 'complete', result } as EventPayload)
  return { ...base, result }
}

function assistantMessageEndedWithOutput(
  event: UnifiedSessionEvent,
  state: { assistantBuffer: string; lastAssistantText?: string | undefined }
): boolean {
  if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
    return false
  }
  const content = mapContentToText(event.message.content)
  const finalText = content ?? state.assistantBuffer
  return finalText.trim().length > 0
}

export function shouldDrainOutstandingTurn(
  event: UnifiedSessionEvent,
  mapped: { turnEnded: boolean },
  context: InFlightRunContext
): boolean {
  return (
    mapped.turnEnded ||
    (context.sawInFlightInput === true &&
      assistantMessageEndedWithOutput(event, context.assistantState))
  )
}
