/**
 * Shared plan-assembly tail for every recipe builder: freezes the selected
 * recipe, profile/compatibility/plan hashes, dispatch request and the common
 * plan envelope in one deterministic projection.
 */
import type { HygieneGateFinding } from 'spaces-config'
import type {
  HarnessInvocationSpec,
  InvocationDispatchRequest,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import {
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
  disallowedToolsUnsupportedDiagnostic,
  hygieneWarningDiagnostic,
  sortHygieneFindings,
} from './compile-diagnostics.js'
import type { CompilePlacement } from './compile-plan-types.js'
import { assertExecutionMatchesResolution } from './harness-selection/assert-execution-matches-resolution.js'
import type { ExecutionRecipe, ResolvedHarnessExecution } from './harness-selection/types.js'
import type { PreparedPlacementCliRuntime } from './prepare-cli-runtime.js'
import type { BuildHarnessBrokerInvocationResponse } from './types.js'

const COMPILER_VERSION = '0.1.1'

type PreparedResolvedBundle = NonNullable<BuildHarnessBrokerInvocationResponse['resolvedBundle']>

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

/** Bundle identity (or `'unknown'`) and optional lock hash of a resolved bundle. */
export function bundleIdentityAndLockHash(bundle: { bundleIdentity: string } | undefined): {
  bundleIdentity: string
  lockHash: string | undefined
} {
  return {
    bundleIdentity: bundle?.bundleIdentity ?? 'unknown',
    lockHash: (bundle as { lockHash?: string | undefined } | undefined)?.lockHash,
  }
}

/**
 * Spread-ready `finalizePlan` input carrying force-compose hygiene warnings, if
 * any. Returns `{}` when the gate passed cleanly so the plan (and its diagnostics
 * array) is byte-identical to the pre-gate output.
 */
export function hygieneWarningsInput(prepared: PreparedPlacementCliRuntime): {
  hygieneWarnings?: HygieneGateFinding[]
} {
  const warnings = prepared.materialized.hygieneWarnings
  return warnings !== undefined && warnings.length > 0 ? { hygieneWarnings: warnings } : {}
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

/**
 * Inputs for the shared singular plan-assembly tail. Every resolved builder
 * supplies one canonical start request plus the hashed lockedEnv it launches
 * with; this finalizer derives the compatibility hash and lockedEnv key list.
 */
export interface FinalizePlanInput {
  req: RuntimeCompileRequest
  resolved: ResolvedHarnessExecution
  startRequest: InvocationStartRequest
  /** The hashed launch env; its values feed the compatibility hash, its keys the plan. */
  lockedEnv: Record<string, string>
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
 * Fold the shared pre-assembly preamble + plan assembly into a single call.
 * Byte-parity-critical: the diagnostics order, the `stableId('compile', …)` key
 * set, and the assemble key order are unchanged from the inlined tails.
 */
export function finalizePlan(input: FinalizePlanInput): RuntimeCompileResponse {
  assertExecutionMatchesResolution(input.resolved, input.startRequest)
  const compatibilityHash = hashValue(
    buildCompatibilityMaterial(
      input.req,
      input.resolved.selection,
      hashNeutralStartRequest(input.startRequest),
      input.bundleIdentity,
      input.lockHash,
      input.lockedEnv
    )
  )
  const lockedEnvKeys = Object.keys(input.lockedEnv).sort()
  const startRequestHash = neutralStartRequestHash(input.startRequest)
  const profileId = stableId('profile', {
    recipeId: input.resolved.recipe.recipeId,
    startRequest: hashNeutralStartRequest(input.startRequest),
  })
  const profileHash = hashValue({
    profileId,
    recipe: toRecipeDto(input.resolved.recipe),
    compatibilityHash,
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
      compatibilityHash,
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
    lockedEnv: { lockedEnvKeys },
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
