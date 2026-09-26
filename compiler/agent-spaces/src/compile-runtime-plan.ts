import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { HygieneGateFinding, RuntimePlacement } from 'spaces-config'
import { MaterializationHygieneError, parseAgentProfile } from 'spaces-config'
import type {
  HarnessInvocationSpec,
  HarnessLaunchSpec,
  InvocationDispatchRequest,
  InvocationStartRequest,
  PermissionPolicy,
  ProcessLimits,
} from 'spaces-harness-broker-protocol'
import { validateInvocationSpec } from 'spaces-harness-broker-protocol'
import { loadAgentSemantics } from 'spaces-runtime'
import type { AttachmentRef } from 'spaces-runtime'
import {
  type BrokerPermissionPolicy,
  type CompileContext,
  type CompileDiagnostic,
  type CompileId,
  type CompiledRuntimePlan,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  type ExecutionRecipeDto,
  type ProfileId,
  type ResolvedHarnessSelection,
  type RuntimeCompileRequest,
  type RuntimeCompileResponse,
  createCanonicalHasher,
  hashNeutralStartRequest,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

import {
  combineBrokerPrompts,
  deriveHandleParts,
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import { timeCompilePhase, timeCompilePhaseSync } from './compile-phases.js'
import { assertExecutionMatchesResolution } from './harness-selection/assert-execution-matches-resolution.js'
import { BUILDER_REGISTRY } from './harness-selection/builders.js'
import {
  CompileProvisioningError,
  resolveCompileProvisioningLayers,
} from './harness-selection/compile-provisioning.js'
import { resolveHarnessExecution } from './harness-selection/resolve.js'
import type { ExecutionRecipe, ResolvedHarnessExecution } from './harness-selection/types.js'
import { type AgentSpacesRuntimeDependencies, requireAgentSpacesRuntime } from './placement-api.js'
import {
  buildPreparationExecutionContext,
  promptSourcesForCompile,
} from './preparation-execution-context.js'
import {
  type PreparedPlacementCliRuntime,
  preparePlacementCliRuntime,
} from './prepare-cli-runtime.js'
import type {
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
} from './types.js'

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
export type CompilePlacement = RuntimeCompileRequest['placement'] &
  RuntimePlacement & {
    env?: Record<string, string> | undefined
    lockedEnv?: Record<string, string> | undefined
    dispatchEnv?: Record<string, string> | undefined
  }

const COMPILER_VERSION = '0.1.1'

type PreparedResolvedBundle = NonNullable<BuildHarnessBrokerInvocationResponse['resolvedBundle']>

export type CompileRuntimePlanOptions = {
  clientAspHome?: string | undefined
  clientRegistryPath?: string | undefined
  clientRuntime?: AgentSpacesRuntimeDependencies | undefined
  /**
   * Pinned, serializable compile context (T-04133). When present, `nowIso`
   * sources `createdAt` and `idSalt`/`toolchainManifest` feed deterministic id
   * derivation. Production callers omit it (real time, unsalted derivation).
   */
  compileContext?: CompileContext | undefined
  /** Inspection/preview projects a launch plan but must not mutate CODEX_HOME. */
  materializeCodexRuntimeHome?: boolean | undefined
  dispatch?: Omit<InvocationDispatchRequest, 'startRequest'> | undefined
}

function hashValue(value: unknown): string {
  return createCanonicalHasher().hash(value, {
    timestampMode: 'omit-ephemeral',
  }).value
}

function stableId(prefix: 'compile' | 'profile', value: unknown): string {
  return `${prefix}_${hashValue(value).slice(0, 32)}`
}

function hashNeutralCompileIdentity(
  identity: RuntimeCompileRequest['identity']
): Partial<RuntimeCompileRequest['identity']> {
  return { generation: identity.generation }
}

function hashNeutralPlacement(
  placement: CompiledRuntimePlan['placement']
): CompiledRuntimePlan['placement'] {
  const { correlation: _correlation, ...hashPlacement } =
    placement as CompiledRuntimePlan['placement'] & {
      correlation?: unknown
    }
  return hashPlacement
}

function toCompiledPlacement(placement: CompilePlacement): CompiledRuntimePlan['placement'] {
  const { dispatchEnv: _dispatchEnv, ...compiledPlacement } = placement
  return compiledPlacement
}

/**
 * Return the prepared/broker `resolvedBundle` (or a `{ bundleIdentity }`-only
 * fallback when the prepare step produced none) in the plan-shaped contract.
 * Hash-neutral: the returned enumerable field set is identical to the previous
 * inline expression.
 */
function toResolvedBundle(
  source: PreparedResolvedBundle | undefined,
  bundleIdentity: string
): CompiledRuntimePlan['resolvedBundle'] {
  return source === undefined ? { bundleIdentity } : { ...source }
}

/**
 * Inputs for the shared singular plan-assembly tail. Every resolved builder
 * supplies one canonical start request; this finalizer freezes the selected
 * recipe, profile hashes, dispatch request, and common plan envelope in one
 * deterministic projection.
 */
interface FinalizePlanInput {
  req: RuntimeCompileRequest
  resolved: ResolvedHarnessExecution
  startRequest: InvocationStartRequest
  compatibilityHash: string
  preparedWarnings: string[] | undefined
  /**
   * Hygiene findings force-admitted to reusable cache under force-compose. When
   * present, each is appended as a deterministic `materialization_hygiene_error`
   * WARNING diagnostic (Cond 4). Absent on a clean gate pass, so normal-case plans
   * are byte-identical.
   */
  hygieneWarnings?: HygieneGateFinding[] | undefined
  /**
   * When defined, compute + append the disallowed-tools-unsupported diagnostic
   * for `selectedDriver`. When undefined, no diagnostic is added (tmux route with
   * `honorDisallowedTools`).
   */
  disallowedToolsContext: { selectedDriver: string } | undefined
  resolvedBundleSource: PreparedResolvedBundle | undefined
  omitPriming: boolean
  bundleIdentity: string
  placement: CompilePlacement
  materializedBundleRoot?: string | undefined
  systemPromptFile?: string | undefined
  lockHash?: string | undefined
  lockedEnvKeys: string[]
  /**
   * Canonical hash of the preparation execution environment (T-08579). Carried
   * on the compile response, never in plan material, so plan identity is
   * unchanged.
   */
  effectiveEnvironmentHash: string
  /**
   * Pinned wall-clock instant (ISO-8601) from the compile context. When omitted
   * the compiler stamps real time. `createdAt` is NOT part of the plan-hash
   * material, so this affects only the emitted stamp, never plan identity.
   */
  nowIso?: string | undefined
  dispatch?: Omit<InvocationDispatchRequest, 'startRequest'> | undefined
}

/**
 * Fold the shared pre-assembly preamble + {@link assemblePlan} into a single
 * call. Byte-parity-critical: the diagnostics order, the `stableId('compile', …)`
 * key set, and the assemble key order are unchanged from the inlined tails.
 */
function finalizePlan(input: FinalizePlanInput): RuntimeCompileResponse {
  assertExecutionMatchesResolution(input.resolved, input.startRequest)
  const startRequestHash = neutralStartRequestHash(input.startRequest)
  const profileId = stableId('profile', {
    recipeId: input.resolved.recipe.recipeId,
    startRequest: hashNeutralStartRequest(input.startRequest),
  })
  const profileHash = hashValue({
    profileId,
    recipe: toRecipeDto(input.resolved.recipe),
    compatibilityHash: input.compatibilityHash,
    startRequestHash,
  })
  const diagnostics: CompileDiagnostic[] = (input.preparedWarnings ?? []).map((warning) => ({
    level: 'warning',
    code: 'prepare_runtime_warning',
    message: warning,
    plane: 'asp-compiler',
    profileId: profileId as ProfileId,
  }))
  // Force-compose hygiene warnings (Cond 4): deterministic order — sorted by code
  // then path — appended after prepare-runtime warnings. Present only under
  // force-compose, so a clean gate pass leaves the diagnostics array unchanged.
  for (const finding of sortHygieneFindings(input.hygieneWarnings ?? [])) {
    diagnostics.push(hygieneWarningDiagnostic(finding, profileId as ProfileId))
  }
  if (input.disallowedToolsContext !== undefined) {
    const disallowedToolsDiagnostic = disallowedToolsUnsupportedDiagnostic(
      input.req,
      input.disallowedToolsContext.selectedDriver,
      profileId as ProfileId
    )
    if (disallowedToolsDiagnostic !== undefined) diagnostics.push(disallowedToolsDiagnostic)
  }
  const compileId = stableId('compile', {
    generation: input.req.identity.generation,
    profileHash,
  }) as CompileId
  const createdAt = input.nowIso ?? new Date().toISOString()
  const resolvedBundle = toResolvedBundle(input.resolvedBundleSource, input.bundleIdentity)
  const compiledPlacement = toCompiledPlacement(input.placement)
  const dispatchRequest: InvocationDispatchRequest = {
    startRequest: input.startRequest,
    ...((input.dispatch?.dispatchEnv ?? input.placement.dispatchEnv) !== undefined
      ? { dispatchEnv: input.dispatch?.dispatchEnv ?? input.placement.dispatchEnv }
      : {}),
    ...(input.dispatch?.runtime !== undefined ? { runtime: input.dispatch.runtime } : {}),
    ...(input.dispatch?.lifecyclePolicy !== undefined
      ? { lifecyclePolicy: input.dispatch.lifecyclePolicy }
      : {}),
  }
  const execution = {
    ...toRecipeDto(input.resolved.recipe),
    profile: {
      profileId,
      profileHash,
      compatibilityHash: input.compatibilityHash,
      startRequestHash,
    },
    dispatchRequest,
  }
  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v2' as const,
    compiler: { name: 'agent-spaces' as const, version: COMPILER_VERSION },
    compileId,
    createdAt,
    agent: input.req.agent,
    identity: input.req.identity,
    placement: compiledPlacement,
    resolvedBundle,
    omitPriming: input.omitPriming,
    selection: input.resolved.selection,
    execution,
    artifacts: {
      ...(input.materializedBundleRoot !== undefined
        ? { materializedBundleRoot: input.materializedBundleRoot }
        : {}),
      ...(input.systemPromptFile !== undefined ? { systemPromptFile: input.systemPromptFile } : {}),
      ...(input.lockHash !== undefined ? { lockHash: input.lockHash } : {}),
      bundleIdentity: input.bundleIdentity,
    },
    lockedEnv: { lockedEnvKeys: input.lockedEnvKeys },
    diagnostics,
  }
  const planHash = hashValue({
    ...planMaterial,
    createdAt: undefined,
    identity: hashNeutralCompileIdentity(input.req.identity),
    placement: hashNeutralPlacement(compiledPlacement),
  })
  const plan: CompiledRuntimePlan = { ...planMaterial, planHash }
  return {
    schemaVersion: 'agent-runtime-compile-response/v2',
    ok: true,
    plan,
    diagnostics,
    effectiveEnvironmentHash: input.effectiveEnvironmentHash,
  }
}

function toRecipeDto(recipe: ExecutionRecipe): ExecutionRecipeDto {
  return {
    recipeId: recipe.recipeId,
    driver: recipe.driver,
    protocol: recipe.protocol,
    hosting: recipe.hosting,
    ...(recipe.presentationSurface !== undefined
      ? { presentationSurface: recipe.presentationSurface }
      : {}),
    presentationFulfillment:
      recipe.presentationFulfillment as ExecutionRecipeDto['presentationFulfillment'],
  }
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
 * Stable diagnostic code for a compose-time hygiene cache-admission finding —
 * carried on the normal ASPC diagnostics channel by BOTH the blocking (error) and
 * force-compose (warning) paths so callers key on one code (T-05574 Cond 1/4).
 */
const MATERIALIZATION_HYGIENE_ERROR_CODE = 'materialization_hygiene_error'

/** Structured `details` payload for one hygiene finding (stable field set). */
function hygieneFindingDetails(f: HygieneGateFinding): Record<string, unknown> {
  return {
    spaceKey: f.spaceKey,
    pluginPath: f.pluginPath,
    code: f.code,
    severity: f.severity,
    ...(f.path !== undefined ? { path: f.path } : {}),
  }
}

/** Deterministic finding order for diagnostics: by hygiene code, then path. */
function sortHygieneFindings(findings: HygieneGateFinding[]): HygieneGateFinding[] {
  return [...findings].sort(
    (a, b) => a.code.localeCompare(b.code) || (a.path ?? '').localeCompare(b.path ?? '')
  )
}

/**
 * Spread-ready `finalizePlan` input carrying force-compose hygiene warnings, if
 * any. Returns `{}` when the gate passed cleanly so the plan (and its diagnostics
 * array) is byte-identical to the pre-gate output.
 */
function hygieneWarningsInput(prepared: PreparedPlacementCliRuntime): {
  hygieneWarnings?: HygieneGateFinding[]
} {
  const warnings = prepared.materialized.hygieneWarnings
  return warnings !== undefined && warnings.length > 0 ? { hygieneWarnings: warnings } : {}
}

/** One WARNING diagnostic for a force-admitted hygiene finding (Cond 4). */
function hygieneWarningDiagnostic(
  f: HygieneGateFinding,
  profileId: ProfileId | undefined
): CompileDiagnostic {
  return {
    level: 'warning',
    code: MATERIALIZATION_HYGIENE_ERROR_CODE,
    message: f.message,
    plane: 'asp-compiler',
    ...(profileId !== undefined ? { profileId } : {}),
    details: hygieneFindingDetails(f),
  }
}

/**
 * Convert a blocking hygiene gate error into typed ERROR diagnostics (Cond 1). One
 * diagnostic per finding, deterministic order, on the normal ASPC diagnostics
 * channel — NOT degraded to `compiler_exception`.
 */
function hygieneErrorToDiagnostics(err: MaterializationHygieneError): CompileDiagnostic[] {
  return sortHygieneFindings(err.findings).map((f) => ({
    level: 'error' as const,
    code: MATERIALIZATION_HYGIENE_ERROR_CODE,
    message: f.message,
    plane: 'asp-compiler' as const,
    details: hygieneFindingDetails(f),
  }))
}

/**
 * Convert a compose-time hygiene gate block into an `ok: false` compile response
 * BEFORE it reaches the aspc facade's generic `compiler_exception` catch (Cond 1);
 * returns `undefined` for every other error so it propagates unchanged. Exported
 * for direct unit testing — the routing that throws it is exercised e2e.
 */
export function hygieneBlockResponse(error: unknown): RuntimeCompileResponse | undefined {
  if (error instanceof MaterializationHygieneError) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v2',
      ok: false,
      diagnostics: hygieneErrorToDiagnostics(error),
    }
  }
  return undefined
}

function requestedDisallowedTools(req: RuntimeCompileRequest): string[] | undefined {
  const tools = req.hrcPolicy.disallowedTools
  return tools !== undefined && tools.length > 0 ? [...tools] : undefined
}

function disallowedToolsUnsupportedDiagnostic(
  req: RuntimeCompileRequest,
  selectedDriver: string,
  profileId?: ProfileId | undefined
): CompileDiagnostic | undefined {
  const disallowedTools = requestedDisallowedTools(req)
  if (disallowedTools === undefined) return undefined
  return {
    level: 'warning',
    code: 'disallowed_tools_unsupported_driver',
    message: `hrcPolicy.disallowedTools was not applied for ${selectedDriver}; only claude-code-tmux currently supports compiler-enforced tool denial.`,
    plane: 'asp-compiler',
    ...(profileId !== undefined ? { profileId } : {}),
    details: { selectedDriver, disallowedTools, applied: false },
  }
}

/**
 * Validate the headless broker route (openai+meta / codex+muse / codex-cli+muse-cli /
 * headless). The foreground branch has its own route resolver (resolveForegroundRoute).
 */
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

/**
 * Resume fallback for headless broker births. muse serve sessions are
 * disk-backed but server-GC'd, so a stale continuation key must birth fresh
 * instead of killing the turn. Codex threads stay fail-fast.
 */
export function brokerResumeFallback(isMuse: boolean): 'start-fresh' | 'fail' {
  return isMuse ? 'start-fresh' : 'fail'
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
    invocationId: req.correlation.invocationId,
    inputId: req.correlation.inputId,
    traceId: req.correlation.traceId,
    scopeRef: req.correlation.scopeRef,
    laneRef: req.correlation.laneRef,
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function buildCompatibilityMaterial(
  req: RuntimeCompileRequest,
  selection: ResolvedHarnessSelection,
  // Only `.spec` is read, so this accepts both the full start request and the
  // neutralized start-request projection.
  startRequest: { spec: HarnessInvocationSpec },
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
          permissionPolicy: driver.permissionPolicy,
          resumeFallback: driver.resumeFallback,
        }
      : driver
  return {
    bundle: { bundleIdentity, ...(lockHash !== undefined ? { lockHash } : {}) },
    model: {
      provider: selection.modelProvider,
      requestedModel: selection.model,
      reasoningEffort: selection.reasoningEffort,
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
    ...(startRequest.spec.sdk !== undefined ? { sdk: startRequest.spec.sdk } : {}),
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

export type ResolvedRecipeBuilder = (
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  resolved: ResolvedHarnessExecution,
  options?: CompileRuntimePlanOptions
) => Promise<RuntimeCompileResponse>

// Launch-timing instrumentation (diagnostic). The compiler has no logger of its
// own and runs in-process: client-side for `hrc run --dry-run` previews (lands on
// CLI stderr) and server-side inside hrc-server for real runs (lands in
// hrc-server.err.log). A single line per compile is emitted to stderr so the
// compile cost is observable on both paths. Always-on: this is the launch path,
// not a per-token hot loop.
function emitAspCompileTiming(req: RuntimeCompileRequest, startedAtMs: number): void {
  const durMs = (performance.now() - startedAtMs).toFixed(1)
  process.stderr.write(
    `[asp-timing] compileRuntimePlan dur=${durMs}ms harness=${req.requested.harness ?? '(default)'} presentation=${String(req.requested.presentation ?? false)}\n`
  )
}

/**
 * Backstop for `[placement] launch = "participant-only"` (T-09061): such an
 * agent's seat is hosted outside HRC and joins as a direct participant, so no
 * compile may produce a launchable plan for it. HRC refuses before it gets
 * here; this holds even if a SOUL.md is later added to the home. An absent or
 * unparsable profile is left to the normal compile path to report.
 */
function participantOnlyRefusal(agentRoot: string): RuntimeCompileResponse | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  let launch: string | undefined
  try {
    launch = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath).placement?.launch
  } catch {
    return undefined
  }
  if (launch !== 'participant-only') return undefined
  return {
    schemaVersion: 'agent-runtime-compile-response/v2',
    ok: false,
    diagnostics: [
      compileError(
        'agent_participant_only',
        `Agent at ${agentRoot} is participant-only ([placement] launch = "participant-only"): its seat joins HRC as a direct participant and is never launched`,
        { agentRoot, launch }
      ),
    ],
  }
}

export async function compileRuntimePlan(
  req: RuntimeCompileRequest,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const startedAtMs = performance.now()
  try {
    const placement = req.placement as CompilePlacement
    const refusal = participantOnlyRefusal(placement.agentRoot)
    if (refusal !== undefined) return refusal
    const provisioningLayers = resolveCompileProvisioningLayers(req)
    const consistencyAgentIds = [basename(placement.agentRoot)]
    if (placement.bundle.kind === 'agent-project') {
      consistencyAgentIds.push(placement.bundle.agentName)
    }
    const resolved = timeCompilePhaseSync('resolve', () =>
      resolveHarnessExecution({
        agent: req.agent,
        requested: req.requested,
        provisioningLayers,
        consistency: { agentIds: consistencyAgentIds },
      })
    )
    if (!resolved.ok) {
      return {
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [compileError(resolved.code, resolved.message, resolved.details)],
      }
    }
    return await timeCompilePhase('build', () =>
      BUILDER_REGISTRY[resolved.recipe.builder](req, placement, resolved, options)
    )
  } catch (error) {
    // Compose-time hygiene gate block — convert the typed error to `ok: false`
    // with `materialization_hygiene_error` diagnostics HERE, at/below the compiler
    // boundary, before the aspc facade's generic catch can degrade it to
    // `compiler_exception` (T-05574 Cond 1). All other errors propagate unchanged.
    if (error instanceof CompileProvisioningError) {
      return {
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [compileError(error.code, error.message, error.details)],
      }
    }
    const blocked = hygieneBlockResponse(error)
    if (blocked !== undefined) {
      return blocked
    }
    throw error
  } finally {
    emitAspCompileTiming(req, startedAtMs)
  }
}

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
    { ...brokerReq, materializeCodexRuntimeHome: options?.materializeCodexRuntimeHome },
    options?.clientAspHome,
    options?.clientRegistryPath,
    options?.clientRuntime
  )
  const brokerInvocation = toHarnessBrokerStartRequest(prepared, brokerReq)
  const startRequest = brokerInvocation.startRequest
  const spec = brokerInvocation.spec
  const lockedEnv = spec.process.lockedEnv ?? {}
  const lockedEnvKeys = Object.keys(lockedEnv).sort()

  const bundleIdentity = brokerInvocation.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (
    brokerInvocation.resolvedBundle as { lockHash?: string | undefined } | undefined
  )?.lockHash
  const hashStartRequest = hashNeutralStartRequest(startRequest)
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(
      req,
      resolved.selection,
      hashStartRequest,
      bundleIdentity,
      lockHash,
      lockedEnv
    )
  )
  // T-01867 Ph6 cutover: harness-broker/0.1 is decommissioned. The headless codex
  // profile emits the v0.2 durable markers UNCONDITIONALLY — brokerProtocol
  // 'harness-broker/0.2' + control.attachReplay 'optional'. The temporary Ph4b
  // activation env (ASP_HEADLESS_DURABLE_BROKER) is REMOVED entirely: a stale env
  // var has no effect, and there is no v0.1 path to fall back to.

  return finalizePlan({
    req,
    resolved,
    startRequest,
    compatibilityHash,
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
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
    dispatch: options?.dispatch,
  })
}

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
  const { startRequest, spec } = brokerInvocation
  const lockedEnv = spec.process.lockedEnv ?? {}
  const lockedEnvKeys = Object.keys(lockedEnv).sort()
  const bundleIdentity = brokerInvocation.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (brokerInvocation.resolvedBundle as { lockHash?: string } | undefined)?.lockHash
  const hashStartRequest = hashNeutralStartRequest(startRequest)
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(
      req,
      execution.selection,
      hashStartRequest,
      bundleIdentity,
      lockHash,
      lockedEnv
    )
  )
  return finalizePlan({
    req,
    resolved: execution,
    startRequest,
    compatibilityHash,
    preparedWarnings: brokerInvocation.warnings,
    effectiveEnvironmentHash: preparation.effectiveEnvironmentHash,
    disallowedToolsContext: { selectedDriver: driverKind },
    resolvedBundleSource: brokerInvocation.resolvedBundle,
    omitPriming: req.materialization.omitPriming ?? false,
    bundleIdentity,
    placement,
    ...(lockHash !== undefined ? { lockHash } : {}),
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
    dispatch: options?.dispatch,
  })
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
/**
 * Build the harness-kind-agnostic launch payload for tmux broker routes. The
 * priming is delivered to the harness via launch argv (see the prompt-through-
 * argv tests); this payload carries the same material so the tmux launch wrapper
 * can frame-print the header (system prompt + priming) into the pane before the
 * harness boots. Returns undefined when there is nothing to frame.
 */
function buildTmuxLaunchSpec(prepared: PreparedPlacementCliRuntime): HarnessLaunchSpec | undefined {
  const launch: HarnessLaunchSpec = {
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(prepared.systemPrompt?.mode !== undefined
      ? { systemPromptMode: prepared.systemPrompt.mode }
      : {}),
    ...(prepared.expandedPrompt !== undefined ? { initialPrompt: prepared.expandedPrompt } : {}),
  }
  return Object.keys(launch).length > 0 ? launch : undefined
}

/**
 * Compile an interactive claude-code request to an operator-attachable
 * claude-code-tmux compiled execution (Path 2, pre-HRC default).
 *
 * The launch shape (command/args/cwd/lockedEnv/pathPrepend) is sourced from the
 * SAME preparePlacementCliRuntime path the foreground branch uses — so the
 * hashed process launch byte-matches the known-good foreground/legacy claude
 * launch. The process transport is the existing pty HarnessTransportSpec (tmux
 * is the terminal surface/host, NOT a transport). No tmux session is allocated
 * here; surface allocation is deferred to the driver runtime (Phase 3).
 */
/**
 * Per-driver knobs distinguishing the two otherwise-identical interactive tmux
 * broker compilers. claude-code-tmux HONORS disallowedTools (threads it into
 * prepare + the broker policy); codex-cli-tmux does NOT support it and instead
 * surfaces a `disallowed_tools_unsupported` diagnostic. codex additionally
 * carries `hookBridge: 'codex-hooks/v1'` on the spec driver descriptor.
 */
interface TmuxBrokerDriverConfig {
  driverKind: 'claude-code-tmux' | 'muse-cli-tmux'
  provider: 'anthropic' | 'meta'
  frontend: 'claude-code' | 'muse-cli'
  hookBridge?: 'codex-hooks/v1' | 'pi-hrc-events/v1'
  honorDisallowedTools: boolean
}

const CLAUDE_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'claude-code-tmux',
  provider: 'anthropic',
  frontend: 'claude-code',
  honorDisallowedTools: true,
}

const MUSE_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'muse-cli-tmux',
  provider: 'meta',
  frontend: 'muse-cli',
  honorDisallowedTools: false,
}

export const compileClaudeTmuxPlan: ResolvedRecipeBuilder = (req, placement, resolved, options) =>
  compileTmuxBrokerPlan(req, placement, resolved, CLAUDE_TMUX_DRIVER_CONFIG, options)

export const compileMuseTmuxPlan: ResolvedRecipeBuilder = (req, placement, resolved, options) =>
  compileTmuxBrokerPlan(req, placement, resolved, MUSE_TMUX_DRIVER_CONFIG, options)

/**
 * Harness-kind-agnostic interactive tmux broker compiler. The claude-code-tmux
 * and codex-cli-tmux routes are byte-identical except for the per-driver knobs
 * in {@link TmuxBrokerDriverConfig}, so they delegate here. The spec/profile/plan
 * field shapes are preserved verbatim to keep specHash/profileHash/planHash
 * stable for each driver.
 */
export async function compileTmuxBrokerPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  resolved: ResolvedHarnessExecution,
  driverConfig: TmuxBrokerDriverConfig,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const { driverKind, provider, frontend, hookBridge, honorDisallowedTools } = driverConfig

  const attachments = toBrokerAttachments(req.materialization.attachments)
  // claude-code-tmux honors disallowedTools; codex-cli-tmux does not (it emits a
  // diagnostic below instead of threading the field through prepare/policy).
  const disallowedTools = honorDisallowedTools ? requestedDisallowedTools(req) : undefined
  const prepared = await preparePlacementCliRuntime(
    {
      provider,
      frontend,
      interactionMode: 'interactive',
      model: resolved.selection.model,
      ...(resolved.selection.reasoningEffort !== undefined
        ? { modelReasoningEffort: resolved.selection.reasoningEffort }
        : {}),
      ...(req.continuation?.hrc.key !== undefined
        ? {
            continuation: {
              provider,
              key: req.continuation.hrc.key,
            },
          }
        : {}),
      ...(req.materialization.initialPrompt !== undefined
        ? { prompt: req.materialization.initialPrompt }
        : {}),
      ...(req.materialization.omitPriming !== undefined
        ? { omitPriming: req.materialization.omitPriming }
        : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(placement.env !== undefined ? { env: placement.env } : {}),
      ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
      ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
      materializeCodexRuntimeHome: options?.materializeCodexRuntimeHome,
      placement,
    },
    options?.clientAspHome,
    options?.clientRegistryPath,
    options?.clientRuntime
  )

  const limits = toProcessLimits(req.hrcPolicy.resourceLimits)
  const taskId = req.materialization.taskContext?.taskId

  // The muse composer stages a stable CLI home (HOME + XDG_* under the bundle)
  // for `muse exec` spawns. Those keys are ambient-class and forbidden in a
  // hashed lockedEnv — and the muse-cli-tmux driver would ignore them anyway:
  // it mints a per-invocation isolated HOME at birth and stamps it over the
  // launch env itself. Strip them for the muse tmux route only.
  const lockedEnv =
    driverKind === 'muse-cli-tmux'
      ? Object.fromEntries(
          Object.entries(prepared.lockedEnv).filter(
            ([key]) => key !== 'HOME' && key !== 'XDG_CONFIG_HOME' && key !== 'XDG_DATA_HOME'
          )
        )
      : prepared.lockedEnv
  const lockedEnvKeys = Object.keys(lockedEnv).sort()
  const bundleIdentity = prepared.resolvedBundle?.bundleIdentity ?? 'unknown'
  const lockHash = (prepared.resolvedBundle as { lockHash?: string | undefined } | undefined)
    ?.lockHash
  // pty is the PROCESS TRANSPORT; tmux is the broker terminal surface/host. The
  // tmux driver carries terminalHost so the validator can assert the surface
  // contract without duplicating launch mechanics outside the spec.
  const launch = buildTmuxLaunchSpec(prepared)
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.identity.invocationId !== undefined ? { invocationId: req.identity.invocationId } : {}),
    ...(taskId !== undefined ? { labels: { task: taskId } } : {}),
    harness: {
      frontend,
      provider,
      driver: driverKind,
    },
    process: {
      command: prepared.commandPath,
      args: prepared.args,
      cwd: prepared.cwd,
      lockedEnv,
      ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
      harnessTransport: { kind: 'pty' },
      ...(limits !== undefined ? { limits } : {}),
    },
    interaction: {
      mode: 'interactive',
      turnConcurrency: 'single',
      // FIFO enables the broker busy-input policy for this interactive profile.
      // The tmux driver applies busy input as attempted_steer immediately, leaving
      // the TUI to steer, queue internally, or surface a later hook-derived turn.
      inputQueue: 'fifo',
    },
    ...(req.continuation?.hrc.key !== undefined
      ? {
          continuation: {
            provider,
            key: req.continuation.hrc.key,
            kind: 'session',
          },
        }
      : {}),
    driver: {
      kind: driverKind,
      terminalHost: 'tmux',
      ...(hookBridge !== undefined ? { hookBridge } : {}),
      // Operator HOME is REQUIRED for muse model calls: keychain-bound oauth
      // never leaves the operator HOME, so the muse TUI stalls at device-flow
      // login under an isolated HOME even with auth.json symlinked (same
      // posture as the muse-serve driver spec). Other tmux drivers run with
      // the ambient operator HOME already.
      ...(driverKind === 'muse-cli-tmux' ? { homeMode: 'operator' as const } : {}),
    },
    ...(launch !== undefined ? { launch } : {}),
    correlation: brokerCorrelation(req),
  }
  validateInvocationSpec(spec)
  const startRequest: InvocationStartRequest = { spec }
  const hashStartRequest = hashNeutralStartRequest(startRequest)

  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(
      req,
      resolved.selection,
      hashStartRequest,
      bundleIdentity,
      lockHash,
      lockedEnv
    )
  )
  return finalizePlan({
    req,
    resolved,
    startRequest,
    compatibilityHash,
    preparedWarnings: prepared.warnings,
    ...hygieneWarningsInput(prepared),
    effectiveEnvironmentHash: prepared.preparation.effectiveEnvironmentHash,
    disallowedToolsContext: honorDisallowedTools ? undefined : { selectedDriver: driverKind },
    resolvedBundleSource: prepared.resolvedBundle,
    omitPriming: prepared.omitPriming,
    bundleIdentity,
    placement,
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
    dispatch: options?.dispatch,
  })
}
