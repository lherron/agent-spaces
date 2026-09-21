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
  CompiledExecution,
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
  RuntimePlacement,
} from 'spaces-runtime-contracts'
import { neutralSpecHash, neutralStartRequestHash } from 'spaces-runtime-contracts'

import type { ContractHarnessFailure } from './pre-hrc-broker-contract-types.js'

export {
  createControlledParticipantAdapter,
  type ControlledParticipantAdapterDriver,
  type ControlledParticipantContinuityEvidence,
  type ControlledParticipantAdapterOptions,
  type ControlledParticipantWriterEvidence,
} from './controlled-participant-adapter.js'

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
  lockedEnv?: Record<string, string | undefined> | undefined
  dispatchEnv?: Record<string, string | undefined> | undefined
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
  const agentRoot = input.agentRoot ?? resolve(input.projectRoot, '..', 'var', 'agents', agentName)
  return {
    agentRoot,
    projectRoot: input.projectRoot,
    cwd: input.cwd ?? input.projectRoot,
    runMode: input.runMode ?? 'task',
    bundle: { kind: 'agent-project', agentName, projectRoot: input.projectRoot },
    ...(input.lockedEnv !== undefined ? { lockedEnv: { ...input.lockedEnv } } : {}),
    ...(input.dispatchEnv !== undefined ? { dispatchEnv: input.dispatchEnv } : {}),
    correlation: {
      sessionRef: { scopeRef: input.scopeRef, laneRef: input.laneRef ?? 'main' },
      hostSessionId: input.hostSessionId,
    },
  }
}

// ---------------------------------------------------------------------------
// Broker profile selection
// ---------------------------------------------------------------------------

function brokerProfileIncompatibility(
  execution: CompiledExecution,
  identity: CompiledRuntimePlan['identity']
): ContractHarnessFailure | undefined {
  if (execution.hosting.terminalRequired) {
    return {
      code: 'broker_profile_invalid',
      message: 'Selected compiled execution is not headless.',
      path: 'plan.execution.hosting.terminalRequired',
    }
  }
  if (execution.protocol !== 'harness-broker/0.2') {
    return {
      code: 'broker_protocol_invalid',
      message: 'Selected execution does not target harness-broker/0.2.',
      path: 'plan.execution.protocol',
      redactedDetails: { protocol: execution.protocol },
    }
  }
  if (execution.driver !== 'codex-app-server') {
    return {
      code: 'broker_driver_missing',
      message: 'Selected execution does not use the codex-app-server driver.',
      path: 'plan.execution.driver',
      redactedDetails: { driver: execution.driver },
    }
  }
  const startRequest = execution.dispatchRequest.startRequest
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
 * Return the singular compiled broker execution after checking the matrix row.
 *
 * There is no profile selector: the compiler has already resolved exactly one
 * execution. The helper only verifies that it is the expected headless Codex
 * broker row and that its request identity is coherent.
 */
export function selectBrokerProfile(plan: CompiledRuntimePlan): CompiledExecution {
  const incompatibility = brokerProfileIncompatibility(plan.execution, plan.identity)
  if (incompatibility === undefined) return plan.execution
  throw new ContractHarnessFailureError(incompatibility)
}

// ---------------------------------------------------------------------------
// Compiler-closure verification (P3 / PR4)
// ---------------------------------------------------------------------------

/**
 * Recompute a canonical hash using the same policy the compiler applies
 * (`timestampMode: 'omit-ephemeral'`), so recomputed hashes are byte-comparable
 * to the values stored on the profile at compile time.
 */
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
  execution: CompiledExecution
): BrokerStartContractVerification {
  const failures: ContractHarnessFailure[] = []
  const startRequest = execution.dispatchRequest.startRequest
  const recomputedSpecHash = neutralSpecHash(startRequest.spec)
  const recomputedStartRequestHash = neutralStartRequestHash(startRequest)
  if (recomputedStartRequestHash !== execution.profile.startRequestHash) {
    failures.push({
      code: 'start_request_hash_mismatch',
      message:
        'Broker start request hash changed after compile; local code mutated the start request (process/env/continuation/initialInput) before broker start.',
      path: 'plan.execution.profile.startRequestHash',
      redactedDetails: {
        expected: execution.profile.startRequestHash,
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
