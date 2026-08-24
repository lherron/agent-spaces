import type { InvocationStatusResponse } from 'spaces-harness-broker-protocol'
import type { CompiledRuntimePlan } from './compiler-plan'
import type { RuntimeControlError } from './errors'
import type { RuntimeExecutionProfile } from './execution-profile'
import type { RunId, RuntimeId } from './ids'
import type { HrcRuntimeSnapshot, RuntimeInputEnvelope, RuntimeOperation } from './operations'
import type { BrokerInvocationRecord } from './persistence'
import type { RuntimeExecutionView } from './public-api'
import type { RuntimeRouteDecision } from './route-decision'
import type { RuntimeState } from './runtime-state'

export interface RuntimeController<TDecision extends RuntimeRouteDecision = RuntimeRouteDecision> {
  readonly kind: TDecision['controller']

  start(input: RuntimeControllerStartInput<TDecision>): Promise<RuntimeStartResult>
  dispatchTurn(input: RuntimeControllerDispatchInput<TDecision>): Promise<RuntimeDispatchResult>

  deliverInput?(input: RuntimeControllerDispatchInput<TDecision>): Promise<RuntimeDispatchResult>
  interrupt?(runtime: HrcRuntimeSnapshot, reason?: string): Promise<RuntimeInterruptResult>
  stop?(runtime: HrcRuntimeSnapshot, reason?: string): Promise<RuntimeStopResult>
  dispose?(runtime: HrcRuntimeSnapshot): Promise<RuntimeDisposeResult>
  inspect(runtime: HrcRuntimeSnapshot): Promise<RuntimeInspection>
  reconcile(runtime: HrcRuntimeSnapshot): Promise<RuntimeReconcileResult>
}

export type RuntimeControllerStartInput<TDecision extends RuntimeRouteDecision> = {
  decision: TDecision
  compiledPlan: CompiledRuntimePlan
  selectedProfile: RuntimeExecutionProfile
  operation: RuntimeOperation
  existingRuntime?: HrcRuntimeSnapshot | undefined
  /**
   * Optional cancellation seam for an in-flight controller operation. When the
   * signal aborts, an implementation should abandon (and clean up) the
   * half-started runtime rather than return it. Additive and back-compatible:
   * implementations that ignore it behave exactly as before.
   */
  signal?: AbortSignal | undefined
}

export type RuntimeControllerDispatchInput<TDecision extends RuntimeRouteDecision> = {
  decision: TDecision
  runtime: HrcRuntimeSnapshot
  operation: RuntimeOperation
  input: RuntimeInputEnvelope
  /**
   * Optional cancellation seam for an in-flight dispatch. Additive and
   * back-compatible: implementations that ignore it behave exactly as before.
   */
  signal?: AbortSignal | undefined
}

export interface HarnessBrokerController extends RuntimeController<RuntimeRouteDecision> {
  readonly kind: 'harness-broker'
}

export type RuntimeStartResult =
  | {
      ok: true
      runtime: HrcRuntimeSnapshot
      operation: RuntimeOperation
      view: RuntimeExecutionView
    }
  | { ok: false; operation: RuntimeOperation; error: RuntimeControlError }

export type RuntimeDispatchResult =
  | {
      ok: true
      runId: RunId
      runtime: HrcRuntimeSnapshot
      operation: RuntimeOperation
      disposition: 'started' | 'queued' | 'accepted'
    }
  | {
      ok: false
      operation: RuntimeOperation
      error: RuntimeControlError
      disposition?: 'busy' | 'rejected' | 'unsupported' | undefined
    }

export type RuntimeInterruptResult =
  | { ok: true; effect: 'turn_interrupted' | 'invocation_stopping' | 'no_active_turn' }
  | { ok: false; error: RuntimeControlError }

export type RuntimeStopResult =
  | { ok: true; runtime: HrcRuntimeSnapshot; state: HrcRuntimeSnapshot['status'] }
  | { ok: false; error: RuntimeControlError }

export type RuntimeDisposeResult =
  | { ok: true; runtimeId: RuntimeId; disposed: true }
  | { ok: false; error: RuntimeControlError }

export type RuntimeInspection = {
  runtime: HrcRuntimeSnapshot
  state: RuntimeState
  activeOperation?: RuntimeOperation | undefined
  activeInvocation?: BrokerInvocationRecord | undefined
}

export type RuntimeReconcileResult =
  | { state: 'healthy'; status?: InvocationStatusResponse | undefined }
  | { state: 'broker_process_gone'; action: 'mark_runtime_unknown_or_failed' }
  | { state: 'invocation_gone'; action: 'finalize_active_run_degraded' }
  | { state: 'terminal_without_turn_event'; action: 'synthesize_degraded_completion' }
  | { state: 'reattached'; lastObservedSeq?: number | undefined }
