import type {
  BrokerLifecyclePolicyOverlay,
  InvocationCapabilities,
  InvocationEventType,
  InvocationInput,
  InvocationResponseFormat,
  InvocationState,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'
import type { StartedToolCall } from './invocation-model'

// ---------------------------------------------------------------------------
// Reason-string vocabulary (centralized for spec traceability)
// ---------------------------------------------------------------------------
export const REASON_BUSY_REJECTED = 'busy_rejected'
export const REASON_QUEUE_FULL = 'queue_full'
export const REASON_QUEUE_NOT_SUPPORTED = 'queue_not_supported'
export const REASON_UNSUPPORTED_INPUT_KIND = 'unsupported_input_kind_for_queue'
export const REASON_UNSUPPORTED_BUSY_POLICY = 'unsupported_busy_policy'
export const REASON_STEER_NOT_SUPPORTED = 'steer_not_supported'
export const REASON_INVOCATION_TERMINATED = 'invocation_terminated'
export const REASON_INVOCATION_STOPPING = 'invocation_stopping'

export const DEFAULT_MAX_INPUT_QUEUE_DEPTH = 64

/** Fallback bound for a broker-owned permission deadline when the policy omits one. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 1000

/** Terminal states that allow dispose. */
export const TERMINAL_STATES = new Set<InvocationState>(['exited', 'failed'])

// ---------------------------------------------------------------------------
// Tool-call terminal-outcome invariant (T-06550)
// ---------------------------------------------------------------------------
/**
 * Turn-terminal event types. When a turn closes, every `tool.call.started`
 * scoped to it MUST have already reached a terminal; any still open is the
 * burn-in-19 vanished-call defect and the broker synthesizes its `failed`.
 */
export const TURN_TERMINAL_TYPES = new Set<InvocationEventType>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
])
/**
 * Invocation-teardown event types. On provider death mid-turn (the turn itself
 * may never close) these are the catch-all boundary that synthesizes `failed`
 * for ALL still-open tool calls.
 */
export const INVOCATION_TEARDOWN_TYPES = new Set<InvocationEventType>([
  'invocation.exited',
  'invocation.failed',
])
export const SUBMISSION_TERMINAL_TYPES = new Set<InvocationEventType>([
  'submission.absorbed',
  'submission.executed',
  'submission.rejected',
  'submission.expired',
  'submission.withdrawn',
  'submission.cancelled',
  'submission.lost',
])
export const BROKER_DECISION_TYPES = new Set<InvocationEventType>([
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
export const BROKER_PROVENANCE = {
  sourceKind: 'broker' as const,
  normalizer: { name: 'harness-broker-admission', version: '1' },
}
/** Machine-readable `code` for a tool call left open when its turn closed. */
export const TOOL_CALL_UNTERMINATED_CODE = 'broker_unterminated_tool_call'
/** Machine-readable `code` for a tool call left open when the invocation tore down. */
export const TOOL_CALL_TEARDOWN_CODE = 'broker_provider_teardown'

/**
 * Extract the `{ toolCallId, name, turnId }` bracket key from a
 * `tool.call.started` payload, or undefined when the payload lacks a usable
 * toolCallId (nothing to bracket). `name` falls back to `'tool'` so a
 * synthesized failure always carries the required `name` field.
 */
export function asStartedToolCall(
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
export const SESSION_LEAVE_REASONS = new Set(['prompt_input_exit', 'logout'])

/**
 * Reason/message surfaced when a JSON Schema response format is sent to a driver
 * that does not advertise structured final-response support (T-03779).
 */
export const REASON_UNSUPPORTED_FINAL_RESPONSE = 'UnsupportedCapability: finalResponse.jsonSchema'

/**
 * Normalize a per-turn response format for idempotency fingerprinting (T-03779):
 * omitted and `{ kind: 'text' }` both collapse to `null`; a JSON Schema format
 * keeps its `{ kind, schema }`. `stableJsonStringify` canonicalizes object key
 * order downstream, so reordered schema keys fingerprint identically.
 */
export function normalizeResponseFormat(
  responseFormat: InvocationResponseFormat | undefined
): { kind: 'json_schema'; schema: Record<string, unknown> } | null {
  if (responseFormat?.kind === 'json_schema') {
    return { kind: 'json_schema', schema: responseFormat.schema }
  }
  return null
}

/** True when this input requests a JSON Schema structured final response. */
export function requestsJsonSchemaResponse(input: InvocationInput): boolean {
  return input.responseFormat?.kind === 'json_schema'
}

/** True when the driver capabilities advertise per-turn JSON Schema support. */
export function supportsJsonSchemaResponse(capabilities: InvocationCapabilities): boolean {
  return (
    capabilities.finalResponse?.jsonSchema === true && capabilities.finalResponse?.perTurn === true
  )
}

export function assertLifecyclePolicySupported(
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
