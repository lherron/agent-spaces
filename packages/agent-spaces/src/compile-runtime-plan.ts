import type { HygieneGateFinding, RuntimePlacement } from 'spaces-config'
import { MaterializationHygieneError } from 'spaces-config'
import type {
  HarnessInvocationSpec,
  HarnessLaunchSpec,
  InvocationId,
  InvocationStartRequest,
  PermissionPolicy,
  ProcessLimits,
} from 'spaces-harness-broker-protocol'
import { validateInvocationSpec } from 'spaces-harness-broker-protocol'
import type { AttachmentRef } from 'spaces-runtime'
import {
  type AgentchatExposurePolicy,
  type BrokerExecutionProfile,
  type BrokerInputPolicy,
  type BrokerObservabilityContract,
  type BrokerPermissionPolicy,
  type BrokerTerminalSurface,
  type CapabilityRequirements,
  type CompileContext,
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
import type {
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
  HarnessFrontend,
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
type CompilePlacement = RuntimeCompileRequest['placement'] &
  RuntimePlacement & {
    env?: Record<string, string> | undefined
    lockedEnv?: Record<string, string> | undefined
    dispatchEnv?: Record<string, string> | undefined
  }

const COMPILER_VERSION = '0.1.1'

type PreparedResolvedBundle = NonNullable<BuildHarnessBrokerInvocationResponse['resolvedBundle']>

type CompileRuntimePlanOptions = {
  clientAspHome?: string | undefined
  clientRegistryPath?: string | undefined
  /**
   * Pinned, serializable compile context (T-04133). When present, `nowIso`
   * sources `createdAt` and `idSalt`/`toolchainManifest` feed deterministic id
   * derivation. Production callers omit it (real time, unsalted derivation).
   */
  compileContext?: CompileContext | undefined
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

function hashNeutralInvocationSpec(spec: HarnessInvocationSpec): HarnessInvocationSpec {
  const {
    invocationId: _invocationId,
    correlation: _correlation,
    ...hashSpec
  } = spec as HarnessInvocationSpec & { correlation?: unknown }
  return hashSpec
}

/**
 * Hash material for a start request. `spec.invocationId` / `correlation` stay
 * neutralized (per-dispatch identity). Of `initialInput` the deterministic
 * `inputId` is retained (T-04133): its derivation now folds generation + content,
 * so a changed generation moves the start-request hash while a pure correlation
 * change does not. Content is deliberately NOT hashed here — post-compile content
 * drift is caught by `initialInputHash`, keeping the two contract gates distinct.
 * The per-turn `responseFormat` (T-03779) IS retained: it is a caller-supplied
 * turn-identity field that need not move the deterministic `inputId` (callers may
 * pin `initialInputId`), so the start-request gate must observe it directly.
 */
type StartRequestHashMaterial = Omit<InvocationStartRequest, 'initialInput'> & {
  initialInput?: {
    inputId: NonNullable<InvocationStartRequest['initialInput']>['inputId']
    responseFormat?: NonNullable<InvocationStartRequest['initialInput']>['responseFormat']
  }
}

function hashNeutralStartRequest(startRequest: InvocationStartRequest): StartRequestHashMaterial {
  const { initialInput, ...rest } = startRequest
  return {
    ...rest,
    spec: hashNeutralInvocationSpec(startRequest.spec),
    ...(initialInput !== undefined
      ? {
          initialInput: {
            inputId: initialInput.inputId,
            ...(initialInput.responseFormat !== undefined
              ? { responseFormat: initialInput.responseFormat }
              : {}),
          },
        }
      : {}),
  }
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
 * Inputs for the shared plan-assembly tail. The four plan builders
 * (broker / foreground / embedded-sdk / tmux-broker) all assemble an identical
 * `planMaterial` envelope — differing ONLY in the per-route `harness` and `model`
 * objects and in their `executionProfiles` payload. Everything else (schema,
 * compiler stamp, identity, placement, resolvedBundle, artifacts, lockedEnv,
 * diagnostics) is byte-for-byte the same. Centralizing the envelope guarantees a
 * single source for the projection-hashed key order.
 */
interface AssemblePlanInput {
  req: RuntimeCompileRequest
  compileId: CompileId
  createdAt: string
  compiledPlacement: CompiledRuntimePlan['placement']
  resolvedBundle: CompiledRuntimePlan['resolvedBundle']
  harness: CompiledRuntimePlan['harness']
  model: CompiledRuntimePlan['model']
  executionProfiles: CompiledRuntimePlan['executionProfiles']
  materializedBundleRoot: string
  systemPromptFile?: string | undefined
  lockHash?: string | undefined
  bundleIdentity: string
  lockedEnvKeys: string[]
  diagnostics: CompileDiagnostic[]
}

/**
 * Assemble the shared `planMaterial` envelope, compute its plan-projection hash,
 * and wrap it in the `ok` compile response. The object-literal key order here is
 * authoritative for the byte-parity tests — it reproduces the previously inlined
 * tail exactly (schemaVersion, compiler, compileId, createdAt, identity,
 * placement, resolvedBundle, harness, model, executionProfiles, artifacts,
 * lockedEnv, diagnostics), so each caller's projectionHash is unchanged.
 */
function assemblePlan(input: AssemblePlanInput): RuntimeCompileResponse {
  const {
    req,
    compileId,
    createdAt,
    compiledPlacement,
    resolvedBundle,
    harness,
    model,
    executionProfiles,
    materializedBundleRoot,
    systemPromptFile,
    lockHash,
    bundleIdentity,
    lockedEnvKeys,
    diagnostics,
  } = input
  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: COMPILER_VERSION },
    compileId,
    createdAt,
    identity: req.identity,
    placement: compiledPlacement,
    resolvedBundle,
    harness,
    model,
    executionProfiles,
    artifacts: {
      materializedBundleRoot,
      ...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
      ...(lockHash !== undefined ? { lockHash } : {}),
      bundleIdentity,
    },
    lockedEnv: {
      lockedEnvKeys,
    },
    diagnostics,
  }
  const planHash = projectionHash(
    {
      schemaVersion: planMaterial.schemaVersion,
      compiler: planMaterial.compiler,
      identity: hashNeutralCompileIdentity(req.identity),
      placement: hashNeutralPlacement(compiledPlacement),
      harness: planMaterial.harness,
      model: planMaterial.model,
      executionProfiles: planMaterial.executionProfiles.map((profile) => ({
        kind: profile.kind,
        profileHash: profile.profileHash,
        compatibilityHash: profile.compatibilityHash,
      })),
      lockedEnv: planMaterial.lockedEnv,
      diagnostics: planMaterial.diagnostics,
    },
    'plan'
  ).planHash
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
 * Inputs for {@link finalizePlan} — the shared pre-assembly preamble that the
 * four plan builders (broker / foreground / embedded-sdk / tmux-broker) each
 * re-copied: build the `prepare_runtime_warning` diagnostics, append the
 * disallowed-tools diagnostic, stamp `compileId` + `createdAt`, coerce the
 * resolved bundle + placement, then call {@link assemblePlan}.
 *
 * The route-specific bits are parameterized: the warnings source, the
 * disallowed-tools context (the tmux route gates it on `honorDisallowedTools` by
 * passing `undefined`), the resolved-bundle source, and the per-route harness /
 * model / executionProfiles. The diagnostics array ORDER (warnings then the
 * optional disallowed-tools diagnostic) and the {@link assemblePlan} key order
 * are hash-authoritative — both are reproduced verbatim.
 */
interface FinalizePlanInput {
  req: RuntimeCompileRequest
  profileHash: string
  profileId?: ProfileId | undefined
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
  bundleIdentity: string
  placement: CompilePlacement
  harness: CompiledRuntimePlan['harness']
  model: CompiledRuntimePlan['model']
  executionProfiles: CompiledRuntimePlan['executionProfiles']
  materializedBundleRoot: string
  systemPromptFile?: string | undefined
  lockHash?: string | undefined
  lockedEnvKeys: string[]
  /**
   * Pinned wall-clock instant (ISO-8601) from the compile context. When omitted
   * the compiler stamps real time. `createdAt` is NOT part of the plan-hash
   * material, so this affects only the emitted stamp, never plan identity.
   */
  nowIso?: string | undefined
}

/**
 * Fold the shared pre-assembly preamble + {@link assemblePlan} into a single
 * call. Byte-parity-critical: the diagnostics order, the `stableId('compile', …)`
 * key set, and the assemble key order are unchanged from the inlined tails.
 */
function finalizePlan(input: FinalizePlanInput): RuntimeCompileResponse {
  const diagnostics: CompileDiagnostic[] = (input.preparedWarnings ?? []).map((warning) => ({
    level: 'warning',
    code: 'prepare_runtime_warning',
    message: warning,
    plane: 'asp-compiler',
    profileId: input.profileId,
  }))
  // Force-compose hygiene warnings (Cond 4): deterministic order — sorted by code
  // then path — appended after prepare-runtime warnings. Present only under
  // force-compose, so a clean gate pass leaves the diagnostics array unchanged.
  for (const finding of sortHygieneFindings(input.hygieneWarnings ?? [])) {
    diagnostics.push(hygieneWarningDiagnostic(finding, input.profileId))
  }
  if (input.disallowedToolsContext !== undefined) {
    const disallowedToolsDiagnostic = disallowedToolsUnsupportedDiagnostic(
      input.req,
      input.disallowedToolsContext.selectedDriver,
      input.profileId
    )
    if (disallowedToolsDiagnostic !== undefined) diagnostics.push(disallowedToolsDiagnostic)
  }
  const compileId = stableId('compile', {
    generation: input.req.identity.generation,
    profileHash: input.profileHash,
  }) as CompileId
  const createdAt = input.nowIso ?? new Date().toISOString()
  const resolvedBundle = toResolvedBundle(input.resolvedBundleSource, input.bundleIdentity)
  const compiledPlacement = toCompiledPlacement(input.placement)
  return assemblePlan({
    req: input.req,
    compileId,
    createdAt,
    compiledPlacement,
    resolvedBundle,
    harness: input.harness,
    model: input.model,
    executionProfiles: input.executionProfiles,
    materializedBundleRoot: input.materializedBundleRoot,
    ...(input.systemPromptFile !== undefined ? { systemPromptFile: input.systemPromptFile } : {}),
    ...(input.lockHash !== undefined ? { lockHash: input.lockHash } : {}),
    bundleIdentity: input.bundleIdentity,
    lockedEnvKeys: input.lockedEnvKeys,
    diagnostics,
  })
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
      schemaVersion: 'agent-runtime-compile-response/v1',
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
 * Resolve the requested harness family from the explicit `harnessFamily` field,
 * falling back to the family implied by `preferredHarnessRuntime`. Centralizes
 * the family-resolution logic that was duplicated across the foreground route
 * resolver and the interactive-broker route predicates.
 */
function resolveRequestedFamily(req: RuntimeCompileRequest): HarnessFamily | undefined {
  const requestedRuntime = req.requested.preferredHarnessRuntime
  return (
    req.requested.harnessFamily ??
    (requestedRuntime !== undefined ? RUNTIME_TO_FAMILY[requestedRuntime] : undefined)
  )
}

/**
 * Resolve a foreground (interactive) route from the requested harness fields.
 * Emits diagnostics for genuinely unsupported pairings (sdk runtimes, provider
 * mismatch, inconsistent family/runtime) so the compiler returns errors rather
 * than throwing deep in the prepare path.
 */
function resolveForegroundRoute(
  req: RuntimeCompileRequest
):
  | { route: ForegroundRoute; diagnostics: CompileDiagnostic[] }
  | { diagnostics: CompileDiagnostic[] } {
  const diagnostics: CompileDiagnostic[] = []
  const requestedRuntime = req.requested.preferredHarnessRuntime
  const family = resolveRequestedFamily(req)

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
    lifecycle: lifecycleCapabilityBaseline('unmanaged'),
  }
}

function lifecycleCapabilityBaseline(
  route: 'broker' | 'embedded-sdk' | 'unmanaged'
): CapabilityRequirements['lifecycle'] {
  if (route === 'broker') {
    return {
      runtimeRetention: ['keep-alive'],
      harnessRecovery: ['none'],
      turnRetry: ['none'],
      generationFencing: 'optional',
      permissionCancellation: 'optional',
    }
  }
  return {
    runtimeRetention: route === 'unmanaged' ? ['unmanaged'] : [],
    harnessRecovery: ['none'],
    turnRetry: ['none'],
    generationFencing: 'forbidden',
    permissionCancellation: 'forbidden',
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

function expectedCapabilities(
  policy: BrokerPermissionPolicy,
  options?: {
    inputQueue?: CapabilityRequirements['input']['queue'] | undefined
    /**
     * Durable-attach/replay capability shape (T-01878 Ph4b). Defaults to
     * 'forbidden' (the v0.1-style legacy sentinel). The headless v0.2 path passes
     * 'optional' so HRC's route-specific overlay can require attach+replay.
     */
    attachReplay?: CapabilityRequirements['control']['attachReplay'] | undefined
  }
): CapabilityRequirements {
  return {
    input: {
      user: 'required',
      steer: 'optional',
      appendContext: 'optional',
      localImages: 'optional',
      fileRefs: 'forbidden',
      queue: options?.inputQueue ?? 'forbidden',
    },
    turns: {
      concurrency: 'single',
      interrupt: 'optional',
    },
    continuation: 'optional',
    permissions: policy.mode === 'ask-client' ? 'broker-request' : 'none',
    events: {
      assistantDeltas: 'optional',
      toolCalls: 'required',
      usage: 'optional',
      diagnostics: 'optional',
    },
    control: {
      stop: 'optional',
      dispose: 'optional',
      reconcile: 'optional',
      attachReplay: options?.attachReplay ?? 'forbidden',
    },
    lifecycle: lifecycleCapabilityBaseline('broker'),
  }
}

function buildCompatibilityMaterial(
  req: RuntimeCompileRequest,
  // Only `.spec` is read, so this accepts both the full start request and the
  // neutralized {@link StartRequestHashMaterial} projection.
  startRequest: { spec: BrokerExecutionProfile['harnessInvocation']['startRequest']['spec'] },
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

/** Compiles an interactive request into a runtime plan. */
type InteractiveCompileBuilder = (
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  options?: CompileRuntimePlanOptions
) => Promise<RuntimeCompileResponse>

/**
 * Families that route interactive requests to an operator-attachable
 * harness-broker (tmux) rather than the foreground TerminalExecutionProfile.
 * Mirrors the extensible `FOREGROUND_ROUTES` table: adding a tmux-broker family
 * is a one-line entry rather than a new boolean predicate + dispatch branch.
 */
const INTERACTIVE_BROKER_BUILDERS: Partial<Record<HarnessFamily, InteractiveCompileBuilder>> = {
  'claude-code': (req, placement, options) =>
    compileTmuxBrokerPlan(req, placement, CLAUDE_TMUX_DRIVER_CONFIG, options),
  codex: (req, placement, options) =>
    compileTmuxBrokerPlan(req, placement, CODEX_TMUX_DRIVER_CONFIG, options),
  pi: (req, placement, options) =>
    compileTmuxBrokerPlan(req, placement, PI_TMUX_DRIVER_CONFIG, options),
}

/**
 * Resolve the interactive controller route by EXPLICIT compiler intent, never by
 * descriptive catalog array order (cody 0B mandate).
 *
 * The pre-HRC default for interactive claude-code/codex is the operator-attachable
 * harness-broker (claude-code-tmux / codex-cli-tmux). The foreground
 * TerminalExecutionProfile is selectable ONLY when the request carries
 * controllerIntent 'foreground-terminal'; other families fall through to the
 * foreground terminal as their interactive default. Returns the matching broker
 * builder, or `undefined` to fall through to the foreground plan.
 */
function resolveInteractiveBrokerBuilder(
  req: RuntimeCompileRequest
): InteractiveCompileBuilder | undefined {
  if (req.requested.controllerIntent === 'foreground-terminal') return undefined
  const family = resolveRequestedFamily(req)
  if (family === undefined) return undefined
  return INTERACTIVE_BROKER_BUILDERS[family]
}

// Launch-timing instrumentation (diagnostic). The compiler has no logger of its
// own and runs in-process: client-side for `hrc run --dry-run` previews (lands on
// CLI stderr) and server-side inside hrc-server for real runs (lands in
// hrc-server.err.log). A single line per compile is emitted to stderr so the
// compile cost is observable on both paths. Always-on: this is the launch path,
// not a per-token hot loop.
function emitAspCompileTiming(req: RuntimeCompileRequest, startedAtMs: number): void {
  const durMs = (performance.now() - startedAtMs).toFixed(1)
  const mode = req.requested.interactionMode
  const runtime = req.requested.preferredHarnessRuntime ?? '(unspecified)'
  process.stderr.write(
    `[asp-timing] compileRuntimePlan dur=${durMs}ms mode=${mode} runtime=${runtime}\n`
  )
}

export async function compileRuntimePlan(
  req: RuntimeCompileRequest,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const startedAtMs = performance.now()
  try {
    const placement = req.placement as CompilePlacement
    if (req.requested.interactionMode === 'interactive') {
      const brokerBuilder = resolveInteractiveBrokerBuilder(req)
      if (brokerBuilder) {
        return await brokerBuilder(req, placement, options)
      }
      return await compileForegroundPlan(req, placement, options)
    }
    // nonInteractive + pi-sdk routes to the IN-PROCESS embedded-sdk controller.
    // claude-agent-sdk stays UNEMITTED (impl deferred per Lance) — it falls through
    // to the broker route, which rejects it. Any other nonInteractive/headless
    // request stays on the codex headless broker path.
    if (req.requested.preferredHarnessRuntime === 'pi-sdk') {
      return await compileEmbeddedSdkPlan(req, placement, options)
    }
    return await compileBrokerPlan(req, placement, options)
  } catch (error) {
    // Compose-time hygiene gate block — convert the typed error to `ok: false`
    // with `materialization_hygiene_error` diagnostics HERE, at/below the compiler
    // boundary, before the aspc facade's generic catch can degrade it to
    // `compiler_exception` (T-05574 Cond 1). All other errors propagate unchanged.
    const blocked = hygieneBlockResponse(error)
    if (blocked !== undefined) {
      return blocked
    }
    throw error
  } finally {
    emitAspCompileTiming(req, startedAtMs)
  }
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
    modelReasoningEffort: req.requested.reasoningEffort,
    continuation:
      req.continuation?.hrc.key !== undefined
        ? { provider: 'openai', key: req.continuation.hrc.key }
        : undefined,
    prompt: req.materialization.initialPrompt,
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
    resumeFallback: 'fail',
  }

  validateBrokerInvocationRequest(brokerReq)
  const prepared = await preparePlacementCliRuntime(
    brokerReq,
    options?.clientAspHome,
    options?.clientRegistryPath
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
  const hashSpec = hashStartRequest.spec
  const profileId = stableId('profile', {
    kind: 'harness-broker',
    brokerDriver: 'codex-app-server',
    startRequest: hashStartRequest,
  }) as ProfileId
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(req, hashStartRequest, bundleIdentity, lockHash, lockedEnv)
  )
  const specProjection = projectionHash(hashSpec, 'spec')
  const specHash = specProjection.specHash
  const startRequestProjection = projectionHash(hashStartRequest, 'start-request')
  const startRequestHash = startRequestProjection.startRequestHash
  const initialInputHash =
    startRequest.initialInput !== undefined ? hashValue(startRequest.initialInput) : undefined

  // T-01867 Ph6 cutover: harness-broker/0.1 is decommissioned. The headless codex
  // profile emits the v0.2 durable markers UNCONDITIONALLY — brokerProtocol
  // 'harness-broker/0.2' + control.attachReplay 'optional'. The temporary Ph4b
  // activation env (ASP_HEADLESS_DURABLE_BROKER) is REMOVED entirely: a stale env
  // var has no effect, and there is no v0.1 path to fall back to.

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId,
    kind: 'harness-broker' as const,
    interactionMode: 'headless' as const,
    expectedCapabilities: expectedCapabilities(permissionPolicy, {
      inputQueue: 'required',
      attachReplay: 'optional' as const,
    }),
    brokerProtocol: 'harness-broker/0.2' as const,
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
    {
      ...profileMaterial,
      harnessInvocation: {
        startRequest: hashStartRequest,
        specHash: profileMaterial.harnessInvocation.specHash,
        startRequestHash: profileMaterial.harnessInvocation.startRequestHash,
      },
      observability: {
        correlation: hashNeutralCompileIdentity(req.identity),
      },
      compatibilityHash,
    },
    'profile'
  ).profileHash

  const profile: BrokerExecutionProfile = {
    ...profileMaterial,
    profileHash,
    compatibilityHash,
  }

  return finalizePlan({
    req,
    profileHash,
    profileId,
    preparedWarnings: brokerInvocation.warnings,
    ...hygieneWarningsInput(prepared),
    disallowedToolsContext: { selectedDriver: 'codex-app-server' },
    resolvedBundleSource: brokerInvocation.resolvedBundle,
    bundleIdentity,
    placement,
    harness: {
      family: 'codex',
      runtime: 'codex-cli',
      provider: 'openai',
    },
    model: {
      provider: 'openai',
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
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
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
      ...(req.requested.reasoningEffort !== undefined
        ? { modelReasoningEffort: req.requested.reasoningEffort }
        : {}),
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
    options?.clientAspHome,
    options?.clientRegistryPath
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

  return finalizePlan({
    req,
    profileHash,
    profileId,
    preparedWarnings: prepared.warnings,
    ...hygieneWarningsInput(prepared),
    disallowedToolsContext: { selectedDriver: `${route.frontend}:foreground-terminal` },
    resolvedBundleSource: prepared.resolvedBundle,
    bundleIdentity,
    placement,
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
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
  })
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
    lifecycle: lifecycleCapabilityBaseline('embedded-sdk'),
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
      options?.clientAspHome,
      options?.clientRegistryPath
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (req.requested.model !== undefined && /Model not supported/.test(message)) {
      return await preparePlacementCliRuntime(
        baseReq,
        options?.clientAspHome,
        options?.clientRegistryPath
      )
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

  return finalizePlan({
    req,
    profileHash,
    profileId,
    preparedWarnings: prepared.warnings,
    ...hygieneWarningsInput(prepared),
    disallowedToolsContext: { selectedDriver: 'pi-sdk' },
    resolvedBundleSource: prepared.resolvedBundle,
    bundleIdentity,
    placement,
    harness: {
      family: 'pi',
      runtime: 'pi-sdk',
      provider: 'openai',
    },
    model: {
      provider: 'openai',
      modelId,
      ...(req.requested.model !== undefined ? { requestedModel: req.requested.model } : {}),
      ...(req.requested.reasoningEffort !== undefined
        ? { reasoningEffort: req.requested.reasoningEffort }
        : {}),
    },
    executionProfiles: [profile],
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
  })
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
 * The fixed broker-owned tmux surface descriptor shared by the interactive
 * tmux broker routes (claude-code-tmux and codex-cli-tmux). This is
 * selection/exposure metadata ONLY — the socket/session/pane are
 * RUNTIME-REPORTED by the driver (Phase 3), never synthesized at compile time,
 * so a dry compile creates no tmux session and emits no synthetic ids.
 */
const TMUX_BROKER_TERMINAL: BrokerTerminalSurface = {
  host: 'tmux',
  startupMethod: 'create-terminal',
  turnDelivery: 'terminal-literal-input',
  operatorAttach: true,
  exposurePolicy: TMUX_BROKER_EXPOSURE_POLICY,
}

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
 * claude-code-tmux BrokerExecutionProfile (Path 2, pre-HRC default).
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
  driverKind: 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux'
  hookBridge?: 'codex-hooks/v1' | 'pi-hrc-events/v1'
  honorDisallowedTools: boolean
}

const CLAUDE_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'claude-code-tmux',
  honorDisallowedTools: true,
}

const CODEX_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'codex-cli-tmux',
  hookBridge: 'codex-hooks/v1',
  honorDisallowedTools: false,
}

const PI_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'pi-tui-tmux',
  hookBridge: 'pi-hrc-events/v1',
  honorDisallowedTools: false,
}

/**
 * Harness-kind-agnostic interactive tmux broker compiler. The claude-code-tmux
 * and codex-cli-tmux routes are byte-identical except for the per-driver knobs
 * in {@link TmuxBrokerDriverConfig}, so they delegate here. The spec/profile/plan
 * field shapes are preserved verbatim to keep specHash/profileHash/planHash
 * stable for each driver.
 */
async function compileTmuxBrokerPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  driverConfig: TmuxBrokerDriverConfig,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const { driverKind, hookBridge, honorDisallowedTools } = driverConfig
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
  // claude-code-tmux honors disallowedTools; codex-cli-tmux does not (it emits a
  // diagnostic below instead of threading the field through prepare/policy).
  const disallowedTools = honorDisallowedTools ? requestedDisallowedTools(req) : undefined
  const prepared = await preparePlacementCliRuntime(
    {
      provider: route.provider,
      frontend: route.frontend,
      interactionMode: 'interactive',
      ...(req.requested.model !== undefined ? { model: req.requested.model } : {}),
      ...(req.requested.reasoningEffort !== undefined
        ? { modelReasoningEffort: req.requested.reasoningEffort }
        : {}),
      ...(req.continuation?.hrc.key !== undefined
        ? { continuation: { provider: route.provider, key: req.continuation.hrc.key } }
        : {}),
      ...(req.materialization.initialPrompt !== undefined
        ? { prompt: req.materialization.initialPrompt }
        : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(placement.env !== undefined ? { env: placement.env } : {}),
      ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
      ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
      placement,
    },
    options?.clientAspHome,
    options?.clientRegistryPath
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
  // pty is the PROCESS TRANSPORT; tmux is the broker terminal surface/host. The
  // tmux driver carries terminalHost so the validator can assert the surface
  // contract without duplicating launch mechanics outside the spec.
  const launch = buildTmuxLaunchSpec(prepared)
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.identity.invocationId !== undefined ? { invocationId: req.identity.invocationId } : {}),
    ...(taskId !== undefined ? { labels: { task: taskId } } : {}),
    harness: {
      frontend: route.frontend,
      provider: route.provider,
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
            provider: route.provider,
            key: req.continuation.hrc.key,
            kind: 'session',
          },
        }
      : {}),
    driver: {
      kind: driverKind,
      terminalHost: 'tmux',
      ...(hookBridge !== undefined ? { hookBridge } : {}),
    },
    ...(launch !== undefined ? { launch } : {}),
    correlation: brokerCorrelation(req),
  }
  validateInvocationSpec(spec)
  const startRequest: InvocationStartRequest = { spec }
  const hashStartRequest = hashNeutralStartRequest(startRequest)
  const hashSpec = hashStartRequest.spec

  const profileId = stableId('profile', {
    kind: 'harness-broker',
    brokerDriver: driverKind,
    startRequest: hashStartRequest,
  }) as ProfileId
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(req, hashStartRequest, bundleIdentity, lockHash, lockedEnv)
  )
  const specHash = projectionHash(hashSpec, 'spec').specHash
  const startRequestHash = projectionHash(hashStartRequest, 'start-request').startRequestHash

  // T-01817: interactive v0.2 tmux broker profiles must not contradict a durable
  // Unix broker hello that advertises attachReplay:true. Emit attachReplay
  // 'optional' (not the pre-durable 'forbidden' default) for all three tmux
  // drivers. This relaxes the contradiction without asserting restart durability;
  // HRC still requires attachReplay:true from broker hello for durable Unix routes.
  const brokerProtocol = 'harness-broker/0.2' as const
  const attachReplay = 'optional' as const

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId,
    kind: 'harness-broker' as const,
    interactionMode: 'interactive' as const,
    expectedCapabilities: expectedCapabilities(permissionPolicy, {
      inputQueue: 'required',
      attachReplay,
    }),
    brokerProtocol,
    brokerDriver: driverKind,
    brokerOwnership: 'hrc-owned-process' as const,
    brokerTerminal: TMUX_BROKER_TERMINAL,
    harnessInvocation: {
      startRequest,
      specHash,
      startRequestHash,
    },
    policy: {
      permissionPolicy,
      inputPolicy,
      exposurePolicy: TMUX_BROKER_EXPOSURE_POLICY,
      ...(req.hrcPolicy.resourceLimits !== undefined
        ? { resourceLimits: req.hrcPolicy.resourceLimits }
        : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
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
    {
      ...profileMaterial,
      harnessInvocation: {
        startRequest: hashStartRequest,
        specHash: profileMaterial.harnessInvocation.specHash,
        startRequestHash: profileMaterial.harnessInvocation.startRequestHash,
      },
      observability: {
        correlation: hashNeutralCompileIdentity(req.identity),
      },
      compatibilityHash,
    },
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

  return finalizePlan({
    req,
    profileHash,
    profileId,
    preparedWarnings: prepared.warnings,
    ...hygieneWarningsInput(prepared),
    disallowedToolsContext: honorDisallowedTools ? undefined : { selectedDriver: driverKind },
    resolvedBundleSource: prepared.resolvedBundle,
    bundleIdentity,
    placement,
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
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    lockedEnvKeys,
    nowIso: options?.compileContext?.nowIso,
  })
}
