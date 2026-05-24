import type { RuntimePlacement } from 'spaces-config'
import type { InvocationId, PermissionPolicy, ProcessLimits } from 'spaces-harness-broker-protocol'
import type { AttachmentRef } from 'spaces-runtime'
import {
  type AgentchatExposurePolicy,
  type BrokerExecutionProfile,
  type BrokerInputPolicy,
  type BrokerObservabilityContract,
  type BrokerPermissionPolicy,
  type CapabilityRequirements,
  type CompileDiagnostic,
  type CompileId,
  type CompiledRuntimePlan,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  type ProfileId,
  type RuntimeCompileRequest,
  type RuntimeCompileResponse,
  type RuntimeContractProjection,
  createCanonicalHasher,
  project,
} from 'spaces-runtime-contracts'

import {
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import { preparePlacementCliRuntime } from './prepare-cli-runtime.js'
import type { BuildHarnessBrokerInvocationRequest } from './types.js'

const COMPILER_VERSION = '0.1.1'

type CompileRuntimePlanOptions = {
  clientAspHome?: string | undefined
}

function hashValue(value: unknown): string {
  return createCanonicalHasher().hash(value, {
    timestampMode: 'omit-ephemeral',
  }).value
}

function stableId(prefix: 'compile' | 'profile', value: unknown): string {
  return `${prefix}_${hashValue(value).slice(0, 32)}`
}

function projectionHash<K extends 'plan' | 'profile' | 'spec' | 'start-request'>(
  value: unknown,
  kind: K
): Extract<
  RuntimeContractProjection,
  Record<K extends 'start-request' ? 'startRequestHash' : `${K}Hash`, string>
> {
  return project(value, kind) as Extract<
    RuntimeContractProjection,
    Record<K extends 'start-request' ? 'startRequestHash' : `${K}Hash`, string>
  >
}

function toCompiledPlacement(
  placement: RuntimeCompileRequest['placement']
): RuntimeCompileRequest['placement'] {
  const { dispatchEnv: _dispatchEnv, ...compiledPlacement } = placement as Record<string, unknown>
  return compiledPlacement as RuntimeCompileRequest['placement']
}

function compileError(code: string, message: string, details?: unknown): CompileDiagnostic {
  return {
    level: 'error',
    code,
    message,
    plane: 'asp-compiler',
    ...(details !== undefined ? { details } : {}),
  }
}

function validateSupportedRoute(req: RuntimeCompileRequest): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []
  if (req.requested.modelProvider !== undefined && req.requested.modelProvider !== 'openai') {
    diagnostics.push(
      compileError('unsupported_provider', 'compileRuntimePlan only supports openai provider', {
        requested: req.requested.modelProvider,
      })
    )
  }
  if (req.requested.harnessFamily !== undefined && req.requested.harnessFamily !== 'codex') {
    diagnostics.push(
      compileError('unsupported_harness', 'compileRuntimePlan only supports codex harness family', {
        requested: req.requested.harnessFamily,
      })
    )
  }
  if (
    req.requested.preferredHarnessRuntime !== undefined &&
    req.requested.preferredHarnessRuntime !== 'codex-cli'
  ) {
    diagnostics.push(
      compileError('unsupported_runtime', 'compileRuntimePlan only supports codex-cli runtime', {
        requested: req.requested.preferredHarnessRuntime,
      })
    )
  }
  if (req.requested.interactionMode !== undefined && req.requested.interactionMode !== 'headless') {
    diagnostics.push(
      compileError(
        'unsupported_interaction_mode',
        'compileRuntimePlan only supports headless mode',
        {
          requested: req.requested.interactionMode,
        }
      )
    )
  }
  return diagnostics
}

function toBrokerAttachments(
  attachments: RuntimeCompileRequest['materialization']['attachments']
): AttachmentRef[] | undefined {
  if (!attachments || attachments.length === 0) return undefined
  return attachments
    .map((attachment): AttachmentRef | undefined => {
      if (attachment.kind === 'image' || attachment.kind === 'local-file') {
        return {
          kind: 'file',
          path: attachment.path,
          ...(attachment.mimeType !== undefined ? { contentType: attachment.mimeType } : {}),
        }
      }
      return undefined
    })
    .filter((attachment): attachment is AttachmentRef => attachment !== undefined)
}

function toBrokerPermissionPolicy(policy: BrokerPermissionPolicy): PermissionPolicy {
  if (policy.mode === 'ask-client') {
    return {
      mode: 'ask-client',
      timeoutMs: policy.timeoutMs,
      defaultDecision: policy.defaultDecision,
    }
  }
  return { mode: policy.mode }
}

function toProcessLimits(
  limits: RuntimeCompileRequest['hrcPolicy']['resourceLimits']
): ProcessLimits | undefined {
  if (!limits) return undefined
  return {
    ...(limits.startupTimeoutMs !== undefined ? { startupTimeoutMs: limits.startupTimeoutMs } : {}),
    ...(limits.turnTimeoutMs !== undefined ? { turnTimeoutMs: limits.turnTimeoutMs } : {}),
    ...(limits.stopGraceMs !== undefined ? { stopGraceMs: limits.stopGraceMs } : {}),
    ...(limits.maxEventBytes !== undefined ? { maxEventBytes: limits.maxEventBytes } : {}),
  }
}

function brokerCorrelation(req: RuntimeCompileRequest): Record<string, string> {
  const out: Record<string, string> = {
    requestId: req.correlation.requestId,
    hostSessionId: req.correlation.hostSessionId,
  }
  const optional: Record<string, string | undefined> = {
    operationId: req.correlation.operationId,
    runtimeId: req.correlation.runtimeId,
    runId: req.correlation.runId,
    traceId: req.correlation.traceId,
    scopeRef: req.correlation.scopeRef,
    laneRef: req.correlation.laneRef,
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function brokerObservability(
  req: RuntimeCompileRequest,
  invocationId: InvocationId
): BrokerObservabilityContract {
  return {
    correlation: {
      requestId: req.identity.requestId,
      operationId: req.identity.operationId,
      hostSessionId: req.identity.hostSessionId,
      generation: req.identity.generation,
      runtimeId: req.identity.runtimeId,
      ...(req.identity.runId !== undefined ? { runId: req.identity.runId } : {}),
      invocationId,
      ...(req.identity.traceId !== undefined ? { traceId: req.identity.traceId } : {}),
    },
    ...(req.hrcPolicy.observability !== undefined
      ? { driverConfig: { observability: req.hrcPolicy.observability } }
      : {}),
  }
}

function expectedCapabilities(policy: BrokerPermissionPolicy): CapabilityRequirements {
  return {
    input: {
      user: 'required',
      steer: 'optional',
      appendContext: 'optional',
      localImages: 'optional',
      fileRefs: 'forbidden',
      queue: 'forbidden',
    },
    turns: {
      concurrency: 'single',
      interrupt: 'optional',
    },
    continuation: 'optional',
    permissions: policy.mode === 'ask-client' ? 'broker-request' : 'none',
    events: {
      assistantDeltas: 'required',
      toolCalls: 'required',
      usage: 'optional',
      diagnostics: 'optional',
    },
    control: {
      stop: 'optional',
      dispose: 'optional',
      reconcile: 'optional',
      attachReplay: 'forbidden',
    },
  }
}

function buildCompatibilityMaterial(
  req: RuntimeCompileRequest,
  startRequest: BrokerExecutionProfile['harnessInvocation']['startRequest'],
  bundleIdentity: string,
  lockHash: string | undefined,
  lockedEnv: Record<string, string>
): unknown {
  const driver = startRequest.spec.driver
  const driverMaterial =
    driver.kind === 'codex-app-server'
      ? {
          kind: driver.kind,
          model: driver.model,
          modelReasoningEffort: driver.modelReasoningEffort,
          approvalPolicy: driver.approvalPolicy,
          sandboxMode: driver.sandboxMode,
          profile: driver.profile,
          permissionPolicy: driver.permissionPolicy,
          resumeFallback: driver.resumeFallback,
        }
      : driver
  return {
    bundle: { bundleIdentity, ...(lockHash !== undefined ? { lockHash } : {}) },
    model: {
      provider: req.requested.modelProvider ?? 'openai',
      requestedModel: req.requested.model,
      reasoningEffort: req.requested.reasoningEffort,
      driverModel: driver.kind === 'codex-app-server' ? driver.model : undefined,
    },
    process: {
      command: startRequest.spec.process.command,
      args: startRequest.spec.process.args,
      cwd: startRequest.spec.process.cwd,
      lockedEnv,
      pathPrepend: startRequest.spec.process.pathPrepend,
      harnessTransport: startRequest.spec.process.harnessTransport,
      limits: startRequest.spec.process.limits,
    },
    driver: driverMaterial,
    continuation:
      req.continuation !== undefined
        ? {
            hrc: {
              provider: req.continuation.hrc.provider,
              continuationId: req.continuation.hrc.continuationId,
            },
            broker:
              req.continuation.broker !== undefined
                ? {
                    provider: req.continuation.broker.provider,
                    kind: req.continuation.broker.kind,
                    continuationId: req.continuation.broker.continuationId,
                  }
                : undefined,
            source: req.continuation.source,
          }
        : undefined,
    policy: {
      permissionPolicy: req.hrcPolicy.permissionPolicy,
      inputPolicy: req.hrcPolicy.inputPolicy ?? DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: req.hrcPolicy.exposurePolicy ?? { mode: 'none' },
      resourceLimits: req.hrcPolicy.resourceLimits,
    },
  }
}

export async function compileRuntimePlan(
  req: RuntimeCompileRequest,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const routeDiagnostics = validateSupportedRoute(req)
  if (routeDiagnostics.length > 0) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: routeDiagnostics,
    }
  }

  const permissionPolicy = req.hrcPolicy.permissionPolicy ?? { mode: 'deny', audit: true }
  const inputPolicy: BrokerInputPolicy =
    req.hrcPolicy.inputPolicy ?? DEFAULT_CODEX_BROKER_INPUT_POLICY
  const exposurePolicy: AgentchatExposurePolicy = req.hrcPolicy.exposurePolicy ?? { mode: 'none' }
  const attachments = toBrokerAttachments(req.materialization.attachments)
  const taskId = req.materialization.taskContext?.taskId
  const placementEnv = req.placement as {
    env?: Record<string, string> | undefined
    lockedEnv?: Record<string, string> | undefined
    dispatchEnv?: Record<string, string> | undefined
  }
  const brokerReq: BuildHarnessBrokerInvocationRequest = {
    placement: req.placement as unknown as RuntimePlacement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    model: req.requested.model,
    continuation:
      req.continuation?.hrc.key !== undefined
        ? { provider: 'openai', key: req.continuation.hrc.key }
        : undefined,
    prompt: req.materialization.initialPrompt,
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    ...(placementEnv.env !== undefined ? { env: placementEnv.env } : {}),
    ...(placementEnv.lockedEnv !== undefined ? { lockedEnv: placementEnv.lockedEnv } : {}),
    ...(placementEnv.dispatchEnv !== undefined ? { dispatchEnv: placementEnv.dispatchEnv } : {}),
    ...(req.identity.invocationId !== undefined ? { invocationId: req.identity.invocationId } : {}),
    ...(req.identity.initialInputId !== undefined
      ? { initialInputId: req.identity.initialInputId }
      : {}),
    ...(taskId !== undefined ? { labels: { task: taskId } } : {}),
    correlation: brokerCorrelation(req),
    permissionPolicy: toBrokerPermissionPolicy(permissionPolicy),
    limits: toProcessLimits(req.hrcPolicy.resourceLimits),
    resumeFallback: 'fail',
  }

  validateBrokerInvocationRequest(brokerReq)
  const prepared = await preparePlacementCliRuntime(brokerReq, options?.clientAspHome)
  const brokerInvocation = toHarnessBrokerStartRequest(prepared, brokerReq)
  const startRequest = brokerInvocation.startRequest
  const spec = brokerInvocation.spec
  const lockedEnv = spec.process.lockedEnv ?? {}
  const lockedEnvKeys = Object.keys(lockedEnv).sort()

  const bundleIdentity = brokerInvocation.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (
    brokerInvocation.resolvedBundle as { lockHash?: string | undefined } | undefined
  )?.lockHash
  const profileId = stableId('profile', {
    kind: 'harness-broker',
    brokerDriver: 'codex-app-server',
    startRequest,
  }) as ProfileId
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(req, startRequest, bundleIdentity, lockHash, lockedEnv)
  )
  const specProjection = projectionHash(spec, 'spec')
  const specHash = specProjection.specHash
  const startRequestProjection = projectionHash(startRequest, 'start-request')
  const startRequestHash = startRequestProjection.startRequestHash
  const initialInputHash =
    startRequest.initialInput !== undefined ? hashValue(startRequest.initialInput) : undefined

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId,
    kind: 'harness-broker' as const,
    interactionMode: 'headless' as const,
    expectedCapabilities: expectedCapabilities(permissionPolicy),
    brokerProtocol: 'harness-broker/0.1' as const,
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process' as const,
    harnessInvocation: {
      startRequest,
      specHash,
      startRequestHash,
      ...(initialInputHash !== undefined ? { initialInputHash } : {}),
    },
    policy: {
      permissionPolicy,
      inputPolicy,
      exposurePolicy,
      ...(req.hrcPolicy.resourceLimits !== undefined
        ? { resourceLimits: req.hrcPolicy.resourceLimits }
        : {}),
    },
    ...(req.continuation !== undefined
      ? { continuation: { hrc: req.continuation, broker: req.continuation.broker } }
      : {}),
    observability: brokerObservability(
      req,
      startRequest.spec.invocationId ??
        req.identity.invocationId ??
        (profileId as unknown as InvocationId)
    ),
  }
  const profileHash = projectionHash(
    { ...profileMaterial, compatibilityHash },
    'profile'
  ).profileHash

  const profile: BrokerExecutionProfile = {
    ...profileMaterial,
    profileHash,
    compatibilityHash,
  }

  const diagnostics: CompileDiagnostic[] = (brokerInvocation.warnings ?? []).map((warning) => ({
    level: 'warning',
    code: 'prepare_runtime_warning',
    message: warning,
    plane: 'asp-compiler',
    profileId,
  }))
  const compileId = stableId('compile', {
    requestId: req.identity.requestId,
    operationId: req.identity.operationId,
    generation: req.identity.generation,
    profileHash,
  }) as CompileId
  const createdAt = new Date().toISOString()
  const resolvedBundle = (brokerInvocation.resolvedBundle ?? {
    bundleIdentity,
  }) as unknown as CompiledRuntimePlan['resolvedBundle']
  const compiledPlacement = toCompiledPlacement(req.placement)
  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: COMPILER_VERSION },
    compileId,
    createdAt,
    identity: req.identity,
    placement: compiledPlacement,
    resolvedBundle,
    harness: {
      family: 'codex' as const,
      runtime: 'codex-cli' as const,
      provider: 'openai' as const,
    },
    model: {
      provider: 'openai' as const,
      modelId:
        prepared.runtimePlan.model.ok === true
          ? prepared.runtimePlan.model.info.model
          : (req.requested.model ?? 'unknown'),
      ...(req.requested.model !== undefined ? { requestedModel: req.requested.model } : {}),
      ...(req.requested.reasoningEffort !== undefined
        ? { reasoningEffort: req.requested.reasoningEffort }
        : {}),
    },
    executionProfiles: [profile],
    artifacts: {
      materializedBundleRoot: prepared.materialized.materialization.outputPath,
      ...(prepared.systemPrompt?.path !== undefined
        ? { systemPromptFile: prepared.systemPrompt.path }
        : {}),
      ...(lockHash !== undefined ? { lockHash } : {}),
      bundleIdentity,
    },
    lockedEnv: {
      lockedEnvKeys,
    },
    diagnostics,
  }
  const planHash = projectionHash(planMaterial, 'plan').planHash
  const plan: CompiledRuntimePlan = {
    ...planMaterial,
    planHash,
  }

  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan,
    diagnostics,
  }
}
