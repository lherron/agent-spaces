import type { EvidenceAuthorityMatrix } from 'spaces-harness-broker-protocol'

/**
 * Per-driver DECLARED evidence authority (T-07853 §6; law
 * `agent-spaces.harness-broker-local-commit-observation`).
 *
 * These matrices are DESCRIPTIVE: they state where each driver's facts come
 * from today, not where the architecture wants them to come from. Phase 0
 * publishes the declaration and measures it with `scripts/capture-parity.ts`;
 * the authority cutovers are Phases 2-5 and each one changes an entry here
 * together with the code that actually moves the evidence.
 *
 * `harness/harness-broker/AUTHORITY.md` is the published prose form, including
 * the per-driver EXCEPTION matrix: a family whose primary source is `hook` may
 * still take one or two specific event types from the native transcript (and
 * vice versa), and those exceptions are named there rather than smeared into a
 * single dishonest value here.
 *
 * Building each matrix from a base keeps the broker-owned families identical
 * across drivers by construction — no driver can accidentally claim provider
 * authority over `input.accepted` or `turn.stalled`, which no provider reports.
 */
const BROKER_OWNED_BASE: EvidenceAuthorityMatrix = {
  // The broker starts, stops, fails and disposes invocations; no provider can
  // report these, and lifecycle-policy acceptance is a broker decision.
  'invocation-lifecycle': 'broker',
  'harness-lifecycle': 'broker',
  continuation: 'broker',
  // Admission (`input.accepted` / `queued` / `rejected`) is the broker deciding
  // what to do with a submission — always broker, for every driver (§6).
  'input-admission': 'broker',
  'submission-disposition': 'broker',
  'turn-bracket': 'broker',
  // `turn.stalled` / `turn.retry` come from broker lifecycle policy, never from
  // a provider.
  'turn-supervision': 'broker',
  conversation: 'broker',
  tool: 'broker',
  usage: 'broker',
  permission: 'broker',
  diagnostic: 'broker',
  // The broker allocates and reports the terminal surface lease.
  'terminal-surface': 'broker',
  'provider-artifact': 'broker',
}

/**
 * Claude Code TUI — transcript-primary with an explicit hook exception matrix
 * (doc §6), as of the Phase 4 cutover (T-07873).
 *
 * The prerequisite Phase 3 named for codex is already met here: this driver has
 * a NATIVE wakeup (T-07849 rev 12 — a file-change notification on the same
 * serialized drain chain as the hooks), so a session-JSONL fact is timely
 * without a hook to trigger the read. Phase 4 promotes the three families the
 * JSONL proves complete and leaves the rest hook with the measured gap recorded
 * in AUTHORITY.md "Phase 4".
 */
export const CLAUDE_CODE_TMUX_AUTHORITY: EvidenceAuthorityMatrix = {
  ...BROKER_OWNED_BASE,
  'harness-lifecycle': 'hook',
  // `driver.notice` (SubagentStart/Stop, Notification) and the PreCompact
  // `diagnostic` come from hooks; only the API-failure diagnostic comes from the
  // transcript, and that is the documented exception. Corrected from `broker`
  // after the first live session's parity report flagged the disagreement.
  diagnostic: 'hook',
  continuation: 'hook',
  'submission-disposition': 'native',
  // MEASURED, not assumed: the transcript terminal is present for 33 of 36
  // turns in the archived corpus and for 0 of 2 interrupted turns, and the
  // `stop_hook_summary` row records the Stop hooks' own durations, so it is
  // written strictly AFTER the hook terminal. Stays hook (T-07873 §B).
  'turn-bracket': 'hook',
  // `assistant` rows carry the prose and `user` rows carry the prompt, for
  // every path. The MessageDisplay/Stop hook copies are duplicates.
  conversation: 'native',
  // `tool_use` / `tool_result` blocks, paired 100% (82/82 archived, 17/17 on a
  // live session) in the SAME id space as the hooks' `tool_use_id` — which is
  // what lets `permission` stay hook and still correlate.
  tool: 'native',
  // Every `assistant` row carries `message.usage` (155/155), plus `cost-state`
  // roll-ups. Declared native since Phase 0; actually emitting since T-07873.
  usage: 'native',
  // No permission vocabulary exists in the session JSONL at all.
  permission: 'hook',
}

/**
 * Codex CLI TUI. Hooks own lifecycle, tools, turn brackets and permissions;
 * the rollout JSONL already owns assistant prose (the held-latest transcript
 * reader), which is why `conversation` is native here while Claude's is not.
 * Doc §6 names this driver the first broad cutover candidate (Phase 3).
 */
export const CODEX_CLI_TMUX_AUTHORITY: EvidenceAuthorityMatrix = {
  ...BROKER_OWNED_BASE,
  'harness-lifecycle': 'hook',
  continuation: 'hook',
  'turn-bracket': 'hook',
  conversation: 'native',
  tool: 'hook',
  usage: 'native',
  permission: 'hook',
}

/**
 * Codex app-server. The native JSON-RPC notification stream is the primary
 * evidence for everything the model does; the broker owns only its own
 * decisions. Phase 2 moves its normalizer onto the committed sidecar row — the
 * DECLARATION does not change there, only which copy of the row is read.
 */
export const CODEX_APP_SERVER_AUTHORITY: EvidenceAuthorityMatrix = {
  ...BROKER_OWNED_BASE,
  continuation: 'native',
  'turn-bracket': 'native',
  conversation: 'native',
  tool: 'native',
  usage: 'native',
  permission: 'native',
  diagnostic: 'native',
}

/**
 * Pi TUI. `turn-bracket` is `hook`, corrected from `broker` by the live parity
 * report: pi's `turn_start`/`turn_end` hooks mint most of the brackets in a real
 * session (3 hook-observed against 1 broker-authored in the smoke). The
 * manager-authored initial bracket is real but it is ONE bracket — the bounded
 * accepted risk `agent-spaces.pi-delivery-asserted-turn-start`, recorded as the
 * documented exception in AUTHORITY.md rather than promoted to the family's
 * primary. Pi session JSONL stays non-authoritative until a separately approved
 * evidence change.
 */
export const PI_TUI_TMUX_AUTHORITY: EvidenceAuthorityMatrix = {
  ...BROKER_OWNED_BASE,
  'turn-bracket': 'hook',
  'harness-lifecycle': 'hook',
  continuation: 'hook',
  conversation: 'hook',
  tool: 'hook',
  usage: 'hook',
  permission: 'hook',
}

/**
 * agent-harness TUI. Its control protocol is a real answered handshake, so the
 * turn bracket is provider-native evidence (`delivery-acknowledged`), not a
 * broker assertion.
 */
export const AGENT_HARNESS_TMUX_AUTHORITY: EvidenceAuthorityMatrix = {
  ...BROKER_OWNED_BASE,
  'harness-lifecycle': 'native',
  continuation: 'native',
  'turn-bracket': 'native',
  conversation: 'native',
  tool: 'native',
  usage: 'native',
  permission: 'native',
}

/** Drivers with no provider behind them at all (noop, in-process test driver). */
export const BROKER_ONLY_AUTHORITY: EvidenceAuthorityMatrix = { ...BROKER_OWNED_BASE }
