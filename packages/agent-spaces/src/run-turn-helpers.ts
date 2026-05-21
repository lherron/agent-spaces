import type { UnifiedSessionEvent } from 'spaces-execution'

import type { InFlightRunContext } from './run-tracker.js'
import { mapContentToText } from './session-events.js'
import { CodedError } from './client-support.js'
import type { AgentSpacesError } from './types.js'

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
