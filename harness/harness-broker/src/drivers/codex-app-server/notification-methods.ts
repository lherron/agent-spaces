/** The §6.1 disposition of every native Codex notification method the provider declares. */
import type { EventFamily } from 'spaces-harness-broker-protocol'
import { TOOL_TYPES } from './tool-items'

/**
 * Native Codex notifications given an INTENTIONAL non-event treatment: pure state
 * churn, account/capability telemetry, and provider-internal lifecycle signals
 * with no defined broker consumer. Dropped at the mapper so they never enter the
 * durable event stream (and thus never reach the renderer pane) — deliberately
 * classified here, NOT silently falling through the unknown-method diagnostic.
 * Adding a method here is the "intentionally ignore without diagnostic spam"
 * disposition; give one a first-class mapping instead only once a concrete
 * consumer and payload contract exist.
 */
export const SUPPRESSED_METHODS = new Set<string>([
  'account/rateLimits/updated', // T-06191 — account rate-limit telemetry heartbeat
  'thread/status/changed', // T-06193 — provider thread active/idle churn
  'remoteControl/status/changed', // T-06198 — provider capability telemetry
  'mcpServer/startupStatus/updated', // T-06194 — MCP server lifecycle, distinct from tool calls
  'hook/started', // T-06195 — provider-internal hook progress, no broker consumer
  'hook/completed', // T-06196 — hook lifecycle edge, NOT a broker turn terminal
  'thread/started', // T-06197 — optional metadata; start-response thread id stays authoritative

  // T-07726 — remainder of the declared `server_notification_definitions!` set
  // (codex app-server-protocol). Every method the provider can emit is
  // dispositioned here or above so the unknown-method diagnostic below fires
  // only for a method the PROVIDER added after this sweep. Grouped by why.

  // Thread lifecycle / metadata churn. The broker's thread identity comes from
  // the start response and `continuation.updated`; none of these change it.
  'thread/archived',
  'thread/unarchived',
  'thread/deleted',
  'thread/closed',
  'thread/reverted',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/settings/updated',
  'thread/queue/changed',
  'thread/project/updated',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'project/changed',
  // Deprecated by the provider in favour of the `contextCompaction` ITEM, which
  // this mapper surfaces at `item/completed`. Never observed live.
  'thread/compacted',

  // Provider plugin/skill catalogue churn. `SkillsChangedNotification` is an
  // EMPTY struct — the signal carries no payload a consumer could act on.
  'skills/changed',

  // Account / app / capability telemetry with no broker consumer.
  'account/updated',
  'account/login/completed',
  'app/list/updated',
  'mcpServer/oauthLogin/completed',
  'mcpServer/event/stream/notification',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fs/changed',
  'windowsSandbox/setupCompleted',

  // Model-side telemetry. `model/rerouted` is the one operator-relevant member
  // of this family and gets a first-class notice instead (see mapCodexNotice).
  'model/verification',
  'model/safetyBuffering/updated',
  'modelProvider/authRecoveryStarted',
  'modelProvider/authRecoveryCompleted',
  'turn/moderationMetadata',

  // Auto-approval review lifecycle. The broker owns approvals through its own
  // permission request path (permissions.ts), not through these observations.
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'autoApprovalReview/strictReviewRequired',

  // Streaming deltas already aggregated into an authoritative completed item,
  // exactly like the reasoning deltas handled in the switch below.
  'item/plan/delta',
  'item/fileChange/patchUpdated',

  // Client-driven session streams. The broker never issues `command/exec` or
  // `process/spawn`, so these can only describe some other client's session.
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'serverRequest/resolved',

  // Declared internal-only by the provider (used by Codex Cloud). Carrying the
  // full upstream response would duplicate the whole transcript into the ledger.
  'rawResponseItem/completed',
  'rawResponse/completed',

  // Realtime audio/voice session surface. No broker consumer; the audio deltas
  // in particular are high-volume binary payloads.
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/item/started',
  'thread/realtime/item/completed',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',

  // Client-issued fuzzy file search sessions; the broker issues none.
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
])

/**
 * Native methods this mapper handles EXPLICITLY — every `case` label in
 * {@link mapCodexNotificationInner} plus every notice in {@link mapCodexNotice}.
 *
 * It exists so the DRIVER can name a §6.1 disposition for a committed raw
 * record without re-deriving one from what the mapper happened to emit: an
 * unknown method also emits (a debug diagnostic), so emission alone cannot tell
 * `normalized` from `blocked-unknown`. The list is kept honest by
 * `notification-coverage.test.ts`, which fails if a member here falls through to
 * the unhandled diagnostic, if a member is also suppressed, or if the union of
 * the two sets stops covering the provider's declared method list.
 */
const MAPPED_METHODS = new Set<string>([
  // mapCodexNotice
  'deprecationNotice',
  'configWarning',
  'warning',
  'guardianWarning',
  'model/rerouted',
  'windows/worldWritableWarning',
  // mapCodexNotificationInner
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'turn/diff/updated',
  'thread/tokenUsage/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
])

/**
 * How a committed raw record's native method is dispositioned (§6.1):
 *
 *  - `mapped` — inside the broker vocabulary; the mapper decides `normalized`
 *    vs `state-only` by whether it minted anything;
 *  - `ignored-known` — a REVIEWED provider method deliberately outside the
 *    vocabulary ({@link SUPPRESSED_METHODS});
 *  - `unknown` — a method neither list has seen, i.e. one the provider added
 *    after this sweep. That is a `blocked-unknown`.
 */
export type CodexMethodClass = 'mapped' | 'ignored-known' | 'unknown'

export function classifyCodexNotificationMethod(method: string): CodexMethodClass {
  if (SUPPRESSED_METHODS.has(method)) return 'ignored-known'
  return MAPPED_METHODS.has(method) ? 'mapped' : 'unknown'
}

/** Test-only view of the two classification sets, so a coverage oracle can read them. */
export const CODEX_METHOD_CLASSIFICATION = {
  mapped: MAPPED_METHODS as ReadonlySet<string>,
  ignoredKnown: SUPPRESSED_METHODS as ReadonlySet<string>,
}

/**
 * The event family an UNKNOWN method lands in (§6.1), which is what decides how
 * LOUD its warning is — capture itself always advances (T-07883). The mapper's
 * load-bearing vocabulary lives entirely under three prefixes:
 *
 *   - `turn/…`        → the turn bracket;
 *   - `item/…`        → conversation content and tool evidence;
 *   - `thread/queue/…` → the provider queue, which is turn ATTRIBUTION.
 *
 * A novel method under any of those is something a consumer would have acted
 * on, so it is reported as load-bearing drift. Everything else the provider
 * notifies about is account/model/thread/session telemetry: it still records a
 * `blocked-unknown` disposition and raises `capture.warning`, but no committed
 * broker fact depends on it.
 */
export function codexUnknownMethodFamily(method: string): EventFamily {
  if (method.startsWith('turn/')) return 'turn-bracket'
  if (method.startsWith('thread/queue/')) return 'input-admission'
  if (method.startsWith('item/')) {
    return TOOL_TYPES.has(itemSegment(method)) ? 'tool' : 'conversation'
  }
  return 'diagnostic'
}

/** `item/commandExecution/outputDelta` → `commandExecution`. */
function itemSegment(method: string): string {
  return method.split('/')[1] ?? ''
}
