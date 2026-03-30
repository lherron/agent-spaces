import { basename } from 'node:path'

import type { UnifiedSession } from 'spaces-execution'

import type { EventEmitter, EventPayload } from './session-events.js'

import type {
  AgentSpacesError,
  HarnessContinuationRef,
  ProviderDomain,
  RunResult,
  RunTurnNonInteractiveResponse,
} from './types.js'

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
  started: Promise<void>
  completion:
    | {
        done: false
        resolve: (value: RunTurnNonInteractiveResponse) => void
        reject: (error: unknown) => void
      }
    | { done: true }
  sendChain: Promise<void>
}

// ---------------------------------------------------------------------------
// In-flight run Map management
// ---------------------------------------------------------------------------

export function createInFlightRunMap(): Map<string, InFlightRunContext> {
  return new Map<string, InFlightRunContext>()
}

// ---------------------------------------------------------------------------
// In-flight closure helpers
// ---------------------------------------------------------------------------

function toAgentSpacesError(error: unknown, code?: AgentSpacesError['code']): AgentSpacesError {
  const message = error instanceof Error ? error.message : String(error)
  const errorCode = code ?? undefined
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

export function buildInFlightResponse(
  context: InFlightRunContext,
  result: RunResult
): RunTurnNonInteractiveResponse {
  const continuation: HarnessContinuationRef | undefined = context.continuationKey
    ? { provider: context.provider, key: context.continuationKey }
    : undefined

  return {
    ...(continuation ? { continuation } : {}),
    provider: context.provider,
    frontend: context.frontend,
    model: context.model,
    result,
  }
}

export async function completeInFlightSuccess(
  context: InFlightRunContext
): Promise<RunTurnNonInteractiveResponse> {
  const finalOutput = context.assistantState.lastAssistantText
  const result: RunResult = { success: true, ...(finalOutput ? { finalOutput } : {}) }
  await context.eventEmitter.emit({ type: 'state', state: 'complete' } as EventPayload)
  await context.eventEmitter.emit({ type: 'complete', result } as EventPayload)
  return buildInFlightResponse(context, result)
}

export async function completeInFlightFailure(
  context: InFlightRunContext,
  error: unknown,
  code?: AgentSpacesError['code']
): Promise<RunTurnNonInteractiveResponse> {
  const result: RunResult = {
    success: false,
    error: toAgentSpacesError(error, code),
  }
  await context.eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
  await context.eventEmitter.emit({ type: 'complete', result } as EventPayload)
  return buildInFlightResponse(context, result)
}

export function resolveInFlight(
  context: InFlightRunContext,
  response: RunTurnNonInteractiveResponse
): void {
  if (context.completion.done) return
  context.completion.resolve(response)
  context.completion = { done: true }
}

export function rejectInFlight(context: InFlightRunContext, error: unknown): void {
  if (context.completion.done) return
  context.completion.reject(error)
  context.completion = { done: true }
}

export function enqueueInFlightPrompt(
  context: InFlightRunContext,
  prompt: string,
  attachments: string[] | undefined
): Promise<void> {
  context.outstandingTurns += 1
  const attachmentRefs = attachments?.map((path) => ({
    kind: 'file' as const,
    path,
    filename: basename(path),
  }))

  context.sendChain = context.sendChain.then(async () => {
    await context.started
    await context.session.sendPrompt(prompt, {
      ...(attachmentRefs ? { attachments: attachmentRefs } : {}),
      runId: context.runId,
    })
  })

  return context.sendChain
}
