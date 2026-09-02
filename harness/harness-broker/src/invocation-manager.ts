import { join as joinPath } from 'node:path'
import type {
  AdmissionLayer,
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  BrokerQueueEntry,
  BrokerTerminalSurfaceReport,
  CaptureReleasedPayload,
  CaptureStateView,
  CaptureWarningPayload,
  ClientCapabilities,
  ContinuationUpdate,
  EventProvenance,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationCurrentTurnSummary,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationId,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInspectionSummary,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationLifecycleView,
  InvocationLivenessView,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationResponseFormat,
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
import {
  BrokerErrorCode,
  CAPTURE_RELEASE_NOT_BLOCKED,
  EVENT_FAMILY_BY_TYPE,
  LEGACY_BUSY_POLICIES,
  acceptedLifecyclePolicy,
  validateEventEnvelope,
} from 'spaces-harness-broker-protocol'
import type { CaptureGate } from './capture/capture-gate'
import { CaptureRecordNotBlockedError, createCaptureGate } from './capture/capture-gate'
import { type CaptureIndex, openCaptureIndex } from './capture/capture-index'
import { createRawJournal } from './capture/raw-journal'
import type { ApplyInputResult, Driver, DriverContext } from './drivers/driver'
import { BrokerError } from './errors'
import { stableJsonStringify } from './event-ledger'
import type { InvocationEventExtra, InvocationEventSequencer } from './events'
import { LEDGER_APPEND_FAILED } from './ledger-commit'
import type { DispatchEnv } from './runtime/env'
import { normalizeEventPayload } from './runtime/event-normalize'
import { HARNESS_BROKER_VERSION } from './version'

// ---------------------------------------------------------------------------
// Reason-string vocabulary (centralized for spec traceability)
// ---------------------------------------------------------------------------
const REASON_BUSY_REJECTED = 'busy_rejected'
const REASON_QUEUE_FULL = 'queue_full'
const REASON_QUEUE_NOT_SUPPORTED = 'queue_not_supported'
const REASON_UNSUPPORTED_INPUT_KIND = 'unsupported_input_kind_for_queue'
const REASON_UNSUPPORTED_BUSY_POLICY = 'unsupported_busy_policy'
const REASON_STEER_NOT_SUPPORTED = 'steer_not_supported'
const REASON_INVOCATION_TERMINATED = 'invocation_terminated'
const REASON_INVOCATION_STOPPING = 'invocation_stopping'

const DEFAULT_MAX_INPUT_QUEUE_DEPTH = 64

/** Fallback bound for a broker-owned permission deadline when the policy omits one. */
const DEFAULT_PERMISSION_TIMEOUT_MS = 1000

type PermissionDecidedBy = 'policy' | 'user' | 'api' | 'timeout'

/** Terminal states that allow dispose. */
const TERMINAL_STATES = new Set<InvocationState>(['exited', 'failed'])

// ---------------------------------------------------------------------------
// Tool-call terminal-outcome invariant (T-06550)
// ---------------------------------------------------------------------------
/**
 * Turn-terminal event types. When a turn closes, every `tool.call.started`
 * scoped to it MUST have already reached a terminal; any still open is the
 * burn-in-19 vanished-call defect and the broker synthesizes its `failed`.
 */
const TURN_TERMINAL_TYPES = new Set<InvocationEventType>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
])
/**
 * Invocation-teardown event types. On provider death mid-turn (the turn itself
 * may never close) these are the catch-all boundary that synthesizes `failed`
 * for ALL still-open tool calls.
 */
const INVOCATION_TEARDOWN_TYPES = new Set<InvocationEventType>([
  'invocation.exited',
  'invocation.failed',
])
const SUBMISSION_TERMINAL_TYPES = new Set<InvocationEventType>([
  'submission.absorbed',
  'submission.executed',
  'submission.rejected',
  'submission.expired',
  'submission.withdrawn',
  'submission.cancelled',
])
const BROKER_DECISION_TYPES = new Set<InvocationEventType>([
  'admission.requested',
  'admission.admitted',
  'admission.rejected',
  'queue.enqueued',
  'queue.jumped',
  'queue.cancelled',
  'queue.expired',
  'queue.withdrawn',
  'interrupt.requested',
  'interrupt.landed',
  'interrupt.failed',
  ...SUBMISSION_TERMINAL_TYPES,
  'capture.warning',
])
const BROKER_PROVENANCE = {
  sourceKind: 'broker' as const,
  normalizer: { name: 'harness-broker-admission', version: '1' },
}
/** Machine-readable `code` for a tool call left open when its turn closed. */
const TOOL_CALL_UNTERMINATED_CODE = 'broker_unterminated_tool_call'
/** Machine-readable `code` for a tool call left open when the invocation tore down. */
const TOOL_CALL_TEARDOWN_CODE = 'broker_provider_teardown'

/** Broker-side record of an open `tool.call.started` awaiting its terminal. */
interface StartedToolCall {
  toolCallId: ToolCallId
  name: string
  turnId?: TurnId | undefined
}

/**
 * Extract the `{ toolCallId, name, turnId }` bracket key from a
 * `tool.call.started` payload, or undefined when the payload lacks a usable
 * toolCallId (nothing to bracket). `name` falls back to `'tool'` so a
 * synthesized failure always carries the required `name` field.
 */
function asStartedToolCall(
  payload: unknown,
  turnId?: TurnId | undefined
): StartedToolCall | undefined {
  const record = payload as { toolCallId?: unknown; name?: unknown } | undefined
  const toolCallId = record?.toolCallId
  if (typeof toolCallId !== 'string') return undefined
  return {
    toolCallId: toolCallId as ToolCallId,
    name: typeof record?.name === 'string' ? record.name : 'tool',
    turnId,
  }
}

/**
 * continuation.cleared reasons that mean the operator LEFT the session (vs.
 * `clear`, which keeps it). On these the broker pushes a final invocation.summary
 * so a shutdown report is recorded on the durable stream before the lease reap.
 * Mirrors HRC's BROKER_TMUX_PROMPT_EXIT_REASONS.
 */
const SESSION_LEAVE_REASONS = new Set(['prompt_input_exit', 'logout'])

/**
 * Reason/message surfaced when a JSON Schema response format is sent to a driver
 * that does not advertise structured final-response support (T-03779).
 */
const REASON_UNSUPPORTED_FINAL_RESPONSE = 'UnsupportedCapability: finalResponse.jsonSchema'

/**
 * Normalize a per-turn response format for idempotency fingerprinting (T-03779):
 * omitted and `{ kind: 'text' }` both collapse to `null`; a JSON Schema format
 * keeps its `{ kind, schema }`. `stableJsonStringify` canonicalizes object key
 * order downstream, so reordered schema keys fingerprint identically.
 */
function normalizeResponseFormat(
  responseFormat: InvocationResponseFormat | undefined
): { kind: 'json_schema'; schema: Record<string, unknown> } | null {
  if (responseFormat?.kind === 'json_schema') {
    return { kind: 'json_schema', schema: responseFormat.schema }
  }
  return null
}

/** True when this input requests a JSON Schema structured final response. */
function requestsJsonSchemaResponse(input: InvocationInput): boolean {
  return input.responseFormat?.kind === 'json_schema'
}

/** True when the driver capabilities advertise per-turn JSON Schema support. */
function supportsJsonSchemaResponse(capabilities: InvocationCapabilities): boolean {
  return (
    capabilities.finalResponse?.jsonSchema === true && capabilities.finalResponse?.perTurn === true
  )
}

function assertLifecyclePolicySupported(
  policy: BrokerLifecyclePolicyOverlay | undefined,
  capabilities: InvocationCapabilities
): void {
  if (policy === undefined) return
  const missing: string[] = []
  if (!capabilities.lifecycle.runtimeRetention.includes(policy.retention.mode)) {
    missing.push(`retention.${policy.retention.mode}`)
  }
  if (!capabilities.lifecycle.harnessRecovery.includes(policy.harnessRecovery.mode)) {
    missing.push(`harnessRecovery.${policy.harnessRecovery.mode}`)
  }
  if (!capabilities.lifecycle.turnRetry.includes(policy.turnRetry.mode)) {
    missing.push(`turnRetry.${policy.turnRetry.mode}`)
  }
  if (missing.length > 0) {
    throw new BrokerError(
      BrokerErrorCode.BrokerLifecyclePolicyUnsupported,
      'Broker lifecycle policy unsupported by selected driver capabilities',
      {
        code: 'broker-lifecycle-policy-unsupported',
        policyId: policy.policyId,
        policyHash: policy.policyHash,
        missing,
        capabilities: capabilities.lifecycle,
      }
    )
  }
}

// ---------------------------------------------------------------------------
// Queue types
// ---------------------------------------------------------------------------
interface QueuedInput {
  inputId: InputId
  input: InvocationInputWithId
}

type SubmissionRequest =
  | SubmissionSteerRequest
  | SubmissionEnqueueRequest
  | SubmissionInvokeRequest
  | SubmissionPreemptRequest

interface SubmissionRecord {
  submissionId: string
  class: SubmissionClass
  origin: SubmissionOrigin
  input: InvocationInputWithId
  turnPolicy: TurnPolicy
  terminal: boolean
}

interface BrokerHeldSubmission {
  record: SubmissionRecord
  class: 'queue' | 'preempt'
  ttlMs?: number | undefined
  expiresAt?: number | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
}

type InvocationInputWithId = InvocationInput & { inputId: InputId }

/** Per-invocation in-memory record of a resolved input disposition. */
interface InputDispositionRecord {
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
interface PendingPermissionRecord {
  params: PermissionRequestParams
  defaultDecision: 'allow' | 'deny'
  /** Absolute ISO-8601 deadline surfaced to reconnecting controllers. */
  deadlineAt: string
  settle(decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void
}

/** In-memory record of how a permission request settled (idempotency surface). */
interface SettledPermissionRecord {
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
  pendingOwnTurnSubmissionId?: string | undefined
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
  withdraw(req: SubmissionWithdrawRequest): SubmissionWithdrawResponse
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

export function createInvocationManager(options: InvocationManagerOptions): InvocationManager {
  const { sequencer, onEvent, getClientCapabilities = () => ({}), onPermissionRequest } = options
  const now = options.now ?? (() => new Date())
  const maxQueueDepth = options.maxInputQueueDepth ?? DEFAULT_MAX_INPUT_QUEUE_DEPTH
  const invocations = new Map<string, Invocation>()
  // One index handle per broker process, shared by every invocation's gate.
  // It is the Phase 1a `ledger-index.db` when a ledger dir is configured, and
  // an in-memory index otherwise.
  let captureIndex: CaptureIndex | undefined
  function requireCaptureIndex(): CaptureIndex {
    captureIndex ??= openCaptureIndex(
      options.captureDir !== undefined
        ? joinPath(options.captureDir, 'ledger-index.db')
        : undefined,
      now
    )
    return captureIndex
  }

  /**
   * Provenance for a fact the BROKER authored rather than observed: input
   * dispositions, lifecycle policy acceptance, synthesized tool terminals,
   * control dispositions. §6 keeps these broker-authoritative, so they carry
   * `sourceKind: 'broker'` rather than borrowing a provider's cursor.
   */
  const brokerProvenance: EventProvenance = {
    sourceKind: 'broker',
    normalizer: { name: 'harness-broker', version: HARNESS_BROKER_VERSION },
  }

  /**
   * Provenance for an event a DRIVER emitted without attaching a committed raw
   * record. Derived from that driver's DECLARED authority for the event's
   * family (§6) rather than defaulting to `broker`, because calling a
   * provider-observed fact broker-authored would be a false provenance — the
   * one thing §7.2 exists to prevent.
   *
   * A driver that has been wired to the capture gate supplies real record
   * provenance instead, and that always wins. This is the honest floor for the
   * rest: it says which SOURCE owns the fact, and omits the record id / cursor
   * it genuinely does not have yet.
   */
  function declaredProvenance(
    inv: Invocation,
    type: InvocationEventType,
    rawType?: string
  ): EventProvenance {
    // A `broker.*` rawType is a driver ECHOING a broker decision (the user
    // message it was handed, a steer it was asked to deliver), not something it
    // observed the provider do. It stays broker-authored whatever the family's
    // declared authority says — otherwise the envelope would claim the provider
    // reported a fact the provider never saw.
    if (rawType?.startsWith('broker.') === true) {
      return brokerProvenance
    }
    // A driver with no declaration (an in-test stand-in; the Driver interface
    // requires one of every real driver) cannot be attributed to a provider, so
    // it falls back to broker provenance rather than guessing a source.
    const family = EVENT_FAMILY_BY_TYPE[type]
    const authority = family === undefined ? undefined : inv.driver.evidenceAuthority?.[family]
    if (authority === undefined || authority === 'broker') {
      return brokerProvenance
    }
    return {
      sourceKind:
        authority === 'hook'
          ? ('hook' as const)
          : (inv.driver.nativeSourceKind ?? 'provider-jsonl'),
      ...(rawType !== undefined ? { nativeType: rawType } : {}),
      normalizer: { name: inv.driver.kind, version: inv.driver.version },
    }
  }

  /**
   * Provenance truthfulness, enforced for EVERY driver at the one seam every
   * event passes through (T-07870, T-07853 §7.2).
   *
   * A `provider-*` `sourceKind` is a claim that the provider's own transcript or
   * protocol stream reported this fact, and §7.1 makes the committed raw record
   * the only thing that can substantiate that claim. An envelope that claims a
   * provider source but names no record is unfalsifiable: nothing on disk can be
   * opened to check it, which is exactly how a well-formed ledger stayed
   * indistinguishable from a working one under T-07868.
   *
   * So the claim degrades to what is actually true of such an event — the broker
   * minted it from a broker-side path — while the driver's `nativeType` and
   * normalizer are preserved, because those ARE known. This is a floor, not a
   * fix: the fix is to commit the record (what the codex-app-server permission
   * path now does), and `scripts/capture-parity.ts` plus
   * `test/capture/provenance-truthfulness.test.ts` fail on any violation rather
   * than letting the degrade hide one.
   */
  function truthfulProvenance(provenance: EventProvenance): EventProvenance {
    if (!provenance.sourceKind.startsWith('provider-')) return provenance
    if (provenance.rawRecordId !== undefined) return provenance
    return { ...provenance, sourceKind: 'broker' }
  }
  const authorizeSubmission = options.authorizeSubmission ?? (() => true)
  const isOperator =
    options.isOperator ??
    ((principalRef: string) => principalRef === 'lance' || principalRef.startsWith('human:'))
  const authorizeQueueJump =
    options.authorizeQueueJump ??
    ((context: { principalRef: string }) => isOperator(context.principalRef))

  function requireInvocation(invocationId: InvocationId): Invocation {
    const inv = invocations.get(invocationId)
    if (!inv) {
      throw new BrokerError(
        BrokerErrorCode.UnknownInvocation,
        `Unknown invocation: ${invocationId}`,
        { invocationId }
      )
    }
    return inv
  }

  function nextSubmissionId(inv: Invocation): string {
    inv.submissionCounter += 1
    return `submission_${inv.invocationId}_${inv.submissionCounter}`
  }

  function requestToInput(submissionId: string, req: SubmissionRequest): InvocationInputWithId {
    return {
      inputId: submissionId as InputId,
      kind: 'user',
      content: [{ type: 'text', text: req.body }],
      ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
      metadata: {
        submissionId,
        principalRef: req.origin.principalRef,
        ...(req.origin.scopeRef !== undefined ? { scopeRef: req.origin.scopeRef } : {}),
        ...(req.origin.envelopeId !== undefined ? { envelopeId: req.origin.envelopeId } : {}),
      },
    }
  }

  function registerSubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    req: SubmissionRequest
  ): SubmissionRecord {
    const submissionId = nextSubmissionId(inv)
    const record: SubmissionRecord = {
      submissionId,
      class: admissionClass,
      origin: req.origin,
      input: requestToInput(submissionId, req),
      turnPolicy:
        admissionClass === 'steer'
          ? 'open'
          : ((req as SubmissionEnqueueRequest).turnPolicy ?? 'open'),
      terminal: false,
    }
    inv.submissions.set(submissionId, record)
    emit(inv, 'admission.requested', {
      submissionId,
      class: admissionClass,
      origin: req.origin,
      ...(admissionClass !== 'steer' ? { turnPolicy: record.turnPolicy } : {}),
      ...(req.freshContext !== undefined ? { freshContext: req.freshContext } : {}),
    })
    return record
  }

  function registerLegacySubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    input: InvocationInputWithId
  ): SubmissionRecord {
    const origin: SubmissionOrigin = {
      principalRef: input.metadata?.['principalRef'] ?? 'legacy:invocation.input',
      ...(input.metadata?.['scopeRef'] !== undefined
        ? { scopeRef: input.metadata['scopeRef'] }
        : {}),
      ...(input.metadata?.['envelopeId'] !== undefined
        ? { envelopeId: input.metadata['envelopeId'] }
        : {}),
    }
    const record: SubmissionRecord = {
      submissionId: input.inputId,
      class: admissionClass,
      origin,
      input,
      turnPolicy: 'open',
      terminal: false,
    }
    inv.submissions.set(input.inputId, record)
    emit(inv, 'admission.requested', {
      submissionId: input.inputId,
      class: admissionClass,
      origin,
      ...(admissionClass !== 'steer' ? { turnPolicy: 'open' } : {}),
    })
    return record
  }

  function rejectSubmission(
    inv: Invocation,
    record: SubmissionRecord,
    layer: AdmissionLayer,
    reason: string
  ): SubmissionResponse {
    emit(inv, 'admission.rejected', {
      submissionId: record.submissionId,
      class: record.class,
      layer,
      reason,
    })
    emit(inv, 'submission.rejected', { submissionId: record.submissionId, reason })
    return { submissionId: record.submissionId, admission: 'rejected', reason }
  }

  async function checkAdmission(
    inv: Invocation,
    record: SubmissionRecord,
    req: SubmissionRequest
  ): Promise<SubmissionResponse | undefined> {
    if (!inv.capabilities.admission.classes.includes(record.class)) {
      return rejectSubmission(inv, record, 'capability', `unsupported:${record.class}`)
    }
    const driverRejection = inv.driver.admissionRejectionReason?.(record.class)
    if (driverRejection !== undefined) {
      return rejectSubmission(inv, record, 'capability', driverRejection)
    }
    if (req.freshContext === true) {
      return rejectSubmission(inv, record, 'capability', 'fresh-context-unsupported')
    }
    if (inv.state !== 'ready' && inv.state !== 'turn_active') {
      return rejectSubmission(inv, record, 'state', `invalid-state:${inv.state}`)
    }
    if (
      inv.pendingOwnTurnSubmissionId !== undefined &&
      (record.class === 'steer' || record.class === 'exclusive')
    ) {
      return rejectSubmission(inv, record, 'state', 'busy')
    }
    if (
      record.class === 'steer' &&
      inv.state === 'turn_active' &&
      inv.currentTurnPolicy === 'guarded'
    ) {
      return rejectSubmission(inv, record, 'policy', 'guarded')
    }
    const authorized = await authorizeSubmission({
      invocationId: inv.invocationId,
      class: record.class,
      origin: record.origin,
      ...(inv.currentTurnId !== undefined ? { activeTurnId: inv.currentTurnId } : {}),
      ...(inv.state === 'turn_active' ? { activeTurnPolicy: inv.currentTurnPolicy } : {}),
    })
    if (!authorized) {
      return rejectSubmission(inv, record, 'authority', 'authority-denied')
    }
    return undefined
  }

  function admitSubmission(inv: Invocation, record: SubmissionRecord): SubmissionResponse {
    emit(inv, 'admission.admitted', {
      submissionId: record.submissionId,
      class: record.class,
    })
    return { submissionId: record.submissionId, admission: 'admitted' }
  }

  function rejectAdmittedExecution(
    inv: Invocation,
    record: SubmissionRecord,
    error: unknown
  ): void {
    const heldIndex = inv.brokerQueue.findIndex(
      (item) => item.record.submissionId === record.submissionId
    )
    if (heldIndex >= 0) {
      const [held] = inv.brokerQueue.splice(heldIndex, 1)
      if (held?.timer !== undefined) clearTimeout(held.timer)
    }
    emit(inv, 'submission.rejected', {
      submissionId: record.submissionId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  function queueEntry(item: BrokerHeldSubmission, position: number): BrokerQueueEntry {
    return {
      submissionId: item.record.submissionId,
      origin: item.record.origin,
      class: item.class,
      ...(item.ttlMs !== undefined ? { ttlMs: item.ttlMs } : {}),
      position,
    }
  }

  function expireHeldSubmission(inv: Invocation, submissionId: string): void {
    const index = inv.brokerQueue.findIndex((item) => item.record.submissionId === submissionId)
    if (index < 0) return
    const [item] = inv.brokerQueue.splice(index, 1)
    if (item === undefined || item.record.terminal) return
    emit(inv, 'queue.expired', { submissionId })
    emit(inv, 'submission.expired', { submissionId })
    scheduleAdmissionDrain(inv)
  }

  function withdrawHeldSubmission(req: SubmissionWithdrawRequest): SubmissionWithdrawResponse {
    const matches: Array<{ inv: Invocation; record: SubmissionRecord }> = []
    for (const inv of invocations.values()) {
      for (const record of inv.submissions.values()) {
        if (
          ('submissionId' in req && record.submissionId === req.submissionId) ||
          ('envelopeId' in req && record.origin.envelopeId === req.envelopeId)
        ) {
          matches.push({ inv, record })
        }
      }
    }
    if (matches.length === 0) return { outcome: 'unknown' }

    let withdrawn = false
    let accepted = false
    for (const { inv, record } of matches) {
      if (record.terminal) continue
      const position = inv.brokerQueue.findIndex(
        (item) => item.record.submissionId === record.submissionId
      )
      if (position < 0) {
        accepted = true
        continue
      }

      const [item] = inv.brokerQueue.splice(position, 1)
      if (item === undefined) {
        accepted = true
        continue
      }
      if (item.timer !== undefined) clearTimeout(item.timer)
      emit(inv, 'queue.withdrawn', {
        submissionId: record.submissionId,
        reason: req.reason,
        position,
      })
      emit(inv, 'submission.withdrawn', {
        submissionId: record.submissionId,
        reason: req.reason,
      })
      scheduleAdmissionDrain(inv)
      withdrawn = true
    }
    if (withdrawn) return { outcome: 'withdrawn' }
    return { outcome: 'not_held', state: accepted ? 'accepted' : 'terminal' }
  }

  function holdSubmission(
    inv: Invocation,
    record: SubmissionRecord,
    admissionClass: 'queue' | 'preempt',
    ttlMs?: number | undefined
  ): void {
    const item: BrokerHeldSubmission = {
      record,
      class: admissionClass,
      ...(ttlMs !== undefined ? { ttlMs, expiresAt: now().getTime() + ttlMs } : {}),
    }
    if (admissionClass === 'preempt') inv.brokerQueue.unshift(item)
    else inv.brokerQueue.push(item)
    if (ttlMs !== undefined) {
      item.timer = setTimeout(
        () => expireHeldSubmission(inv, record.submissionId),
        Math.max(0, ttlMs)
      )
    }
    const position = inv.brokerQueue.indexOf(item)
    emit(inv, 'queue.enqueued', {
      submissionId: record.submissionId,
      class: admissionClass,
      position,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    })
  }

  function rejectDriverBlockedHeldSubmissions(inv: Invocation): void {
    let index = 0
    while (index < inv.brokerQueue.length) {
      const item = inv.brokerQueue[index]
      if (item === undefined || item.record.terminal) {
        index += 1
        continue
      }
      const reason = inv.driver.admissionRejectionReason?.(item.record.class)
      if (reason === undefined) {
        index += 1
        continue
      }
      inv.brokerQueue.splice(index, 1)
      if (item.timer !== undefined) clearTimeout(item.timer)
      rejectSubmission(inv, item.record, 'capability', reason)
    }
  }

  function hasDriverBlockedHeldSubmission(inv: Invocation): boolean {
    return inv.brokerQueue.some(
      (item) =>
        !item.record.terminal &&
        inv.driver.admissionRejectionReason?.(item.record.class) !== undefined
    )
  }

  function scheduleAdmissionDrain(inv: Invocation): void {
    if (inv.admissionDrainPromise !== undefined) return
    inv.admissionDrainPromise = Promise.resolve()
      .then(() => drainAdmissionQueue(inv))
      .finally(() => {
        inv.admissionDrainPromise = undefined
        const head = inv.brokerQueue[0]
        const quiescenceBlocked =
          head?.class === 'preempt' &&
          (inv.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0) > 0
        if (
          hasDriverBlockedHeldSubmission(inv) ||
          (inv.state === 'ready' &&
            inv.pendingOwnTurnSubmissionId === undefined &&
            head !== undefined &&
            !quiescenceBlocked)
        ) {
          scheduleAdmissionDrain(inv)
        }
      })
  }

  async function drainAdmissionQueue(inv: Invocation): Promise<void> {
    // Drivers can lose a capability after admission while a submission is
    // broker-held. Re-evaluate those records before seat-state gates so an
    // active turn cannot strand a preempt whose terminal is no longer
    // observable. Unaffected classes remain held in their original order.
    rejectDriverBlockedHeldSubmissions(inv)
    if (inv.state !== 'ready') return
    if (inv.pendingOwnTurnSubmissionId !== undefined) return
    const head = inv.brokerQueue[0]
    if (head === undefined) return
    if (
      head.class === 'preempt' &&
      head.record.class === 'preempt' &&
      head.record.terminal === false &&
      (inv.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0) > 0
    ) {
      return
    }
    inv.brokerQueue.shift()
    if (head.timer !== undefined) clearTimeout(head.timer)
    try {
      await applyAndEmit(inv, head.record.input)
    } catch (error) {
      rejectAdmittedExecution(inv, head.record, error)
    }
  }

  async function requestPreemptInterrupt(inv: Invocation, record: SubmissionRecord): Promise<void> {
    const turnId = inv.currentTurnId
    if (turnId === undefined || inv.preemptInterruptTurnId !== undefined) return
    if (inv.driver.preemptMode === 'quiescence' && !inv.currentTurnRequestInFlight) return
    inv.preemptInterruptTurnId = turnId
    emit(inv, 'interrupt.requested', {
      submissionId: record.submissionId,
      turnId,
    })
    try {
      const result = await inv.driver.interrupt({
        invocationId: inv.invocationId,
        scope: 'turn',
        reason: `submission.preempt:${record.submissionId}`,
      })
      if (!result.accepted) {
        emit(inv, 'interrupt.failed', {
          submissionId: record.submissionId,
          turnId,
          reason: result.reason ?? result.effect,
        })
        if (inv.preemptInterruptTurnId === turnId) inv.preemptInterruptTurnId = undefined
        rejectAdmittedExecution(inv, record, result.reason ?? result.effect)
        return
      }
      emit(inv, 'interrupt.landed', {
        submissionId: record.submissionId,
        turnId,
      })
      scheduleAdmissionDrain(inv)
    } catch (error) {
      emit(inv, 'interrupt.failed', {
        submissionId: record.submissionId,
        turnId,
        reason: error instanceof Error ? error.message : String(error),
      })
      if (inv.preemptInterruptTurnId === turnId) inv.preemptInterruptTurnId = undefined
      rejectAdmittedExecution(inv, record, error)
    }
  }

  function maybeRequestPreemptInterrupt(inv: Invocation): void {
    const preempt = inv.brokerQueue.find((item) => item.class === 'preempt')
    if (preempt === undefined || inv.driver.preemptMode !== 'quiescence') return
    void requestPreemptInterrupt(inv, preempt.record)
  }

  // ---------------------------------------------------------------------------
  // Drain logic — promise-guarded, at most one drain in flight per ready window
  // ---------------------------------------------------------------------------
  function scheduleDrain(inv: Invocation): void {
    if (inv.drainPromise) return
    if (inv.pending.length === 0) return
    if (inv.state !== 'ready') return
    if (inv.pendingOwnTurnSubmissionId !== undefined) return
    inv.drainPromise = doDrain(inv).finally(() => {
      inv.drainPromise = undefined
      // Reschedule if invocation is still ready with pending inputs — prevents
      // stalling when a mid-drain failure leaves items in the queue.
      if (
        inv.state === 'ready' &&
        inv.pendingOwnTurnSubmissionId === undefined &&
        inv.pending.length > 0
      ) {
        scheduleDrain(inv)
      }
    })
  }

  async function doDrain(inv: Invocation): Promise<void> {
    while (
      inv.pending.length > 0 &&
      inv.state === 'ready' &&
      inv.pendingOwnTurnSubmissionId === undefined
    ) {
      const head = inv.pending.shift()
      if (head === undefined) return
      try {
        await applyAndEmit(inv, head.input)
      } catch (err) {
        // Input failed at the driver level — reject this item and continue
        // draining; the while-loop guard re-checks state before the next item.
        emit(
          inv,
          'input.rejected',
          {
            inputId: head.inputId,
            reason: String(err instanceof Error ? err.message : err),
          },
          { inputId: head.inputId }
        )
        emit(inv, 'submission.rejected', {
          submissionId: head.inputId,
          reason: String(err instanceof Error ? err.message : err),
        })
      }
    }
  }

  /**
   * Emit broker-owned input.accepted, then call driver.applyInputNow, then
   * GUARANTEE the `turn.started` bracket from the returned turnId (T-04846).
   *
   * The broker no longer depends on a driver hook (e.g. Claude
   * `UserPromptSubmit`) to open the turn: that hook does not fire for an idle
   * dispatch, leaving the turn body/terminal orphaned with no open bracket.
   * Instead, once the input is delivered and `applyInputNow` returns the
   * authoritative turnId, the broker synthesizes exactly one `turn.started`
   * (provenance `source:'broker-delivery'`) BEFORE any body/terminal event.
   * If the driver/hook ALSO observes the start for the same turnId, `emit`
   * dedupes it (whichever path lands first wins). This is the single code path
   * for both immediate application and drain. `attempted_steer` does not flow
   * through here, so it never gets a synthetic start.
   */
  async function applyAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<{ turnId?: TurnId | undefined }> {
    // Broker owns input.accepted emission — before the driver applies the input
    const { inputId } = input
    if (inv.submissions.has(inputId)) {
      if (
        inv.pendingOwnTurnSubmissionId !== undefined &&
        inv.pendingOwnTurnSubmissionId !== inputId
      ) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Seat delivery is busy', {
          invocationId: inv.invocationId,
          submissionId: inv.pendingOwnTurnSubmissionId,
        })
      }
      inv.pendingOwnTurnSubmissionId = inputId
    }
    emit(inv, 'input.accepted', { inputId, disposition: 'started' }, { inputId })
    let result: ApplyInputResult
    try {
      result = await inv.driver.applyInputNow(input)
    } catch (error) {
      if (inv.pendingOwnTurnSubmissionId === inputId) {
        inv.pendingOwnTurnSubmissionId = undefined
      }
      throw error
    }
    // Broker-guaranteed turn.started: synthesize the bracket from the delivered
    // input's turnId. Deduped in emit() so it never double-opens a turn the
    // driver/hook also reports. Emitted synchronously after delivery so it
    // strictly precedes the (asynchronously-arriving) hook body/terminal events.
    if (result.turnId !== undefined && inv.driver.bracketMintingMode !== 'harness-evidence') {
      emit(
        inv,
        'turn.started',
        { turnId: result.turnId, source: 'broker-delivery', inputId },
        { turnId: result.turnId, inputId }
      )
      if (inv.submissions.has(inputId)) {
        if (result.deliveryDisposition === 'rejected') {
          emit(
            inv,
            'submission.rejected',
            {
              submissionId: inputId,
              reason: result.rejectionReason ?? 'delivery-rejected',
            },
            { turnId: result.turnId, inputId }
          )
        } else {
          emit(
            inv,
            'submission.executed',
            { submissionId: inputId, turnId: result.turnId },
            { turnId: result.turnId, inputId }
          )
        }
      }
    }
    return result
  }

  async function attemptSteerAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<InvocationInputResponse> {
    const applySteerNow = inv.driver.applySteerNow
    if (applySteerNow === undefined) {
      return rejectQueueInput(inv, input.inputId, REASON_STEER_NOT_SUPPORTED)
    }

    // Serialize pane writes only. This does not create a broker-owned pending
    // turn, and it never retroactively upgrades the request to `started`.
    const previous = inv.steerPromise ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async (): Promise<InvocationInputResponse> => {
        try {
          await applySteerNow.call(inv.driver, input)
        } catch (err) {
          return rejectQueueInput(
            inv,
            input.inputId,
            String(err instanceof Error ? err.message : err)
          )
        }

        emit(
          inv,
          'input.accepted',
          { inputId: input.inputId, disposition: 'attempted_steer' },
          { inputId: input.inputId }
        )
        if (
          inv.submissions.has(input.inputId) &&
          inv.currentTurnId !== undefined &&
          inv.driver.steerLandingEvidence !== 'transcript'
        ) {
          emit(
            inv,
            'submission.absorbed',
            { submissionId: input.inputId, turnId: inv.currentTurnId },
            { turnId: inv.currentTurnId, inputId: input.inputId }
          )
        }
        return {
          inputId: input.inputId,
          accepted: true,
          disposition: 'attempted_steer',
        }
      })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    inv.steerPromise = tail
    try {
      return await run
    } finally {
      if (inv.steerPromise === tail) {
        inv.steerPromise = undefined
      }
    }
  }

  function rejectQueueInput(
    inv: Invocation,
    inputId: InputId,
    reason: string
  ): InvocationInputResponse {
    emit(inv, 'input.rejected', { inputId, reason }, { inputId })
    return {
      inputId,
      accepted: false,
      disposition: 'rejected',
      reason,
    }
  }

  // ---------------------------------------------------------------------------
  // Queue eviction — reject all pending when invocation terminates or stops
  // ---------------------------------------------------------------------------
  function evictQueue(inv: Invocation, reason: string): void {
    if (inv.pendingOwnTurnSubmissionId !== undefined) {
      const pendingId = inv.pendingOwnTurnSubmissionId
      inv.pendingOwnTurnSubmissionId = undefined
      emit(inv, 'submission.cancelled', {
        submissionId: pendingId,
        reason: 'teardown',
      })
    }
    while (inv.pending.length > 0) {
      const item = inv.pending.shift()
      if (item === undefined) return
      emit(inv, 'input.rejected', { inputId: item.inputId, reason }, { inputId: item.inputId })
      emit(inv, 'submission.cancelled', {
        submissionId: item.inputId,
        reason: 'teardown',
      })
    }
    while (inv.brokerQueue.length > 0) {
      const item = inv.brokerQueue.shift()
      if (item === undefined) return
      if (item.timer !== undefined) clearTimeout(item.timer)
      emit(inv, 'queue.cancelled', {
        submissionId: item.record.submissionId,
        principalRef: 'broker',
      })
      emit(inv, 'submission.cancelled', {
        submissionId: item.record.submissionId,
        reason: 'teardown',
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Event state machine
  // ---------------------------------------------------------------------------
  function applyEventState(inv: Invocation, event: InvocationEventEnvelope): void {
    // Inspection timestamps/seq project on EVERY event (T-01851): startedAt is
    // the first event's time, lastActivityAt/currentSeq track the latest.
    if (inv.startedAt === undefined) {
      inv.startedAt = event.time
    }
    inv.lastActivityAt = event.time
    inv.currentSeq = event.seq

    switch (event.type) {
      case 'invocation.started': {
        // Capture the child pid for the manager-owned status projection.
        const pid = (event.payload as { pid?: unknown } | undefined)?.pid
        if (typeof pid === 'number') {
          inv.childPid = pid
        }
        return
      }
      case 'harness.started': {
        // A real driver-owned harness.started supersedes the broker's synthetic
        // invocation.started fallback and carries generation + child pid.
        inv.harnessStartedSeen = true
        const payload = event.payload as { generation?: unknown; pid?: unknown } | undefined
        if (typeof payload?.generation === 'number') {
          inv.currentHarnessGeneration = payload.generation
        }
        if (typeof payload?.pid === 'number') {
          inv.childPid = payload.pid
        }
        return
      }
      case 'harness.recovery.completed': {
        const payload = event.payload as { toGeneration?: unknown } | undefined
        if (typeof payload?.toGeneration === 'number') {
          inv.currentHarnessGeneration = payload.toGeneration
        }
        return
      }
      case 'turn.retry': {
        const payload = event.payload as
          | { toAttempt?: unknown; toHarnessGeneration?: unknown }
          | undefined
        const toAttempt = event.turnAttempt ?? payload?.toAttempt
        if (typeof toAttempt === 'number') {
          inv.currentTurnAttempt = toAttempt
        }
        const toGeneration = event.harnessGeneration ?? payload?.toHarnessGeneration
        if (typeof toGeneration === 'number') {
          inv.currentHarnessGeneration = toGeneration
        }
        return
      }
      case 'terminal.surface.reported': {
        inv.terminalSurface = event.payload as BrokerTerminalSurfaceReport
        return
      }
      case 'invocation.ready':
        inv.state = 'ready'
        return
      case 'input.accepted':
        if (
          (event.payload as { disposition?: unknown } | undefined)?.disposition ===
          'attempted_steer'
        ) {
          return
        }
        // The input that drives the next turn — cleared when the turn ends.
        if (event.inputId !== undefined) {
          inv.currentInputId = event.inputId
        }
        return
      case 'turn.started': {
        inv.state = 'turn_active'
        if (event.turnId !== undefined) {
          inv.currentTurnId = event.turnId
        }
        inv.currentTurnRequestInFlight = false
        // Project the active-turn summary fields (event fields first, then
        // payload, then manager-tracked fallbacks).
        const payload = event.payload as
          | { turnId?: unknown; inputId?: unknown; turnAttempt?: unknown }
          | undefined
        inv.currentTurnStartedAt = event.time
        const attempt = event.turnAttempt ?? payload?.turnAttempt
        inv.currentTurnAttempt = typeof attempt === 'number' ? attempt : 1
        const generation = event.harnessGeneration
        if (typeof generation === 'number') {
          inv.currentHarnessGeneration = generation
        }
        if (inv.driver.bracketMintingMode === 'harness-evidence' && event.inputId !== undefined) {
          const record = inv.submissions.get(event.inputId)
          if (record !== undefined && !record.terminal && event.turnId !== undefined) {
            emit(
              inv,
              'submission.executed',
              { submissionId: record.submissionId, turnId: event.turnId },
              { turnId: event.turnId, inputId: event.inputId }
            )
          }
        }
        return
      }
      case 'assistant.message.started':
      case 'assistant.message.delta':
      case 'assistant.message.completed':
      case 'tool.call.started':
        if (event.turnId !== undefined && event.turnId === inv.currentTurnId) {
          inv.currentTurnRequestInFlight = true
          maybeRequestPreemptInterrupt(inv)
        }
        return
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: intentional — turn.completed increments the counter then shares the turn-end projection below.
      case 'turn.completed':
        inv.turnsCompleted = (inv.turnsCompleted ?? 0) + 1
      // falls through to the shared turn-end projection below
      case 'turn.failed':
      case 'turn.interrupted': {
        const terminalTurnId = event.turnId
        const targeted =
          terminalTurnId !== undefined && inv.preemptInterruptTurnId === terminalTurnId
        if (targeted) inv.preemptInterruptTurnId = undefined
        if (
          terminalTurnId !== undefined &&
          inv.currentTurnId !== undefined &&
          terminalTurnId !== inv.currentTurnId
        ) {
          // A drained successor's user row can precede the prior turn's
          // interrupt marker. Preserve the successor projection; it becomes
          // interruptible only after its own request evidence arrives.
          if (targeted) maybeRequestPreemptInterrupt(inv)
          return
        }
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.currentTurnStartedAt = undefined
        inv.currentTurnRequestInFlight = false
        if (inv.state !== 'exited' && inv.state !== 'failed' && inv.state !== 'disposed') {
          inv.state = 'ready'
        }
        // Schedule drain if there are pending inputs and we transitioned to ready
        scheduleDrain(inv)
        scheduleAdmissionDrain(inv)
        return
      }
      case 'invocation.stopping':
        inv.state = 'stopping'
        inv.terminalReason = 'stopping'
        evictQueue(inv, REASON_INVOCATION_STOPPING)
        return
      case 'invocation.exited': {
        inv.state = 'exited'
        inv.terminalEmitted = true
        inv.terminalReason = 'exited'
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.currentTurnStartedAt = undefined
        const payload = event.payload as { exitCode?: unknown; signal?: unknown } | undefined
        if (payload && 'exitCode' in payload) {
          inv.exitCode = payload.exitCode as number | null | undefined
        }
        if (payload && 'signal' in payload) {
          inv.signal = payload.signal as string | null | undefined
        }
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
        return
      }
      case 'invocation.failed':
        inv.state = 'failed'
        inv.terminalEmitted = true
        inv.terminalReason = 'failed'
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.currentTurnStartedAt = undefined
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
        return
      case 'invocation.disposed':
        inv.state = 'disposed'
        inv.disposedEmitted = true
        inv.terminalReason = 'disposed'
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.currentTurnStartedAt = undefined
        return
      case 'continuation.updated':
        inv.continuation = event.payload as ContinuationUpdate
        return
      case 'continuation.cleared':
        inv.continuation = undefined
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Tool-call terminal-outcome invariant (T-06550)
  // ---------------------------------------------------------------------------
  /**
   * Synthesize a broker-owned `tool.call.failed` for every open tool call
   * matching `predicate`, closing the started→exactly-one-terminal bracket when
   * the provider tore down without emitting a terminal. Snapshots the matching
   * entries first (the recursive `emit` deletes them from `startedToolCalls`),
   * so mutation during iteration is safe. Each synthesized event is tagged with
   * a machine-readable `code`, `data.synthesized:true`, and a `broker` driver
   * kind so it is traceable as broker-originated, mirroring how the T-04846
   * bracket marks a synthesized `turn.started` with `source:'broker-delivery'`.
   */
  function synthesizeOpenToolFailures(
    inv: Invocation,
    code: string,
    message: string,
    predicate: (call: StartedToolCall) => boolean
  ): void {
    if (inv.startedToolCalls.size === 0) return
    const open = [...inv.startedToolCalls.values()].filter(predicate)
    for (const call of open) {
      inv.startedToolCalls.delete(call.toolCallId)
      emit(
        inv,
        'tool.call.failed',
        {
          toolCallId: call.toolCallId,
          name: call.name,
          message,
          code,
          data: { synthesized: true, reason: code },
        },
        {
          ...(call.turnId !== undefined ? { turnId: call.turnId } : {}),
          itemId: call.toolCallId,
          driver: { kind: 'broker', rawType: 'tool-call-invariant' },
        }
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Emit helper
  // ---------------------------------------------------------------------------
  function emit<K extends InvocationEventType>(
    inv: Invocation,
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope<K> {
    return emitEvent(inv, { type, payload }, extra)
  }

  function submissionDispositionContext(
    inv: Invocation,
    type: InvocationEventType,
    payload: unknown
  ): { submissionId?: string; existing?: InvocationEventEnvelope } {
    if (!SUBMISSION_TERMINAL_TYPES.has(type)) return {}
    const submissionId = (payload as { submissionId?: string }).submissionId
    if (submissionId === undefined) return {}
    const existing = inv.submissionDispositions.get(submissionId)
    return {
      submissionId,
      ...(existing !== undefined ? { existing } : {}),
    }
  }

  function buildEventExtra(
    inv: Invocation,
    type: InvocationEventType,
    extra?: InvocationEventExtra
  ): InvocationEventExtra {
    // Provenance precedence (T-07853 §7.2):
    //   1. what the EMITTER supplied — it holds the committed raw record this
    //      event was normalized from, which no default can reconstruct;
    //   2. the broker-decision default for the admission/queue/interrupt types
    //      that are broker facts by construction (T-07860);
    //   3. the driver's DECLARED authority for the family, so a
    //      provider-observed fact is never labelled broker-authored.
    //
    // Order 1-before-2 is the ruling on wrkq T-07863: the ledger must never
    // carry a rewritten provenance. `submission.absorbed`/`executed`/`cancelled`
    // are DISPOSITIONS — on claude-code-tmux they are minted from session-JSONL
    // queue evidence (T-07849 rev 11) and carry that row's real record — so the
    // schema requires provenance on them without dictating its source.
    const suppliedProvenance = truthfulProvenance(
      extra?.provenance ??
        (BROKER_DECISION_TYPES.has(type) ? BROKER_PROVENANCE : undefined) ??
        declaredProvenance(inv, type, extra?.driver?.rawType)
    )
    const withProvenance: InvocationEventExtra = { ...extra, provenance: suppliedProvenance }
    // Harness-evidence drivers correlate a submission only when their hook or
    // transcript mirror supplies the inputId. A pending delivery may coexist
    // with an unrelated harness-owned turn (for example, launch priming), so
    // borrowing the pending id here would turn that stranger into evidence.
    if (
      type !== 'turn.started' ||
      withProvenance.inputId !== undefined ||
      inv.pendingOwnTurnSubmissionId === undefined ||
      inv.driver.bracketMintingMode === 'harness-evidence'
    ) {
      return withProvenance
    }
    return {
      ...withProvenance,
      inputId: inv.pendingOwnTurnSubmissionId as InputId,
    }
  }

  function emitEvent<K extends InvocationEventType>(
    inv: Invocation,
    descriptor: InvocationEventFor<K>,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope<K>
  function emitEvent(
    inv: Invocation,
    descriptor: InvocationEvent,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope {
    const { type, payload } = descriptor
    const disposition = submissionDispositionContext(inv, type, payload)
    if (disposition.existing !== undefined) return disposition.existing
    const submissionId = disposition.submissionId
    const eventExtra = buildEventExtra(inv, type, extra)
    const isTurnTerminal = TURN_TERMINAL_TYPES.has(type)
    const terminalTurnId = isTurnTerminal
      ? (eventExtra.turnId ?? (payload as { turnId?: TurnId } | undefined)?.turnId)
      : undefined

    // Exactly-one turn-terminal bracket. An error callback and a late recovery
    // completion can race for the same turn; only the first terminal may reach
    // sequencing, state projection, and queue draining. Input redelivery itself
    // remains governed by the existing inputId disposition ledger.
    if (terminalTurnId !== undefined) {
      const existing = inv.terminalTurns.get(terminalTurnId)
      if (existing !== undefined) {
        return existing
      }
    }

    // Tool-call exactly-one-terminal bracket (T-06550). A turn or invocation
    // teardown is the point every open `tool.call.started` MUST have closed; any
    // still open is the burn-in-19 vanished-call defect. Synthesize its `failed`
    // BEFORE this boundary event is sequenced so the synthesized terminal lands
    // with a lower seq — inside the closing bracket, ahead of the turn/invocation
    // terminal. The synthesized `tool.call.failed` re-enters `emit`, but it is
    // neither a turn nor an invocation terminal, so it cannot re-trigger this.
    if (isTurnTerminal) {
      synthesizeOpenToolFailures(
        inv,
        TOOL_CALL_UNTERMINATED_CODE,
        'Tool call did not report a terminal result before the turn ended',
        (call) => terminalTurnId === undefined || call.turnId === terminalTurnId
      )
    } else if (INVOCATION_TEARDOWN_TYPES.has(type)) {
      synthesizeOpenToolFailures(
        inv,
        TOOL_CALL_TEARDOWN_CODE,
        'Tool call did not report a terminal result before the invocation terminated',
        () => true
      )
    }

    // Exactly-once `turn.started` bracket (T-04846). A turn may be started from
    // two seams — the broker synthesizing it from a delivered input
    // (`source:'broker-delivery'`) and a driver/hook observing the harness open
    // the turn — and both flow through here. Dedupe by turnId so the turn is
    // opened exactly once: the first start wins and is recorded; a later start
    // for the same turn is suppressed (not sequenced, not projected) and the
    // original winning envelope is returned to the (return-ignoring) caller.
    if (descriptor.type === 'turn.started') {
      const turnId = eventExtra.turnId ?? descriptor.payload.turnId
      if (turnId !== undefined) {
        const existing = inv.startedTurns.get(turnId)
        if (existing !== undefined) {
          return existing
        }
      }
    }

    // Single central event-safety path before sequencing: constrain/normalize
    // well-known payloads and truncate oversized payloads against maxEventBytes.
    const { payload: safePayload, diagnostics } = normalizeEventPayload({
      type,
      payload,
      maxEventBytes: inv.spec.process.limits?.maxEventBytes,
    })

    // Provenance is composed in buildEventExtra, so every sequenced envelope
    // carries it whether or not the call site thought about it.
    const sequencedEvent = sequencer.next(inv.invocationId, type, safePayload, eventExtra)
    // Runtime producer boundary: validate the fully normalized, sequenced
    // envelope before it can reach state projection, observers, or the durable
    // ledger. The protocol package owns both the map and these validators.
    const candidate: unknown = {
      ...sequencedEvent,
      payload: safePayload,
    }
    const event = validateEventEnvelope(candidate)
    if (inv.spec.correlation !== undefined) {
      event.correlation = inv.spec.correlation
    }
    // Record the winning `turn.started` so any subsequent start for this turn
    // (e.g. a hook-observed start after a broker-delivery synthesis) is deduped
    // above and resolves back to this same envelope (T-04846).
    if (event.type === 'turn.started' && event.turnId !== undefined) {
      inv.startedTurns.set(event.turnId, event)
      const record = event.inputId !== undefined ? inv.submissions.get(event.inputId) : undefined
      const policy = record?.class === 'steer' ? 'open' : (record?.turnPolicy ?? 'open')
      inv.currentTurnPolicy = policy
      inv.turnManifests.set(event.turnId, {
        invocationId: inv.invocationId,
        turnId: event.turnId,
        policy,
        submissionIds: [],
      })
      if (event.inputId !== undefined && inv.pendingOwnTurnSubmissionId === event.inputId) {
        inv.pendingOwnTurnSubmissionId = undefined
      }
    }
    if (TURN_TERMINAL_TYPES.has(event.type) && event.turnId !== undefined) {
      inv.terminalTurns.set(event.turnId, event)
    }
    if (submissionId !== undefined) {
      inv.submissionDispositions.set(submissionId, event)
      const record = inv.submissions.get(submissionId)
      if (record !== undefined) record.terminal = true
      if (
        (event.type === 'submission.absorbed' || event.type === 'submission.executed') &&
        event.payload.turnId !== undefined
      ) {
        const existingManifest = inv.turnManifests.get(event.payload.turnId)
        const policy = existingManifest?.policy ?? record?.turnPolicy ?? 'open'
        const submissionIds = existingManifest?.submissionIds ?? []
        if (!submissionIds.includes(submissionId)) submissionIds.push(submissionId)
        inv.turnManifests.set(event.payload.turnId, {
          invocationId: inv.invocationId,
          turnId: event.payload.turnId,
          policy,
          submissionIds,
        })
      }
    }
    // Tool-call bracket bookkeeping (T-06550): open the bracket on a start, close
    // it on either terminal. A real driver terminal AND a broker-synthesized one
    // both flow through here, so a synthesized close deletes the same entry the
    // synthesizer already snapshotted — exactly one terminal per started call.
    if (event.type === 'tool.call.started') {
      const started = asStartedToolCall(event.payload, event.turnId)
      if (started !== undefined) {
        inv.startedToolCalls.set(started.toolCallId, started)
      }
    } else if (event.type === 'tool.call.completed' || event.type === 'tool.call.failed') {
      inv.startedToolCalls.delete(event.payload.toolCallId)
    }
    // Deliver BEFORE projecting state: applyEventState can synchronously emit
    // follow-on events (turn terminal → drain dequeues input.accepted /
    // user.message; invocation.stopping → queue eviction input.rejected). If
    // delivery ran after projection, those cascade events (seq N+1…) would hit
    // the ledger/wire before this event (seq N), and downstream monotonic-seq
    // dedup (harness-broker-client InvocationEventHub) would then drop seq N as
    // a duplicate — T-06088: a queued input at turn end lost the active turn's
    // terminal. onEvent reads only the envelope, never invocation state.
    onEvent(event)
    applyEventState(inv, event)

    // Follow-on diagnostics (e.g. truncation notices) are emitted as their own
    // events. Their payloads are small, so they never re-trigger truncation.
    if (diagnostics) {
      for (const diagnostic of diagnostics) {
        emit(inv, 'diagnostic', diagnostic, eventExtra)
      }
    }

    // Graceful-exit summary push: on the user-exit continuation.cleared, push one
    // authoritative invocation.summary on the SAME ordered stream — recorded
    // downstream BEFORE the lease is reaped, so the operator shutdown report reads
    // a pushed-and-recorded summary instead of pulling the (by-then gone) live
    // broker read model. Guarded so it fires exactly once per invocation.
    if (event.type === 'continuation.cleared' && !inv.summaryEmitted) {
      const reason = event.payload.reason
      if (typeof reason === 'string' && SESSION_LEAVE_REASONS.has(reason)) {
        inv.summaryEmitted = true
        emit(inv, 'invocation.summary', {
          summary: buildInspectionSummary(inv),
          reason,
        })
      }
    }

    return event
  }

  function emitTerminal<K extends 'invocation.exited' | 'invocation.failed'>(
    inv: Invocation,
    type: K,
    payload: InvocationEventPayloadMap[K]
  ): void {
    if (inv.terminalEmitted) {
      return
    }
    inv.terminalEmitted = true
    emit(inv, type, payload)
  }

  // ---------------------------------------------------------------------------
  // InputId resolution
  // ---------------------------------------------------------------------------
  function resolveInputId(inv: Invocation, input: InvocationInput): InputId {
    if (input.inputId) return input.inputId
    inv.inputCounter += 1
    return `input_${inv.invocationId}_${inv.inputCounter}` as InputId
  }

  /**
   * Stable fingerprint of an input request's content + policy, used to detect
   * whether a duplicate inputId carries byte-identical payload (idempotent
   * replay) or differing payload (conflict). Keyed externally by inputId, so
   * the fingerprint deliberately ignores the inputId itself.
   */
  function fingerprintInput(req: InvocationInputRequest): string {
    return stableJsonStringify({
      kind: req.input.kind,
      content: req.input.content,
      policy: req.policy ?? null,
      responseFormat: normalizeResponseFormat(req.input.responseFormat),
    })
  }

  /** Persist a resolved disposition for a client-provided inputId (idempotency). */
  function recordDisposition(
    inv: Invocation,
    req: InvocationInputRequest,
    response: InvocationInputResponse
  ): void {
    if (req.input.inputId === undefined) return
    inv.inputDispositions.set(req.input.inputId, {
      fingerprint: fingerprintInput(req),
      response,
    })
  }

  // ---------------------------------------------------------------------------
  // Broker-owned permission lifecycle (C2)
  // ---------------------------------------------------------------------------
  /**
   * Register a broker-owned pending permission request and return a promise that
   * resolves with the FINAL decision. Unlike the JSON-RPC request promise, this
   * pending state is broker-held: it survives controller disconnect and is
   * retained until an absolute `deadlineAt`. It settles exactly once — by the
   * connected client's response (`user`), a reconnected controller's respond
   * (`user`), or deadline expiry applying `defaultDecision` (`timeout`). The
   * `permission.resolved` audit event is emitted on settlement. A failed/closed
   * broker→client request does NOT settle the pending request; it stays pending
   * until the deadline or a respond.
   */
  function brokerRequestPermission(
    inv: Invocation,
    params: PermissionRequestParams
  ): Promise<PermissionDecision> {
    const defaultDecision = params.defaultDecision
    const timeoutMs = params.deadlineMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    const deadlineAt = new Date(now().getTime() + timeoutMs).toISOString()
    const extra = {
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(inv.currentInputId !== undefined ? { inputId: inv.currentInputId } : {}),
    }

    return new Promise<PermissionDecision>((resolveDriver) => {
      let settled = false

      const settle = (decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inv.pendingPermissions.delete(params.permissionRequestId)
        inv.settledPermissions.set(params.permissionRequestId, {
          decision,
          expired: decidedBy === 'timeout',
        })
        emit(
          inv,
          'permission.resolved',
          { permissionRequestId: params.permissionRequestId, decision, decidedBy },
          extra
        )
        resolveDriver({ decision })
      }

      // setTimeout/onPermissionRequest are async, so `timer` is always assigned
      // before `settle` (which reads it) can run.
      const timer = setTimeout(() => settle(defaultDecision, 'timeout'), timeoutMs)

      inv.pendingPermissions.set(params.permissionRequestId, {
        params,
        defaultDecision,
        deadlineAt,
        settle,
      })

      // Ask the connected controller. A response settles by `user`; a rejection
      // (controller disconnect / handler error) is intentionally ignored so the
      // request stays pending until the deadline or a reconnect respond.
      if (onPermissionRequest !== undefined) {
        onPermissionRequest(params).then(
          (decision) => settle(decision.decision === 'allow' ? 'allow' : 'deny', 'user'),
          () => {}
        )
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Inspection read-model (T-01851) — ONE shared summary builder consumed by
  // status(), snapshot/buildSnapshot, and listInvocations so they cannot drift.
  // ---------------------------------------------------------------------------
  function inferDriverHealth(
    state: InvocationState
  ): 'unknown' | 'healthy' | 'degraded' | 'unresponsive' | 'exited' {
    switch (state) {
      case 'ready':
      case 'turn_active':
        return 'healthy'
      case 'stopping':
        return 'degraded'
      case 'exited':
      case 'failed':
      case 'disposed':
        return 'exited'
      default:
        return 'unknown'
    }
  }

  function isProcessAlive(state: InvocationState): boolean {
    return state !== 'exited' && state !== 'failed' && state !== 'disposed'
  }

  /** Live-state retention blockers (which conditions hold off idle retirement). */
  function computeRetentionBlockers(
    inv: Invocation
  ): Array<'active-turn' | 'pending-input' | 'pending-permission' | 'not-ready'> {
    const blockers: Array<'active-turn' | 'pending-input' | 'pending-permission' | 'not-ready'> = []
    if (inv.currentTurnId !== undefined) blockers.push('active-turn')
    if (inv.pending.length > 0) blockers.push('pending-input')
    if (inv.pendingPermissions.size > 0) blockers.push('pending-permission')
    if (inv.state === 'starting' || inv.state === 'stopping') blockers.push('not-ready')
    return blockers
  }

  function buildLifecycleView(inv: Invocation): InvocationLifecycleView | undefined {
    const overlay = inv.lifecycleOverlay
    if (overlay === undefined && inv.terminalReason === undefined) {
      return undefined
    }

    const blockedBy = computeRetentionBlockers(inv)
    const retention: InvocationLifecycleView['retention'] = {
      mode: overlay?.retention.mode ?? 'unknown',
    }
    if (overlay?.retention.mode === 'idle-ttl') {
      const { idleTtlMs } = overlay.retention
      retention.idleTtlMs = idleTtlMs
      const idleSince = inv.lastActivityAt
      if (idleSince !== undefined) {
        retention.idleSince = idleSince
        // computedRetireAt is only meaningful while nothing blocks retirement.
        if (blockedBy.length === 0) {
          retention.computedRetireAt = new Date(Date.parse(idleSince) + idleTtlMs).toISOString()
        }
      }
    }
    if (blockedBy.length > 0) {
      retention.blockedBy = blockedBy
    }

    const harnessRecovery: InvocationLifecycleView['harnessRecovery'] = {
      mode: overlay?.harnessRecovery.mode ?? 'unknown',
    }
    if (inv.currentHarnessGeneration !== undefined) {
      harnessRecovery.currentGeneration = inv.currentHarnessGeneration
    }

    const turnRetry: InvocationLifecycleView['turnRetry'] = {
      mode: overlay?.turnRetry.mode ?? 'unknown',
    }
    if (inv.currentTurnAttempt !== undefined) {
      turnRetry.currentAttempt = inv.currentTurnAttempt
    }

    const view: InvocationLifecycleView = { retention, harnessRecovery, turnRetry }
    if (overlay !== undefined) {
      view.policyId = overlay.policyId
      view.policyHash = overlay.policyHash
    }
    if (inv.terminalReason !== undefined) {
      view.terminalReason = inv.terminalReason
    }
    return view
  }

  function buildCurrentTurn(inv: Invocation): InvocationCurrentTurnSummary | undefined {
    if (inv.currentTurnId === undefined) return undefined
    const turn: InvocationCurrentTurnSummary = {
      turnId: inv.currentTurnId,
      startedAt: inv.currentTurnStartedAt ?? inv.lastActivityAt ?? inv.startedAt ?? '',
    }
    if (inv.currentInputId !== undefined) turn.inputId = inv.currentInputId
    if (inv.currentTurnAttempt !== undefined) turn.attempt = inv.currentTurnAttempt
    return turn
  }

  /**
   * Cached liveness view. This phase advertises liveness:'cached' only, so even
   * a probeLiveness request answers from projected facts with mode:'cached' (it
   * never issues tmux/process probes it cannot truthfully perform).
   */
  function buildLivenessView(inv: Invocation): InvocationLivenessView {
    const driverHealth = inv.driver.runtimeHealth?.()
    return {
      mode: 'cached',
      checkedAt: inv.lastActivityAt ?? inv.startedAt ?? '',
      driver: driverHealth ?? { state: inferDriverHealth(inv.state) },
      process: {
        brokerPid: process.pid,
        ...(inv.childPid !== undefined ? { childPid: inv.childPid } : {}),
        alive: isProcessAlive(inv.state),
        ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
        ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
      },
    }
  }

  function buildInspectionSummary(
    inv: Invocation,
    opts?: InspectionSummaryOptions
  ): InvocationInspectionSummary {
    const summary: InvocationInspectionSummary = {
      invocationId: inv.invocationId,
      state: inv.state,
      driver: inv.driver.kind,
      startedAt: inv.startedAt ?? inv.lastActivityAt ?? '',
      lastActivityAt: inv.lastActivityAt ?? inv.startedAt ?? '',
    }
    if (inv.turnsCompleted !== undefined) summary.turnsCompleted = inv.turnsCompleted
    if (inv.currentSeq !== undefined) summary.currentSeq = inv.currentSeq
    // currentTurn is always present (undefined when no turn is active) so a
    // cleared turn is observable as `currentTurn: undefined` rather than a
    // missing key after a terminal transition.
    summary.currentTurn = buildCurrentTurn(inv)
    const lifecycle = buildLifecycleView(inv)
    if (lifecycle !== undefined) summary.lifecycle = lifecycle
    if (inv.terminalSurface !== undefined) summary.terminalSurface = inv.terminalSurface
    if (opts?.probeLiveness === true || inv.driver.runtimeHealth?.().state === 'degraded') {
      summary.liveness = buildLivenessView(inv)
    }
    return summary
  }

  return {
    async start(
      spec: HarnessInvocationSpec,
      driver: Driver,
      initialInput?: InvocationInput | undefined,
      dispatchEnv?: DispatchEnv | undefined,
      runtime?: InvocationRuntimeContext | undefined,
      lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
    ): Promise<InvocationStartResponse> {
      // Check if there's already an active invocation
      for (const existing of invocations.values()) {
        if (!TERMINAL_STATES.has(existing.state) && existing.state !== 'disposed') {
          throw new BrokerError(
            BrokerErrorCode.InvalidInvocationState,
            'A non-terminal invocation already exists; single-invocation broker rejects concurrent starts',
            { existingInvocationId: existing.invocationId }
          )
        }
      }

      const invocationId =
        spec.invocationId ??
        (`inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` as InvocationId)

      const driverCaps = driver.capabilities()
      assertLifecyclePolicySupported(lifecyclePolicy, driverCaps)
      // T-03779: reject a JSON Schema initialInput on an unsupporting driver
      // BEFORE driver.start and before the invocation is registered, so no
      // input.accepted/input.rejected is emitted and the driver never sees it.
      if (
        initialInput !== undefined &&
        requestsJsonSchemaResponse(initialInput) &&
        !supportsJsonSchemaResponse(driverCaps)
      ) {
        throw new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          REASON_UNSUPPORTED_FINAL_RESPONSE
        )
      }
      const composedQueue =
        driverCaps.input.queue === true &&
        // input.user is a capability-dependency check (queueing requires user-input capability),
        // NOT a second queue flag.
        driverCaps.input.user === true &&
        spec.interaction?.inputQueue === 'fifo'
      const capabilities: InvocationCapabilities = {
        ...driverCaps,
        admission: {
          // Admission is a driver declaration, not an inference from method
          // presence. A driver may retain a legacy input method without being
          // able to provide the evidence required by a v0.3 admission class.
          classes: [...driverCaps.admission.classes],
        },
        bracketMintingMode: driver.bracketMintingMode,
        queue: { cancelHarnessLocal: false },
        preempt: { mode: driver.preemptMode },
        steer: { landingEvidence: driver.steerLandingEvidence },
        interrupt: { landingEvidence: driver.interruptLandingEvidence },
        input: {
          ...driverCaps.input,
          // Broker-composed: the public surface reflects the composed value,
          // NOT the raw driver-reported value.
          queue: composedQueue,
          // T-07155: advertise what THIS broker process can execute. Clients
          // negotiate against this instead of assuming an installed upgrade
          // reached a long-lived broker; `steer` appears iff the driver can
          // actually write into the active turn.
          busyPolicies: [
            ...LEGACY_BUSY_POLICIES,
            ...(driver.applySteerNow !== undefined ? (['steer'] as const) : []),
          ],
        },
      }

      // Two-step because the capture gate's emit callbacks close over `inv`:
      // the record exists first, then its normalization cursor is attached.
      const inv = {
        invocationId,
        spec,
        state: 'starting',
        capabilities,
        driver,
        terminalEmitted: false,
        disposedEmitted: false,
        pending: [],
        brokerQueue: [],
        submissions: new Map(),
        submissionDispositions: new Map(),
        turnManifests: new Map(),
        currentTurnPolicy: 'open',
        currentTurnRequestInFlight: false,
        submissionCounter: 0,
        inputCounter: 0,
        inputDispositions: new Map(),
        startedTurns: new Map(),
        terminalTurns: new Map(),
        startedToolCalls: new Map(),
        pendingPermissions: new Map(),
        settledPermissions: new Map(),
      } as unknown as Invocation
      inv.capture = createCaptureGate({
        invocationId,
        journal: createRawJournal({
          invocationId,
          ...(options.captureDir !== undefined ? { dir: options.captureDir } : {}),
          now,
        }),
        index: requireCaptureIndex(),
        normalizer: { name: driver.kind, version: driver.version },
        now,
        ...(options.logWarn !== undefined ? { warn: options.logWarn } : {}),
        // The gate's own events are BROKER facts about capture, never provider
        // observations — so they carry broker provenance explicitly rather than
        // inheriting the `diagnostic` family's declared authority from the
        // driver tag. Without this a driver whose diagnostics come from hooks
        // would publish `capture.warning` as hook-observed, which it never is.
        emitWarning: (payload: CaptureWarningPayload) =>
          emit(inv, 'capture.warning', payload, {
            driver: { kind: driver.kind },
            provenance: brokerProvenance,
          }).seq,
        emitReleased: (payload: CaptureReleasedPayload) =>
          emit(inv, 'capture.released', payload, {
            driver: { kind: driver.kind },
            provenance: brokerProvenance,
          }).seq,
        emitNormalizedAs: (releaseSpec, provenance) =>
          emitEvent(
            inv,
            {
              type: releaseSpec.type,
              payload: releaseSpec.payload,
            } as InvocationEvent,
            {
              ...(releaseSpec.turnId !== undefined ? { turnId: releaseSpec.turnId } : {}),
              ...(releaseSpec.itemId !== undefined ? { itemId: releaseSpec.itemId } : {}),
              driver: { kind: driver.kind },
              provenance,
            }
          ).seq,
      })
      invocations.set(invocationId, inv)

      const ctx: DriverContext = {
        invocationId,
        clientCapabilities: getClientCapabilities(),
        ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        capture: inv.capture,
        emit<K extends InvocationEventType>(
          type: K,
          payload: InvocationEventPayloadMap[K],
          extra?: Parameters<typeof emit>[3]
        ) {
          return emit(inv, type, payload, extra)
        },
        emitEvent: (event, extra) => emitEvent(inv, event, extra),
        admissionStateChanged: () => scheduleAdmissionDrain(inv),
        ...(onPermissionRequest !== undefined
          ? {
              // Broker-owned permission lifecycle (C2): the driver hands the
              // request to the broker, which holds it until an absolute
              // deadline, survives controller disconnect, emits
              // permission.resolved, and returns the final decision.
              requestPermission: (params) => brokerRequestPermission(inv, params),
              brokerOwnsPermissionLifecycle: true,
            }
          : {}),
      }

      if (lifecyclePolicy !== undefined) {
        // Retain the FULL accepted overlay on the record so the inspection
        // lifecycle view can report idle-ttl details without reconstructing them
        // from the accepted-policy event (which only carries the modes).
        inv.lifecycleOverlay = lifecyclePolicy
        emit(inv, 'lifecycle.policy.accepted', acceptedLifecyclePolicy(lifecyclePolicy))
      }

      try {
        await driver.start(spec, ctx)
      } catch (err) {
        inv.state = 'failed'
        emitTerminal(inv, 'invocation.failed', {
          message: err instanceof Error ? err.message : 'Driver start failed',
        })
        throw err
      }

      if (!inv.terminalEmitted) {
        // Synthetic invocation.started is a fallback for drivers that do not emit
        // their own harness.started; skip it when a real harness.started arrived.
        if (inv.state === 'starting' && inv.harnessStartedSeen !== true) {
          emit(inv, 'invocation.started', {
            command: spec.process.command,
            args: spec.process.args,
            cwd: spec.process.cwd,
          })
        }
        if (inv.state !== 'ready') {
          emit(inv, 'invocation.ready', { state: 'ready' })
        }
      }

      inv.state = 'ready'

      // Apply initialInput through the same broker-owned path as client.input()
      if (initialInput !== undefined && !inv.terminalEmitted) {
        const inputId = resolveInputId(inv, initialInput)
        const inputWithId: InvocationInputWithId = { ...initialInput, inputId }
        const submission = registerLegacySubmission(inv, 'exclusive', inputWithId)
        admitSubmission(inv, submission)
        try {
          await applyAndEmit(inv, inputWithId)
        } catch (error) {
          rejectAdmittedExecution(inv, submission, error)
          throw error
        }
      }

      return {
        invocationId,
        state: inv.state,
        capabilities: inv.capabilities,
        ...(lifecyclePolicy !== undefined
          ? { acceptedLifecyclePolicy: acceptedLifecyclePolicy(lifecyclePolicy) }
          : {}),
      }
    },

    async steer(req: SubmissionSteerRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'steer', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      const response = admitSubmission(inv, record)
      if (inv.state === 'ready') {
        void applyAndEmit(inv, record.input).catch((error) =>
          rejectAdmittedExecution(inv, record, error)
        )
      } else {
        void attemptSteerAndEmit(inv, record.input).then((result) => {
          if (!result.accepted)
            rejectAdmittedExecution(inv, record, result.reason ?? 'steer-failed')
        })
      }
      return response
    },

    async enqueue(req: SubmissionEnqueueRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'queue', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      if (inv.brokerQueue.length >= maxQueueDepth) {
        return rejectSubmission(inv, record, 'state', REASON_QUEUE_FULL)
      }
      const response = admitSubmission(inv, record)
      holdSubmission(inv, record, 'queue', req.ttlMs)
      scheduleAdmissionDrain(inv)
      return response
    },

    async invoke(req: SubmissionInvokeRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'exclusive', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      if (inv.state === 'turn_active' || inv.pendingOwnTurnSubmissionId !== undefined) {
        return rejectSubmission(inv, record, 'state', 'busy')
      }
      const response = admitSubmission(inv, record)
      void applyAndEmit(inv, record.input).catch((error) =>
        rejectAdmittedExecution(inv, record, error)
      )
      return response
    },

    async preempt(req: SubmissionPreemptRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'preempt', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      const response = admitSubmission(inv, record)
      holdSubmission(inv, record, 'preempt', req.ttlMs)
      if (inv.state === 'turn_active') {
        if (inv.driver.preemptMode === 'quiescence') maybeRequestPreemptInterrupt(inv)
        else void requestPreemptInterrupt(inv, record)
      } else scheduleAdmissionDrain(inv)
      return response
    },

    withdraw(req: SubmissionWithdrawRequest): SubmissionWithdrawResponse {
      return withdrawHeldSubmission(req)
    },

    queueList(invocationId: InvocationId): QueueListResponse {
      const inv = requireInvocation(invocationId)
      return { entries: inv.brokerQueue.map(queueEntry) }
    },

    async queueJump(req: QueueJumpRequest): Promise<QueueJumpResponse> {
      const inv = requireInvocation(req.invocationId)
      const fromPosition = inv.brokerQueue.findIndex(
        (item) => item.record.submissionId === req.submissionId
      )
      if (fromPosition < 0) return { jumped: false, reason: 'not-broker-held' }
      const queued = inv.brokerQueue[fromPosition]
      if (queued === undefined) return { jumped: false, reason: 'not-broker-held' }
      const toPosition = Math.max(0, Math.min(req.position, inv.brokerQueue.length - 1))
      const authorized = await authorizeQueueJump({
        invocationId: inv.invocationId,
        principalRef: req.principalRef,
        submissionOrigin: queued.record.origin,
        fromPosition,
        toPosition,
      })
      if (!authorized) return { jumped: false, reason: 'authority-denied' }
      const [item] = inv.brokerQueue.splice(fromPosition, 1)
      if (item === undefined) return { jumped: false, reason: 'not-broker-held' }
      inv.brokerQueue.splice(toPosition, 0, item)
      emit(inv, 'queue.jumped', {
        submissionId: req.submissionId,
        fromPosition,
        toPosition,
        principalRef: req.principalRef,
      })
      scheduleAdmissionDrain(inv)
      return { jumped: true }
    },

    async queueCancel(req: QueueCancelRequest): Promise<QueueCancelResponse> {
      const inv = requireInvocation(req.invocationId)
      const index = inv.brokerQueue.findIndex(
        (item) => item.record.submissionId === req.submissionId
      )
      if (index < 0) return { cancelled: false, reason: 'not-broker-held' }
      const item = inv.brokerQueue[index]
      if (
        item === undefined ||
        (item.record.origin.principalRef !== req.principalRef && !isOperator(req.principalRef))
      ) {
        return { cancelled: false, reason: 'authority-denied' }
      }
      inv.brokerQueue.splice(index, 1)
      if (item.timer !== undefined) clearTimeout(item.timer)
      emit(inv, 'queue.cancelled', {
        submissionId: req.submissionId,
        principalRef: req.principalRef,
      })
      emit(inv, 'submission.cancelled', {
        submissionId: req.submissionId,
        reason: 'broker-cancelled',
      })
      return { cancelled: true }
    },

    turnManifest(invocationId: InvocationId, turnId: TurnId): TurnManifestResponse {
      const inv = requireInvocation(invocationId)
      return (
        inv.turnManifests.get(turnId) ?? {
          invocationId,
          turnId,
          policy: 'open',
          submissionIds: [],
        }
      )
    },

    seatProbe(invocationId: InvocationId): SeatProbeResponse {
      const inv = requireInvocation(invocationId)
      const seat =
        inv.state === 'ready' && inv.pendingOwnTurnSubmissionId !== undefined
          ? ({ state: 'starting' } as const)
          : inv.state === 'ready'
            ? ({ state: 'idle' } as const)
            : inv.state === 'turn_active' && inv.currentTurnId !== undefined
              ? ({
                  state: 'turn-active',
                  turnId: inv.currentTurnId,
                  policy: inv.currentTurnPolicy,
                } as const)
              : inv.state === 'starting'
                ? ({ state: 'starting' } as const)
                : inv.state === 'stopping'
                  ? ({ state: 'stopping' } as const)
                  : ({ state: 'terminal' } as const)
      return { invocationId, seat, brokerHeldDepth: inv.brokerQueue.length }
    },

    async input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
      const inv = requireInvocation(req.invocationId)

      // inputId idempotency: a duplicate client-provided inputId replays the
      // original response when content/policy is byte-identical, or conflicts
      // when it differs. Checked before any state validation so a retry never
      // re-drives a turn or trips a stale-state rejection.
      const providedInputId = req.input.inputId
      if (providedInputId !== undefined) {
        const existing = inv.inputDispositions.get(providedInputId)
        if (existing !== undefined) {
          if (existing.fingerprint === fingerprintInput(req)) {
            return existing.response
          }
          throw new BrokerError(
            BrokerErrorCode.DuplicateInputConflict,
            `Duplicate inputId ${providedInputId} differs by content, policy, or responseFormat`,
            { invocationId: inv.invocationId, inputId: providedInputId }
          )
        }
      }

      // Resolve inputId upfront — stable across all paths
      const rawInput = req.input
      const inputId = resolveInputId(inv, rawInput)
      const input: InvocationInputWithId = { ...rawInput, inputId }
      const seatBusy = inv.state === 'turn_active' || inv.pendingOwnTurnSubmissionId !== undefined
      const admissionClass: SubmissionClass = seatBusy
        ? req.policy?.whenBusy === 'queue'
          ? 'queue'
          : req.policy?.whenBusy === 'interrupt_then_apply'
            ? 'preempt'
            : req.policy?.whenBusy === 'steer' || input.kind === 'steer'
              ? 'steer'
              : 'exclusive'
        : input.kind === 'steer'
          ? 'steer'
          : 'exclusive'
      const submission = registerLegacySubmission(inv, admissionClass, input)

      const rejectLegacy = (
        layer: AdmissionLayer,
        reason: string,
        code: BrokerErrorCode = BrokerErrorCode.InputRejected
      ): never => {
        rejectSubmission(inv, submission, layer, reason)
        emit(inv, 'input.rejected', { inputId, reason }, { inputId })
        throw new BrokerError(code, reason, { invocationId: inv.invocationId, inputId })
      }
      const rejectLegacyResponse = (
        layer: AdmissionLayer,
        reason: string
      ): InvocationInputResponse => {
        rejectSubmission(inv, submission, layer, reason)
        const response = rejectQueueInput(inv, inputId, reason)
        recordDisposition(inv, req, response)
        return response
      }

      // Invalid state rejection
      if (inv.state !== 'ready' && inv.state !== 'turn_active') {
        rejectLegacy(
          'state',
          `Cannot accept input in state: ${inv.state}`,
          BrokerErrorCode.InvalidInvocationState
        )
      }

      if (input.kind === 'steer' && !inv.capabilities.input.steer) {
        rejectLegacy(
          'capability',
          'UnsupportedCapability: input.steer',
          BrokerErrorCode.UnsupportedCapability
        )
      }
      if (input.kind === 'append_context' && !inv.capabilities.input.appendContext) {
        rejectLegacy(
          'capability',
          'UnsupportedCapability: input.appendContext',
          BrokerErrorCode.UnsupportedCapability
        )
      }
      // T-03779: a JSON Schema response format is accepted only when the driver
      // advertises per-turn structured support. Reject before input.accepted,
      // queueing, or driver apply.
      if (requestsJsonSchemaResponse(input) && !supportsJsonSchemaResponse(inv.capabilities)) {
        rejectLegacy(
          'capability',
          REASON_UNSUPPORTED_FINAL_RESPONSE,
          BrokerErrorCode.UnsupportedCapability
        )
      }

      // --- State: ready → apply immediately ---
      if (inv.state === 'ready' && inv.pendingOwnTurnSubmissionId === undefined) {
        admitSubmission(inv, submission)
        let result: ApplyInputResult
        try {
          result = await applyAndEmit(inv, input)
        } catch (error) {
          rejectAdmittedExecution(inv, submission, error)
          throw error
        }
        const response: InvocationInputResponse = {
          inputId,
          accepted: true,
          disposition: 'started',
          turnId: result.turnId,
        }
        recordDisposition(inv, req, response)
        return response
      }

      // --- State: turn_active → policy-driven ---
      const policy = req.policy

      // Default: no policy → reject (legacy behavior)
      const busyPolicy =
        policy ?? rejectLegacy('state', 'Input rejected: turn already active (no policy specified)')

      if (busyPolicy.whenBusy === 'reject') {
        rejectLegacy('state', REASON_BUSY_REJECTED)
      }
      if (busyPolicy.whenBusy === 'queue') {
        if (input.kind !== 'user') {
          return rejectLegacyResponse('capability', REASON_UNSUPPORTED_INPUT_KIND)
        }
        const queueEnabled =
          inv.spec.interaction?.inputQueue === 'fifo' && inv.capabilities.input.queue === true
        if (!queueEnabled) {
          return rejectLegacyResponse('capability', REASON_QUEUE_NOT_SUPPORTED)
        }
        if (
          inv.spec.interaction?.mode === 'interactive' &&
          inv.driver.applySteerNow !== undefined
        ) {
          admitSubmission(inv, submission)
          const response = await attemptSteerAndEmit(inv, input)
          if (!response.accepted) {
            rejectAdmittedExecution(inv, submission, response.reason ?? REASON_STEER_NOT_SUPPORTED)
          }
          recordDisposition(inv, req, response)
          return response
        }
        if (inv.pending.length >= maxQueueDepth) {
          return rejectLegacyResponse('state', REASON_QUEUE_FULL)
        }
        admitSubmission(inv, submission)
        inv.pending.push({ inputId, input })
        emit(inv, 'input.queued', { inputId, disposition: 'queued' }, { inputId })
        const response: InvocationInputResponse = {
          inputId,
          accepted: true,
          disposition: 'queued',
        }
        recordDisposition(inv, req, response)
        return response
      }
      if (busyPolicy.whenBusy === 'interrupt_then_apply') {
        return rejectLegacyResponse('capability', REASON_UNSUPPORTED_BUSY_POLICY)
      }
      if (input.kind !== 'user') {
        return rejectLegacyResponse('capability', REASON_UNSUPPORTED_INPUT_KIND)
      }
      if (inv.driver.applySteerNow === undefined) {
        return rejectLegacyResponse('capability', REASON_STEER_NOT_SUPPORTED)
      }
      if (inv.currentTurnPolicy === 'guarded') {
        return rejectLegacyResponse('policy', 'guarded')
      }
      admitSubmission(inv, submission)
      const response = await attemptSteerAndEmit(inv, input)
      if (!response.accepted) rejectAdmittedExecution(inv, submission, response.reason)
      recordDisposition(inv, req, response)
      return response
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      const inv = requireInvocation(req.invocationId)
      if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
        return { accepted: false, effect: 'no_active_turn', reason: `Invocation is ${inv.state}` }
      }
      const turnId = inv.currentTurnId
      emit(inv, 'interrupt.requested', {
        ...(turnId !== undefined ? { turnId } : {}),
      })
      try {
        const response = await inv.driver.interrupt(req)
        if (response.accepted) {
          emit(inv, 'interrupt.landed', {
            ...(turnId !== undefined ? { turnId } : {}),
          })
        } else {
          emit(inv, 'interrupt.failed', {
            ...(turnId !== undefined ? { turnId } : {}),
            reason: response.reason ?? response.effect,
          })
        }
        return response
      } catch (error) {
        emit(inv, 'interrupt.failed', {
          ...(turnId !== undefined ? { turnId } : {}),
          reason: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      const inv = requireInvocation(req.invocationId)

      if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
        return { accepted: false, state: inv.state }
      }

      inv.state = 'stopping'
      emit(inv, 'invocation.stopping', { reason: req.reason })

      const result = await inv.driver.stop(req)

      // Terminal state determined by driver
      const terminalState = result.state === 'failed' ? 'failed' : 'exited'
      inv.state = terminalState

      if (terminalState === 'failed') {
        emitTerminal(inv, 'invocation.failed', {
          message: req.reason ?? 'Stopped',
        })
      } else {
        emitTerminal(inv, 'invocation.exited', {})
      }

      return { accepted: true, state: inv.state }
    },

    status(invocationId: InvocationId, opts?: InspectionSummaryOptions): InvocationStatusResponse {
      const inv = requireInvocation(invocationId)
      // status() projects through the shared inspection summary, then layers the
      // status-only fields (capabilities/continuation/process + legacy ids).
      const response: InvocationStatusResponse = {
        ...buildInspectionSummary(inv, opts),
        capabilities: inv.capabilities,
        continuation: inv.continuation,
      }
      if (inv.currentTurnId !== undefined) {
        response.currentTurnId = inv.currentTurnId
      }
      if (inv.currentHarnessGeneration !== undefined) {
        response.currentHarnessGeneration = inv.currentHarnessGeneration
      }
      if (inv.currentTurnAttempt !== undefined) {
        response.currentTurnAttempt = inv.currentTurnAttempt
      }
      // Project child-process info when any of pid/exitCode/signal is known.
      if (inv.childPid !== undefined || inv.exitCode !== undefined || inv.signal !== undefined) {
        response.process = {
          ...(inv.childPid !== undefined ? { pid: inv.childPid } : {}),
          ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
          ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
        }
      }
      return response
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      const inv = requireInvocation(req.invocationId)

      // Idempotent: a second dispose neither re-runs the driver nor re-emits.
      if (inv.state === 'disposed' || inv.disposedEmitted) {
        return { disposed: true }
      }

      if (!TERMINAL_STATES.has(inv.state)) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Cannot dispose invocation in state: ${inv.state}`,
          { invocationId: inv.invocationId, state: inv.state }
        )
      }

      await inv.driver.dispose()

      // emit() → applyEventState sets state = 'disposed' and disposedEmitted.
      emit(inv, 'invocation.disposed', { disposed: true })

      return { disposed: true }
    },

    failForStorage(invocationId: InvocationId, detail: string): void {
      const inv = invocations.get(invocationId)
      if (inv === undefined || inv.state === 'disposed') {
        return
      }
      const wasTerminal = TERMINAL_STATES.has(inv.state)
      if (!wasTerminal) {
        inv.state = 'failed'
      }
      emitTerminal(inv, 'invocation.failed', {
        message: `Event ledger append failed: ${detail}`,
        reason: LEDGER_APPEND_FAILED,
        code: 'LEDGER_APPEND_FAILED',
        retryable: false,
        data: { detail },
      })
      // Best effort and out of band: the caller is inside the publish path, so
      // this must neither block it nor let a driver rejection escape into it.
      void (async () => {
        try {
          await inv.driver.stop({ invocationId, reason: LEDGER_APPEND_FAILED })
        } catch {
          // The driver is being torn down because storage is already broken;
          // a stop failure changes nothing we can still record.
        }
        try {
          await inv.driver.dispose()
        } catch {
          // Same: dispose is the last cleanup step, with nowhere left to report.
        }
      })()
    },

    captureRelease(req: InvocationCaptureReleaseRequest): InvocationCaptureReleaseResponse {
      const inv = requireInvocation(req.invocationId)
      try {
        const outcome = inv.capture.release({
          rawRecordId: req.rawRecordId,
          disposition: req.disposition,
          ...(req.normalizedAs !== undefined ? { normalizedAs: req.normalizedAs } : {}),
          ...(req.note !== undefined ? { note: req.note } : {}),
        })
        return {
          released: true,
          invocationId: req.invocationId,
          rawRecordId: req.rawRecordId,
          disposition: outcome.disposition,
          releasedSeq: outcome.releasedSeq,
          ...(outcome.normalizedSeq !== undefined ? { normalizedSeq: outcome.normalizedSeq } : {}),
          resumedRecords: outcome.resumedRecords,
          capture: outcome.capture,
        }
      } catch (error) {
        if (error instanceof CaptureRecordNotBlockedError) {
          // A release naming a record that is not the blocking one is an
          // operator mistake, not a broker fault: answer typed with the record
          // the cursor IS blocked on so the operator can correct it.
          throw new BrokerError(
            // JSON-RPC Invalid Params. The enum has no member for it (it names
            // broker-domain codes); -32602 is the standard code the transport
            // already returns for a malformed request, and a release naming the
            // wrong record is exactly that.
            -32602 as BrokerErrorCode,
            `Raw record ${req.rawRecordId} is not the blocked-unknown record for ${req.invocationId}`,
            {
              reason: CAPTURE_RELEASE_NOT_BLOCKED,
              invocationId: req.invocationId,
              rawRecordId: req.rawRecordId,
              capture: inv.capture.state(),
            }
          )
        }
        throw error
      }
    },

    captureState(invocationId: InvocationId): CaptureStateView | undefined {
      return invocations.get(invocationId)?.capture.state()
    },

    replayPendingCapture(invocationId: InvocationId): number {
      const inv = invocations.get(invocationId)
      if (inv === undefined) return 0
      const normalize = inv.driver.captureNormalizer?.()
      if (normalize === undefined) return 0
      return inv.capture.replayPending(normalize)
    },

    permissionRespond(
      req: InvocationPermissionRespondRequest
    ): InvocationPermissionRespondResponse {
      const inv = requireInvocation(req.invocationId)

      const pending = inv.pendingPermissions.get(req.permissionRequestId)
      if (pending !== undefined) {
        // Settle the broker-owned pending request: emits permission.resolved and
        // resolves the driver's awaiting decision.
        pending.settle(req.decision, 'user')
        return {
          status: 'accepted',
          permissionRequestId: req.permissionRequestId,
          decision: req.decision,
        }
      }

      const settled = inv.settledPermissions.get(req.permissionRequestId)
      if (settled === undefined) {
        throw new BrokerError(
          BrokerErrorCode.UnknownPermissionRequest,
          `Unknown permission request: ${req.permissionRequestId}`,
          { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId }
        )
      }

      // Settled by deadline expiry — a respond can no longer take effect.
      if (settled.expired) {
        throw new BrokerError(
          BrokerErrorCode.PermissionResponseExpired,
          `Permission request already expired: ${req.permissionRequestId}`,
          { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId }
        )
      }

      // Already answered: replay the original decision, or conflict on a mismatch.
      if (settled.decision === req.decision) {
        return {
          status: 'duplicate',
          permissionRequestId: req.permissionRequestId,
          originalDecision: settled.decision,
        }
      }
      throw new BrokerError(
        BrokerErrorCode.PermissionResponseConflict,
        `Permission request already decided ${settled.decision}; cannot change to ${req.decision}`,
        {
          invocationId: req.invocationId,
          permissionRequestId: req.permissionRequestId,
          originalDecision: settled.decision,
          attemptedDecision: req.decision,
        }
      )
    },

    get(invocationId: InvocationId): Invocation | undefined {
      return invocations.get(invocationId)
    },

    buildInspectionSummary(
      invocationId: InvocationId,
      opts?: InspectionSummaryOptions
    ): InvocationInspectionSummary {
      return buildInspectionSummary(requireInvocation(invocationId), opts)
    },

    listInvocations(req: BrokerListInvocationsRequest): BrokerListInvocationsResponse {
      const includeDisposed = req.includeDisposed === true
      const opts: InspectionSummaryOptions = {
        ...(req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : {}),
      }
      const invocationsOut: InvocationInspectionSummary[] = []
      for (const inv of invocations.values()) {
        if (inv.state === 'disposed' && !includeDisposed) continue
        invocationsOut.push(buildInspectionSummary(inv, opts))
      }
      return { invocations: invocationsOut }
    },

    activeCount(): number {
      let count = 0
      for (const inv of invocations.values()) {
        if (!TERMINAL_STATES.has(inv.state) && inv.state !== 'disposed') {
          count++
        }
      }
      return count
    },
  }
}
