/**
 * Muse CLI session-log vocabulary (T-08601).
 *
 * The muse TUI exposes no hooks. Its `session.jsonl` — one JSON record per
 * line under `<dataDir>/sessions/YYYY/MM/DD/<uuid>/` — is the complete
 * structured turn log and the evidence source this driver tails.
 *
 * BEHAVIOUR-PINNED, live against muse 1.3.0:
 * - Echo-provider TUI spikes (isolated HOME, tmux): birth prompt as
 *   positional arg, mid-turn paste + separate Enter, Escape interrupt,
 *   busy-paste queues as the next turn via the native inbox.
 * - Five real operator sessions (2026-09-18, ~26k records): full run-event
 *   vocabulary including tool calls, usage, inbox steer, todo snapshots,
 *   permission questions, and context compaction.
 *
 * The log schema is internal (no `muse schema` fingerprint covers it), so the
 * normalizer treats these sets as REVIEWED-not-exhaustive: a record outside
 * them warns as diagnostic but never halts the tail.
 */
export const MUSE_CLI_TMUX_DRIVER_KIND = 'muse-cli-tmux'

/** Top-level `payload_type` values the normalizer places. */
export const MUSE_KNOWN_PAYLOAD_TYPES: ReadonlySet<string> = new Set([
  'runtime.session',
  'runtime.session.task',
  'runtime.command_intake.received',
  'runtime.command_intake.settled',
  'runtime.command_intake.session_name.received',
  'runtime.user_intent.accepted',
  'runtime.user_intent.materialized',
  'runtime.session.metadata',
  'runtime.session.route_facts',
  'runtime.session.permission_format_declared',
  'runtime.session.permission_profile_committed',
  'runtime.session_start.intake_v2',
  'runtime.session_handoff.goal_safety',
  'runtime.retained_fact',
  'session.opened.observed',
  'session.startup_phases.observed',
  'session.name.changed',
  'session.started',
  'session.end',
  'session.workspace_branch.observed',
  'session.resource_pressure.observed',
  'tool_batch.effect.started',
  'tool_batch.effect.terminal',
  'command.invoked',
  'reminder.cleanup_effect.started',
  'reminder.cleanup_effect.terminal',
])

/** `runtime.session` run-event kinds the normalizer places. */
export const MUSE_KNOWN_RUN_EVENT_KINDS: ReadonlySet<string> = new Set([
  // Turn lifecycle (load-bearing).
  'started',
  'terminal',
  'run_retracted',
  'assistant_message_committed',
  'assistant_tool_calls_committed',
  'tool_result_batch_committed',
  'model_response_created',
  'model_completed',
  'goal_usage_attribution',
  'inbox_item_queued',
  'inbox_item_drained',
  'user_input_prompt_requested',
  'user_input_prompt_settled',
  // Observed and intentionally ignored (diagnostics/config, not turn facts).
  'context_block_diagnostic',
  'model_request_configured',
  'provider_request_options_configured',
  'model_input_trace_recorded',
  'resource_usage_sampled',
  'task_stream_linked',
  'memory_reminder_child_session_linked',
  'reminder_proposal',
  'reminder_reconciler_outcome',
  'reminder_installed',
  'skill_reminder_decision',
  'skill_read_observed',
  'reasoning_committed',
  'reasoning_summary_delta',
  'reasoning_summary_committed',
  'todo_snapshot_updated',
  'tool_results_cleared',
  'tool_result_model_visible_content',
  'task_backgrounded',
  'inbox_delivery_anomaly',
  'context_compaction_candidate',
  'context_compaction_installed',
  'context_projection_checkpoint',
  'user_prompt_display',
  'agent_tree_initialized',
])

/** A single unwrapped session record: envelope fields plus its payload. */
export interface MuseSessionRecord {
  sequence: number
  recordedAt?: number | undefined
  sessionId?: string | undefined
  payloadType: string
  payload: unknown
}

/** `assistant_tool_calls_committed` tool call entry. */
export interface MuseToolCallEntry {
  id: string
  callId: string
  name: string
  args: string
}

/** `tool_result_batch_committed` result entry. */
export interface MuseToolResultEntry {
  toolCallIndex: number
  toolCallId: string
  text: string
}
