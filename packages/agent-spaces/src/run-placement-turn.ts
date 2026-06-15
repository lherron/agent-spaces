import {
  type RuntimePlacement,
  ensureDir,
  getAspHome,
  normalizeAgentSdkModel,
  resolvePlacementContext,
} from 'spaces-config'
import {
  type UnifiedSession,
  createSession,
  detectAgentLocalComponents,
  planPlacementRuntime,
} from 'spaces-execution'
import { PiSession, loadPiSdkBundle } from 'spaces-harness-pi-sdk/pi-session'
import { materializeSystemPrompt } from 'spaces-runtime'

import { deriveHandleParts } from './broker-invocation.js'
import { materializeSpec } from './client-materialization.js'
import {
  AGENT_SDK_FRONTEND,
  PI_SDK_FRONTEND,
  assertProviderMatch,
  resolveFrontend,
} from './client-support.js'
import { composeAgentLocalEnv } from './compose-agent-local-env.js'
import type { InFlightRunContext } from './run-tracker.js'
import { enqueueInFlightPrompt } from './run-tracker.js'
import { emitTurnFailure, toAgentSpacesError } from './run-turn-helpers.js'
import {
  applyEnvOverlay,
  piSessionPath,
  resolveHostSessionId,
  resolveRunId,
} from './runtime-env.js'
import {
  type EventPayload,
  buildAutoPermissionHandler,
  createEventEmitter,
} from './session-events.js'
import { attachTurnDriver } from './turn-driver.js'
import type {
  HarnessContinuationRef,
  RunResult,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
} from './types.js'

/**
 * Handle placement-based runTurnNonInteractive request.
 * Resolves placement, materializes spaces, creates an SDK session, and runs the turn.
 */
export async function runPlacementTurnNonInteractive(
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
    assertProviderMatch(frontendDef, req.continuation)

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
    return emitTurnFailure(
      eventEmitter,
      {
        provider: frontendDef.provider,
        frontend: req.frontend,
        model: req.model,
      },
      toAgentSpacesError(error)
    )
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
    return emitTurnFailure(
      eventEmitter,
      {
        provider: runtimePlan.provider,
        frontend: req.frontend,
        model: runtimePlan.model.modelId,
      },
      error
    )
  }

  const permissionHandler = buildAutoPermissionHandler()
  let session: UnifiedSession | undefined
  let context: InFlightRunContext | undefined
  let finalOutput: string | undefined
  const assistantState: { assistantBuffer: string; lastAssistantText?: string | undefined } = {
    assistantBuffer: '',
  }

  try {
    // Resolve placement to get audit metadata, effective cwd, and materialization inputs.
    const placementContext = await resolvePlacementContext(placement)
    const resolvedBundle = placementContext.resolvedBundle
    const cwd = resolvedBundle.cwd

    // Apply the env overlay once it contains the disjoint locked and dispatch
    // env channels plus frontend-specific session env.
    const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
    const placementAgentLocalComponents = await detectAgentLocalComponents(placement.agentRoot)

    // Compose the agent-local env channels. The placement turn path omits
    // adapterEnv/agentchatEnv, runs brain preparation unconditionally (no dryRun
    // gate), and deliberately ignores the typed pathPrepend + tool warnings the
    // CLI path consumes.
    const composed = await composeAgentLocalEnv({
      placement,
      agentLocalComponents: placementAgentLocalComponents,
      aspHome,
      ...(req.env !== undefined ? { reqEnv: req.env } : {}),
      ...(req.lockedEnv !== undefined ? { reqLockedEnv: req.lockedEnv } : {}),
      ...(req.dispatchEnv !== undefined ? { reqDispatchEnv: req.dispatchEnv } : {}),
      gateBrainOnDryRun: false,
    })
    const harnessEnv = composed.env

    let restoreEnv: (() => void) | undefined

    try {
      // Unified materialization: use the shared placement context rather than
      // reconstructing client-local synthetic planning state.
      //
      // `runtimePlan` was already resolved above from the dry-run placement
      // context (used to gate model support and emit the user message). The
      // planner is pure and `dryRun` only changes error tolerance — not the
      // materialization manifest / effectiveConfig / cwd that planPlacementRuntime
      // reads — so re-running it here against the non-dry context yields a
      // byte-identical plan. Reuse the first result instead of recomputing it.
      const { spec } = placementContext.materialization
      // `runtimePlan.model.ok` is already guaranteed `true` here: the early gate
      // above returns a failure response when the dry-run plan reports an
      // unsupported model, and the reused plan is byte-identical.
      if (!runtimePlan.model.ok) {
        throw new Error(`Model not supported for frontend ${frontendDef.frontend}`)
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

        const driverContext = context
        attachTurnDriver(session, driverContext, {
          onContinuationKey: (key) => {
            continuationKey = key
            driverContext.continuationKey = key
            eventEmitter.setContinuation({
              provider: runtimePlan.provider,
              key,
            })
          },
          onDrained: (activeContext) => {
            activeContext.completion = { done: true }
            void eventEmitter.idle().then(resolve, reject)
          },
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
      // Do NOT propagate continuation on failure — a crashed session's
      // sdkSessionId points to a non-existent or corrupt conversation file.
      // Returning it here causes a cascade where every subsequent turn tries
      // to --resume from a dead session and immediately fails with ENOENT.
      return emitTurnFailure(
        eventEmitter,
        {
          provider: runtimePlan.provider,
          frontend: req.frontend,
          model: runtimePlan.model.info.effectiveModel,
          resolvedBundle,
        },
        error
      )
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

    const finalContinuation: HarnessContinuationRef | undefined = continuationKey
      ? { provider: runtimePlan.provider, key: continuationKey }
      : undefined

    return emitTurnFailure(
      eventEmitter,
      {
        ...(finalContinuation ? { continuation: finalContinuation } : {}),
        provider: runtimePlan.provider,
        frontend: req.frontend,
        model: runtimePlan.model.ok ? runtimePlan.model.info.effectiveModel : req.model,
      },
      toAgentSpacesError(error, 'resolve_failed')
    )
  }
}
