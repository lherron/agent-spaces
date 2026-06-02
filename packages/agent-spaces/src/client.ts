import { existsSync } from 'node:fs'

import { isAbsolute } from 'node:path'

import {
  HARNESS_PROVIDERS,
  ensureDir,
  getHarnessFrontendsForProvider,
  normalizeAgentSdkModel,
} from 'spaces-config'

import {
  type UnifiedSession,
  type UnifiedSessionEvent,
  createSession,
  harnessRegistry,
} from 'spaces-execution'

import { buildCodexAppServerLaunchDescriptor } from 'spaces-harness-codex'
import { PiSession, loadPiSdkBundle } from 'spaces-harness-pi-sdk/pi-session'
import {
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import { compileRuntimePlan } from './compile-runtime-plan.js'

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
  type EventPayload,
  buildAutoPermissionHandler,
  createEventEmitter,
  mapUnifiedEvents,
  runSession,
} from './session-events.js'

import {
  type ValidatedSpec,
  collectHooks,
  collectLintWarnings,
  collectTools,
  materializeSpec,
  resolveSpecToLock,
  validateSpec,
} from './client-materialization.js'
import {
  AGENT_SDK_FRONTEND,
  CodedError,
  FRONTEND_DEFS,
  PI_SDK_FRONTEND,
  formatDisplayCommand,
  resolveFrontend,
  resolveModel,
  validateProviderMatch,
} from './client-support.js'
import { preparePlacementCliRuntime, toProcessInvocationSpec } from './prepare-cli-runtime.js'
import { runPlacementTurnNonInteractive } from './run-placement-turn.js'
import {
  emitTurnFailure,
  shouldDrainOutstandingTurn,
  toAgentSpacesError,
} from './run-turn-helpers.js'
import type {
  AgentSpacesClient,
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationRef,
  HarnessFrontend,
  InterruptInFlightTurnRequest,
  ProcessInvocationSpec,
  QueueInFlightInputRequest,
  QueueInFlightInputResponse,
  ResolveRequest,
  ResolveResponse,
  RunResult,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
} from './types.js'

// ---------------------------------------------------------------------------
// Frontend definitions (provider-typed harness registry, spec §5.1)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export interface AgentSpacesClientOptions {
  aspHome?: string | undefined
  registryPath?: string | undefined
}

export function createAgentSpacesClient(options?: AgentSpacesClientOptions): AgentSpacesClient {
  const clientAspHome = options?.aspHome
  const _clientRegistryPath = options?.registryPath
  const inFlightRuns = createInFlightRunMap()

  return {
    async compileRuntimePlan(req) {
      return compileRuntimePlan(req, { clientAspHome })
    },

    async resolve(req: ResolveRequest): Promise<ResolveResponse> {
      return withAspHome(req.aspHome, async () => {
        try {
          const spec = validateSpec(req.spec)
          await resolveSpecToLock(spec, req.aspHome)
          return { ok: true }
        } catch (error) {
          return {
            ok: false,
            error: toAgentSpacesError(error, 'resolve_failed'),
          }
        }
      })
    },

    async describe(req: DescribeRequest): Promise<DescribeResponse> {
      return withAspHome(req.aspHome, async () => {
        const spec = validateSpec(req.spec)
        const frontendDef = req.frontend
          ? resolveFrontend(req.frontend)
          : resolveFrontend(AGENT_SDK_FRONTEND)
        const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId, {
          registryPathOverride: req.registryPath,
        })
        const hooks = await collectHooks(materialized.materialization.pluginDirs)
        const tools = await collectTools(materialized.materialization.mcpConfigPath)
        const lintWarnings =
          req.runLint === true
            ? await collectLintWarnings(spec, req.aspHome, req.registryPath)
            : undefined
        const response: DescribeResponse = {
          hooks,
          skills: materialized.skills,
          tools,
        }

        if (lintWarnings) {
          response.lintWarnings = lintWarnings
        }

        if (frontendDef.frontend === AGENT_SDK_FRONTEND) {
          const modelResolution = resolveModel(frontendDef, req.model)
          if (!modelResolution.ok) {
            throw new Error(
              `Model not supported for frontend ${frontendDef.frontend}: ${modelResolution.modelId}`
            )
          }
          const plugins = materialized.materialization.pluginDirs.map((dir) => ({
            type: 'local' as const,
            path: dir,
          }))
          response.agentSdkSessionParams = [
            { paramName: 'kind', paramValue: 'agent-sdk' },
            { paramName: 'sessionId', paramValue: resolveHostSessionId(req, false) ?? null },
            { paramName: 'cwd', paramValue: req.cwd ?? null },
            { paramName: 'model', paramValue: normalizeAgentSdkModel(modelResolution.info.model) },
            { paramName: 'plugins', paramValue: plugins },
            { paramName: 'permissionHandler', paramValue: 'auto-allow' },
          ]
        }

        return response
      })
    },

    async getHarnessCapabilities(): Promise<HarnessCapabilities> {
      return {
        harnesses: HARNESS_PROVIDERS.map((provider) => {
          const frontends = getHarnessFrontendsForProvider(provider) as HarnessFrontend[]
          return {
            id: provider,
            provider,
            frontends,
            models: frontends.flatMap((frontend) => FRONTEND_DEFS.get(frontend)?.models ?? []),
          }
        }),
      }
    },

    async buildProcessInvocationSpec(
      req: BuildProcessInvocationSpecRequest
    ): Promise<BuildProcessInvocationSpecResponse> {
      // Placement-based path (v2)
      if (req.placement) {
        const prepared = await preparePlacementCliRuntime(req, clientAspHome)
        return toProcessInvocationSpec(prepared, req)
      }

      return withAspHome(req.aspHome, async () => {
        const warnings: string[] = []
        const spec = validateSpec(req.spec)

        // Validate cwd is absolute (spec §6.3)
        if (!isAbsolute(req.cwd)) {
          throw new Error('cwd must be an absolute path')
        }

        const frontendDef = resolveFrontend(req.frontend)

        // Validate provider matches frontend
        if (req.provider !== frontendDef.provider) {
          throw new CodedError(
            `Provider mismatch: frontend "${req.frontend}" requires provider "${frontendDef.provider}" but got "${req.provider}"`,
            'provider_mismatch'
          )
        }

        // Validate provider match with continuation if provided
        validateProviderMatch(frontendDef, req.continuation)

        // Validate model
        const modelResolution = resolveModel(frontendDef, req.model)
        if (!modelResolution.ok) {
          throw new Error(
            `Model not supported for frontend ${req.frontend}: ${modelResolution.modelId}`
          )
        }

        // Materialize the spec
        const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId)

        // Get adapter from registry and detect binary
        const adapter = harnessRegistry.getOrThrow(frontendDef.internalId)
        const detection = await adapter.detect()
        if (!detection.available) {
          throw new Error(
            `Harness "${frontendDef.internalId}" is not available: ${detection.error ?? 'not found'}`
          )
        }

        // Load the composed target bundle
        const bundle = await adapter.loadTargetBundle(
          materialized.materialization.outputPath,
          materialized.targetName
        )

        // Build run options for the adapter
        const isResume = !!req.continuation?.key
        const runOptions = {
          interactive: req.interactionMode === 'interactive',
          model: modelResolution.info.model,
          projectPath: req.cwd,
          cwd: req.cwd,
          yolo: req.yolo,
          ...(isResume && req.continuation?.key ? { continuationKey: req.continuation.key } : {}),
        }

        // Build argv and env using the adapter
        const args = adapter.buildRunArgs(bundle, runOptions)
        const adapterEnv = adapter.getRunEnv(bundle, runOptions)
        const commandPath = detection.path ?? frontendDef.internalId
        const argv = [commandPath, ...args]

        // Merge env: adapter env + request env delta
        const env: Record<string, string> = {
          ...adapterEnv,
          ...(req.env ?? {}),
          ASP_HOME: req.aspHome,
        }

        // Build display command
        const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)

        // Build continuation ref
        const continuation: HarnessContinuationRef | undefined = req.continuation
          ? { provider: frontendDef.provider, key: req.continuation.key }
          : undefined

        const invocationSpec: ProcessInvocationSpec = {
          provider: frontendDef.provider,
          frontend: req.frontend,
          argv,
          cwd: req.cwd,
          env,
          interactionMode: req.interactionMode,
          ioMode: req.ioMode,
          ...(continuation ? { continuation } : {}),
          displayCommand,
          ...(req.frontend === 'codex-cli' && req.interactionMode === 'headless'
            ? { codexAppServer: buildCodexAppServerLaunchDescriptor(runOptions) }
            : {}),
        }

        return { spec: invocationSpec, ...(warnings.length > 0 ? { warnings } : {}) }
      })
    },

    async buildHarnessBrokerInvocation(
      req: BuildHarnessBrokerInvocationRequest
    ): Promise<BuildHarnessBrokerInvocationResponse> {
      validateBrokerInvocationRequest(req)
      const prepared = await preparePlacementCliRuntime(req, clientAspHome)
      return toHarnessBrokerStartRequest(prepared, req)
    },

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

        let spec: ValidatedSpec
        let modelResolution: ReturnType<typeof resolveModel>
        const continuationKey = req.continuation?.key

        try {
          spec = validateSpec(req.spec)
          if (!isAbsolute(req.cwd)) {
            throw new Error('cwd must be an absolute path')
          }
          validateProviderMatch(frontendDef, req.continuation)
          modelResolution = resolveModel(frontendDef, req.model)
        } catch (error) {
          return emitTurnFailure(
            eventEmitter,
            { provider: frontendDef.provider, frontend: req.frontend, model: req.model },
            toAgentSpacesError(error)
          )
        }

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
          const restoreEnv = applyEnvOverlay({ ...(req.env ?? {}) })

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

                activeSession.onEvent((event: UnifiedSessionEvent) => {
                  if (!context || context.completion.done) return

                  const mapped = mapUnifiedEvents(
                    event,
                    (mappedEvent) => {
                      void context?.eventEmitter.emit(mappedEvent)
                    },
                    (key) => {
                      if (!context) return
                      context.continuationKey = key
                      context.eventEmitter.setContinuation({
                        provider: frontendDef.provider,
                        key,
                      })
                    },
                    context.assistantState,
                    { allowSessionIdUpdate: context.allowSessionIdUpdate }
                  )

                  if (!shouldDrainOutstandingTurn(event, mapped, context)) return

                  context.outstandingTurns = Math.max(0, context.outstandingTurns - 1)
                  if (context.outstandingTurns !== 0) return

                  const activeContext = context
                  void completeInFlightSuccess(activeContext)
                    .then((response) => resolveInFlight(activeContext, response))
                    .catch((error) => rejectInFlight(activeContext, error))
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

        let spec: ValidatedSpec
        let modelResolution: ReturnType<typeof resolveModel>
        let continuationKey = req.continuation?.key

        try {
          spec = validateSpec(req.spec)

          // Validate cwd is absolute (spec §6.3)
          if (!isAbsolute(req.cwd)) {
            throw new Error('cwd must be an absolute path')
          }

          // Validate provider match with continuation
          validateProviderMatch(frontendDef, req.continuation)

          modelResolution = resolveModel(frontendDef, req.model)
        } catch (error) {
          return emitTurnFailure(
            eventEmitter,
            { provider: frontendDef.provider, frontend: req.frontend, model: req.model },
            toAgentSpacesError(error)
          )
        }

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

          const harnessEnv: Record<string, string> = { ...(req.env ?? {}) }
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

            const turnPromise = new Promise<void>((resolve, reject) => {
              if (!session) return
              session.onEvent((event: UnifiedSessionEvent) => {
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

            await runSession(session!, req.prompt, req.attachments, req.runId)
            await turnPromise
            await session!.stop('complete')
            await eventEmitter.idle()
            finalOutput = assistantState.lastAssistantText
          } finally {
            restoreEnv()
          }

          const result: RunResult = { success: true, ...(finalOutput ? { finalOutput } : {}) }
          await eventEmitter.emit({ type: 'state', state: 'complete' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)

          // Build final continuation ref
          const finalContinuation: HarnessContinuationRef | undefined = continuationKey
            ? { provider: frontendDef.provider, key: continuationKey }
            : undefined

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

          const finalContinuation: HarnessContinuationRef | undefined = continuationKey
            ? { provider: frontendDef.provider, key: continuationKey }
            : undefined

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
