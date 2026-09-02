import type { EventFamily } from 'spaces-harness-broker-protocol'

/**
 * Codex CLI hook vocabulary (T-07853 §6.1).
 *
 * The broker writes Codex's hook configuration itself, so this is the complete
 * set of names it can receive; anything else means the harness started firing a
 * hook the broker never registered, which must fail loudly rather than be
 * dropped.
 */
export const CODEX_CLI_KNOWN_HOOK_NAMES: ReadonlySet<string> = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PermissionRequest',
])

/**
 * Codex ROLLOUT vocabulary (T-07870; the gap AUTHORITY.md named under Phase 0).
 *
 * BEHAVIOUR-PINNED AND SOURCE-CONFIRMED, in that order:
 *
 * - CORPUS: six real codex-cli-tmux invocations on release-20260902024216362
 *   (idle prompt, tool call, permission approve, permission deny, interrupt,
 *   multi-turn), 250 committed raw rows — invocation ids
 *   `inv_t07870_idle_prompt_mtji755n`, `inv_t07870_tool_call_mtji7z80`,
 *   `inv_t07870_permission_approve_mtji8jbw`,
 *   `inv_t07870_permission_deny_mtji9dgp`, `inv_t07870_interrupt_mtjiex7a`,
 *   `inv_t07870_multi_turn_mtjicete` (artifacts under
 *   `var/wrkq-artifacts/T-07870/corpus`). Plus the 1611 archived rollout files
 *   under `~/.codex/sessions`, spanning a year of codex releases.
 * - SOURCE: `~/tools/codex` @ 90ae0c4ef944bb80a3c725d15910289dfbb7db51 —
 *   `codex-rs/history/src/rollout_payload.rs` (`RolloutItemWire`, the top-level
 *   row enum), `codex-rs/protocol/src/protocol.rs` (`EventMsg`),
 *   `codex-rs/protocol/src/models.rs` (`ResponseItem`),
 *   `codex-rs/protocol/src/items.rs` (`TurnItem`), and
 *   `codex-rs/rollout/src/policy.rs`, which is the filter deciding what reaches
 *   a rollout file at all.
 *
 * The corpus alone would have pinned 14 types. The source turns the table from
 * "what we happened to see" into "what codex can write", which is the whole
 * difference between a warning meaning "something new" and a warning meaning
 * "the author did not look it up".
 */

/**
 * Top-level rollout row types — `RolloutItemWire`, serialized
 * `#[serde(tag = "type", rename_all = "snake_case")]`.
 */
export const CODEX_KNOWN_ROLLOUT_ROW_TYPES: ReadonlySet<string> = new Set([
  'session_meta',
  'response_item',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'compacted',
  'turn_context',
  'token_usage_record',
  'world_state',
  'security_risk_score',
  'event_msg',
  'realtime_item',
])

/**
 * `event_msg` payload types. `policy.rs::should_persist_event_msg` splits
 * `EventMsg` into three arms; this is the union of the two that can reach a
 * rollout file (always-persisted, and legacy-history-mode-persisted), plus
 * `undo_completed`, which the archive carries from a codex release that has
 * since retired the variant.
 *
 * The absentees are the point of the table as much as the members:
 * `exec_approval_request`, `apply_patch_approval_request`, `request_permissions`,
 * `request_user_input` and `elicitation_request` are ALL in the transient arm,
 * which is why the rollout carries no permission evidence and why the
 * `permission` family stays hook.
 */
export const CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES: ReadonlySet<string> = new Set([
  // Always persisted.
  'item_completed',
  // A real `EventMsg` variant in the transient arm: not persisted by the pinned
  // source revision, but reviewed — and its `item` channel is the same one
  // `item_completed` uses, so it is classified with it rather than left novel.
  'item_started',
  'token_count',
  'thread_goal_updated',
  'thread_rolled_back',
  'turn_aborted',
  'task_started',
  'task_complete',
  'thread_settings_applied',
  // Persisted only while the thread's history mode is Legacy — which is what
  // codex-cli 0.145 writes today, and what the whole corpus is.
  'user_message',
  'agent_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'entered_review_mode',
  'exited_review_mode',
  'patch_apply_end',
  'context_compacted',
  'mcp_tool_call_end',
  'web_search_end',
  'image_generation_end',
  'sub_agent_activity',
  // Observed in the archive, no longer a variant in the pinned source revision.
  'undo_completed',
  // CONSUMED by this reader (the streamed-prose coalescer), from a codex shape
  // that predates the pinned source revision. A type the normalizer acts on is
  // known by construction, whatever `policy.rs` says about persisting it today —
  // leaving it out would warn on every row the moment an older codex is on PATH.
  'agent_message_delta',
  'agent_message_content_delta',
])

/**
 * `response_item` payload types — `ResponseItem`, snake_case. The full enum is
 * pinned rather than only `policy.rs`'s persisted subset: a type in the enum is
 * REVIEWED, and a reviewed type appearing where the policy says it should not
 * is a codex change to notice, not a row to treat as novel.
 */
export const CODEX_KNOWN_ROLLOUT_RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
  'additional_tools',
  'message',
  'agent_message',
  'reasoning',
  'local_shell_call',
  'function_call',
  'tool_search_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_output',
  'web_search_call',
  'image_generation_call',
  'compaction',
  'compaction_trigger',
  'context_compaction',
  'other',
  // Observed in the archive, no longer a variant in the pinned source revision.
  'ghost_snapshot',
])

/**
 * `item` subtypes carried by `item_started` / `item_completed` / `item_updated`
 * — `TurnItem`, `#[serde(tag = "type")]` with NO rename, so PascalCase on the
 * wire.
 */
export const CODEX_KNOWN_ROLLOUT_ITEM_TYPES: ReadonlySet<string> = new Set([
  'UserMessage',
  'FunctionCallOutput',
  'HookPrompt',
  'AgentMessage',
  'Plan',
  'Reasoning',
  'CommandExecution',
  'DynamicToolCall',
  'CollabAgentToolCall',
  'SubAgentActivity',
  'WebSearch',
  'ImageView',
  'Extension',
  'ImageGeneration',
  'EnteredReviewMode',
  'ExitedReviewMode',
  'FileChange',
  'McpToolCall',
  'ContextCompaction',
])

/**
 * `event_msg` payload types whose `item` this reader places in a LOAD-BEARING
 * family. An unknown `item.type` under one of these is not merely unplaceable —
 * its parent is pinned, and the parent's channel is where assistant prose and
 * tool evidence arrive — so it is the LOUDEST class of warning
 * (`CODEX_UNKNOWN_ITEM_FAMILY`).
 */
export const CODEX_ITEM_CARRYING_EVENT_MSG_TYPES: ReadonlySet<string> = new Set([
  'item_started',
  'item_completed',
])

/**
 * Family an unknown `item` subtype is attributed to. `conversation` is
 * load-bearing, which is what makes this the loudest warning the reader can
 * raise: the item channel is where `AgentMessage` (the terminal answer this
 * reader holds) arrives in codex's paginated history mode, and a renamed or
 * added item type there silently costs assistant prose. This is the codex
 * analogue of Claude's unknown QUEUE OPERATION — a demonstrated dependency,
 * not a guess. Capture still advances past it (T-07883).
 */
export const CODEX_UNKNOWN_ITEM_FAMILY: EventFamily = 'conversation'

/**
 * Family an unknown top-level row type, `event_msg` payload type or
 * `response_item` payload type is attributed to: `diagnostic`, the quieter of
 * the two blocked-unknown classes.
 *
 * A type we cannot place in any family cannot be asserted to be load-bearing —
 * the same reasoning as `CLAUDE_UNKNOWN_ROW_FAMILY`, and the same reasoning
 * that took unknown HOOK names out of the load-bearing set after the first live
 * pi session piled 135 records behind a hook the normalizer would simply have
 * ignored.
 */
export const CODEX_UNKNOWN_ROLLOUT_FAMILY: EventFamily = 'diagnostic'
