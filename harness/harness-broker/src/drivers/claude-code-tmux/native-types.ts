import type { EventFamily } from 'spaces-harness-broker-protocol'

/**
 * Claude Code native-type classification (T-07853 §6.1).
 *
 * Every raw record the driver commits must reach exactly one disposition, so
 * every native type it can see needs a home. This table is BEHAVIOR-PINNED, not
 * a documented API: it was enumerated from the three archived live sessions on
 * wrkq T-07849 (`e2e-enqueue-pin-transcript-73efc2a5.jsonl`,
 * `…-pin2-…-36022e44.jsonl`, `…-pin3-…-f3003503.jsonl`), which between them
 * cover 14 session-JSONL row types, 9 attachment subtypes and 4 queue
 * operations — and then EXTENDED by a live smoke, which immediately produced
 * two more (`ai-title`, `attachment:auto_mode_exit`) that no archive contained.
 * Anything outside it is `blocked-unknown` and warns.
 */

/**
 * Session-JSONL row types that carry no broker-vocabulary fact.
 *
 * `cost-state` and `system` LEFT this set under T-07873: both now mint
 * (`usage.updated` and the pinned turn-terminal read respectively).
 */
export const CLAUDE_IGNORED_ROW_TYPES: ReadonlySet<string> = new Set([
  // Per-session UI/config state the TUI rewrites as it goes.
  'last-prompt',
  'custom-title',
  'agent-name',
  'mode',
  'permission-mode',
  'atis-latch',
  'bridge-session',
  // Editor undo bookkeeping, not a tool result.
  'file-history-snapshot',
  // Session title the TUI generates for its own picker. Found by the live
  // smoke, not by the archives — the archived sessions never got far enough to
  // be titled. Exactly the gap "make one real call before trusting a fixture"
  // is about.
  'ai-title',
])

/**
 * `type:'system'` row subtypes and what each one is (T-07873, Phase 4).
 *
 * `system` was in {@link CLAUDE_IGNORED_ROW_TYPES} until Phase 4 measured the
 * turn bracket, which lives in these rows. The row type is now pinned per
 * SUBTYPE instead, because the three subtypes mean three different things:
 *
 * - `turn_duration` / `stop_hook_summary` — the transcript's turn terminal.
 *   READ (they carry `durationMs`, `stopReason`, `preventedContinuation`) but
 *   `duplicate`: `turn-bracket` stays `hook`, and AUTHORITY.md "Phase 4" holds
 *   the measurement that decided it.
 * - `bridge_status` — the `/remote-control is active …` notice. Cosmetic;
 *   `ignored-known`. Found by MEASURING the corpus, not from the spec baseline:
 *   1 per session in all three archived sessions.
 *
 * A subtype outside this set is `blocked-unknown` in
 * {@link CLAUDE_UNKNOWN_ROW_FAMILY} — it WARNS and does not halt, consistent
 * with the unknown-row-type law (a row we cannot place in a family cannot be
 * asserted to be load-bearing).
 */
export const CLAUDE_KNOWN_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'turn_duration',
  'stop_hook_summary',
  'bridge_status',
])

/**
 * Hook records whose FACT the session JSONL now owns (T-07873 scope A).
 *
 * These hooks still fire and are still committed — `PreToolUse`/`PostToolUse`
 * remain synchronous CONTROLS (the permission decision bridge), and
 * `MessageDisplay` is what makes the TUI's streaming visible — but the events
 * they used to mint are now minted from the transcript rows that are the real
 * evidence. Their records therefore reach the `duplicate` disposition (§6.1)
 * rather than `state-only`: they are real evidence of a fact another record
 * already carried, which is exactly what `duplicate` means.
 */
export const CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS: ReadonlyMap<string, string> = new Map([
  ['PreToolUse', 'tool.call.started owned by the assistant row tool_use block'],
  ['PostToolUse', 'tool.call.completed owned by the user row tool_result block'],
  ['MessageDisplay', 'assistant prose owned by the assistant row'],
])

/**
 * Attachment subtypes reviewed and intentionally outside the broker vocabulary.
 * `queued_command` is deliberately ABSENT: it is the absorption signal and is
 * handled by the disposition mirror. `hook_cancelled` is classified separately
 * so its four diagnostic fields remain visible in the raw disposition detail.
 */
export const CLAUDE_IGNORED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'hook_success',
  'deferred_tools_delta',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'auto_mode',
  // Paired with `auto_mode`; also found only by the live smoke.
  'auto_mode_exit',
  'total_tokens_reminder',
  'remote_session_change',
])

/** Queue operations the disposition mirror knows how to classify (T-07849). */
export const CLAUDE_KNOWN_QUEUE_OPERATIONS: ReadonlySet<string> = new Set([
  'enqueue',
  'remove',
  'dequeue',
  'popAll',
])

/**
 * Hook names the broker registers for this driver. The broker writes Claude's
 * hook configuration itself, so a name outside this set means the harness
 * started firing something the broker never asked for — a vocabulary drift that
 * must fail loudly rather than be dropped.
 */
export const CLAUDE_KNOWN_HOOK_NAMES: ReadonlySet<string> = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'MessageDisplay',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
  'PermissionRequest',
  'PermissionResolved',
])

/**
 * Family an UNKNOWN attachment subtype is attributed to.
 *
 * Deliberately NOT `submission-disposition` (which would halt the cursor). The
 * attachment channel is overwhelmingly UI/session metadata — 125 attachments
 * across the pin-1 session, of which 5 were `queued_command` — and new cosmetic
 * subtypes appear between Claude releases (`remote_session_change` shows up
 * only in the third archived session). Halting a whole runtime's capture on
 * cosmetic noise would make the mechanism something operators route around.
 *
 * Absorption evidence going missing is still caught, and caught EARLIER: under
 * T-07849 rev 10 an unresolved `remove` that reaches a disposition boundary is
 * itself blocked-unknown in `submission-disposition`, which DOES halt. So a
 * renamed absorption attachment fails loudly through the mirror rather than
 * through this table.
 */
export const CLAUDE_UNKNOWN_ATTACHMENT_FAMILY: EventFamily = 'diagnostic'

/**
 * Family an UNKNOWN top-level row type is attributed to. Same reasoning: the
 * law halts on "an unclassified LOAD-BEARING type", and a row type we cannot
 * place in any family cannot be asserted to be load-bearing. It warns.
 */
export const CLAUDE_UNKNOWN_ROW_FAMILY: EventFamily = 'diagnostic'

/**
 * Prefix Claude puts on the `user` row it writes when a HOOK BLOCKS a decision
 * — today only the `Stop` decision bridge, which the broker blocks to drive a
 * structured-output retry.
 *
 * Pinned as a string because it IS one: the row is an ordinary `type:'user'`
 * row with string content, indistinguishable from an operator prompt except by
 * this prefix. Without it the disposition mirror sees a plain user row arriving
 * while a turn is active, which is a load-bearing anomaly and HALTS the cursor
 * — reproduced on `release-20260902035322961-10808` (pre-Phase-4), so this is a
 * pre-existing defect the T-07873 structured-output leg surfaced, not a
 * regression. Same shape of fact as the `[Request interrupted by user]` marker
 * the interrupt path already pins.
 */
export const CLAUDE_STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:'
