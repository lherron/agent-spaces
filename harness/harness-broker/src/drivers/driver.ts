import type {
  ClientCapabilities,
  EventProvenance,
  EvidenceAuthorityMatrix,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationId,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationRuntimeContext,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { CaptureGate } from '../capture/capture-gate'
import type { DispatchEnv } from '../runtime/env'

export interface ApplyInputResult {
  turnId?: TurnId | undefined
  deliveryDisposition?: 'executed' | 'rejected' | undefined
  rejectionReason?: string | undefined
}

/**
 * Declares what makes an applyInputNow-returned turn id sufficient evidence to
 * open a broker turn bracket. The declaration is descriptive: drivers may only
 * change modes together with the corresponding verified delivery semantics.
 */
export type BracketMintingMode = 'delivery-acknowledged' | 'harness-evidence' | 'delivery-asserted'
export type PreemptMode = 'quiescence' | 'atomic'
export type SteerLandingEvidence = 'transcript' | 'ack' | 'asserted'

export interface Driver {
  readonly kind: string
  readonly version: string
  readonly bracketMintingMode: BracketMintingMode
  /**
   * Declared per-event-family evidence authority (T-07853 §6, law
   * `agent-spaces.harness-broker-local-commit-observation`). Authority is
   * declared per FAMILY, never once per provider: `native` = the provider's own
   * transcript / notification stream owns the family, `hook` = a synchronous
   * harness hook owns it, `broker` = it is a broker decision no provider can
   * report.
   *
   * The declaration is DESCRIPTIVE — it states where this driver's facts come
   * from TODAY. Changing an entry is an authority cutover and must ship with
   * the code change that actually moves the evidence, plus a parity report.
   * `harness/harness-broker/AUTHORITY.md` is the published prose form of the
   * same matrix and must agree with it.
   */
  readonly evidenceAuthority: EvidenceAuthorityMatrix
  /**
   * Which raw source kind this driver's `native` authority means: a provider
   * transcript file (`provider-jsonl`) or a provider protocol stream
   * (`provider-jsonrpc`). Used to stamp truthful provenance on events emitted
   * without a committed raw record. Irrelevant — but still declared — for a
   * driver whose every family is `hook` or `broker`.
   */
  readonly nativeSourceKind: 'provider-jsonl' | 'provider-jsonrpc'
  readonly preemptMode: PreemptMode | null
  readonly steerLandingEvidence: SteerLandingEvidence | null
  capabilities(): InvocationCapabilities
  start(spec: HarnessInvocationSpec, ctx: DriverContext): Promise<DriverStartResult>
  applyInputNow(input: InvocationInput): Promise<ApplyInputResult>
  applySteerNow?(input: InvocationInput): Promise<void>
  probeAdmissionState?(): {
    harnessLocalQueueDepth: number
  }
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  dispose(): Promise<void>
}

export interface DriverContext {
  invocationId: InvocationId
  clientCapabilities: ClientCapabilities
  /**
   * Per-invocation env from the `InvocationDispatchRequest` envelope (HRC-supplied,
   * not part of the hashed spec). The driver threads this into the spawn-env
   * composition (`spawnHarnessProcess`). Absent when no dispatchEnv was supplied.
   */
  dispatchEnv?: DispatchEnv | undefined
  /**
   * Dispatch-time runtime overlay (spec §3.3) supplied by the HRC runtime
   * control plane — or the pre-HRC harness stand-in — AFTER profile selection.
   * Carries pre-allocated runtime resource handles: for terminal-host drivers
   * (Phase C/D) this is the `terminalSurface` pane lease the driver attaches
   * to. NOT part of the hashed spec. Absent when the route needs no runtime
   * handles. The legacy `tmux.socketPath` shape is still on the protocol
   * envelope for backward compatibility, but Phase C+ driver code reads ONLY
   * `terminalSurface`.
   */
  runtime?: InvocationRuntimeContext | undefined
  /**
   * This invocation's normalization cursor (T-07853 §§6.1, 7). A driver commits
   * every provider input through `capture.ingest` BEFORE normalizing it, and
   * returns a disposition for each. Absent only for in-process callers with no
   * capture pipeline; when absent the driver normalizes directly, as before.
   */
  capture?: CaptureGate | undefined
  emit<K extends InvocationEventType>(
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: {
      turnId?: TurnId | undefined
      inputId?: InputId | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
      harnessGeneration?: number | undefined
      turnAttempt?: number | undefined
      provenance?: EventProvenance | undefined
    }
  ): InvocationEventEnvelope<K>
  emitEvent(
    event: InvocationEvent,
    extra?: {
      turnId?: TurnId | undefined
      inputId?: InputId | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
      harnessGeneration?: number | undefined
      turnAttempt?: number | undefined
      provenance?: EventProvenance | undefined
    }
  ): InvocationEventEnvelope
  /**
   * Notify the broker that a driver-private admission projection changed
   * without producing a normalized event (for example, a Claude queue
   * dequeue). The broker re-evaluates held admission work on the next
   * microtask; the driver's synchronous transcript processing still wins any
   * race that opens a turn in the same batch.
   */
  admissionStateChanged?(): void
  /**
   * Ask the connected client to decide a permission request via the
   * broker→client JSON-RPC request transport. Provided only when the broker
   * has a transport that supports outbound requests (and, in production, when
   * the client negotiated `permissionRequests`). Absent for in-process callers
   * that have no client to ask.
   */
  requestPermission?(params: PermissionRequestParams): Promise<PermissionDecision>
  /**
   * True when the broker owns the permission-request lifecycle (C2): pending
   * state is broker-held until an absolute deadline, survives controller
   * disconnect, and the broker emits `permission.resolved` and applies the
   * timeout default. In this mode the driver emits `permission.requested`, then
   * awaits {@link requestPermission} for the FINAL decision WITHOUT imposing its
   * own timeout or emitting `permission.resolved`. When false/absent (e.g. the
   * isolated driver unit harness) the driver owns the timeout and emits the
   * resolution itself.
   */
  brokerOwnsPermissionLifecycle?: boolean | undefined
}

export interface DriverStartResult {
  ok: true
}
