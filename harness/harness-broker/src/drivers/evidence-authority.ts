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
 * Claude Code TUI. Every event ARRIVES through a hook — the session-JSONL
 * reader is a hook-driven byte-offset tail, so no hook means no transcript
 * read — which is why the hook is the declared authority for the families it
 * normalizes. The exception is the submission disposition mirror (T-07849):
 * queue operations, `queued_command` attachments and plain user rows exist
 * ONLY in the session JSONL, so that family is native today.
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
  'turn-bracket': 'hook',
  conversation: 'hook',
  tool: 'hook',
  // Not emitted today; the session JSONL is where usage would come from.
  usage: 'native',
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
