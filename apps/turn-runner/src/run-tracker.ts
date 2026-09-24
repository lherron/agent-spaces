import type { AttachmentRef, UnifiedSession } from 'spaces-execution'

import { type EventEmitter, normalizeAttachmentRefs } from './session-events.js'

import type { ProviderDomain } from 'agent-spaces'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface InFlightRunContext {
  hostSessionId: string
  runId: string
  provider: ProviderDomain
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  session: UnifiedSession
  eventEmitter: EventEmitter
  assistantState: { assistantBuffer: string; lastAssistantText?: string | undefined }
  allowSessionIdUpdate: boolean
  continuationKey?: string | undefined
  outstandingTurns: number
  sawInFlightInput?: boolean | undefined
  acceptedInputApplicationIds: Set<string>
  started: Promise<void>
  completion: { done: false } | { done: true }
  sendChain: Promise<void>
}

// ---------------------------------------------------------------------------
// In-flight run Map management
// ---------------------------------------------------------------------------

export function createInFlightRunMap(): Map<string, InFlightRunContext> {
  return new Map<string, InFlightRunContext>()
}

// ---------------------------------------------------------------------------
// In-flight prompt chaining
// ---------------------------------------------------------------------------

export function enqueueInFlightPrompt(
  context: InFlightRunContext,
  prompt: string,
  attachments: Array<string | AttachmentRef> | undefined,
  options: { inFlight?: boolean | undefined } = {}
): Promise<void> {
  context.outstandingTurns += 1
  if (options.inFlight === true) {
    context.sawInFlightInput = true
  }
  const attachmentRefs = normalizeAttachmentRefs(attachments)

  context.sendChain = context.sendChain.then(async () => {
    await context.started
    await context.session.sendPrompt(prompt, {
      ...(attachmentRefs ? { attachments: attachmentRefs } : {}),
      runId: context.runId,
    })
  })

  return context.sendChain
}
