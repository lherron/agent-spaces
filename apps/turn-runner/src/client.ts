import { createAgentSpacesClient as createCompilerClient } from 'agent-spaces'
import { CodedError, sessionRuntimeFacts } from 'agent-spaces/turn-support'

import type {
  AgentSpacesClient,
  AgentSpacesClientOptions,
  InterruptInFlightTurnRequest,
  QueueInFlightInputRequest,
  QueueInFlightInputResponse,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
} from 'agent-spaces'
import { compilerRuntime } from './compiler-runtime.js'
import { runPlacementTurnNonInteractive } from './run-placement-turn.js'
import { createInFlightRunMap, enqueueInFlightPrompt } from './run-tracker.js'
import { emitTurnFailure, toAgentSpacesError } from './run-turn-helpers.js'
import { resolveHostSessionId } from './runtime-env.js'
import { type EventPayload, createEventEmitter } from './session-events.js'

/**
 * Turn execution is placement-only after the v2 cutover. The old direct SDK
 * request contained frontend identity but no canonical harness selection, so
 * accepting it would recreate a frontend-to-harness route in this package.
 */
async function rejectDirectSdkTurn(
  req: RunTurnNonInteractiveRequest
): Promise<RunTurnNonInteractiveResponse> {
  const facts = sessionRuntimeFacts(req.frontend) as
    | ReturnType<typeof sessionRuntimeFacts>
    | undefined
  if (facts === undefined) {
    throw new CodedError(`Unsupported session runtime: ${req.frontend}`, 'unsupported_frontend')
  }
  const hostSessionId = resolveHostSessionId(req)
  const eventEmitter = createEventEmitter(
    req.callbacks.onEvent,
    { hostSessionId: hostSessionId as string, runId: req.runId },
    req.continuation
  )
  return emitTurnFailure(
    eventEmitter,
    { provider: facts.provider, frontend: req.frontend, model: req.model },
    toAgentSpacesError(
      new CodedError(
        'Direct SDK turn requests are retired; supply placement so ASP resolves the canonical harness.',
        'unsupported_frontend'
      )
    )
  )
}

export function createAgentSpacesClient(options?: AgentSpacesClientOptions): AgentSpacesClient {
  const clientAspHome = options?.aspHome
  const inFlightRuns = createInFlightRunMap()
  const compilerClient = createCompilerClient({
    ...options,
    runtime: options?.runtime ?? compilerRuntime,
  })

  return {
    ...compilerClient,

    async runTurnInFlight(req: RunTurnInFlightRequest): Promise<RunTurnNonInteractiveResponse> {
      return rejectDirectSdkTurn(req)
    },

    async queueInFlightInput(req: QueueInFlightInputRequest): Promise<QueueInFlightInputResponse> {
      const hostSessionId = resolveHostSessionId(req)
      const context = inFlightRuns.get(hostSessionId as string)
      if (!context) {
        throw new Error(`No active in-flight run for hostSessionId ${hostSessionId as string}`)
      }
      if (context.runId !== req.runId) {
        throw new Error(
          `Active in-flight run mismatch for hostSessionId ${hostSessionId as string}: expected ${context.runId}, got ${req.runId}`
        )
      }
      if (context.completion.done) {
        throw new Error(`In-flight run ${req.runId} is already completed`)
      }
      if (
        req.inputApplicationId !== undefined &&
        context.acceptedInputApplicationIds.has(req.inputApplicationId)
      ) {
        return { accepted: true, pendingTurns: context.outstandingTurns }
      }

      await context.eventEmitter.emit({
        type: 'message',
        role: 'user',
        content: req.prompt,
      } as EventPayload)

      await enqueueInFlightPrompt(context, req.prompt, req.attachments, { inFlight: true })
      if (req.semantics === 'interrupt_and_continue') {
        const interruptable = context.session as { interrupt?: (reason?: string) => Promise<void> }
        if (typeof interruptable.interrupt === 'function') {
          await interruptable.interrupt('in-flight user correction')
        }
      }
      if (req.inputApplicationId !== undefined) {
        context.acceptedInputApplicationIds.add(req.inputApplicationId)
      }
      return { accepted: true, pendingTurns: context.outstandingTurns }
    },

    async interruptInFlightTurn(req: InterruptInFlightTurnRequest): Promise<void> {
      const hostSessionId = resolveHostSessionId(req)
      const context = inFlightRuns.get(hostSessionId as string)
      if (!context) {
        throw new Error(`No active in-flight run for hostSessionId ${hostSessionId as string}`)
      }
      if (req.runId && context.runId !== req.runId) {
        throw new Error(
          `Active in-flight run mismatch for hostSessionId ${hostSessionId as string}: expected ${context.runId}, got ${req.runId}`
        )
      }
      if (context.completion.done) {
        return
      }

      const interruptable = context.session as { interrupt?: (reason?: string) => Promise<void> }
      if (typeof interruptable.interrupt === 'function') {
        await interruptable.interrupt(req.reason)
        return
      }
      await context.session.stop(req.reason ?? 'interrupt')
    },

    async runTurnNonInteractive(
      req: RunTurnNonInteractiveRequest
    ): Promise<RunTurnNonInteractiveResponse> {
      if (req.placement) {
        return runPlacementTurnNonInteractive(req, clientAspHome, inFlightRuns)
      }
      return rejectDirectSdkTurn(req)
    },
  }
}
