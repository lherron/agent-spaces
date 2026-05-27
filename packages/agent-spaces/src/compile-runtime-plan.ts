import type { RuntimePlacement } from 'spaces-config'
import type {
  HarnessInvocationSpec,
  InputContent,
  InputId,
  InvocationId,
  InvocationInput,
  InvocationStartRequest,
  PermissionPolicy,
  ProcessLimits,
} from 'spaces-harness-broker-protocol'
import { validateInvocationInput, validateInvocationSpec } from 'spaces-harness-broker-protocol'
import type { AttachmentRef } from 'spaces-runtime'
import {
  type AgentchatExposurePolicy,
  type BrokerExecutionProfile,
  type BrokerInputPolicy,
  type BrokerObservabilityContract,
  type BrokerPermissionPolicy,
  type BrokerTerminalSurface,
  type CapabilityRequirements,
  type CompileDiagnostic,
  type CompileId,
  type CompiledRuntimePlan,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  type EmbeddedSdkExecutionProfile,
  type HarnessFamily,
  type HarnessRuntime,
  type ProfileId,
  type ProviderDomain,
  type RuntimeCompileRequest,
  type RuntimeCompileResponse,
  type RuntimeContractProjection,
  type TerminalExecutionProfile,
  createCanonicalHasher,
  project,
  validateBrokerExecutionProfile,
  validateEmbeddedSdkExecutionProfile,
  validateTerminalExecutionProfile,
} from 'spaces-runtime-contracts'

import {
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import { PI_SDK_FRONTEND, resolveFrontend } from './client-support.js'
import {
  type PreparedPlacementCliRuntime,
  preparePlacementCliRuntime,
} from './prepare-cli-runtime.js'
import type { BuildHarnessBrokerInvocationRequest, HarnessFrontend } from './types.js'

/**
 * The compile request placement, narrowed to the spaces-config RuntimePlacement
 * shape it actually carries plus the typed env channels the compiler reads.
 *
 * Intersecting the contract placement with the spaces-config RuntimePlacement
 * makes this an honest refinement of `RuntimeCompileRequest['placement']`: it is
 * a valid downcast (no `as unknown as RuntimePlacement` bridge) and is directly
 * assignable to the strict RuntimePlacement that prepare-cli-runtime expects.
 * Replaces the former scattered cast cluster.
 */
type CompilePlacement = RuntimeCompileRequest['placement'] &
  RuntimePlacement & {
    env?: Record<string, string> | undefined
    lockedEnv?: Record<string, string> | undefined
    dispatchEnv?: Record<string, string> | undefined
  }

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

function toCompiledPlacement(placement: CompilePlacement): CompiledRuntimePlan['placement'] {
  const { dispatchEnv: _dispatchEnv, ...compiledPlacement } = placement
  return compiledPlacement
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

/**
 * Validate the headless broker route (openai / codex / codex-cli / headless).
 * The foreground branch has its own route resolver (resolveForegroundRoute).
 */
function validateBrokerRoute(req: RuntimeCompileRequest): CompileDiagnostic[] {
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

/** Canonical foreground (interactive) route per harness family. */
type ForegroundRoute = {
  frontend: HarnessFrontend
  family: HarnessFamily
  runtime: HarnessRuntime
  provider: ProviderDomain
}

const FOREGROUND_ROUTES: Record<HarnessFamily, ForegroundRoute> = {
  'claude-code': {
    frontend: 'claude-code',
    family: 'claude-code',
    runtime: 'claude-code-cli',
    provider: 'anthropic',
  },
  codex: { frontend: 'codex-cli', family: 'codex', runtime: 'codex-cli', provider: 'openai' },
  pi: { frontend: 'pi-cli', family: 'pi', runtime: 'pi-cli', provider: 'openai' },
}

const RUNTIME_TO_FAMILY: Partial<Record<HarnessRuntime, HarnessFamily>> = {
  'claude-code-cli': 'claude-code',
  'codex-cli': 'codex',
  'pi-cli': 'pi',
}

/**
 * Resolve a foreground (interactive) route from the requested harness fields.
 * Emits diagnostics for genuinely unsupported pairings (sdk runtimes, provider
 * mismatch, inconsistent family/runtime) so the compiler returns errors rather
 * than throwing deep in the prepare path.
 */
function resolveForegroundRoute(
  req: RuntimeCompileRequest
): { route: ForegroundRoute; diagnostics: CompileDiagnostic[] } | { diagnostics: CompileDiagnostic[] } {
  const diagnostics: CompileDiagnostic[] = []
  const requestedRuntime = req.requested.preferredHarnessRuntime
  const family =
    req.requested.harnessFamily ??
    (requestedRuntime !== undefined ? RUNTIME_TO_FAMILY[requestedRuntime] : undefined)

  if (family === undefined) {
    diagnostics.push(
      compileError(
        'unsupported_harness',
        'interactive compile requires a foreground-capable harness family (claude-code, codex, or pi)',
        { requested: req.requested }
      )
    )
    return { diagnostics }
  }

  const route = FOREGROUND_ROUTES[family]

  if (req.requested.modelProvider !== undefined && req.requested.modelProvider !== route.provider) {
    diagnostics.push(
      compileError(
        'unsupported_provider',
        `interactive ${route.frontend} requires provider ${route.provider}`,
        { requested: req.requested.modelProvider, frontend: route.frontend }
      )
    )
  }
  if (requestedRuntime !== undefined && requestedRuntime !== route.runtime) {
    diagnostics.push(
      compileError(
        'unsupported_runtime',
        `interactive ${route.family} requires the ${route.runtime} runtime`,
        { requested: requestedRuntime, frontend: route.frontend }
      )
    )
  }

  if (diagnostics.length > 0) return { diagnostics }
  return { route, diagnostics }
}

/** Capability requirements for a foreground, operator-driven terminal session. */
function foregroundCapabilities(): CapabilityRequirements {
  return {
    input: {
      user: 'required',
      steer: 'forbidden',
      appendContext: 'forbidden',
      localImages: 'optional',
      fileRefs: 'optional',
      queue: 'forbidden',
    },
    turns: {
      concurrency: 'single',
      interrupt: 'optional',
    },
    continuation: 'optional',
    permissions: 'none',
    events: {
      assistantDeltas: 'optional',
      toolCalls: 'optional',
      usage: 'optional',
      diagnostics: 'optional',
    },
    control: {
      stop: 'optional',
      dispose: 'optional',
      reconcile: 'forbidden',
      attachReplay: 'forbidden',
    },
  }
}

function buildForegroundCompatibilityMaterial(
  req: RuntimeCompileRequest,
  process: TerminalExecutionProfile['process'],
  route: ForegroundRoute,
  bundleIdentity: string,
  lockHash: string | undefined
): unknown {
  return {
    bundle: { bundleIdentity, ...(lockHash !== undefined ? { lockHash } : {}) },
    model: {
      provider: route.provider,
      requestedModel: req.requested.model,
      reasoningEffort: req.requested.reasoningEffort,
    },
    process: {
      command: process.command,
      args: process.args,
      cwd: process.cwd,
      lockedEnv: process.lockedEnv,
      pathPrepend: process.pathPrepend,
      io: process.io,
    },
    terminal: {
      host: 'foreground',
      startupMethod: 'inherit-current-terminal',
      turnDelivery: 'terminal-launch-input',
    },
    continuation:
      req.continuation !== undefined
        ? {
            hrc: {
              provider: req.continuation.hrc.provider,
              continuationId: req.continuation.hrc.continuationId,
            },
            source: req.continuation.source,
          }
        : undefined,
    policy: { exposurePolicy: { mode: 'none' } },
  }
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

function withoutInteractiveLaunchPrompt(args: string[], prompt: string | undefined): string[] {
  if (prompt === undefined || prompt.length === 0) return args
  if (args.length >= 2 && args[args.length - 2] === '--' && args[args.length - 1] === prompt) {
    return args.slice(0, -2)
  }
  return args
}

function buildClaudeTmuxInitialInput(
  req: RuntimeCompileRequest,
  initialText: string | undefined
): InvocationInput | undefined {
  const content: InputContent[] = []
  if (initialText !== undefined && initialText.length > 0) {
    content.push({ type: 'text', text: initialText })
  }
  if (content.length === 0) return undefined
  return {
    inputId:
      req.identity.initialInputId ??
      (`input_${hashValue({ route: 'claude-code-tmux', content }).slice(0, 32)}` as InputId),
    kind: 'user',
    content,
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

/**
 * Discriminate the interactive controller route by EXPLICIT compiler intent,
 * never by descriptive catalog array order (cody 0B mandate).
 *
 * The pre-HRC default for interactive claude-code is the operator-attachable
 * harness-broker (claude-code-tmux). The foreground TerminalExecutionProfile is
 * selectable ONLY when the request carries controllerIntent 'foreground-terminal'.
 * Non-claude families keep the foreground terminal as their interactive default.
 */
function selectsInteractiveClaudeTmuxBroker(req: RuntimeCompileRequest): boolean {
  if (req.requested.controllerIntent === 'foreground-terminal') return false
  const requestedRuntime = req.requested.preferredHarnessRuntime
  const family =
    req.requested.harnessFamily ??
    (requestedRuntime !== undefined ? RUNTIME_TO_FAMILY[requestedRuntime] : undefined)
  return family === 'claude-code'
}

export async function compileRuntimePlan(
  req: RuntimeCompileRequest,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const placement = req.placement as CompilePlacement
  if (req.requested.interactionMode === 'interactive') {
    if (selectsInteractiveClaudeTmuxBroker(req)) {
      return compileClaudeTmuxBrokerPlan(req, placement, options)
    }
    return compileForegroundPlan(req, placement, options)
  }
  // nonInteractive + pi-sdk routes to the IN-PROCESS embedded-sdk controller.
  // claude-agent-sdk stays UNEMITTED (impl deferred per Lance) — it falls through
  // to the broker route, which rejects it. Any other nonInteractive/headless
  // request stays on the codex headless broker path.
  if (req.requested.preferredHarnessRuntime === 'pi-sdk') {
    return compileEmbeddedSdkPlan(req, placement, options)
  }
  return compileBrokerPlan(req, placement, options)
}

async function compileBrokerPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const routeDiagnostics = validateBrokerRoute(req)
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
  const brokerReq: BuildHarnessBrokerInvocationRequest = {
    placement,
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
    ...(placement.env !== undefined ? { env: placement.env } : {}),
    ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
    ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
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
  const compiledPlacement = toCompiledPlacement(placement)
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

/**
 * Compile an interactive request to a foreground TerminalExecutionProfile.
 *
 * The launch shape (command/args/cwd/lockedEnv/pathPrepend) is sourced from the
 * SAME prepare-cli-runtime path the broker branch uses — which itself calls the
 * harness adapters' buildRunArgs — so the compiler is the single source of truth
 * for argv. Foreground is caller-owned (exposurePolicy {mode:'none'}), inherits
 * the operator's TTY (io {kind:'inherit'}), and delivers at most one launch turn
 * (turnDelivery 'terminal-launch-input').
 */
async function compileForegroundPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const routed = resolveForegroundRoute(req)
  if (!('route' in routed)) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: routed.diagnostics,
    }
  }
  const route = routed.route
  // Resolve the frontend up front so an unknown frontend surfaces as a thrown
  // CodedError before the heavier prepare path runs.
  resolveFrontend(route.frontend)

  const attachments = toBrokerAttachments(req.materialization.attachments)
  const prepared = await preparePlacementCliRuntime(
    {
      provider: route.provider,
      frontend: route.frontend,
      interactionMode: 'interactive',
      ...(req.requested.model !== undefined ? { model: req.requested.model } : {}),
      ...(req.continuation?.hrc.key !== undefined
        ? { continuation: { provider: route.provider, key: req.continuation.hrc.key } }
        : {}),
      ...(req.materialization.initialPrompt !== undefined
        ? { prompt: req.materialization.initialPrompt }
        : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(placement.env !== undefined ? { env: placement.env } : {}),
      ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
      ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
      placement,
    },
    options?.clientAspHome
  )

  const lockedEnv = prepared.lockedEnv
  const lockedEnvKeys = Object.keys(lockedEnv).sort()
  const bundleIdentity = prepared.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (prepared.resolvedBundle as { lockHash?: string | undefined } | undefined)
    ?.lockHash

  const processSpec: TerminalExecutionProfile['process'] = {
    command: prepared.commandPath,
    args: prepared.args,
    cwd: prepared.cwd,
    lockedEnv,
    ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
    io: { kind: 'inherit' },
  }

  const compatibilityHash = hashValue(
    buildForegroundCompatibilityMaterial(req, processSpec, route, bundleIdentity, lockHash)
  )
  const profileId = stableId('profile', {
    kind: 'terminal',
    host: 'foreground',
    command: processSpec.command,
    args: processSpec.args,
    cwd: processSpec.cwd,
  }) as ProfileId

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId,
    kind: 'terminal' as const,
    interactionMode: 'interactive' as const,
    expectedCapabilities: foregroundCapabilities(),
    terminal: {
      host: 'foreground' as const,
      startupMethod: 'inherit-current-terminal' as const,
      turnDelivery: 'terminal-launch-input' as const,
    },
    process: processSpec,
    policy: {
      exposurePolicy: { mode: 'none' as const },
      ...(req.hrcPolicy.resourceLimits !== undefined
        ? { resourceLimits: req.hrcPolicy.resourceLimits }
        : {}),
    },
  }
  const profileHash = projectionHash(
    { ...profileMaterial, compatibilityHash },
    'profile'
  ).profileHash
  const profile: TerminalExecutionProfile = {
    ...profileMaterial,
    profileHash,
    compatibilityHash,
  }

  const validationDiagnostics = validateTerminalExecutionProfile(profile)
  if (validationDiagnostics.length > 0) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: validationDiagnostics,
    }
  }

  const diagnostics: CompileDiagnostic[] = (prepared.warnings ?? []).map((warning) => ({
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
  const resolvedBundle = (prepared.resolvedBundle ?? {
    bundleIdentity,
  }) as unknown as CompiledRuntimePlan['resolvedBundle']
  const compiledPlacement = toCompiledPlacement(placement)

  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: COMPILER_VERSION },
    compileId,
    createdAt,
    identity: req.identity,
    placement: compiledPlacement,
    resolvedBundle,
    harness: {
      family: route.family,
      runtime: route.runtime,
      provider: route.provider,
    },
    model: {
      provider: route.provider,
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

/** Capability requirements for an in-process, nonInteractive embedded-sdk session. */
function embeddedSdkCapabilities(): CapabilityRequirements {
  return {
    input: {
      user: 'required',
      steer: 'optional',
      appendContext: 'optional',
      localImages: 'optional',
      fileRefs: 'optional',
      queue: 'optional',
    },
    turns: {
      concurrency: 'single',
      interrupt: 'optional',
    },
    continuation: 'optional',
    permissions: 'none',
    events: {
      assistantDeltas: 'optional',
      toolCalls: 'optional',
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

function buildEmbeddedSdkCompatibilityMaterial(
  req: RuntimeCompileRequest,
  session: EmbeddedSdkExecutionProfile['session'],
  sdk: EmbeddedSdkExecutionProfile['sdk'],
  bundleIdentity: string,
  lockHash: string | undefined
): unknown {
  return {
    bundle: { bundleIdentity, ...(lockHash !== undefined ? { lockHash } : {}) },
    model: {
      provider: session.provider,
      requestedModel: req.requested.model,
      reasoningEffort: req.requested.reasoningEffort,
      modelId: session.modelId,
    },
    sdk,
    session: {
      provider: session.provider,
      modelId: session.modelId,
      cwd: session.cwd,
      lockedEnv: session.lockedEnv,
      pathPrepend: session.pathPrepend,
    },
    continuation:
      req.continuation !== undefined
        ? {
            hrc: {
              provider: req.continuation.hrc.provider,
              continuationId: req.continuation.hrc.continuationId,
            },
            source: req.continuation.source,
          }
        : undefined,
  }
}

/**
 * Prepare the pi-sdk session launch shape (cwd/lockedEnv/pathPrepend/model) from
 * the SAME preparePlacementCliRuntime path the foreground/broker branches use, so
 * the embedded session composes env exactly like a launched harness process. The
 * pi-sdk model catalog is namespaced (`openai-codex/<model>`); a bare requested
 * model (e.g. `gpt-5.5`) that the adapter does not recognize falls back to the
 * pi-sdk default rather than failing the compile — honoring an explicit pi-sdk
 * model id when one is given.
 */
async function prepareEmbeddedSdkSession(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  options?: CompileRuntimePlanOptions
): Promise<PreparedPlacementCliRuntime> {
  const attachments = toBrokerAttachments(req.materialization.attachments)
  const baseReq = {
    provider: 'openai' as ProviderDomain,
    frontend: PI_SDK_FRONTEND,
    interactionMode: 'nonInteractive' as const,
    ...(req.continuation?.hrc.key !== undefined
      ? { continuation: { provider: 'openai' as ProviderDomain, key: req.continuation.hrc.key } }
      : {}),
    ...(req.materialization.initialPrompt !== undefined
      ? { prompt: req.materialization.initialPrompt }
      : {}),
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    ...(placement.env !== undefined ? { env: placement.env } : {}),
    ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
    ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
    placement,
  }
  try {
    return await preparePlacementCliRuntime(
      { ...baseReq, ...(req.requested.model !== undefined ? { model: req.requested.model } : {}) },
      options?.clientAspHome
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (req.requested.model !== undefined && /Model not supported/.test(message)) {
      return await preparePlacementCliRuntime(baseReq, options?.clientAspHome)
    }
    throw error
  }
}

/**
 * Compile a nonInteractive pi-sdk request to an in-process EmbeddedSdkExecutionProfile
 * (controller 'embedded-sdk'), per ARCPS §7.3.2 / FINAL_CONTRACTS §7.8. The profile
 * carries NO broker/process/transport/terminal launch fields — the SDK session runs
 * in-process inside hrc-server. PATH is emitted as the typed session.pathPrepend
 * channel; session.lockedEnv never carries PATH. claude-agent-sdk is intentionally
 * NOT emitted (impl deferred); only pi-sdk reaches this branch.
 */
async function compileEmbeddedSdkPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  // ARCPS §7.3.2 legality gate: an embedded-sdk pi-sdk profile is legal ONLY for
  // openai + harnessFamily pi + interactionMode nonInteractive EXACTLY. Reject
  // headless, an omitted interactionMode, and a non-pi family rather than
  // silently rewriting interactionMode to nonInteractive.
  const legalityDiagnostics: CompileDiagnostic[] = []
  if (req.requested.modelProvider !== undefined && req.requested.modelProvider !== 'openai') {
    legalityDiagnostics.push(
      compileError('unsupported_provider', 'pi-sdk embedded compile requires the openai provider', {
        requested: req.requested.modelProvider,
      })
    )
  }
  if (req.requested.interactionMode === undefined) {
    legalityDiagnostics.push(
      compileError(
        'unsupported_interaction_mode',
        'pi-sdk embedded compile requires an explicit nonInteractive interactionMode',
        { requested: null }
      )
    )
  } else if (req.requested.interactionMode !== 'nonInteractive') {
    legalityDiagnostics.push(
      compileError(
        'unsupported_interaction_mode',
        'pi-sdk embedded compile requires interactionMode nonInteractive (not headless)',
        { requested: req.requested.interactionMode }
      )
    )
  }
  if (req.requested.harnessFamily !== undefined && req.requested.harnessFamily !== 'pi') {
    legalityDiagnostics.push(
      compileError('unsupported_harness', 'pi-sdk embedded compile requires harnessFamily pi', {
        requested: req.requested.harnessFamily,
      })
    )
  }
  if (legalityDiagnostics.length > 0) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: legalityDiagnostics,
    }
  }

  const prepared = await prepareEmbeddedSdkSession(req, placement, options)

  const lockedEnv = prepared.lockedEnv
  const lockedEnvKeys = Object.keys(lockedEnv).sort()
  const bundleIdentity = prepared.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (prepared.resolvedBundle as { lockHash?: string | undefined } | undefined)
    ?.lockHash
  // Emit the registry-qualified effectiveModel (e.g. `openai-codex/gpt-5.5`), not
  // the de-namespaced `info.model` — the pi model registry is keyed by the
  // namespaced provider, so the in-process executor must be able to recover
  // (registryProvider, registryModel) to drive PiSession to legacy parity. The
  // coarse session.provider stays the ProviderDomain ('openai') for validation.
  const modelId =
    prepared.runtimePlan.model.ok === true
      ? prepared.runtimePlan.model.info.effectiveModel
      : (req.requested.model ?? 'unknown')

  const sdk: EmbeddedSdkExecutionProfile['sdk'] = {
    runtime: 'pi-sdk',
    startupMethod: 'create-sdk-session',
    turnDelivery: 'sdk-turn',
  }
  const session: EmbeddedSdkExecutionProfile['session'] = {
    provider: 'openai',
    modelId,
    cwd: prepared.cwd,
    lockedEnv,
    ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
  }

  const compatibilityHash = hashValue(
    buildEmbeddedSdkCompatibilityMaterial(req, session, sdk, bundleIdentity, lockHash)
  )
  const profileId = stableId('profile', {
    kind: 'embedded-sdk',
    runtime: sdk.runtime,
    cwd: session.cwd,
    modelId: session.modelId,
  }) as ProfileId

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId,
    kind: 'embedded-sdk' as const,
    interactionMode: 'nonInteractive' as const,
    expectedCapabilities: embeddedSdkCapabilities(),
    sdk,
    session,
    policy: {
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      ...(req.hrcPolicy.resourceLimits !== undefined
        ? { resourceLimits: req.hrcPolicy.resourceLimits }
        : {}),
    },
    ...(req.continuation !== undefined ? { continuation: req.continuation } : {}),
  }
  const profileHash = projectionHash(
    { ...profileMaterial, compatibilityHash },
    'profile'
  ).profileHash
  const profile: EmbeddedSdkExecutionProfile = {
    ...profileMaterial,
    profileHash,
    compatibilityHash,
  }

  const validationDiagnostics = validateEmbeddedSdkExecutionProfile(profile)
  if (validationDiagnostics.length > 0) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: validationDiagnostics,
    }
  }

  const diagnostics: CompileDiagnostic[] = (prepared.warnings ?? []).map((warning) => ({
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
  const resolvedBundle = (prepared.resolvedBundle ?? {
    bundleIdentity,
  }) as unknown as CompiledRuntimePlan['resolvedBundle']
  const compiledPlacement = toCompiledPlacement(placement)

  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: COMPILER_VERSION },
    compileId,
    createdAt,
    identity: req.identity,
    placement: compiledPlacement,
    resolvedBundle,
    harness: {
      family: 'pi' as const,
      runtime: 'pi-sdk' as const,
      provider: 'openai' as const,
    },
    model: {
      provider: 'openai' as const,
      modelId,
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

/**
 * The pre-HRC interactive claude-code surface is an operator-attachable tmux
 * session, exposed via the broker-reports-target policy (PLANE_SPEC AD-010).
 * Both policy.exposurePolicy and brokerTerminal.exposurePolicy carry this exact
 * literal; the broker validator asserts they are identical.
 */
const TMUX_BROKER_EXPOSURE_POLICY = {
  mode: 'broker-reports-target',
  targetKind: 'tmux-session',
} as const

/**
 * The fixed broker-owned tmux surface descriptor for the interactive claude
 * route. This is selection/exposure metadata ONLY — the socket/session/pane are
 * RUNTIME-REPORTED by the driver (Phase 3), never synthesized at compile time,
 * so a dry compile creates no tmux session and emits no synthetic ids.
 */
const CLAUDE_TMUX_BROKER_TERMINAL: BrokerTerminalSurface = {
  host: 'tmux',
  startupMethod: 'create-terminal',
  turnDelivery: 'terminal-literal-input',
  operatorAttach: true,
  exposurePolicy: TMUX_BROKER_EXPOSURE_POLICY,
}

/**
 * Compile an interactive claude-code request to an operator-attachable
 * claude-code-tmux BrokerExecutionProfile (Path 2, pre-HRC default).
 *
 * The launch shape (command/args/cwd/lockedEnv/pathPrepend) is sourced from the
 * SAME preparePlacementCliRuntime path the foreground branch uses — so the
 * hashed process launch byte-matches the known-good foreground/legacy claude
 * launch. The process transport is the existing pty HarnessTransportSpec (tmux
 * is the terminal surface/host, NOT a transport). No tmux session is allocated
 * here; surface allocation is deferred to the driver runtime (Phase 3).
 */
async function compileClaudeTmuxBrokerPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const routed = resolveForegroundRoute(req)
  if (!('route' in routed)) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: routed.diagnostics,
    }
  }
  const route = routed.route
  // Resolve the frontend up front so an unknown frontend surfaces as a thrown
  // CodedError before the heavier prepare path runs.
  resolveFrontend(route.frontend)

  const attachments = toBrokerAttachments(req.materialization.attachments)
  const prepared = await preparePlacementCliRuntime(
    {
      provider: route.provider,
      frontend: route.frontend,
      interactionMode: 'interactive',
      ...(req.requested.model !== undefined ? { model: req.requested.model } : {}),
      ...(req.continuation?.hrc.key !== undefined
        ? { continuation: { provider: route.provider, key: req.continuation.hrc.key } }
        : {}),
      ...(req.materialization.initialPrompt !== undefined
        ? { prompt: req.materialization.initialPrompt }
        : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(placement.env !== undefined ? { env: placement.env } : {}),
      ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
      ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
      placement,
    },
    options?.clientAspHome
  )

  const permissionPolicy = req.hrcPolicy.permissionPolicy ?? { mode: 'deny', audit: true }
  const inputPolicy: BrokerInputPolicy =
    req.hrcPolicy.inputPolicy ?? DEFAULT_CODEX_BROKER_INPUT_POLICY
  const limits = toProcessLimits(req.hrcPolicy.resourceLimits)
  const taskId = req.materialization.taskContext?.taskId

  const lockedEnv = prepared.lockedEnv
  const lockedEnvKeys = Object.keys(lockedEnv).sort()
  const bundleIdentity = prepared.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (prepared.resolvedBundle as { lockHash?: string | undefined } | undefined)
    ?.lockHash
  const processArgs = withoutInteractiveLaunchPrompt(prepared.args, prepared.expandedPrompt)

  // pty is the PROCESS TRANSPORT; tmux is the broker terminal surface/host. The
  // claude-code-tmux driver carries terminalHost so the validator can assert the
  // surface contract without duplicating launch mechanics outside the spec.
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.identity.invocationId !== undefined ? { invocationId: req.identity.invocationId } : {}),
    ...(taskId !== undefined ? { labels: { task: taskId } } : {}),
    harness: {
      frontend: route.frontend,
      provider: route.provider,
      driver: 'claude-code-tmux',
    },
    process: {
      command: prepared.commandPath,
      args: processArgs,
      cwd: prepared.cwd,
      lockedEnv,
      ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
      harnessTransport: { kind: 'pty' },
      ...(limits !== undefined ? { limits } : {}),
    },
    interaction: {
      mode: 'interactive',
      turnConcurrency: 'single',
      inputQueue: 'none',
    },
    ...(req.continuation?.hrc.key !== undefined
      ? {
          continuation: {
            provider: route.provider,
            key: req.continuation.hrc.key,
            kind: 'session',
          },
        }
      : {}),
    driver: { kind: 'claude-code-tmux', terminalHost: 'tmux' },
    correlation: brokerCorrelation(req),
  }
  validateInvocationSpec(spec)
  const initialInput = buildClaudeTmuxInitialInput(req, prepared.expandedPrompt)
  if (initialInput !== undefined) {
    validateInvocationInput(initialInput)
  }
  const startRequest: InvocationStartRequest =
    initialInput === undefined ? { spec } : { spec, initialInput }

  const profileId = stableId('profile', {
    kind: 'harness-broker',
    brokerDriver: 'claude-code-tmux',
    startRequest,
  }) as ProfileId
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(req, startRequest, bundleIdentity, lockHash, lockedEnv)
  )
  const specHash = projectionHash(spec, 'spec').specHash
  const startRequestHash = projectionHash(startRequest, 'start-request').startRequestHash
  const initialInputHash =
    startRequest.initialInput !== undefined ? hashValue(startRequest.initialInput) : undefined

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId,
    kind: 'harness-broker' as const,
    interactionMode: 'interactive' as const,
    expectedCapabilities: expectedCapabilities(permissionPolicy),
    brokerProtocol: 'harness-broker/0.1' as const,
    brokerDriver: 'claude-code-tmux' as const,
    brokerOwnership: 'hrc-owned-process' as const,
    brokerTerminal: CLAUDE_TMUX_BROKER_TERMINAL,
    harnessInvocation: {
      startRequest,
      specHash,
      startRequestHash,
      ...(initialInputHash !== undefined ? { initialInputHash } : {}),
    },
    policy: {
      permissionPolicy,
      inputPolicy,
      exposurePolicy: TMUX_BROKER_EXPOSURE_POLICY,
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

  const validationDiagnostics = validateBrokerExecutionProfile(profile)
  if (validationDiagnostics.length > 0) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: validationDiagnostics,
    }
  }

  const diagnostics: CompileDiagnostic[] = (prepared.warnings ?? []).map((warning) => ({
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
  const resolvedBundle = (prepared.resolvedBundle ?? {
    bundleIdentity,
  }) as unknown as CompiledRuntimePlan['resolvedBundle']
  const compiledPlacement = toCompiledPlacement(placement)

  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: COMPILER_VERSION },
    compileId,
    createdAt,
    identity: req.identity,
    placement: compiledPlacement,
    resolvedBundle,
    harness: {
      family: route.family,
      runtime: route.runtime,
      provider: route.provider,
    },
    model: {
      provider: route.provider,
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
