import { existsSync } from 'node:fs'

import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import type { AttachmentRef } from 'spaces-runtime'

import {
  HARNESS_PROVIDERS,
  type HarnessDetection,
  type HarnessRunOptions,
  type ResolvedPlacementContext,
  ensureDir,
  getAspHome,
  getHarnessFrontendsForProvider,
  normalizeAgentSdkModel,
} from 'spaces-config'

import { type RuntimePlacement, resolvePlacementContext } from 'spaces-config'

import {
  type PlacementRuntimePlan,
  type UnifiedSession,
  type UnifiedSessionEvent,
  createSession,
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentBrainRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'

import {
  type CodexAppServerDriverSpec,
  type HarnessInvocationSpec,
  type InputContent,
  type InvocationInput,
  type InvocationStartRequest,
  validateInvocationInput,
  validateInvocationSpec,
} from 'spaces-harness-broker-protocol'
import { buildCodexAppServerLaunchDescriptor } from 'spaces-harness-codex'
import { PiSession, loadPiSdkBundle } from 'spaces-harness-pi-sdk/pi-session'

import { buildCorrelationEnvVars } from './placement-api.js'

import {
  type InFlightRunContext,
  completeInFlightFailure,
  completeInFlightSuccess,
  createInFlightRunMap,
  enqueueInFlightPrompt,
  rejectInFlight,
  resolveInFlight,
} from './run-tracker.js'

import {
  type ContextResolverContext,
  type MaterializeResult,
  expandTemplate,
  materializeSystemPrompt,
} from 'spaces-runtime'
import {
  applyEnvOverlay,
  piSessionPath,
  resolveHostSessionId,
  resolveRunId,
  withAspHome,
} from './runtime-env.js'

import {
  type EventPayload,
  buildAutoPermissionHandler,
  createEventEmitter,
  mapContentToText,
  mapUnifiedEvents,
  runSession,
} from './session-events.js'

import {
  type MaterializedSpec,
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
  CODEX_CLI_FRONTEND,
  CodedError,
  FRONTEND_DEFS,
  PI_SDK_FRONTEND,
  formatDisplayCommand,
  resolveFrontend,
  resolveModel,
  validateProviderMatch,
} from './client-support.js'
import type {
  AgentSpacesClient,
  AgentSpacesError,
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationRef,
  HarnessFrontend,
  InteractionMode,
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

interface HandleParts {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
}

function deriveHandleParts(placement: RuntimePlacement): HandleParts {
  const parts: HandleParts = {}
  const scopeRef = placement.correlation?.sessionRef?.scopeRef
  const laneRef = placement.correlation?.sessionRef?.laneRef
  if (scopeRef) {
    try {
      const parsed = parseScopeRef(scopeRef)
      parts.agentId = parsed.agentId
      if (parsed.projectId !== undefined) {
        parts.projectId = parsed.projectId
      }
      if (parsed.taskId !== undefined) {
        parts.taskId = parsed.taskId
      }
    } catch {
      // Best-effort fallback for older callers that sent shorthand handles
      // instead of canonical ScopeRefs.
      const atIndex = scopeRef.indexOf('@')
      if (atIndex === -1) {
        parts.agentId = scopeRef
      } else {
        parts.agentId = scopeRef.slice(0, atIndex)
        const rest = scopeRef.slice(atIndex + 1)
        const colonIndex = rest.indexOf(':')
        if (colonIndex === -1) {
          parts.projectId = rest
        } else {
          parts.projectId = rest.slice(0, colonIndex)
          parts.taskId = rest.slice(colonIndex + 1)
        }
      }
    }
  }
  if (parts.agentId === undefined) {
    parts.agentId = basename(placement.agentRoot)
  }
  if (parts.projectId === undefined && placement.projectRoot) {
    parts.projectId = basename(resolve(placement.projectRoot))
  }
  if (laneRef && laneRef.length > 0 && laneRef !== 'main' && laneRef !== 'lane:main') {
    parts.lane = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  }
  return parts
}

// ---------------------------------------------------------------------------
// Helpers: error conversion
// ---------------------------------------------------------------------------

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.avif',
])

function isImageAttachment(attachment: AttachmentRef): boolean {
  if (attachment.contentType?.toLowerCase().startsWith('image/') === true) return true
  const ref = attachment.path ?? attachment.url
  if (!ref) return false
  const clean = ref.split('?')[0]?.split('#')[0] ?? ref
  return IMAGE_ATTACHMENT_EXTENSIONS.has(extname(clean).toLowerCase())
}

function extractImageAttachmentPaths(attachments: AttachmentRef[] | undefined): string[] {
  if (!attachments) return []
  const paths: string[] = []
  for (const attachment of attachments) {
    if (attachment.kind !== 'file' || !attachment.path) continue
    if (!isImageAttachment(attachment)) continue
    paths.push(attachment.path)
  }
  return paths
}

function toAgentSpacesError(error: unknown, code?: AgentSpacesError['code']): AgentSpacesError {
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

function shouldDrainOutstandingTurn(
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
          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(
              new CodedError(
                `In-flight input is only supported for frontend "${AGENT_SDK_FRONTEND}"`,
                'unsupported_frontend'
              )
            ),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
        }

        if (inFlightRuns.has(hostSessionId as string)) {
          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(
              new Error(`In-flight run already active for hostSessionId ${hostSessionId as string}`)
            ),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
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
          const result: RunResult = { success: false, error: toAgentSpacesError(error) }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
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
          const result: RunResult = { success: false, error }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.modelId,
            result,
          }
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

          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(error, 'resolve_failed'),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            result,
          }
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
          const result: RunResult = { success: false, error: toAgentSpacesError(error) }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
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
          const result: RunResult = { success: false, error }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.modelId,
            result,
          }
        }

        // For pi-sdk resume: validate session path exists
        if (frontendDef.frontend === PI_SDK_FRONTEND && isResume && continuationKey) {
          if (!existsSync(continuationKey)) {
            const error = toAgentSpacesError(
              new Error(`Continuation not found: ${continuationKey}`),
              'continuation_not_found'
            )
            const result: RunResult = { success: false, error }
            await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
            await eventEmitter.emit({ type: 'complete', result } as EventPayload)
            return {
              continuation: { provider: frontendDef.provider, key: continuationKey },
              provider: frontendDef.provider,
              frontend: req.frontend,
              model: modelResolution.info.effectiveModel,
              result,
            }
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

            await runSession(session, req.prompt, req.attachments, req.runId)
            await turnPromise
            await session.stop('complete')
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

          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(error, 'resolve_failed'),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)

          const finalContinuation: HarnessContinuationRef | undefined = continuationKey
            ? { provider: frontendDef.provider, key: continuationKey }
            : undefined

          return {
            ...(finalContinuation ? { continuation: finalContinuation } : {}),
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            result,
          }
        }
      })
    },
  }
}

interface PreparedPlacementCliRuntime {
  placement: RuntimePlacement
  placementContext: ResolvedPlacementContext
  resolvedBundle: BuildProcessInvocationSpecResponse['resolvedBundle']
  runtimePlan: PlacementRuntimePlan
  materialized: MaterializedSpec
  systemPrompt?: MaterializeResult | undefined
  expandedPrompt?: string | undefined
  imageAttachmentPaths: string[]
  runOptions: HarnessRunOptions
  detection: HarnessDetection
  commandPath: string
  args: string[]
  argv: string[]
  env: Record<string, string>
  cwd: string
  displayCommand: string
  continuation?: HarnessContinuationRef | undefined
  codexAppServer?: ProcessInvocationSpec['codexAppServer'] | undefined
  warnings: string[]
}

interface PreparePlacementCliRuntimeRequest {
  aspHome?: string | undefined
  provider: HarnessContinuationRef['provider']
  frontend: HarnessFrontend
  interactionMode: InteractionMode
  model?: string | undefined
  yolo?: boolean | undefined
  continuation?: HarnessContinuationRef | undefined
  prompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  env?: Record<string, string> | undefined
  placement?: RuntimePlacement | undefined
}

const DEFAULT_BROKER_PROCESS_LIMITS: NonNullable<HarnessInvocationSpec['process']['limits']> = {
  startupTimeoutMs: 20_000,
  turnTimeoutMs: 900_000,
  stopGraceMs: 5_000,
}

function buildPromptExpansionContext(placement: RuntimePlacement): ContextResolverContext {
  const handleParts = deriveHandleParts(placement)
  return {
    agentRoot: placement.agentRoot,
    agentsRoot: dirname(placement.agentRoot),
    agentId: handleParts.agentId ?? basename(placement.agentRoot),
    projectId: handleParts.projectId,
    taskId: handleParts.taskId,
    lane: handleParts.lane,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    runMode: placement.runMode,
  }
}

/**
 * Prepare placement-based CLI runtime state without choosing an output protocol.
 */
async function preparePlacementCliRuntime(
  req: PreparePlacementCliRuntimeRequest,
  defaultAspHome?: string
): Promise<PreparedPlacementCliRuntime> {
  const placement = req.placement as RuntimePlacement
  const warnings: string[] = []

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

  const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
  const { spec } = placementContext.materialization

  // Resolve placement to get audit metadata and materialization inputs
  const resolvedBundle = placementContext.resolvedBundle

  // Resolve effective cwd from placement
  const cwd = resolvedBundle.cwd

  const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
  const runtimePlan = await planPlacementRuntime({
    placement,
    placementContext,
    frontend: req.frontend,
    aspHome,
    model: req.model,
    prompt: req.prompt,
    yolo: req.yolo,
    interactive: req.interactionMode === 'interactive',
    continuationKey: req.continuation?.key,
  })
  if (!runtimePlan.model.ok) {
    throw new Error(
      `Model not supported for frontend ${req.frontend}: ${runtimePlan.model.modelId}`
    )
  }

  // Get adapter from registry and detect binary
  const adapter = harnessRegistry.getOrThrow(runtimePlan.harnessId)
  const detection = await adapter.detect()
  if (!detection.available) {
    throw new Error(
      `Harness "${runtimePlan.harnessId}" is not available: ${detection.error ?? 'not found'}`
    )
  }

  // Detect agent-local skills/ and commands/ for materialization
  const agentLocalComponents = await detectAgentLocalComponents(placement.agentRoot)

  // Derive handle parts from the placement correlation, when present, so that
  // priming prompts and system prompt sections can reference {{agentId}},
  // {{projectId}}, {{taskId}}, {{handle}}, etc.
  const handleParts = deriveHandleParts(placement)

  // Unified materialization: use the shared placement context, then materialize the resolved spec.
  const materialized = await materializeSpec(spec, aspHome, runtimePlan.harnessId, {
    agentRoot: placement.agentRoot,
    projectRoot: placement.projectRoot,
    agentLocalComponents,
  })
  const systemPrompt = await materializeSystemPrompt(materialized.materialization.outputPath, {
    ...placement,
    ...(handleParts.agentId !== undefined ? { agentId: handleParts.agentId } : {}),
    ...(handleParts.projectId !== undefined ? { projectId: handleParts.projectId } : {}),
    ...(handleParts.taskId !== undefined ? { taskId: handleParts.taskId } : {}),
    ...(handleParts.lane !== undefined ? { lane: handleParts.lane } : {}),
  })

  const bundle = await adapter.loadTargetBundle(
    materialized.materialization.outputPath,
    materialized.targetName
  )

  const imageAttachmentPaths = extractImageAttachmentPaths(req.attachments)

  const expandedPrompt =
    runtimePlan.prompt !== undefined
      ? expandTemplate(runtimePlan.prompt, buildPromptExpansionContext(placement))
      : undefined

  // Build run options for the adapter
  let runOptions: HarnessRunOptions = {
    ...runtimePlan.runOptions,
    model: runtimePlan.model.info.model,
    ...(expandedPrompt !== undefined ? { prompt: expandedPrompt } : {}),
    ...(runtimePlan.yolo !== undefined ? { yolo: runtimePlan.yolo } : {}),
    ...(imageAttachmentPaths.length > 0 ? { imageAttachments: imageAttachmentPaths } : {}),
    ...(systemPrompt
      ? {
          systemPrompt: systemPrompt.content,
          systemPromptMode: systemPrompt.mode,
        }
      : {}),
  }

  // For codex frontends, prepare the stable runtime home directory so that
  // hrc run uses the same CODEX_HOME as asp run (codex-homes/<project>_<target>).
  // prepareCodexRuntimeHome syncs managed files, injects system prompt into
  // AGENTS.md, ensures project trust, and symlinks auth — all the steps that
  // were previously duplicated inline here.
  if (frontendDef.frontend === CODEX_CLI_FRONTEND) {
    const codexHomeDir = await prepareCodexRuntimeHome(bundle, {
      ...runOptions,
      aspHome,
    })
    runOptions = { ...runOptions, codexHomeDir }
  }

  // Build argv and env using the adapter
  const args = adapter.buildRunArgs(bundle, runOptions)
  const adapterEnv = adapter.getRunEnv(bundle, runOptions)
  const commandPath = detection.path ?? runtimePlan.harnessId
  const argv = [commandPath, ...args]

  // Build correlation env vars
  const correlationEnv = buildCorrelationEnvVars(placement)

  // Derive ASP_PROJECT and AGENTCHAT_ID so tools like agentchat can discover
  // their project and agent context without a manual .env.local.
  const agentchatEnv: Record<string, string> = {
    AGENTCHAT_ID: basename(placement.agentRoot),
  }
  if (placement.projectRoot) {
    agentchatEnv['ASP_PROJECT'] = basename(resolve(placement.projectRoot))
  }

  // Merge env: adapter env + correlation + agentchat + request env delta + ASP_HOME
  let env: Record<string, string> = {
    ...adapterEnv,
    ...correlationEnv,
    ...agentchatEnv,
    ...(req.env ?? {}),
    ASP_HOME: aspHome,
  }

  const brainEnv = await prepareAgentBrainRuntime(
    {
      agentRoot: placement.agentRoot,
      agentName: basename(placement.agentRoot),
      ...(agentLocalComponents ? { components: agentLocalComponents } : {}),
    },
    env
  )
  env = { ...env, ...brainEnv }

  if (agentLocalComponents?.hasTools) {
    const toolRuntime = await prepareAgentToolRuntime(
      {
        agentRoot: placement.agentRoot,
        projectRoot: placement.projectRoot,
        components: agentLocalComponents,
      },
      env
    )
    env = { ...env, ...toolRuntime.env }
    warnings.push(...toolRuntime.warnings)
  }

  // Build display command
  const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)

  // Build continuation ref
  const continuation: HarnessContinuationRef | undefined = req.continuation
    ? { provider: runtimePlan.provider, key: req.continuation.key }
    : undefined

  const codexAppServer =
    req.frontend === 'codex-cli' && req.interactionMode === 'headless'
      ? buildCodexAppServerLaunchDescriptor(runOptions)
      : undefined

  return {
    placement,
    placementContext,
    resolvedBundle,
    runtimePlan,
    materialized,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(expandedPrompt !== undefined ? { expandedPrompt } : {}),
    imageAttachmentPaths,
    runOptions,
    detection,
    commandPath,
    args,
    argv,
    cwd,
    env,
    ...(continuation ? { continuation } : {}),
    displayCommand,
    ...(codexAppServer ? { codexAppServer } : {}),
    warnings,
  }
}

function toProcessInvocationSpec(
  prepared: PreparedPlacementCliRuntime,
  req: BuildProcessInvocationSpecRequest
): BuildProcessInvocationSpecResponse {
  const invocationSpec: ProcessInvocationSpec = {
    provider: prepared.runtimePlan.provider,
    frontend: req.frontend,
    argv: prepared.argv,
    cwd: prepared.cwd,
    env: prepared.env,
    interactionMode: req.interactionMode,
    ioMode: req.ioMode,
    ...(prepared.continuation ? { continuation: prepared.continuation } : {}),
    displayCommand: prepared.displayCommand,
    ...(prepared.systemPrompt
      ? {
          systemPromptFile: prepared.systemPrompt.path,
          prompts: {
            system: {
              content: prepared.systemPrompt.content,
              mode: prepared.systemPrompt.mode,
              sourcePath: prepared.systemPrompt.path,
            },
          },
        }
      : {}),
    ...(prepared.codexAppServer ? { codexAppServer: prepared.codexAppServer } : {}),
  }

  return {
    spec: invocationSpec,
    resolvedBundle: prepared.resolvedBundle,
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
  }
}

function validateBrokerInvocationRequest(req: BuildHarnessBrokerInvocationRequest): void {
  if (req.provider !== 'openai') {
    throw new CodedError(
      `Harness broker invocation only supports provider "openai"; got "${req.provider}"`,
      'provider_mismatch'
    )
  }
  if (req.frontend !== CODEX_CLI_FRONTEND) {
    throw new CodedError(
      `Harness broker invocation only supports frontend "${CODEX_CLI_FRONTEND}"; got "${req.frontend}"`,
      'unsupported_frontend'
    )
  }
  if (req.interactionMode !== 'headless') {
    throw new CodedError(
      `Harness broker invocation only supports headless interaction mode; got "${req.interactionMode}"`,
      'unsupported_frontend'
    )
  }
}

function brokerCorrelationFromPlacement(placement: RuntimePlacement): Record<string, string> {
  const correlation: Record<string, string> = {
    agentRoot: placement.agentRoot,
  }
  if (placement.projectRoot !== undefined) {
    correlation['projectRoot'] = placement.projectRoot
  }
  if (placement.cwd !== undefined) {
    correlation['cwd'] = placement.cwd
  }
  if (placement.runMode !== undefined) {
    correlation['runMode'] = placement.runMode
  }

  const sessionRef = placement.correlation?.sessionRef
  if (sessionRef?.scopeRef !== undefined) {
    correlation['scopeRef'] = sessionRef.scopeRef
  }
  if (sessionRef?.laneRef !== undefined) {
    correlation['laneRef'] = sessionRef.laneRef
  }
  if (placement.correlation?.hostSessionId !== undefined) {
    correlation['hostSessionId'] = placement.correlation.hostSessionId
  }

  const handleParts = deriveHandleParts(placement)
  if (handleParts.agentId !== undefined) {
    correlation['agentId'] = handleParts.agentId
  }
  if (handleParts.projectId !== undefined) {
    correlation['projectId'] = handleParts.projectId
  }
  if (handleParts.taskId !== undefined) {
    correlation['taskId'] = handleParts.taskId
  }
  if (handleParts.lane !== undefined) {
    correlation['lane'] = handleParts.lane
  }

  return correlation
}

function combineBrokerPrompts(
  primingPrompt: string | undefined,
  callerPrompt: string | undefined
): string | undefined {
  if (primingPrompt !== undefined && callerPrompt !== undefined) {
    return `${primingPrompt}\n\n${callerPrompt}`
  }
  return primingPrompt ?? callerPrompt
}

function buildBrokerInitialText(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): string | undefined {
  if (req.prompt === '') {
    return undefined
  }

  const expansionContext = buildPromptExpansionContext(prepared.placement)
  const defaultPrompt =
    prepared.runtimePlan.defaultRunOptions.prompt ??
    prepared.placementContext.materialization.effectiveConfig?.priming_prompt
  const primingPrompt =
    defaultPrompt !== undefined ? expandTemplate(defaultPrompt, expansionContext) : undefined
  const callerPrompt =
    req.prompt !== undefined ? expandTemplate(req.prompt, expansionContext) : undefined

  return combineBrokerPrompts(primingPrompt, callerPrompt)
}

function buildInitialInput(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): InvocationInput | undefined {
  const content: InputContent[] = []
  const initialText = buildBrokerInitialText(prepared, req)
  if (initialText !== undefined && initialText.length > 0) {
    content.push({ type: 'text', text: initialText })
  }
  for (const imagePath of prepared.imageAttachmentPaths) {
    content.push({ type: 'local_image', path: imagePath })
  }
  if (content.length === 0) {
    return undefined
  }
  return {
    inputId: `input_${randomUUID()}`,
    kind: 'user',
    content,
  }
}

function toHarnessBrokerStartRequest(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): BuildHarnessBrokerInvocationResponse {
  const codexDescriptor = buildCodexAppServerLaunchDescriptor(prepared.runOptions)
  const driver: CodexAppServerDriverSpec = {
    kind: 'codex-app-server',
    ...(req.continuation?.key !== undefined ? { resumeThreadId: req.continuation.key } : {}),
    ...(codexDescriptor.model !== undefined ? { model: codexDescriptor.model } : {}),
    ...(codexDescriptor.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: codexDescriptor.modelReasoningEffort }
      : {}),
    approvalPolicy: codexDescriptor.approvalPolicy ?? 'never',
    ...(codexDescriptor.sandboxMode !== undefined
      ? { sandboxMode: codexDescriptor.sandboxMode }
      : {}),
    ...(codexDescriptor.profile !== undefined ? { profile: codexDescriptor.profile } : {}),
    permissionPolicy: req.permissionPolicy ?? { mode: 'deny' },
    resumeFallback: req.resumeFallback ?? 'start-fresh',
  }

  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.invocationId !== undefined ? { invocationId: req.invocationId } : {}),
    ...(req.labels !== undefined ? { labels: req.labels } : {}),
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: prepared.commandPath,
      args: prepared.args,
      cwd: prepared.cwd,
      env: prepared.env,
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: req.limits ?? DEFAULT_BROKER_PROCESS_LIMITS,
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'none',
    },
    ...(req.continuation?.key !== undefined
      ? { continuation: { provider: 'codex', kind: 'thread', key: req.continuation.key } }
      : {}),
    driver,
    correlation: req.correlation ?? brokerCorrelationFromPlacement(req.placement),
  }
  const initialInput = buildInitialInput(prepared, req)
  const startRequest: InvocationStartRequest =
    initialInput === undefined ? { spec } : { spec, initialInput }

  validateInvocationSpec(startRequest.spec)
  if (startRequest.initialInput !== undefined) {
    validateInvocationInput(startRequest.initialInput)
  }

  return {
    startRequest,
    spec,
    ...(initialInput !== undefined ? { initialInput } : {}),
    resolvedBundle: prepared.resolvedBundle,
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
  }
}

/**
 * Handle placement-based runTurnNonInteractive request.
 * Resolves placement, materializes spaces, creates an SDK session, and runs the turn.
 */
async function runPlacementTurnNonInteractive(
  req: RunTurnNonInteractiveRequest,
  defaultAspHome: string | undefined,
  inFlightRuns: Map<string, InFlightRunContext>
): Promise<RunTurnNonInteractiveResponse> {
  const placement = req.placement as RuntimePlacement
  const frontendDef = resolveFrontend(req.frontend)
  const hostSessionId = resolveHostSessionId(req)
  const runId = resolveRunId(req)
  const eventEmitter = createEventEmitter(
    req.callbacks.onEvent,
    { hostSessionId: hostSessionId as string, runId: runId as string },
    req.continuation
  )

  let runtimePlan: Awaited<ReturnType<typeof planPlacementRuntime>>
  let continuationKey = req.continuation?.key
  let resolvedPrompt = req.prompt

  try {
    validateProviderMatch(frontendDef, req.continuation)

    const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
    const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
    runtimePlan = await planPlacementRuntime({
      placement,
      placementContext,
      frontend: req.frontend,
      aspHome,
      model: req.model,
      prompt: req.prompt,
      promptOverrideMode: 'truthy',
      yolo: req.yolo,
      continuationKey,
    })
    resolvedPrompt = runtimePlan.prompt ?? ''
  } catch (error) {
    const result: RunResult = { success: false, error: toAgentSpacesError(error) }
    await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)
    return {
      provider: frontendDef.provider,
      frontend: req.frontend,
      model: req.model,
      result,
    }
  }

  if (continuationKey) {
    eventEmitter.setContinuation({
      provider: runtimePlan.provider,
      key: continuationKey,
    })
  }

  await eventEmitter.emit({ type: 'state', state: 'running' } as EventPayload)
  await eventEmitter.emit({
    type: 'message',
    role: 'user',
    content: resolvedPrompt,
  } as EventPayload)

  if (!runtimePlan.model.ok) {
    const error = toAgentSpacesError(
      new Error(
        `Model not supported for frontend ${frontendDef.frontend}: ${runtimePlan.model.modelId}`
      ),
      'model_not_supported'
    )
    const result: RunResult = { success: false, error }
    await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)
    return {
      provider: runtimePlan.provider,
      frontend: req.frontend,
      model: runtimePlan.model.modelId,
      result,
    }
  }

  const permissionHandler = buildAutoPermissionHandler()
  let session: UnifiedSession | undefined
  let context: InFlightRunContext | undefined
  let turnEnded = false
  let finalOutput: string | undefined
  const assistantState: { assistantBuffer: string; lastAssistantText?: string | undefined } = {
    assistantBuffer: '',
  }

  try {
    // Resolve placement to get audit metadata, effective cwd, and materialization inputs.
    const placementContext = await resolvePlacementContext(placement)
    const resolvedBundle = placementContext.resolvedBundle
    const cwd = resolvedBundle.cwd

    // Build correlation env vars. Apply the env overlay once it also contains
    // agent tool env and frontend-specific session env.
    const correlationEnv = buildCorrelationEnvVars(placement)
    const harnessEnv: Record<string, string> = { ...correlationEnv, ...(req.env ?? {}) }

    const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
    harnessEnv['ASP_HOME'] = aspHome

    const placementAgentLocalComponents = await detectAgentLocalComponents(placement.agentRoot)
    const brainEnv = await prepareAgentBrainRuntime(
      {
        agentRoot: placement.agentRoot,
        agentName: basename(placement.agentRoot),
        ...(placementAgentLocalComponents ? { components: placementAgentLocalComponents } : {}),
      },
      harnessEnv
    )
    Object.assign(harnessEnv, brainEnv)

    if (placementAgentLocalComponents?.hasTools) {
      const toolRuntime = await prepareAgentToolRuntime(
        {
          agentRoot: placement.agentRoot,
          projectRoot: placement.projectRoot,
          components: placementAgentLocalComponents,
        },
        harnessEnv
      )
      Object.assign(harnessEnv, toolRuntime.env)
    }

    let restoreEnv: (() => void) | undefined

    try {
      // Unified materialization: use the shared placement context rather than
      // reconstructing client-local synthetic planning state.
      const { spec } = placementContext.materialization
      runtimePlan = await planPlacementRuntime({
        placement,
        placementContext,
        frontend: req.frontend,
        aspHome,
        model: req.model,
        prompt: req.prompt,
        promptOverrideMode: 'truthy',
        yolo: req.yolo,
        continuationKey,
      })
      if (!runtimePlan.model.ok) {
        throw new Error(
          `Model not supported for frontend ${frontendDef.frontend}: ${runtimePlan.model.modelId}`
        )
      }
      const effectiveModel = runtimePlan.model.info.effectiveModel
      const resolvedYolo = runtimePlan.yolo ?? false
      const materialized = await materializeSpec(spec, aspHome, runtimePlan.harnessId, {
        agentRoot: placement.agentRoot,
        projectRoot: placement.projectRoot,
        agentLocalComponents: placementAgentLocalComponents,
      })

      if (frontendDef.frontend === PI_SDK_FRONTEND) {
        harnessEnv['PI_CODING_AGENT_DIR'] = materialized.materialization.outputPath
      }

      restoreEnv = applyEnvOverlay(harnessEnv)

      if (frontendDef.frontend === AGENT_SDK_FRONTEND) {
        const plugins = (materialized.materialization.pluginDirs ?? []).map((dir) => ({
          type: 'local' as const,
          path: dir,
        }))

        // Materialize the instruction layer into a system prompt file and read it
        const handleParts = deriveHandleParts(placement)
        const systemPrompt = await materializeSystemPrompt(
          materialized.materialization.outputPath,
          {
            ...placement,
            ...(handleParts.agentId !== undefined ? { agentId: handleParts.agentId } : {}),
            ...(handleParts.projectId !== undefined ? { projectId: handleParts.projectId } : {}),
            ...(handleParts.taskId !== undefined ? { taskId: handleParts.taskId } : {}),
            ...(handleParts.lane !== undefined ? { lane: handleParts.lane } : {}),
          }
        )

        session = createSession({
          kind: 'agent-sdk',
          sessionId: continuationKey ?? (hostSessionId as string),
          cwd,
          model: normalizeAgentSdkModel(runtimePlan.model.info.model),
          plugins,
          permissionHandler,
          ...(continuationKey ? { continuationKey } : {}),
          ...(systemPrompt
            ? {
                systemPrompt: systemPrompt.content,
                systemPromptMode: systemPrompt.mode,
              }
            : {}),
        })
      } else {
        // pi-sdk — load bundle from materialized output
        const isResume = continuationKey !== undefined
        if (!isResume && !continuationKey && aspHome) {
          continuationKey = piSessionPath(aspHome, hostSessionId as string)
          await ensureDir(continuationKey)
          eventEmitter.setContinuation({
            provider: runtimePlan.provider,
            key: continuationKey,
          })
        }

        const piBundle = await loadPiSdkBundle(materialized.materialization.outputPath, {
          cwd,
          yolo: resolvedYolo,
          noExtensions: false,
          noSkills: false,
          agentDir: materialized.materialization.outputPath,
        })
        const piSession = new PiSession({
          ownerId: hostSessionId as string,
          cwd,
          provider: runtimePlan.model.info.provider,
          model: runtimePlan.model.info.model,
          sessionId: hostSessionId as string,
          extensions: piBundle.extensions,
          skills: piBundle.skills,
          contextFiles: piBundle.contextFiles,
          agentDir: materialized.materialization.outputPath,
          ...(continuationKey ? { sessionPath: continuationKey } : {}),
        })
        piSession.setPermissionHandler(permissionHandler)
        session = piSession
      }

      const turnPromise = new Promise<void>((resolve, reject) => {
        if (!session) return
        const started = session.start()
        context = {
          hostSessionId: hostSessionId as string,
          runId: runId as string,
          provider: runtimePlan.provider,
          frontend: req.frontend,
          model: effectiveModel,
          session,
          eventEmitter,
          assistantState,
          allowSessionIdUpdate: frontendDef.frontend !== PI_SDK_FRONTEND,
          continuationKey,
          outstandingTurns: 0,
          acceptedInputApplicationIds: new Set<string>(),
          started,
          completion: { done: false, resolve: () => {}, reject: () => {} },
          sendChain: Promise.resolve(),
        }
        inFlightRuns.set(hostSessionId as string, context)

        session.onEvent((event: UnifiedSessionEvent) => {
          const activeContext = context
          if (!activeContext || activeContext.completion.done) return

          const result = mapUnifiedEvents(
            event,
            (mapped) => {
              void eventEmitter.emit(mapped)
            },
            (key) => {
              continuationKey = key
              activeContext.continuationKey = key
              eventEmitter.setContinuation({
                provider: runtimePlan.provider,
                key,
              })
            },
            assistantState,
            { allowSessionIdUpdate: frontendDef.frontend !== PI_SDK_FRONTEND }
          )

          if (shouldDrainOutstandingTurn(event, result, activeContext) && !turnEnded) {
            activeContext.outstandingTurns = Math.max(0, activeContext.outstandingTurns - 1)
            if (activeContext.outstandingTurns !== 0) return
            turnEnded = true
            activeContext.completion = { done: true }
            void eventEmitter.idle().then(resolve, reject)
          }
        })

        void started.catch(reject)
      })

      if (!context) {
        throw new Error('Session creation failed unexpectedly')
      }
      await enqueueInFlightPrompt(context, resolvedPrompt, req.attachments)
      await turnPromise
      await session.stop('complete')
      await eventEmitter.idle()
      finalOutput = assistantState.lastAssistantText
    } finally {
      inFlightRuns.delete(hostSessionId as string)
      restoreEnv?.()
    }

    // Detect silent "success with no content" — e.g. when the harness child
    // crashed mid-turn or resumed into a corrupted transcript, turn_end can
    // fire with no assistant message ever captured. Treat this as a failure
    // so callers don't mistake an empty turn for a real response.
    const producedContent =
      (finalOutput !== undefined && finalOutput.length > 0) ||
      assistantState.assistantBuffer.length > 0
    if (!producedContent) {
      const error = toAgentSpacesError(
        new Error(
          `Agent session produced no assistant output (frontend=${frontendDef.frontend}, continuationKey=${continuationKey ?? 'none'})`
        ),
        'empty_response'
      )
      const result: RunResult = { success: false, error }
      await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
      await eventEmitter.emit({ type: 'complete', result } as EventPayload)

      // Do NOT propagate continuation on failure — a crashed session's
      // sdkSessionId points to a non-existent or corrupt conversation file.
      // Returning it here causes a cascade where every subsequent turn tries
      // to --resume from a dead session and immediately fails with ENOENT.
      return {
        provider: runtimePlan.provider,
        frontend: req.frontend,
        model: runtimePlan.model.info.effectiveModel,
        result,
        resolvedBundle,
      }
    }

    const result: RunResult = { success: true, ...(finalOutput ? { finalOutput } : {}) }
    await eventEmitter.emit({ type: 'state', state: 'complete' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)

    const finalContinuation: HarnessContinuationRef | undefined = continuationKey
      ? { provider: runtimePlan.provider, key: continuationKey }
      : undefined

    return {
      ...(finalContinuation ? { continuation: finalContinuation } : {}),
      provider: runtimePlan.provider,
      frontend: req.frontend,
      model: runtimePlan.model.info.effectiveModel,
      result,
      resolvedBundle,
    }
  } catch (error) {
    if (session) {
      try {
        await session.stop('error')
      } catch {
        // Ignore cleanup failures.
      }
    }

    const result: RunResult = {
      success: false,
      error: toAgentSpacesError(error, 'resolve_failed'),
    }
    await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)

    const finalContinuation: HarnessContinuationRef | undefined = continuationKey
      ? { provider: runtimePlan.provider, key: continuationKey }
      : undefined

    return {
      ...(finalContinuation ? { continuation: finalContinuation } : {}),
      provider: runtimePlan.provider,
      frontend: req.frontend,
      model: runtimePlan.model.ok ? runtimePlan.model.info.effectiveModel : req.model,
      result,
    }
  }
}
