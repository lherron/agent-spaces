import { existsSync } from 'node:fs'

import { isAbsolute } from 'node:path'

import { ensureDir, normalizeAgentSdkModel } from 'spaces-config'

import { type UnifiedSession, type UnifiedSessionEvent, createSession } from 'spaces-execution'

import { createAgentSpacesClient as createCompilerClient } from 'agent-spaces'
import { PiSession, loadPiSdkBundle } from 'spaces-harness-pi-sdk/pi-session'

import {
  type InFlightRunContext,
  completeInFlightFailure,
  completeInFlightSuccess,
  createInFlightRunMap,
  enqueueInFlightPrompt,
  rejectInFlight,
  resolveInFlight,
} from './run-tracker.js'

import { applyEnvOverlay, piSessionPath, resolveHostSessionId, withAspHome } from './runtime-env.js'

import {
  type EventEmitter,
  type EventPayload,
  buildAutoPermissionHandler,
  createEventEmitter,
  mapUnifiedEvents,
  runSession,
} from './session-events.js'

import type {
  AgentSpacesClient,
  AgentSpacesClientOptions,
  HarnessContinuationRef,
  InterruptInFlightTurnRequest,
  ProviderDomain,
  QueueInFlightInputRequest,
  QueueInFlightInputResponse,
  RunResult,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
} from 'agent-spaces'
import {
  AGENT_SDK_FRONTEND,
  CodedError,
  type FrontendDef,
  PI_SDK_FRONTEND,
  type ValidatedSpec,
  assertProviderMatch,
  materializeSpec,
  resolveFrontend,
  resolveModel,
  validateSpec,
} from 'agent-spaces/turn-support'
import { runPlacementTurnNonInteractive } from './run-placement-turn.js'
import { emitTurnFailure, toAgentSpacesError } from './run-turn-helpers.js'
import { attachTurnDriver } from './turn-driver.js'

// ---------------------------------------------------------------------------
// Frontend definitions (provider-typed harness registry, spec §5.1)
// ---------------------------------------------------------------------------

/**
 * Build a {@link HarnessContinuationRef} from a provider + optional key, or
 * `undefined` when no key is present. Centralizes the repeated
 * `key ? { provider, key } : undefined` ternary used across the turn paths.
 */
function buildContinuationRef(
  provider: ProviderDomain,
  key: string | undefined
): HarnessContinuationRef | undefined {
  return key ? { provider, key } : undefined
}

/**
 * Result of {@link validateTurnRequest}: either the resolved
 * spec + model-resolution tuple, or an already-emitted failure response to
 * return early. `resolved` discriminates the try/catch outcome (NOT model
 * support — `modelResolution.ok` is still checked by the caller after the
 * running/message events).
 */
type ValidateTurnRequestResult =
  | { resolved: true; spec: ValidatedSpec; modelResolution: ReturnType<typeof resolveModel> }
  | { resolved: false; failureResponse: RunTurnNonInteractiveResponse }

/**
 * Hoisted early-validation guard shared by `runTurnInFlight` and the
 * non-placement `runTurnNonInteractive`. Runs the identical
 * `validateSpec` → `isAbsolute(cwd)` → `assertProviderMatch` → `resolveModel`
 * block; on any throw it emits the canonical failure event pair via
 * {@link emitTurnFailure} (state:error then complete) and returns that response
 * for the caller to return early. The emitted failure-event order is preserved.
 */
async function validateTurnRequest(
  req: RunTurnNonInteractiveRequest,
  frontendDef: FrontendDef,
  eventEmitter: EventEmitter
): Promise<ValidateTurnRequestResult> {
  try {
    const spec = validateSpec(req.spec)
    if (!isAbsolute(req.cwd)) {
      throw new Error('cwd must be an absolute path')
    }
    assertProviderMatch(frontendDef, req.continuation)
    const modelResolution = resolveModel(frontendDef, req.model)
    return { resolved: true, spec, modelResolution }
  } catch (error) {
    const failureResponse = await emitTurnFailure(
      eventEmitter,
      { provider: frontendDef.provider, frontend: req.frontend, model: req.model },
      toAgentSpacesError(error)
    )
    return { resolved: false, failureResponse }
  }
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export function createAgentSpacesClient(options?: AgentSpacesClientOptions): AgentSpacesClient {
  const clientAspHome = options?.aspHome
  const inFlightRuns = createInFlightRunMap()
  const compilerClient = createCompilerClient(options)

  return {
    ...compilerClient,

    async runTurnInFlight(req: RunTurnInFlightRequest): Promise<RunTurnNonInteractiveResponse> {
      return withAspHome(req.aspHome, async () => {
        const frontendDef = resolveFrontend(req.frontend)
        const hostSessionId = resolveHostSessionId(req)
        const eventEmitter = createEventEmitter(
          req.callbacks.onEvent,
          { hostSessionId: hostSessionId as string, runId: req.runId },
          req.continuation
        )

        if (frontendDef.frontend !== AGENT_SDK_FRONTEND) {
          return emitTurnFailure(
            eventEmitter,
            { provider: frontendDef.provider, frontend: req.frontend, model: req.model },
            toAgentSpacesError(
              new CodedError(
                `In-flight input is only supported for frontend "${AGENT_SDK_FRONTEND}"`,
                'unsupported_frontend'
              )
            )
          )
        }

        if (inFlightRuns.has(hostSessionId as string)) {
          return emitTurnFailure(
            eventEmitter,
            { provider: frontendDef.provider, frontend: req.frontend, model: req.model },
            toAgentSpacesError(
              new Error(`In-flight run already active for hostSessionId ${hostSessionId as string}`)
            )
          )
        }

        const continuationKey = req.continuation?.key

        const validated = await validateTurnRequest(req, frontendDef, eventEmitter)
        if (!validated.resolved) return validated.failureResponse
        const { spec, modelResolution } = validated

        if (continuationKey) {
          eventEmitter.setContinuation({
            provider: frontendDef.provider,
            key: continuationKey,
          })
        }

        await eventEmitter.emit({ type: 'state', state: 'running' } as EventPayload)
        await eventEmitter.emit({
          type: 'message',
          role: 'user',
          content: req.prompt,
        } as EventPayload)

        if (!modelResolution.ok) {
          const error = toAgentSpacesError(
            new Error(
              `Model not supported for frontend ${frontendDef.frontend}: ${modelResolution.modelId}`
            ),
            'model_not_supported'
          )
          return emitTurnFailure(
            eventEmitter,
            {
              provider: frontendDef.provider,
              frontend: req.frontend,
              model: modelResolution.modelId,
            },
            error
          )
        }

        const permissionHandler = buildAutoPermissionHandler()
        let session: UnifiedSession | undefined
        let context: InFlightRunContext | undefined

        try {
          const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId)
          const restoreEnv = applyEnvOverlay({})

          try {
            const plugins = materialized.materialization.pluginDirs.map((dir) => ({
              type: 'local' as const,
              path: dir,
            }))

            session = createSession({
              kind: 'agent-sdk',
              sessionId: continuationKey ?? (hostSessionId as string),
              cwd: req.cwd,
              model: normalizeAgentSdkModel(modelResolution.info.model),
              plugins,
              permissionHandler,
              ...(continuationKey ? { continuationKey } : {}),
            })

            const completionPromise = new Promise<RunTurnNonInteractiveResponse>(
              (resolve, reject) => {
                const activeSession = session
                if (!activeSession) {
                  throw new Error('Session creation failed unexpectedly')
                }
                const started = activeSession.start()
                const assistantState: {
                  assistantBuffer: string
                  lastAssistantText?: string | undefined
                } = { assistantBuffer: '' }

                context = {
                  hostSessionId: hostSessionId as string,
                  runId: req.runId,
                  provider: frontendDef.provider,
                  frontend: req.frontend,
                  model: modelResolution.info.effectiveModel,
                  session: activeSession,
                  eventEmitter,
                  assistantState,
                  allowSessionIdUpdate: true,
                  continuationKey,
                  outstandingTurns: 0,
                  acceptedInputApplicationIds: new Set<string>(),
                  started,
                  completion: { done: false, resolve, reject },
                  sendChain: Promise.resolve(),
                }

                inFlightRuns.set(hostSessionId as string, context)

                attachTurnDriver(activeSession, context, {
                  onContinuationKey: (key) => {
                    if (!context) return
                    context.continuationKey = key
                    context.eventEmitter.setContinuation({
                      provider: frontendDef.provider,
                      key,
                    })
                  },
                  onDrained: (activeContext) => {
                    void completeInFlightSuccess(activeContext)
                      .then((response) => resolveInFlight(activeContext, response))
                      .catch((error) => rejectInFlight(activeContext, error))
                  },
                })

                void started.catch((error) => {
                  if (!context || context.completion.done) return
                  const activeContext = context
                  void completeInFlightFailure(activeContext, error, 'resolve_failed')
                    .then((response) => resolveInFlight(activeContext, response))
                    .catch((failureError) => rejectInFlight(activeContext, failureError))
                })

                void enqueueInFlightPrompt(context, req.prompt, req.attachments).catch((error) => {
                  if (!context || context.completion.done) return
                  const activeContext = context
                  activeContext.outstandingTurns = Math.max(0, activeContext.outstandingTurns - 1)
                  void completeInFlightFailure(activeContext, error, 'resolve_failed')
                    .then((response) => resolveInFlight(activeContext, response))
                    .catch((failureError) => rejectInFlight(activeContext, failureError))
                })
              }
            )

            return await completionPromise
          } finally {
            inFlightRuns.delete(hostSessionId as string)
            if (session) {
              try {
                await session.stop('complete')
              } catch {
                // Ignore cleanup failures.
              }
            }
            restoreEnv()
            await eventEmitter.idle()
          }
        } catch (error) {
          if (context && !context.completion.done) {
            const response = await completeInFlightFailure(context, error, 'resolve_failed')
            resolveInFlight(context, response)
            return response
          }

          return emitTurnFailure(
            eventEmitter,
            {
              provider: frontendDef.provider,
              frontend: req.frontend,
              model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            },
            toAgentSpacesError(error, 'resolve_failed')
          )
        }
      })
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

      // Fallback: hard-stop when an interrupt primitive is unavailable.
      await context.session.stop(req.reason ?? 'interrupt')
    },

    async runTurnNonInteractive(
      req: RunTurnNonInteractiveRequest
    ): Promise<RunTurnNonInteractiveResponse> {
      // Placement-based path (v2)
      if (req.placement) {
        return runPlacementTurnNonInteractive(req, clientAspHome, inFlightRuns)
      }

      return withAspHome(req.aspHome, async () => {
        const frontendDef = resolveFrontend(req.frontend)
        const hostSessionId = resolveHostSessionId(req)
        const eventEmitter = createEventEmitter(
          req.callbacks.onEvent,
          { hostSessionId: hostSessionId as string, runId: req.runId },
          req.continuation
        )

        let continuationKey = req.continuation?.key

        const validated = await validateTurnRequest(req, frontendDef, eventEmitter)
        if (!validated.resolved) return validated.failureResponse
        const { spec, modelResolution } = validated

        // Determine session/continuation context (no session record persistence)
        const isResume = continuationKey !== undefined
        if (frontendDef.frontend === PI_SDK_FRONTEND && !continuationKey) {
          // For pi-sdk first run, create deterministic session path as continuation key
          continuationKey = piSessionPath(req.aspHome, hostSessionId as string)
        }

        // Update continuation on emitter
        if (continuationKey) {
          eventEmitter.setContinuation({
            provider: frontendDef.provider,
            key: continuationKey,
          })
        }

        await eventEmitter.emit({ type: 'state', state: 'running' } as EventPayload)
        await eventEmitter.emit({
          type: 'message',
          role: 'user',
          content: req.prompt,
        } as EventPayload)

        if (!modelResolution.ok) {
          const error = toAgentSpacesError(
            new Error(
              `Model not supported for frontend ${frontendDef.frontend}: ${modelResolution.modelId}`
            ),
            'model_not_supported'
          )
          return emitTurnFailure(
            eventEmitter,
            {
              provider: frontendDef.provider,
              frontend: req.frontend,
              model: modelResolution.modelId,
            },
            error
          )
        }

        // For pi-sdk resume: validate session path exists
        if (frontendDef.frontend === PI_SDK_FRONTEND && isResume && continuationKey) {
          if (!existsSync(continuationKey)) {
            const error = toAgentSpacesError(
              new Error(`Continuation not found: ${continuationKey}`),
              'continuation_not_found'
            )
            return emitTurnFailure(
              eventEmitter,
              {
                continuation: { provider: frontendDef.provider, key: continuationKey },
                provider: frontendDef.provider,
                frontend: req.frontend,
                model: modelResolution.info.effectiveModel,
              },
              error
            )
          }
        }

        // For pi-sdk first run: ensure session directory exists
        if (frontendDef.frontend === PI_SDK_FRONTEND && !isResume && continuationKey) {
          await ensureDir(continuationKey)
        }

        const permissionHandler = buildAutoPermissionHandler()

        let session: UnifiedSession | undefined
        let turnEnded = false
        let finalOutput: string | undefined
        const assistantState: { assistantBuffer: string; lastAssistantText?: string | undefined } =
          {
            assistantBuffer: '',
          }

        try {
          const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId)

          const harnessEnv: Record<string, string> = {}
          if (frontendDef.frontend === PI_SDK_FRONTEND) {
            harnessEnv['PI_CODING_AGENT_DIR'] = materialized.materialization.outputPath
          }

          const restoreEnv = applyEnvOverlay(harnessEnv)
          try {
            if (frontendDef.frontend === AGENT_SDK_FRONTEND) {
              const plugins = materialized.materialization.pluginDirs.map((dir) => ({
                type: 'local' as const,
                path: dir,
              }))
              session = createSession({
                kind: 'agent-sdk',
                sessionId: continuationKey ?? (hostSessionId as string),
                cwd: req.cwd,
                model: normalizeAgentSdkModel(modelResolution.info.model),
                plugins,
                permissionHandler,
                ...(isResume && continuationKey ? { continuationKey } : {}),
              })
            } else {
              // pi-sdk
              const bundle = await loadPiSdkBundle(materialized.materialization.outputPath, {
                cwd: req.cwd,
                yolo: true,
                noExtensions: false,
                noSkills: false,
                agentDir: materialized.materialization.outputPath,
              })
              const piSession = new PiSession({
                ownerId: hostSessionId as string,
                cwd: req.cwd,
                provider: modelResolution.info.provider,
                model: modelResolution.info.model,
                sessionId: hostSessionId as string,
                extensions: bundle.extensions,
                skills: bundle.skills,
                contextFiles: bundle.contextFiles,
                agentDir: materialized.materialization.outputPath,
                ...(continuationKey ? { sessionPath: continuationKey } : {}),
              })
              piSession.setPermissionHandler(permissionHandler)
              session = piSession
            }

            if (!session) {
              throw new Error(`No session created for frontend ${frontendDef.frontend}`)
            }
            const activeSession = session

            const turnPromise = new Promise<void>((resolve, reject) => {
              activeSession.onEvent((event: UnifiedSessionEvent) => {
                const result = mapUnifiedEvents(
                  event,
                  (mapped) => {
                    void eventEmitter.emit(mapped)
                  },
                  (key) => {
                    // Continuation key observed from SDK events
                    continuationKey = key
                    eventEmitter.setContinuation({
                      provider: frontendDef.provider,
                      key,
                    })
                  },
                  assistantState,
                  { allowSessionIdUpdate: frontendDef.frontend !== PI_SDK_FRONTEND }
                )

                if (result.turnEnded && !turnEnded) {
                  turnEnded = true
                  void eventEmitter.idle().then(resolve, reject)
                }
              })
            })

            await runSession(activeSession, req.prompt, req.attachments, req.runId)
            await turnPromise
            await activeSession.stop('complete')
            await eventEmitter.idle()
            finalOutput = assistantState.lastAssistantText
          } finally {
            restoreEnv()
          }

          const result: RunResult = { success: true, ...(finalOutput ? { finalOutput } : {}) }
          await eventEmitter.emit({ type: 'state', state: 'complete' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)

          // Build final continuation ref
          const finalContinuation = buildContinuationRef(frontendDef.provider, continuationKey)

          return {
            ...(finalContinuation ? { continuation: finalContinuation } : {}),
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.info.effectiveModel,
            result,
          }
        } catch (error) {
          if (session) {
            try {
              await session.stop('error')
            } catch {
              // Ignore cleanup failures.
            }
          }

          const finalContinuation = buildContinuationRef(frontendDef.provider, continuationKey)

          return emitTurnFailure(
            eventEmitter,
            {
              ...(finalContinuation ? { continuation: finalContinuation } : {}),
              provider: frontendDef.provider,
              frontend: req.frontend,
              model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            },
            toAgentSpacesError(error, 'resolve_failed')
          )
        }
      })
    },
  }
}
