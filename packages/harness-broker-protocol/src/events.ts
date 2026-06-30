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

export interface InvocationEventEnvelope<TPayload = InvocationEventPayload> {
  invocationId: InvocationId
  seq: number
  time: IsoTimestamp
  type: InvocationEventType
  payload: TPayload
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

export type InvocationEventType =
  | 'invocation.started'
  | 'invocation.ready'
  | 'invocation.stopping'
  | 'invocation.exited'
  | 'invocation.failed'
  | 'invocation.disposed'
  | 'invocation.summary'
  | 'lifecycle.policy.accepted'
  | 'lifecycle.escalation'
  | 'harness.started'
  | 'harness.exited'
  | 'harness.recovery.started'
  | 'harness.recovery.completed'
  | 'harness.recovery.failed'
  | 'continuation.updated'
  | 'continuation.cleared'
  | 'input.accepted'
  | 'input.rejected'
  | 'input.queued'
  | 'turn.started'
  | 'turn.stalled'
  | 'turn.retry'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.interrupted'
  | 'assistant.message.started'
  | 'assistant.message.delta'
  | 'assistant.message.completed'
  | 'user.message'
  | 'tool.call.started'
  | 'tool.call.delta'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'usage.updated'
  | 'diagnostic'
  | 'driver.notice'
  | 'terminal.surface.reported'
  | 'permission.requested'
  | 'permission.resolved'
  | 'permission.cancelled'
  | 'provider.transcript.reported'

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
  emit<TPayload>(
    type: InvocationEventType,
    payload: TPayload,
    extra?: ProviderTranscriptReportedExtra
  ): InvocationEventEnvelope<TPayload>
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
): InvocationEventEnvelope<ProviderTranscriptReportedPayload> {
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

export type InvocationEventPayload =
  | InvocationStartedPayload
  | InvocationSummaryPayload
  | InvocationReadyPayload
  | InvocationStoppingPayload
  | InvocationExitedPayload
  | InvocationFailedPayload
  | InvocationDisposedPayload
  | LifecyclePolicyAcceptedPayload
  | LifecycleEscalationPayload
  | HarnessStartedPayload
  | HarnessExitedPayload
  | HarnessRecoveryStartedPayload
  | HarnessRecoveryCompletedPayload
  | HarnessRecoveryFailedPayload
  | ContinuationUpdate
  | ContinuationCleared
  | InputDispositionPayload
  | TurnStartedPayload
  | TurnStalledPayload
  | TurnRetryPayload
  | TurnCompletedPayload
  | TurnFailedPayload
  | TurnInterruptedPayload
  | AssistantMessageStartedPayload
  | AssistantMessageDeltaPayload
  | AssistantMessageCompletedPayload
  | UserMessagePayload
  | ToolCallStartedPayload
  | ToolCallDeltaPayload
  | ToolCallCompletedPayload
  | ToolCallFailedPayload
  | UsageUpdatedPayload
  | DiagnosticPayload
  | DriverNoticePayload
  | TerminalSurfaceReportedPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionCancelledPayload
  | ProviderTranscriptReportedPayload

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
  message: string
  code?: string | undefined
  data?: unknown
  retryable?: boolean | undefined
  reason?: 'harness-stalled' | 'retry-unsafe' | 'retry-exhausted' | string | undefined
  turnAttempt?: number | undefined
  retrySuppressed?: boolean | undefined
}

export interface TurnInterruptedPayload {
  turnId: TurnId
  reason?: string | undefined
}

export interface ToolCallFailedPayload {
  toolCallId: ToolCallId
  name: string
  message: string
  code?: string | undefined
  data?: unknown
}

export interface DiagnosticPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source?: 'broker' | 'harness' | 'driver' | undefined
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
