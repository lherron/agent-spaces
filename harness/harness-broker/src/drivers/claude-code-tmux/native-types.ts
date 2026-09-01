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
 * operations. Anything outside it is `blocked-unknown` and warns.
 */

/** Session-JSONL row types that carry no broker-vocabulary fact. */
export const CLAUDE_IGNORED_ROW_TYPES: ReadonlySet<string> = new Set([
  // Per-session UI/config state the TUI rewrites as it goes.
  'last-prompt',
  'custom-title',
  'agent-name',
  'mode',
  'permission-mode',
  'atis-latch',
  'cost-state',
  'bridge-session',
  // Editor undo bookkeeping, not a tool result.
  'file-history-snapshot',
  // Local reminders/instructions injected into the model's context; the broker
  // reports what the model DID, not what the TUI told it.
  'system',
])

/**
 * Attachment subtypes reviewed and intentionally outside the broker vocabulary.
 * `queued_command` is deliberately ABSENT: it is the absorption signal and is
 * handled by the disposition mirror.
 */
export const CLAUDE_IGNORED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'hook_success',
  'deferred_tools_delta',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'auto_mode',
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
