import { basename } from 'node:path'

import { loadAgentSemantics } from 'spaces-runtime'
import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import {
  combineBrokerPrompts,
  deriveHandleParts,
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import {
  brokerCorrelation,
  toBrokerAttachments,
  toBrokerPermissionPolicy,
  toProcessLimits,
} from './broker-request-projection.js'
import { compileError } from './compile-diagnostics.js'
import { timeCompilePhase } from './compile-phases.js'
import { bundleIdentityAndLockHash, finalizePlan } from './compile-plan-finalize.js'
import type { CompilePlacement, CompileRuntimePlanOptions } from './compile-plan-types.js'
import type { ResolvedHarnessExecution } from './harness-selection/types.js'
import { requireAgentSpacesRuntime } from './placement-api.js'
import {
  buildPreparationExecutionContext,
  promptSourcesForCompile,
} from './preparation-execution-context.js'
import type { BuildHarnessBrokerInvocationRequest } from './types.js'

function nativeAgentHarnessSpec(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  aspHome: string
): NonNullable<BuildHarnessBrokerInvocationRequest['agent']> {
  const handle = deriveHandleParts(placement)
  return {
    agentId: handle.agentId ?? basename(placement.agentRoot),
    ...(handle.projectId !== undefined ? { projectId: handle.projectId } : {}),
    agentRoot: placement.agentRoot,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    aspHome,
    runMode: placement.runMode,
    ...(req.correlation.scopeRef !== undefined ? { scopeRef: req.correlation.scopeRef } : {}),
    ...(req.correlation.laneRef !== undefined ? { laneRef: req.correlation.laneRef } : {}),
    ...(req.identity.runId !== undefined ? { runId: req.identity.runId } : {}),
    hostSessionId: req.identity.hostSessionId,
    generation: req.identity.generation,
    ...(req.materialization.taskContext !== undefined
      ? { taskContext: req.materialization.taskContext }
      : {}),
  }
}

function resolvedReasoningEffort(
  value: string | undefined
): RuntimeCompileRequest['requested']['reasoningEffort'] {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined
}

/**
 * Compile the first-party route without projecting a child executable. The
 * release-selected worker owns the driver; this compiler only emits its
 * hash-covered runtime inputs and HRC presentation intent.
 */
export async function compileNativeAgentHarnessPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  execution: ResolvedHarnessExecution,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const interactionMode = execution.selection.presentation
    ? ('interactive' as const)
    : ('headless' as const)
  const driverKind = execution.recipe.driver as 'agent-harness' | 'agent-harness-tmux'
  const promptSources = promptSourcesForCompile(options?.clientAspHome)
  const semanticAgent = nativeAgentHarnessSpec(req, placement, promptSources.aspHome)
  const preparation = buildPreparationExecutionContext(placement, {
    promptSources,
    identityHints: {
      agentId: semanticAgent.agentId,
      ...(semanticAgent.projectId !== undefined ? { projectId: semanticAgent.projectId } : {}),
    },
    taskContext: semanticAgent.taskContext,
  })
  const semantics = await timeCompilePhase('load-semantics', () =>
    loadAgentSemantics(
      {
        ...semanticAgent,
        cwd: placement.cwd,
        provider: execution.selection.modelProvider as 'openai' | 'anthropic',
        model: execution.selection.model,
        ...(execution.selection.reasoningEffort !== undefined
          ? { reasoningEffort: execution.selection.reasoningEffort }
          : {}),
        ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
        ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
        baseEnvironment: preparation.execEnv,
        ...(semanticAgent.taskContext !== undefined
          ? { taskContext: semanticAgent.taskContext }
          : {}),
        ...(options?.clientRegistryPath !== undefined
          ? { registryPathOverride: options.clientRegistryPath }
          : {}),
      },
      requireAgentSpacesRuntime(options?.clientRuntime)
    )
  )
  const resolvedAgent = {
    ...semanticAgent,
    agentId: semantics.agentId,
    ...(semantics.projectId !== undefined ? { projectId: semantics.projectId } : {}),
    agentRoot: semantics.placement.agentRoot,
    ...(semantics.placement.projectRoot !== undefined
      ? { projectRoot: semantics.placement.projectRoot }
      : {}),
    aspHome: semantics.aspHome,
    runMode: semantics.placement.runMode,
  }

  const permissionPolicy = req.hrcPolicy.permissionPolicy ?? { mode: 'deny' as const, audit: true }
  if (interactionMode === 'interactive' && permissionPolicy.mode === 'ask-client') {
    return {
      schemaVersion: 'agent-runtime-compile-response/v2',
      ok: false,
      diagnostics: [
        compileError(
          'agent_harness_tmux_forbids_ask_client',
          'agent-harness-tmux cannot use ask-client permission policy without a broker-mediated approval surface.'
        ),
      ],
    }
  }
  const attachments = toBrokerAttachments(req.materialization.attachments)
  const taskId = req.materialization.taskContext?.taskId
  const modelRoute = semantics.model
  const reasoningEffort = resolvedReasoningEffort(
    execution.selection.reasoningEffort ?? semantics.reasoningEffort
  )
  const initialPrompt = combineBrokerPrompts(
    req.continuation === undefined
      ? semantics.sources.placementContext.materialization.effectiveConfig?.priming
      : undefined,
    req.materialization.initialPrompt,
    req.materialization.omitPriming ?? false
  )
  const prepared = {
    cwd: semantics.sources.cwd,
    // The profile serializes declared worker-local locks, never the resolved
    // environment (which can contain credentials). The worker reloads source
    // resources through the same semantic agent block at birth/replacement.
    lockedEnv: { ...(placement.lockedEnv ?? {}) },
    pathPrepend: semantics.sources.pathPrepend,
    ...(initialPrompt !== undefined ? { expandedPrompt: initialPrompt } : {}),
    imageAttachmentPaths: (req.materialization.attachments ?? [])
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => attachment.path)
      .filter((path): path is string => path !== undefined),
    resolvedBundle: semantics.sources.placementContext.resolvedBundle,
    warnings: semantics.warnings,
  }
  const brokerReq: BuildHarnessBrokerInvocationRequest = {
    placement,
    provider: 'openai',
    frontend: 'agent-harness-tui',
    interactionMode,
    brokerDriver: driverKind,
    harnessTransport: { kind: 'native-worker' },
    sdk: {
      runtime: 'pi-sdk',
      provider: modelRoute.piProvider,
      modelId: modelRoute.piModelId,
      authMode: modelRoute.authMode,
      ...(reasoningEffort !== undefined ? { thinkingLevel: reasoningEffort } : {}),
    },
    agent: resolvedAgent,
    ...(req.continuation?.hrc.key !== undefined
      ? { continuation: { provider: 'openai', key: req.continuation.hrc.key } }
      : {}),
    prompt: req.materialization.initialPrompt,
    omitPriming: req.materialization.omitPriming,
    ...(req.materialization.responseFormat !== undefined
      ? { responseFormat: req.materialization.responseFormat }
      : {}),
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    ...(req.identity.invocationId !== undefined ? { invocationId: req.identity.invocationId } : {}),
    ...(req.identity.initialInputId !== undefined
      ? { initialInputId: req.identity.initialInputId }
      : {}),
    ...(options?.compileContext?.idSalt !== undefined
      ? { idSalt: options.compileContext.idSalt }
      : {}),
    generation: req.identity.generation,
    ...(taskId !== undefined ? { labels: { task: taskId } } : {}),
    correlation: brokerCorrelation(req),
    permissionPolicy: toBrokerPermissionPolicy(permissionPolicy),
    limits: toProcessLimits(req.hrcPolicy.resourceLimits),
    interaction: { inputQueue: 'fifo' },
    resumeFallback: 'fail',
  }
  validateBrokerInvocationRequest(brokerReq)
  const brokerInvocation = toHarnessBrokerStartRequest(prepared, brokerReq)
  const { bundleIdentity, lockHash } = bundleIdentityAndLockHash(brokerInvocation.resolvedBundle)
  return finalizePlan({
    req,
    resolved: execution,
    startRequest: brokerInvocation.startRequest,
    lockedEnv: brokerInvocation.spec.process.lockedEnv ?? {},
    preparedWarnings: brokerInvocation.warnings,
    effectiveEnvironmentHash: preparation.effectiveEnvironmentHash,
    disallowedToolsContext: { selectedDriver: driverKind },
    resolvedBundleSource: brokerInvocation.resolvedBundle,
    omitPriming: req.materialization.omitPriming ?? false,
    bundleIdentity,
    placement,
    ...(lockHash !== undefined ? { lockHash } : {}),
    nowIso: options?.compileContext?.nowIso,
    dispatch: options?.dispatch,
  })
}
