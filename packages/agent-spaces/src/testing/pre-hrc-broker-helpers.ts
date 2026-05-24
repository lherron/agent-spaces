/**
 * Reusable, named helpers shared by the pre-HRC broker contract harness, its
 * CLI, and the later broker-start streams (P4/P7). These were extracted from
 * P1's inline harness/CLI logic (pre-HRC plan §5.2–5.6).
 *
 * - allocatePreHrcRuntimeIdentity — deterministic RuntimeIdentityAllocation seed.
 * - buildPlacementFromScopeRef    — scope-ref → RuntimePlacement.
 * - selectBrokerProfile           — gating selection of the harness-broker profile.
 * - verifyBrokerStartContract      — compiler-closure verifier run immediately
 *                                    before broker start (P3 / PR4).
 *
 * No HRC imports, no Codex driver internals. PreHrcRouteDecision stays a local
 * mirror (see pre-hrc-broker-contract-types.ts).
 */
import { resolve } from 'node:path'

import { resolveScopeInput } from 'agent-scope'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
  RuntimePlacement,
} from 'spaces-runtime-contracts'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

import type { ContractHarnessFailure } from './pre-hrc-broker-contract-types.js'

// ---------------------------------------------------------------------------
// Structured failure (thrown by the selection helper)
// ---------------------------------------------------------------------------

/**
 * Carries a structured {@link ContractHarnessFailure} as a throwable Error so
 * callers can either catch-and-collect (the harness) or fail-fast (P4/P7).
 */
export class ContractHarnessFailureError extends Error {
  readonly failure: ContractHarnessFailure

  constructor(failure: ContractHarnessFailure) {
    super(`${failure.code}: ${failure.message}`)
    this.name = 'ContractHarnessFailureError'
    this.failure = failure
  }
}

// ---------------------------------------------------------------------------
// Identity allocation
// ---------------------------------------------------------------------------

export type PreHrcRuntimeIdentitySeed = {
  /** Namespace folded into the deterministic runtime ids (default `prehrc_contract`). */
  namespace?: string | undefined
  invocationId?: string | undefined
  initialInputId?: string | undefined
  generation?: number | undefined
  runId?: string | undefined
  traceId?: string | undefined
  idempotencyKey?: string | undefined
  /** When false, no initialInputId is emitted (no initial input). Defaults to true. */
  withInitialInput?: boolean | undefined
}

/**
 * Allocate a {@link RuntimeIdentityAllocation} for the pre-HRC harness. IDs are
 * deterministic for a given seed (stable across runs) so tests and golden
 * artifacts stay reproducible. The seed's namespace is folded into the request /
 * operation / host-session / runtime / run / trace ids.
 */
export function allocatePreHrcRuntimeIdentity(
  seed: PreHrcRuntimeIdentitySeed = {}
): RuntimeIdentityAllocation {
  const namespace = seed.namespace ?? 'prehrc_contract'
  const withInitialInput = seed.withInitialInput ?? true
  const invocationId = seed.invocationId ?? `inv_${namespace}`
  const identity: RuntimeIdentityAllocation = {
    requestId: `request_${namespace}` as RuntimeIdentityAllocation['requestId'],
    operationId: `runtimeOperation_${namespace}` as RuntimeIdentityAllocation['operationId'],
    hostSessionId: `hostSession_${namespace}` as RuntimeIdentityAllocation['hostSessionId'],
    generation: seed.generation ?? 1,
    runtimeId: `runtime_${namespace}` as RuntimeIdentityAllocation['runtimeId'],
    invocationId: invocationId as RuntimeIdentityAllocation['invocationId'],
    runId: (seed.runId ?? `run_${namespace}`) as RuntimeIdentityAllocation['runId'],
    traceId: (seed.traceId ?? `trace_${namespace}`) as RuntimeIdentityAllocation['traceId'],
    idempotencyKey: seed.idempotencyKey ?? 'pre-hrc-broker-contract',
  }
  if (withInitialInput) {
    identity.initialInputId = (seed.initialInputId ??
      `input_${namespace}`) as RuntimeIdentityAllocation['initialInputId']
  }
  return identity
}

// ---------------------------------------------------------------------------
// Placement construction
// ---------------------------------------------------------------------------

export type BuildPlacementFromScopeRefInput = {
  scopeRef: string
  projectRoot: string
  hostSessionId: string
  /** Explicit agent root; defaults to `<projectRoot>/../var/agents/<agentName>`. */
  agentRoot?: string | undefined
  cwd?: string | undefined
  env?: Record<string, string | undefined> | undefined
  laneRef?: string | undefined
  runMode?: string | undefined
  /** Override the derived agent name (otherwise parsed from the scope ref). */
  agentName?: string | undefined
}

/**
 * Build a {@link RuntimePlacement} from a scope handle (e.g. `cody@agent-spaces`
 * or `agent:cody:project:agent-spaces`). The raw scope ref is preserved on the
 * correlation session ref; the agent name is parsed from the handle and used for
 * both the default agent root and the agent-project bundle.
 */
export function buildPlacementFromScopeRef(
  input: BuildPlacementFromScopeRefInput
): RuntimePlacement {
  const agentName = input.agentName ?? resolveScopeInput(input.scopeRef).parsed.agentId
  const agentRoot =
    input.agentRoot ?? resolve(input.projectRoot, '..', 'var', 'agents', agentName)
  return {
    agentRoot,
    projectRoot: input.projectRoot,
    cwd: input.cwd ?? input.projectRoot,
    runMode: input.runMode ?? 'task',
    bundle: { kind: 'agent-project', agentName, projectRoot: input.projectRoot },
    env: input.env ?? process.env,
    correlation: {
      sessionRef: { scopeRef: input.scopeRef, laneRef: input.laneRef ?? 'main' },
      hostSessionId: input.hostSessionId,
    },
  }
}

// ---------------------------------------------------------------------------
// Broker profile selection
// ---------------------------------------------------------------------------

export type BrokerProfileSelector = {
  profileId?: string | undefined
  profileHash?: string | undefined
}

function brokerProfileIncompatibility(
  profile: BrokerExecutionProfile,
  identity: CompiledRuntimePlan['identity']
): ContractHarnessFailure | undefined {
  if (profile.kind !== 'harness-broker') {
    return {
      code: 'broker_profile_invalid',
      message: 'Selected profile is not a harness-broker profile.',
      path: 'selectedProfile.kind',
      redactedDetails: { kind: profile.kind },
    }
  }
  if (profile.interactionMode !== 'headless') {
    return {
      code: 'broker_profile_invalid',
      message: 'Selected broker profile is not headless.',
      path: 'selectedProfile.interactionMode',
      redactedDetails: { interactionMode: profile.interactionMode },
    }
  }
  if (profile.brokerProtocol !== 'harness-broker/0.1') {
    return {
      code: 'broker_protocol_invalid',
      message: 'Selected broker profile does not target harness-broker/0.1.',
      path: 'selectedProfile.brokerProtocol',
      redactedDetails: { brokerProtocol: profile.brokerProtocol },
    }
  }
  if (profile.brokerDriver !== 'codex-app-server') {
    return {
      code: 'broker_driver_missing',
      message: 'Selected broker profile does not use the codex-app-server driver.',
      path: 'selectedProfile.brokerDriver',
      redactedDetails: { brokerDriver: profile.brokerDriver },
    }
  }
  const startRequest = profile.harnessInvocation?.startRequest
  if (startRequest === undefined) {
    return {
      code: 'start_request_missing',
      message: 'Selected broker profile has no invocation start request.',
      path: 'selectedProfile.harnessInvocation.startRequest',
    }
  }
  if (
    identity.invocationId !== undefined &&
    startRequest.spec.invocationId !== undefined &&
    startRequest.spec.invocationId !== identity.invocationId
  ) {
    return {
      code: 'start_request_identity_mismatch',
      message: 'Broker start request invocationId does not match the compiled runtime identity.',
      path: 'selectedProfile.harnessInvocation.startRequest.spec.invocationId',
      redactedDetails: {
        identityInvocationId: identity.invocationId,
        startRequestInvocationId: startRequest.spec.invocationId,
      },
    }
  }
  if (
    startRequest.initialInput !== undefined &&
    identity.initialInputId !== undefined &&
    startRequest.initialInput.inputId !== undefined &&
    startRequest.initialInput.inputId !== identity.initialInputId
  ) {
    return {
      code: 'initial_input_identity_mismatch',
      message: 'Broker initial input inputId does not match the compiled runtime identity.',
      path: 'selectedProfile.harnessInvocation.startRequest.initialInput.inputId',
      redactedDetails: {
        identityInitialInputId: identity.initialInputId,
        startRequestInitialInputId: startRequest.initialInput.inputId,
      },
    }
  }
  return undefined
}

/**
 * Select the single compatible harness-broker profile from a compiled plan.
 *
 * Requires kind `harness-broker`, interactionMode `headless`, brokerProtocol
 * `harness-broker/0.1`, brokerDriver `codex-app-server`, a start request whose
 * `spec.invocationId` matches the plan identity, and (when an initial input is
 * present) a matching `initialInput.inputId`. Selection can be narrowed by
 * `profileId` / `profileHash`. Throws a {@link ContractHarnessFailureError} when
 * no compatible profile is found.
 */
export function selectBrokerProfile(
  plan: CompiledRuntimePlan,
  selector?: BrokerProfileSelector
): BrokerExecutionProfile {
  const brokerProfiles = (plan.executionProfiles ?? []).filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  if (brokerProfiles.length === 0) {
    throw new ContractHarnessFailureError({
      code: 'broker_profile_missing',
      message: 'Compiled plan did not contain a harness-broker execution profile.',
      path: 'plan.executionProfiles',
    })
  }

  let candidates = brokerProfiles
  if (selector?.profileId !== undefined) {
    candidates = candidates.filter((profile) => profile.profileId === selector.profileId)
  }
  if (selector?.profileHash !== undefined) {
    candidates = candidates.filter((profile) => profile.profileHash === selector.profileHash)
  }
  if (candidates.length === 0) {
    throw new ContractHarnessFailureError({
      code: 'broker_profile_missing',
      message: 'No harness-broker profile matched the requested selector.',
      path: 'plan.executionProfiles',
      redactedDetails: { selector },
    })
  }

  const reasons: ContractHarnessFailure[] = []
  let primary: ContractHarnessFailure | undefined
  for (const profile of candidates) {
    const incompatibility = brokerProfileIncompatibility(profile, plan.identity)
    if (incompatibility === undefined) return profile
    const reason: ContractHarnessFailure = {
      ...incompatibility,
      redactedDetails: {
        ...(incompatibility.redactedDetails as object | undefined),
        profileId: profile.profileId,
      },
    }
    reasons.push(reason)
    primary ??= incompatibility
  }

  throw new ContractHarnessFailureError({
    code: primary?.code ?? 'broker_profile_invalid',
    message: primary?.message ?? 'No compatible harness-broker profile was found.',
    path: primary?.path,
    redactedDetails: { incompatibleProfiles: reasons },
  })
}

// ---------------------------------------------------------------------------
// Compiler-closure verification (P3 / PR4)
// ---------------------------------------------------------------------------

/**
 * Recompute a canonical hash using the same policy the compiler applies
 * (`timestampMode: 'omit-ephemeral'`), so recomputed hashes are byte-comparable
 * to the values stored on the profile at compile time.
 */
function canonicalHash(value: unknown): string {
  return createCanonicalHasher().hash(value, { timestampMode: 'omit-ephemeral' }).value
}

/** Recursively freeze an object graph in place. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

export type BrokerStartContractVerification = {
  ok: boolean
  /** The frozen start request, safe to hand to broker start once `ok` is true. */
  startRequest?: InvocationStartRequest | undefined
  recomputed?: { specHash: string; startRequestHash: string } | undefined
  failures: ContractHarnessFailure[]
}

/**
 * Compiler-closure gate run immediately before broker start.
 *
 * Recomputes `specHash` and `startRequestHash` from the selected profile's
 * start request and asserts they equal the hashes the compiler embedded. Any
 * local mutation of `spec.driver`, `spec.process.{command,args,cwd,env}`,
 * `spec.process.harnessTransport`, `spec.continuation`, or `initialInput` after
 * compile drifts one or both hashes and FAILS the run. On success, the start
 * request is deep-frozen so nothing can mutate it between verification and the
 * actual broker start.
 */
export function verifyBrokerStartContract(
  profile: BrokerExecutionProfile
): BrokerStartContractVerification {
  const failures: ContractHarnessFailure[] = []
  const invocation = profile.harnessInvocation
  if (invocation?.startRequest === undefined) {
    failures.push({
      code: 'broker_start_contract_unverifiable',
      message: 'Selected broker profile has no start request to verify before broker start.',
      path: 'selectedProfile.harnessInvocation.startRequest',
    })
    return { ok: false, failures }
  }

  const startRequest = invocation.startRequest
  const recomputedSpecHash = canonicalHash(startRequest.spec)
  const recomputedStartRequestHash = canonicalHash(startRequest)

  if (recomputedSpecHash !== invocation.specHash) {
    failures.push({
      code: 'spec_hash_mismatch',
      message:
        'Broker spec hash changed after compile; local code mutated spec.driver / spec.process before broker start.',
      path: 'selectedProfile.harnessInvocation.specHash',
      redactedDetails: { expected: invocation.specHash, actual: recomputedSpecHash },
    })
  }
  if (recomputedStartRequestHash !== invocation.startRequestHash) {
    failures.push({
      code: 'start_request_hash_mismatch',
      message:
        'Broker start request hash changed after compile; local code mutated the start request (process/env/continuation/initialInput) before broker start.',
      path: 'selectedProfile.harnessInvocation.startRequestHash',
      redactedDetails: {
        expected: invocation.startRequestHash,
        actual: recomputedStartRequestHash,
      },
    })
  }

  // Lock the start request so nothing can mutate it between this gate and the
  // actual broker start.
  deepFreeze(startRequest)

  return {
    ok: failures.length === 0,
    startRequest,
    recomputed: { specHash: recomputedSpecHash, startRequestHash: recomputedStartRequestHash },
    failures,
  }
}
