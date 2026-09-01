import type {
  InputId,
  InvocationId,
  MessageId,
  PermissionRequestId,
  ToolCallId,
  TurnId,
} from './ids'
import type { InvocationInspectionSummary } from './invocation'
import type {
  HarnessExitedPayload,
  HarnessRecoveryCompletedPayload,
  HarnessRecoveryFailedPayload,
  HarnessRecoveryStartedPayload,
  HarnessStartedPayload,
  LifecycleEscalationPayload,
  LifecyclePolicyAcceptedPayload,
  PermissionCancelledPayload,
  TurnRetryPayload,
  TurnStalledPayload,
} from './lifecycle'
import type { IsoTimestamp } from './primitives'

export interface InvocationEventEnvelopeBase {
  invocationId: InvocationId
  seq: number
  time: IsoTimestamp
  turnId?: TurnId | undefined
  inputId?: InputId | undefined
  itemId?: string | undefined
  correlation?: Record<string, string> | undefined
  driver?:
    | {
        kind: string
        rawType?: string | undefined
      }
    | undefined
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
}

/**
 * A single invocation event with its name and payload coupled by
 * {@link InvocationEventPayloadMap}. This non-distributive form is useful to
 * generic producers that already hold one concrete event key.
 */
export type InvocationEventEnvelopeFor<K extends InvocationEventType> =
  InvocationEventEnvelopeBase & {
    type: K
    payload: InvocationEventPayloadMap[K]
  }

export type InvocationEventFor<K extends InvocationEventType> = {
  type: K
  payload: InvocationEventPayloadMap[K]
}

/** A correlated event-name/payload pair without envelope metadata. */
export type InvocationEvent<K extends InvocationEventType = InvocationEventType> =
  K extends InvocationEventType ? InvocationEventFor<K> : never

/**
 * The public discriminated envelope union. With the default type argument,
 * narrowing `type` also narrows `payload`; passing a concrete K selects the
 * corresponding envelope member.
 */
export type InvocationEventEnvelope<K extends InvocationEventType = InvocationEventType> =
  K extends InvocationEventType ? InvocationEventEnvelopeFor<K> : never

/** Invocation event names are authoritative map keys, never a parallel union. */
export type InvocationEventType = keyof InvocationEventPayloadMap

/**
 * Provider-transcript provenance contract (T-05374).
 *
 * ASP is the SOLE canonical producer-side source for the broker event that
 * reports where a raw provider transcript artifact lives. These constants pin
 * the event name and the artifact's kind / storage / media-type / schema so
 * producers (the codex-app-server driver) and downstream consumers (HRC) agree
 * without stringly-typed drift. Rows under {@link PROVIDER_TRANSCRIPT_SCHEMA}
 * are NDJSON JSON objects preserving the raw upstream Codex app-server JSON-RPC
 * notifications received BEFORE normalization (`jsonrpc: '2.0'`, `method`,
 * optional `params`). Broker envelopes, normalized broker events, mapper
 * output, HRC state, and rendered transcript text are NOT valid sources.
 */
export const PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE = 'provider.transcript.reported' as const
export const PROVIDER_TRANSCRIPT_ARTIFACT_KIND = 'provider-transcript-jsonl' as const
export const PROVIDER_TRANSCRIPT_STORAGE = 'file-path' as const
export const PROVIDER_TRANSCRIPT_MEDIA_TYPE = 'application/x-ndjson' as const
export const PROVIDER_TRANSCRIPT_SCHEMA =
  'harness-broker.provider-transcript.codex-jsonrpc-notification-jsonl/v1' as const

/**
 * Payload for {@link PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE}. `artifactPath` is
 * an absolute path to a readable JSONL file whose rows conform to
 * {@link PROVIDER_TRANSCRIPT_SCHEMA}.
 */
export interface ProviderTranscriptReportedPayload {
  kind: typeof PROVIDER_TRANSCRIPT_ARTIFACT_KIND
  artifactPath: string
  provider: 'codex'
  harnessGeneration?: number | undefined
}

/**
 * Extra envelope metadata accepted by {@link emitProviderTranscriptReported}.
 * Mirrors the structural `extra` of the broker `DriverContext.emit` so the
 * driver call site needs no `as never` / stringly-typed names / untyped casts.
 */
export interface ProviderTranscriptReportedExtra {
  turnId?: TurnId | undefined
  inputId?: InputId | undefined
  itemId?: string | undefined
  driver?: { kind: string; rawType?: string | undefined } | undefined
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
}

/**
 * Minimal structural emit context compatible with the broker `DriverContext`.
 * Kept protocol-only so this package never imports `spaces-harness-broker` or
 * any HRC package.
 */
export interface ProviderTranscriptEmitContext {
  emit<K extends InvocationEventType>(
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: ProviderTranscriptReportedExtra
  ): InvocationEventEnvelopeFor<K>
}

/**
 * Typed producer helper so driver code emits `provider.transcript.reported`
 * with the correct event name and payload shape and no casts. When
 * `harnessGeneration` is supplied in BOTH the payload and the envelope extra,
 * the helper reconciles them to the same value so payload and envelope metadata
 * stay identical.
 */
export function emitProviderTranscriptReported(
  ctx: ProviderTranscriptEmitContext,
  payload: ProviderTranscriptReportedPayload,
  extra: ProviderTranscriptReportedExtra = {}
): InvocationEventEnvelopeFor<typeof PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE> {
  const harnessGeneration = payload.harnessGeneration ?? extra.harnessGeneration
  const mergedPayload: ProviderTranscriptReportedPayload =
    harnessGeneration !== undefined ? { ...payload, harnessGeneration } : payload
  const mergedExtra: ProviderTranscriptReportedExtra =
    harnessGeneration !== undefined ? { ...extra, harnessGeneration } : extra
  return ctx.emit(PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE, mergedPayload, mergedExtra)
}

/**
 * Pushed by the broker on a graceful session end (the user-exit
 * `continuation.cleared`) so a final, authoritative session summary is recorded
 * on the durable event stream BEFORE the lease is reaped — consumed downstream to
 * render an operator shutdown report without pulling the (by-then gone) live
 * broker read model.
 */
export interface InvocationSummaryPayload {
  summary: InvocationInspectionSummary
  /** The terminal reason that triggered the summary (e.g. `prompt_input_exit`). */
  reason?: string | undefined
}

/**
 * Canonical invocation event contract. This is the only event-name to payload
 * mapping; event-name unions, envelope members, sequencers, and emitters derive
 * from it so adding an event cannot leave the compile-time relationship behind.
 */
export interface InvocationEventPayloadMap {
  'invocation.started': InvocationStartedPayload
  'invocation.ready': InvocationReadyPayload
  'invocation.stopping': InvocationStoppingPayload
  'invocation.exited': InvocationExitedPayload
  'invocation.failed': InvocationFailedPayload
  'invocation.disposed': InvocationDisposedPayload
  'invocation.summary': InvocationSummaryPayload
  'lifecycle.policy.accepted': LifecyclePolicyAcceptedPayload
  'lifecycle.escalation': LifecycleEscalationPayload
  'harness.started': HarnessStartedPayload
  'harness.exited': HarnessExitedPayload
  'harness.recovery.started': HarnessRecoveryStartedPayload
  'harness.recovery.completed': HarnessRecoveryCompletedPayload
  'harness.recovery.failed': HarnessRecoveryFailedPayload
  'continuation.updated': ContinuationUpdate
  'continuation.cleared': ContinuationCleared
  'input.accepted': InputDispositionPayload
  'input.rejected': InputDispositionPayload
  'input.queued': InputDispositionPayload
  'submission.absorbed': SubmissionTurnDispositionPayload
  'submission.executed': SubmissionTurnDispositionPayload
  'submission.cancelled': SubmissionCancelledPayload
  'capture.warning': CaptureWarningPayload
  'turn.started': TurnStartedPayload
  'turn.stalled': TurnStalledPayload
  'turn.retry': TurnRetryPayload
  'turn.completed': TurnCompletedPayload
  'turn.failed': TurnFailedPayload
  'turn.interrupted': TurnInterruptedPayload
  'assistant.message.started': AssistantMessageStartedPayload
  'assistant.message.delta': AssistantMessageDeltaPayload
  'assistant.message.completed': AssistantMessageCompletedPayload
  'user.message': UserMessagePayload
  'tool.call.started': ToolCallStartedPayload
  'tool.call.delta': ToolCallDeltaPayload
  'tool.call.completed': ToolCallCompletedPayload
  'tool.call.failed': ToolCallFailedPayload
  'usage.updated': UsageUpdatedPayload
  diagnostic: DiagnosticPayload
  'driver.notice': DriverNoticePayload
  'terminal.surface.reported': TerminalSurfaceReportedPayload
  'permission.requested': PermissionRequestedPayload
  'permission.resolved': PermissionResolvedPayload
  'permission.cancelled': PermissionCancelledPayload
  'provider.transcript.reported': ProviderTranscriptReportedPayload
}

export type InvocationEventPayload = InvocationEventPayloadMap[InvocationEventType]

export interface InvocationStartedPayload {
  pid?: number | undefined
  command: string
  args: string[]
  cwd: string
}

export interface InvocationReadyPayload {
  state: 'ready'
}

export interface InvocationStoppingPayload {
  reason?: string | undefined
}

export interface InvocationDisposedPayload {
  disposed: true
}

export interface ContinuationUpdate {
  provider: string
  key: string
  kind?: string | undefined
}

/**
 * Drop a previously-captured continuation so the next launch starts a FRESH
 * session instead of resuming. Emitted when the harness observes a
 * USER-INITIATED end (e.g. Claude `/quit`), as opposed to an external
 * pane-kill / crash where the continuation must survive for `--resume`.
 * `reason` carries the raw driver end-reason for diagnostics.
 */
export interface ContinuationCleared {
  reason?: string | undefined
}

export interface TurnStartedPayload {
  turnId: TurnId
  inputId?: InputId | undefined
  turnAttempt?: number | undefined
  source?: 'broker-delivery' | 'hook-observed' | undefined
  sessionId?: string | undefined
  prompt?: string | undefined
}

/** A submission joined an already-open turn or originated its own turn. */
export interface SubmissionTurnDispositionPayload {
  submissionId: string
  turnId: TurnId
}

/** A submission left the harness-local queue without entering model context. */
export interface SubmissionCancelledPayload {
  submissionId: string
  reason?: 'recalled' | 'removed' | 'teardown' | undefined
}

/** Loud evidence that the behavior-pinned harness transcript vocabulary drifted. */
export interface CaptureWarningPayload {
  message: string
  raw: unknown
  /**
   * Stable machine-readable discriminator for warnings a consumer must be able
   * to act on rather than merely render. Optional: most capture warnings are
   * free-form driver diagnostics and carry only `message`/`raw`.
   *
   * Known kinds:
   * - `ledger_tail_repaired` — the broker truncated a torn trailing record from
   *   the durable event ledger at startup (a crash mid-append). `raw` carries
   *   the truncation offset and byte count.
   */
  kind?: string | undefined
}

/**
 * A user-typed prompt captured at submit time. Emitted by interactive tmux
 * drivers (claude-code-tmux / codex-cli-tmux) alongside `turn.started` so the
 * prompt text the operator typed directly into the harness TUI flows onto the
 * durable event stream — previously dropped for non-headless turns. `content`
 * is the raw prompt string (role is implicitly `user`).
 */
export interface UserMessagePayload {
  content: string
  inputId?: InputId | undefined
  role?: 'user' | undefined
  turnId?: TurnId | undefined
}

export interface AssistantMessageStartedPayload {
  messageId: MessageId
}

export interface AssistantMessageDeltaPayload {
  messageId: MessageId
  text: string
}

export interface AssistantMessageCompletedPayload {
  messageId: MessageId
  content: Array<{ type: 'text'; text: string }>
  final?: boolean | undefined
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId
  name: string
  input?: unknown
}

export interface ToolCallDeltaPayload {
  toolCallId: ToolCallId
  text?: string | undefined
  data?: unknown
}

/**
 * Terminal-outcome contract (T-06550, daedalus-ruled 2026-07-18).
 *
 * `tool.call.completed` means the provider reached its terminal RESULT
 * BOUNDARY. Unsuccessful results STAY completed: a domain operation that ran
 * and returned an error (`isError:true`), a rejected domain op, and — critically
 * — a nonzero process exit are all `completed`, NOT `failed`. `isError` reports
 * a DOMAIN error signal only; it is NEVER derived from a process exit code.
 *
 * Process-backed tools carry the raw status at the neutral path
 * `result.exitCode` and NOWHERE else — consumers read forensic exit status from
 * there and must not infer the event type or `isError` from it. Canonical
 * `exitCode` location per driver family (verified against real tool_response
 * payloads):
 *   - codex-app-server: `result.exitCode` (mapper projects the item's top-level
 *     `exitCode` into the neutral `result.exitCode`).
 *   - claude-code-tmux / codex-cli-tmux / pi-tui-tmux: the driver passes the raw
 *     hook `tool_response` through VERBATIM as `result.details` and derives no
 *     exit code of its own. Fixture-provided exit status therefore surfaces at
 *     exactly the key the hook used: `result.details.exit_code` (snake_case), NOT
 *     a top-level `result.exitCode` and NOT `result.details.exitCode`.
 *   - claude-code-tmux live capture (2026-07-24): real Claude Code Bash
 *     `PostToolUse.tool_response` carried `stdout`, `stderr`, `interrupted`,
 *     `isImage`, and `noOutputExpected`, but NO exit-code field. Therefore current
 *     live Claude Code events expose no process exit status at any path; consumers
 *     must treat fixture-shaped `result.details.exit_code` as optional future /
 *     compatibility data only.
 */
export interface ToolCallCompletedPayload {
  toolCallId: ToolCallId
  name: string
  result?: unknown
  isError?: boolean | undefined
  durationMs?: number | undefined
}

export interface TurnCompletedPayload {
  turnId: TurnId
  status: 'completed' | 'failed' | 'interrupted'
  finalOutput?: string | undefined
  /** Compatibility projection included on observer notifications. */
  result?: unknown
  /**
   * Whether the turn produced observable content (assistant text OR tool
   * activity). A tool-only turn sets this true even with an empty finalOutput;
   * an empty finalOutput alone is NOT an empty_response (T-01522).
   */
  producedContent?: boolean | undefined
  usage?: unknown
}

export interface TurnFailedPayload {
  turnId: TurnId
  status?: 'failed' | undefined
  message: string
  finalOutput?: string | undefined
  code?: string | undefined
  data?: unknown
  retryable?: boolean | undefined
  reason?: 'harness-stalled' | 'retry-unsafe' | 'retry-exhausted' | string | undefined
  turnAttempt?: number | undefined
  retrySuppressed?: boolean | undefined
}

export interface TurnInterruptedPayload {
  turnId: TurnId
  status?: 'interrupted' | undefined
  finalOutput?: string | undefined
  reason?: string | undefined
}

/**
 * Terminal-outcome contract (T-06550). `tool.call.failed` means the call
 * terminated WITHOUT reaching a result boundary: the invocation failed or was
 * rejected before a result existed (malformed args pre-execution, spawn /
 * transport / handler failure, timeout, cancellation) — OR the broker
 * synthesized this terminal because the provider started the call and never
 * closed it (the burn-in-19 vanished-call defect; see the tool-call bracket in
 * `invocation-manager`). A nonzero process exit is NOT a failure — it reached a
 * result boundary and is reported as `completed`.
 *
 * `message` is REQUIRED and `code` is ALWAYS populated: the machine-readable
 * `code` is the sole stable discriminator downstream, so it is a required field
 * (not optional) — every producer, including the broker's teardown synthesizer,
 * must set it. The `validateEventEnvelope` contract test pins both.
 */
export interface ToolCallFailedPayload {
  toolCallId: ToolCallId
  name: string
  message: string
  code: string
  data?: unknown
}

export interface DiagnosticPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source?: 'broker' | 'harness' | 'driver' | undefined
  kind?: string | undefined
  data?: unknown
}

export interface InvocationExitedPayload {
  exitCode?: number | null | undefined
  signal?: string | null | undefined
  reason?: 'idle-ttl' | 'operator-stop' | 'process-exit' | string | undefined
  droppedContinuation?: boolean | undefined
}

export interface InvocationFailedPayload {
  message: string
  code?: string | undefined
  data?: unknown
  retryable?: boolean | undefined
  reason?:
    | 'idle-retire-timeout'
    | 'harness-stalled'
    | 'stall-unrecoverable'
    | 'runner-degraded'
    | string
    | undefined
}

export interface InputDispositionPayload {
  inputId: InputId
  disposition?: 'started' | 'queued' | 'attempted_steer' | 'rejected' | undefined
  reason?: string | undefined
}

export interface UsageUpdatedPayload {
  usage: unknown
}

export interface DriverNoticePayload {
  message: string
  code?: string | undefined
  data?: unknown
}

/**
 * Discriminated payload for `terminal.surface.reported`.
 *
 * - `tmux-session` (legacy): emitted by drivers on the pre-lease path. The
 *   driver reports the runtime tmux socket plus the observed session name
 *   and optional pane id. Stays valid for non-leased routes.
 * - `tmux-pane`: emitted by drivers operating from a runtime-owned pane
 *   lease (Phase C/D). Carries the full pane coordinates so consumers can
 *   address the pane directly without re-resolving via session name.
 *
 * Schema assertion (see `validateEventEnvelope`): when the envelope's
 * `driver.kind` is `claude-code-tmux` or `codex-cli-tmux`, the payload kind
 * MUST be `tmux-pane`.
 */
export type TerminalSurfaceReportedPayload =
  | {
      kind: 'tmux-session'
      socketPath: string
      sessionName: string
      paneId?: string | undefined
    }
  | {
      kind: 'tmux-pane'
      socketPath: string
      sessionId: string
      windowId: string
      paneId: string
      sessionName?: string | undefined
      windowName?: string | undefined
    }

export interface PermissionRequestedPayload {
  permissionRequestId: PermissionRequestId
  kind: 'command' | 'file_change' | 'tool' | string
  subjectDisplay: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
}

export interface PermissionResolvedPayload {
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  message?: string | undefined
}
