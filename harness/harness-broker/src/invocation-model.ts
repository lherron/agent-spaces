import type {
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  BrokerTerminalSurfaceReport,
  CaptureStateView,
  ClientCapabilities,
  ContinuationUpdate,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationId,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInspectionSummary,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationRuntimeContext,
  InvocationStartResponse,
  InvocationState,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestId,
  PermissionRequestParams,
  QueueCancelRequest,
  QueueCancelResponse,
  QueueJumpRequest,
  QueueJumpResponse,
  QueueListResponse,
  SeatProbeResponse,
  SubmissionClass,
  SubmissionEnqueueRequest,
  SubmissionInvokeRequest,
  SubmissionOrigin,
  SubmissionPreemptRequest,
  SubmissionResponse,
  SubmissionSteerRequest,
  SubmissionWithdrawRequest,
  SubmissionWithdrawResponse,
  ToolCallId,
  TurnId,
  TurnManifestResponse,
  TurnPolicy,
} from 'spaces-harness-broker-protocol'
import type { CaptureGate } from './capture/capture-gate'
import type { DeliveryEvidence, Driver } from './drivers/driver'
import type { InvocationEventExtra } from './events'
import type { InvocationEventSequencer } from './events'
import type { DispatchEnv } from './runtime/env'

export type PermissionDecidedBy = 'policy' | 'user' | 'api' | 'timeout'

/** Broker-side record of an open `tool.call.started` awaiting its terminal. */
export interface StartedToolCall {
  toolCallId: ToolCallId
  name: string
  turnId?: TurnId | undefined
}

// ---------------------------------------------------------------------------
// Queue types
// ---------------------------------------------------------------------------
export interface QueuedInput {
  inputId: InputId
  input: InvocationInputWithId
}

export type SubmissionRequest =
  | SubmissionSteerRequest
  | SubmissionEnqueueRequest
  | SubmissionInvokeRequest
  | SubmissionPreemptRequest

export interface SubmissionRecord {
  submissionId: string
  class: SubmissionClass
  origin: SubmissionOrigin
  input: InvocationInputWithId
  turnPolicy: TurnPolicy
  /** Typed write evidence from the driver's most recent failed delivery. */
  deliveryEvidence?: DeliveryEvidence | undefined
  terminal: boolean
}

export interface BrokerHeldSubmission {
  record: SubmissionRecord
  class: 'queue' | 'preempt'
  ttlMs?: number | undefined
  expiresAt?: number | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
}

export interface RetryableNotWrittenCarrier {
  readonly retryableNotWritten: true
  readonly deliveryEvidence: 'not_written'
  readonly receipt?: unknown
}

export type InvocationInputWithId = InvocationInput & { inputId: InputId }

/** Per-invocation in-memory record of a resolved input disposition. */
export interface InputDispositionRecord {
  /** Stable fingerprint of the request content + policy, keyed by inputId. */
  fingerprint: string
  response: InvocationInputResponse
}

/**
 * Broker-owned pending permission request (C2). The pending state is held in
 * the broker (NOT the JSON-RPC request promise), survives controller
 * disconnect, and is retained until `deadlineAt`. `settle` resolves it exactly
 * once — by client response, reconnect respond, or deadline expiry.
 */
export interface PendingPermissionRecord {
  params: PermissionRequestParams
  defaultDecision: 'allow' | 'deny'
  /** Absolute ISO-8601 deadline surfaced to reconnecting controllers. */
  deadlineAt: string
  settle(decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void
}

/** In-memory record of how a permission request settled (idempotency surface). */
export interface SettledPermissionRecord {
  decision: 'allow' | 'deny'
  /** True when settled by deadline expiry — a later respond is then "expired". */
  expired: boolean
}

export interface Invocation {
  readonly invocationId: InvocationId
  readonly spec: HarnessInvocationSpec
  state: InvocationState
  capabilities: InvocationCapabilities
  driver: Driver
  continuation?: ContinuationUpdate | undefined
  terminalEmitted: boolean
  /** True once invocation.disposed has been emitted — keeps it idempotent. */
  disposedEmitted: boolean
  /** Manager-owned public status projection, driven by applyEventState. */
  currentTurnId?: TurnId | undefined
  currentInputId?: InputId | undefined
  /** Observed provider turn whose first committed item has not attributed ownership yet. */
  unattributedTurnId?: TurnId | undefined
  childPid?: number | undefined
  exitCode?: number | null | undefined
  signal?: string | null | undefined
  // --- Inspection read-model projection (T-01851) ---
  /** Time of the first projected event (invocation creation activity). */
  startedAt?: string | undefined
  /** Time of the most recent projected event. */
  lastActivityAt?: string | undefined
  /** Seq of the most recent projected event. */
  currentSeq?: number | undefined
  /** Count of turns that reached turn.completed over the invocation's life. */
  turnsCompleted?: number | undefined
  /** True once the graceful-exit invocation.summary has been pushed (idempotent). */
  summaryEmitted?: boolean | undefined
  /** Active turn start time, projected from turn.started event.time. */
  currentTurnStartedAt?: string | undefined
  /** Active turn attempt, projected from turn.started/turn.retry. */
  currentTurnAttempt?: number | undefined
  /** Current harness generation, projected from harness.started/recovery. */
  currentHarnessGeneration?: number | undefined
  /**
   * Full accepted lifecycle overlay retained at start so the lifecycle view can
   * report idleTtlMs/idleSince/computedRetireAt without reverse-engineering the
   * accepted-policy event (which only carries the modes).
   */
  lifecycleOverlay?: BrokerLifecyclePolicyOverlay | undefined
  /** Terminal reason, projected from terminal events. */
  terminalReason?: string | undefined
  /** Terminal surface facts, projected from terminal.surface.reported. */
  terminalSurface?: BrokerTerminalSurfaceReport | undefined
  /** True once a driver-owned harness.started has been observed. */
  harnessStartedSeen?: boolean | undefined
  /** Per-invocation FIFO queue of pending inputs. */
  pending: QueuedInput[]
  brokerQueue: BrokerHeldSubmission[]
  submissions: Map<string, SubmissionRecord>
  submissionDispositions: Map<string, InvocationEventEnvelope>
  turnManifests: Map<TurnId, TurnManifestResponse>
  currentTurnPolicy: TurnPolicy
  /** True once the current turn's provider request has observable assistant/tool evidence. */
  currentTurnRequestInFlight: boolean
  /** Quiescence interrupt waiting for the targeted turn's marker or terminal. */
  preemptInterruptTurnId?: TurnId | undefined
  submissionCounter: number
  /** Own-turn delivery awaiting the driver's declared turn-start evidence. */
  pendingOwnTurnSubmissionId?: InputId | undefined
  /** Foreign turn that started while an own-turn delivery awaited evidence. */
  pendingOwnTurnContestedByTurnId?: TurnId | undefined
  /**
   * Observed-source turn that started while an own-turn delivery awaited
   * evidence. `observePendingOwnTurnStart` is skipped for an observed start, so
   * such a turn can neither correlate the delivery nor record a contest — its
   * terminal is the only boundary that can release the reservation (T-08514).
   */
  pendingOwnTurnUncorrelatableTurnId?: TurnId | undefined
  /** Prevent repeated diagnostics if the stale-pending invariant is breached. */
  stalePendingProbeReported?: boolean | undefined
  admissionDrainPromise?: Promise<void> | undefined
  /** Self-clearing drain lock: set while a drain is in flight, cleared in .finally(). */
  drainPromise?: Promise<void> | undefined
  /** Short write lock for terminal-immediate busy inputs. This is not a turn queue. */
  steerPromise?: Promise<void> | undefined
  /** Monotonic counter for broker-assigned inputIds. */
  inputCounter: number
  /**
   * In-memory idempotency ledger for client-provided inputIds. A duplicate
   * inputId with byte-identical content/policy replays the original response;
   * a duplicate inputId with differing content/policy is a conflict. Surfaced
   * in the durability snapshot. Broker-survives-HRC-restart only (not on disk).
   */
  inputDispositions: Map<string, InputDispositionRecord>
  /**
   * Exactly-once `turn.started` bracket ledger (T-04846), keyed by turnId.
   * The broker GUARANTEES one `turn.started` per delivered input — it
   * synthesizes the bracket from `applyInputNow`'s returned turnId rather than
   * depending on a driver hook (e.g. Claude `UserPromptSubmit`) that may not
   * fire for an idle dispatch. Both the synthesized (`source:'broker-delivery'`)
   * path and any driver/hook-observed `turn.started` flow through `emit`, which
   * dedupes on this map so a turn is never double-opened. The stored envelope is
   * the first (winning) start, returned to callers on a suppressed duplicate.
   */
  startedTurns: Map<TurnId, InvocationEventEnvelope<'turn.started'>>
  /**
   * Exactly-one turn-terminal bracket ledger, keyed by turnId. Provider error
   * and recovery seams may both report a terminal for the same turn; the first
   * terminal wins and every later completed/failed/interrupted variant is
   * suppressed before it can re-project ready state or trigger another queue
   * drain. This extends the broker-central bracket mechanism from T-06550
   * instead of adding a queue-specific dedupe path.
   */
  terminalTurns: Map<TurnId, InvocationEventEnvelope>
  /**
   * Exactly-one-terminal bracket ledger for tool calls (T-06550), keyed by
   * toolCallId. Every `tool.call.started` that flows through `emit` is recorded
   * here and cleared by its `tool.call.completed`/`tool.call.failed` terminal.
   * When a turn closes (or the invocation tears down) with calls still open —
   * the provider started a tool and never closed it, the burn-in-19
   * vanished-call defect (84 started vs 83 completed) — the broker synthesizes a
   * provenance-tagged `tool.call.failed` for each so no `tool.call.started` is
   * ever left unterminated. Broker-central: covers all five drivers + teardown
   * in one seam, exactly as `startedTurns` does for `turn.started` (T-04846).
   */
  startedToolCalls: Map<ToolCallId, StartedToolCall>
  /**
   * Broker-owned pending permission requests, keyed by permissionRequestId.
   * Retained across controller disconnect until each request's absolute
   * deadline, and surfaced in the durability snapshot (C2). In-memory only.
   */
  pendingPermissions: Map<PermissionRequestId, PendingPermissionRecord>
  /**
   * How already-settled permission requests resolved, keyed by
   * permissionRequestId. Backs idempotent/conflict/expired `permission.respond`.
   */
  settledPermissions: Map<PermissionRequestId, SettledPermissionRecord>
  /**
   * This invocation's normalization cursor (T-07853 §§6.1, 7). Owns the raw
   * ingress journal and the durable per-record disposition. It never stops:
   * a blocked-unknown warns loudly and the cursor advances (T-07883). Handed to
   * the driver as `DriverContext.capture`.
   */
  capture: CaptureGate
}

export interface InvocationManagerOptions {
  sequencer: InvocationEventSequencer
  onEvent: (event: InvocationEventEnvelope) => void
  getClientCapabilities?: (() => ClientCapabilities) | undefined
  /**
   * Broker→client permission request transport. When provided, drivers can ask
   * the connected client to decide a permission request via
   * `DriverContext.requestPermission`. Absent when no outbound request
   * transport is available.
   */
  onPermissionRequest?:
    | ((params: PermissionRequestParams) => Promise<PermissionDecision>)
    | undefined
  maxInputQueueDepth?: number | undefined
  /** Clock for broker-owned permission deadlines. Defaults to wall-clock. */
  now?: (() => Date) | undefined
  /**
   * Directory the durable normalized ledger lives in. The raw ingress journal
   * goes in `raw/` beneath it and the disposition index shares the Phase 1a
   * SQLite index beside it. ABSENT keeps capture in memory — the same pathless
   * mode `createEventLedger` already has for the stdio/in-process broker.
   */
  captureDir?: string | undefined
  /**
   * ONE line at WARN on the broker process's own log for each unclassified
   * `(driver, nativeType, family)` a capture gate sees. Defaults to
   * `process.stderr` — the seat's `bipc/<id>/broker.err`.
   */
  logWarn?: ((line: string) => void) | undefined
  authorizeSubmission?:
    | ((context: {
        invocationId: InvocationId
        class: SubmissionClass
        origin: SubmissionOrigin
        activeTurnId?: TurnId | undefined
        activeTurnPolicy?: TurnPolicy | undefined
      }) => boolean | Promise<boolean>)
    | undefined
  isOperator?: ((principalRef: string) => boolean) | undefined
  authorizeQueueJump?:
    | ((context: {
        invocationId: InvocationId
        principalRef: string
        submissionOrigin: SubmissionOrigin
        fromPosition: number
        toPosition: number
      }) => boolean | Promise<boolean>)
    | undefined
}

/** Options for the shared inspection summary builder. */
export interface InspectionSummaryOptions {
  /**
   * When true the caller asked for a liveness view. This phase only advertises
   * cached liveness, so the summary returns projected facts with mode:'cached'
   * even under a probe request (it never pretends to actively probe).
   */
  probeLiveness?: boolean | undefined
}

export interface InvocationManager {
  start(
    spec: HarnessInvocationSpec,
    driver: Driver,
    initialInput?: InvocationInput | undefined,
    dispatchEnv?: DispatchEnv | undefined,
    runtime?: InvocationRuntimeContext | undefined,
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
  ): Promise<InvocationStartResponse>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  steer(req: SubmissionSteerRequest): Promise<SubmissionResponse>
  enqueue(req: SubmissionEnqueueRequest): Promise<SubmissionResponse>
  invoke(req: SubmissionInvokeRequest): Promise<SubmissionResponse>
  preempt(req: SubmissionPreemptRequest): Promise<SubmissionResponse>
  withdraw(req: SubmissionWithdrawRequest): Promise<SubmissionWithdrawResponse>
  queueList(invocationId: InvocationId): QueueListResponse
  queueJump(req: QueueJumpRequest): Promise<QueueJumpResponse>
  queueCancel(req: QueueCancelRequest): Promise<QueueCancelResponse>
  turnManifest(invocationId: InvocationId, turnId: TurnId): TurnManifestResponse
  seatProbe(invocationId: InvocationId): SeatProbeResponse
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(invocationId: InvocationId, opts?: InspectionSummaryOptions): InvocationStatusResponse
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
  permissionRespond(req: InvocationPermissionRespondRequest): InvocationPermissionRespondResponse
  /**
   * Retained operator disposition surface (§6.1). Since T-07883 the cursor
   * never halts, so this always answers with the typed "not the blocked-unknown
   * record" refusal; the RPC stays on the wire for the fleet still calling it.
   */
  captureRelease(req: InvocationCaptureReleaseRequest): InvocationCaptureReleaseResponse
  /** Capture-cursor state for the snapshot surface. */
  captureState(invocationId: InvocationId): CaptureStateView | undefined
  /**
   * Re-drive every raw record this invocation committed but never
   * dispositioned, through its DRIVER'S own normalizer (T-07853 §7.3, §14 row
   * 1). Returns how many records were re-normalized; 0 when there is nothing
   * pending, when the invocation is unknown, or when its driver declares no
   * replayable normalizer.
   *
   * Generic on purpose: this is the production caller Phase 1a left missing,
   * and it belongs to whichever drivers ingest through the gate, not to one of
   * them.
   */
  replayPendingCapture(invocationId: InvocationId): number
  get(invocationId: InvocationId): Invocation | undefined
  /**
   * Shared inspection read-model builder. status(), snapshot/buildSnapshot, and
   * listInvocations all project through this single helper so their inspection
   * fields cannot drift.
   */
  buildInspectionSummary(
    invocationId: InvocationId,
    opts?: InspectionSummaryOptions
  ): InvocationInspectionSummary
  listInvocations(req: BrokerListInvocationsRequest): BrokerListInvocationsResponse
  activeCount(): number
  /**
   * Drive an invocation to a typed storage failure after its durable event
   * ledger refused an append. Called synchronously from the commit-before-publish
   * path, so it must never throw: it emits the terminal (the only event still
   * allowed onto the poisoned stream) and then stops/disposes the driver
   * cleanly in the background.
   */
  failForStorage(invocationId: InvocationId, detail: string): void
}

/** Emit one broker event for an invocation; shared by every manager module. */
export type EmitFn = <K extends InvocationEventType>(
  inv: Invocation,
  type: K,
  payload: InvocationEventPayloadMap[K],
  extra?: InvocationEventExtra
) => InvocationEventEnvelope<K>
