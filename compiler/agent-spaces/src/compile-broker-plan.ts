import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import {
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import {
  brokerCorrelation,
  brokerResumeFallback,
  toBrokerAttachments,
  toBrokerPermissionPolicy,
  toProcessLimits,
} from './broker-request-projection.js'
import {
  bundleIdentityAndLockHash,
  finalizePlan,
  hygieneWarningsInput,
} from './compile-plan-finalize.js'
import type { CompilePlacement, CompileRuntimePlanOptions } from './compile-plan-types.js'
import type { ResolvedHarnessExecution } from './harness-selection/types.js'
import { preparePlacementCliRuntime } from './prepare-cli-runtime.js'
import type { BuildHarnessBrokerInvocationRequest } from './types.js'

/**
 * Compile the headless (or codex-tui presented) broker route: codex-app-server
 * and muse-serve. Both prepare through the same CLI runtime path and differ only
 * in provider/frontend/driver and resume fallback.
 */
export async function compileBrokerPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  resolved: ResolvedHarnessExecution,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const isMuse = resolved.recipe.builder === 'muse-serve'
  const codexTui = resolved.selection.presentation
  const brokerProvider = isMuse ? ('meta' as const) : ('openai' as const)
  const brokerFrontend = isMuse ? ('muse-cli' as const) : ('codex-cli' as const)
  const brokerDriverKind = resolved.recipe.driver as 'muse-serve' | 'codex-app-server'

  const permissionPolicy = req.hrcPolicy.permissionPolicy ?? {
    mode: 'deny',
    audit: true,
  }
  const attachments = toBrokerAttachments(req.materialization.attachments)
  const taskId = req.materialization.taskContext?.taskId
  const brokerReq: BuildHarnessBrokerInvocationRequest = {
    placement,
    provider: brokerProvider,
    frontend: brokerFrontend,
    interactionMode: codexTui ? 'interactive' : 'headless',
    brokerDriver: brokerDriverKind,
    ...(codexTui
      ? {
          presentation: 'codex-tui' as const,
          transport: 'websocket-unix' as const,
          codexHookEvents: ['Stop', 'PostToolUse'] as const,
        }
      : {}),
    model: resolved.selection.model,
    modelReasoningEffort: resolved.selection.reasoningEffort,
    continuation:
      req.continuation?.hrc.key !== undefined
        ? { provider: brokerProvider, key: req.continuation.hrc.key }
        : undefined,
    prompt: req.materialization.initialPrompt,
    omitPriming: req.materialization.omitPriming,
    ...(req.materialization.responseFormat !== undefined
      ? { responseFormat: req.materialization.responseFormat }
      : {}),
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    ...(placement.env !== undefined ? { env: placement.env } : {}),
    ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
    ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
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
    resumeFallback: brokerResumeFallback(isMuse),
  }

  validateBrokerInvocationRequest(brokerReq)
  const prepared = await preparePlacementCliRuntime(
    {
      ...brokerReq,
      materializeCodexRuntimeHome: options?.materializeCodexRuntimeHome,
      ...(req.materialization.taskContext !== undefined
        ? { taskContext: req.materialization.taskContext }
        : {}),
    },
    options?.clientAspHome,
    options?.clientRegistryPath,
    options?.clientRuntime
  )
  const brokerInvocation = toHarnessBrokerStartRequest(prepared, brokerReq)
  const { bundleIdentity, lockHash } = bundleIdentityAndLockHash(brokerInvocation.resolvedBundle)
  // T-01867 Ph6 cutover: harness-broker/0.1 is decommissioned. The headless codex
  // profile emits the v0.2 durable markers UNCONDITIONALLY — brokerProtocol
  // 'harness-broker/0.2' + control.attachReplay 'optional'. The temporary Ph4b
  // activation env (ASP_HEADLESS_DURABLE_BROKER) is REMOVED entirely: a stale env
  // var has no effect, and there is no v0.1 path to fall back to.

  return finalizePlan({
    req,
    resolved,
    startRequest: brokerInvocation.startRequest,
    lockedEnv: brokerInvocation.spec.process.lockedEnv ?? {},
    preparedWarnings: brokerInvocation.warnings,
    ...hygieneWarningsInput(prepared),
    effectiveEnvironmentHash: prepared.preparation.effectiveEnvironmentHash,
    disallowedToolsContext: { selectedDriver: brokerDriverKind },
    resolvedBundleSource: brokerInvocation.resolvedBundle,
    omitPriming: prepared.omitPriming,
    bundleIdentity,
    placement,
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    nowIso: options?.compileContext?.nowIso,
    dispatch: options?.dispatch,
  })
}
