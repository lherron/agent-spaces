import type {
  EventFamily,
  InputId,
  InvocationEventFor,
  InvocationEventType,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { JsonRpcNotification } from './rpc-client'

export type MappedEventFor<K extends InvocationEventType> = InvocationEventFor<K> & {
  extra?: {
    turnId?: TurnId | undefined
    inputId?: InputId | undefined
    itemId?: string | undefined
    driver?: { kind: string; rawType?: string | undefined } | undefined
  }
}

export type MappedEvent = {
  [K in InvocationEventType]: MappedEventFor<K>
}[InvocationEventType]

export interface CodexErrorInfo {
  message: string
  code: string
  data: Record<string, unknown>
  retryable?: boolean | undefined
  reason?: string | undefined
}

/** Stable driver identity stamped onto every event derived from a native notification. */
export const CODEX_DRIVER_KIND = 'codex-app-server'

const TOOL_NAMES: Record<string, string> = {
  commandExecution: 'command',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool',
  webSearch: 'web_search',
  imageView: 'image_view',
  imageGeneration: 'image_generation',
}

const TOOL_TYPES = new Set(Object.keys(TOOL_NAMES))

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
const SUPPRESSED_METHODS = new Set<string>([
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
 * The event family an UNKNOWN method would have landed in, which is what
 * decides whether it halts the normalization cursor (§6.1). The mapper's
 * load-bearing vocabulary lives entirely under three prefixes:
 *
 *   - `turn/…`        → the turn bracket;
 *   - `item/…`        → conversation content and tool evidence;
 *   - `thread/queue/…` → the provider queue, which is turn ATTRIBUTION.
 *
 * A novel method under any of those is something a consumer would have acted
 * on, so guessing past it is not recoverable and capture halts. Everything else
 * the provider notifies about is account/model/thread/session telemetry: it
 * still records a `blocked-unknown` disposition and raises `capture.warning`,
 * but it does not stop the cursor, because no committed broker fact depends on
 * it.
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

export interface DiffFileStat {
  path: string
  added: number
  removed: number
}

export interface DiffSummary {
  files: DiffFileStat[]
  totalAdded: number
  totalRemoved: number
  /** Files beyond the per-summary cap, elided from `files`. */
  truncated: number
}

const MAX_DIFF_FILES = 8

/**
 * Reasoning summaries are durable churn-forensics evidence, not a token stream.
 * Keep one bounded summary per completed reasoning item: enough to explain the
 * model's next action without turning the broker ledger into a second rollout.
 */
const MAX_REASONING_SUMMARY_PARTS = 8
const MAX_REASONING_SUMMARY_CHARS = 4_096

/**
 * Summarize a unified diff into compact per-file add/remove counts. Only the
 * `diff --git` file boundaries and `+`/`-` body lines are counted; the `+++`/
 * `---` headers and hunk markers are excluded. The full diff body is discarded —
 * only counts survive, keeping the derived event payload small.
 */
export function summarizeUnifiedDiff(diff: string): DiffSummary {
  const files: DiffFileStat[] = []
  let current: DiffFileStat | undefined
  let totalAdded = 0
  let totalRemoved = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = /[ ]b\/(.+)$/.exec(line)
      current = { path: match?.[1] ?? 'file', added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      current.added += 1
      totalAdded += 1
    } else if (line.startsWith('-')) {
      current.removed += 1
      totalRemoved += 1
    }
  }
  return {
    files: files.slice(0, MAX_DIFF_FILES),
    totalAdded,
    totalRemoved,
    truncated: Math.max(0, files.length - MAX_DIFF_FILES),
  }
}

type HeldAssistantCompletions = Map<string, MappedEventFor<'assistant.message.completed'>>

/**
 * The last diff summary emitted per turn, so an unchanged repeat can be dropped
 * (T-06350). Keyed by turnId and cleared on `turn/started`, so each turn always
 * renders its first diff even if it happens to match the previous turn's last.
 */
type LastDiffSignatures = Map<string, string>

const defaultHeldAssistantCompletions: HeldAssistantCompletions = new Map()
const defaultLastDiffSignatures: LastDiffSignatures = new Map()

function asTurnId(value: string): TurnId {
  return value as TurnId
}

function asMessageId(value: string): MessageId {
  return value as MessageId
}

function asToolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

/**
 * Map a native Codex app-server notification to zero or more normalized broker
 * events. Every emitted event is stamped with `extra.driver` so consumers can
 * trace it back to the native method without that native type ever leaking into
 * the normalized `type`. Unknown native methods become a trace-level diagnostic
 * (again carrying `rawType`) rather than being silently dropped.
 */
export function mapCodexNotification(notification: JsonRpcNotification): MappedEvent[] {
  return mapCodexNotificationWithState(
    notification,
    defaultHeldAssistantCompletions,
    defaultLastDiffSignatures
  )
}

export function createCodexNotificationMapper(): (
  notification: JsonRpcNotification
) => MappedEvent[] {
  const heldAssistantCompletions: HeldAssistantCompletions = new Map()
  const lastDiffSignatures: LastDiffSignatures = new Map()
  return (notification) =>
    mapCodexNotificationWithState(notification, heldAssistantCompletions, lastDiffSignatures)
}

function mapCodexNotificationWithState(
  notification: JsonRpcNotification,
  heldAssistantCompletions: HeldAssistantCompletions,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const driver = { kind: CODEX_DRIVER_KIND, rawType: notification.method }
  return mapCodexNotificationInner(notification, heldAssistantCompletions, lastDiffSignatures).map(
    (event) => ({
      ...event,
      extra: { ...event.extra, driver: event.extra?.driver ?? driver },
    })
  )
}

/**
 * `turn/diff/updated` → a compact per-file filestat card, deduped per turn.
 *
 * Codex sends this event carrying a CUMULATIVE snapshot of the whole turn's diff
 * rather than a delta, and re-sends it unchanged on every
 * `account/rateLimits/updated` telemetry heartbeat. Measured over the largest real
 * captured transcripts: of 992 fires, the 822 that followed a heartbeat carried a
 * byte-identical diff (100%), while the 170 that followed an actual
 * `item/completed(fileChange)` carried none (0%). Mapping each fire repainted the
 * same card down the pane (T-06350).
 *
 * Dedupe on the SUMMARY rather than on which method preceded the event: it states
 * the real invariant — never emit a card that says nothing new — and it does not
 * couple us to a heartbeat-pairing detail of a provider we do not control. It also
 * correctly drops the case where the diff body moved but the rendered `+/-` stats
 * did not (an in-place edit at equal line counts), where the card would be identical.
 */
function mapDiffUpdated(
  params: Record<string, unknown>,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const diff = stringValue(params['diff'])
  if (diff === undefined || diff.trim().length === 0) return []
  const summary = summarizeUnifiedDiff(diff)
  if (summary.files.length === 0) return []
  const turnId = stringValue(params['turnId']) ?? ''
  const signature = JSON.stringify(summary)
  if (lastDiffSignatures.get(turnId) === signature) return []
  lastDiffSignatures.set(turnId, signature)
  // Only the compact per-file +/- summary is carried (never the full diff body), so
  // the payload stays small and survives event-size truncation.
  return [
    {
      type: 'diagnostic',
      payload: {
        level: 'info',
        source: 'driver',
        kind: 'diff',
        message: `diff updated (${summary.files.length} file${summary.files.length === 1 ? '' : 's'}, +${summary.totalAdded} -${summary.totalRemoved})`,
        data: summary,
      },
    },
  ]
}

/**
 * Codex `unified_exec`: the MODEL wrote to a PTY session that is still open
 * (`write_stdin` tool, core/src/tools/handlers/unified_exec/write_stdin.rs).
 *
 * `itemId` is the owning `ExecCommandBegin` call_id — the same id already used as
 * `toolCallId` — so this is a continuation write into an IN-FLIGHT tool call, not
 * a new call and emphatically not operator input (that is `input.queued`).
 *
 * Unlike `outputDelta`, each fire carries one COMPLETE `chars` argument rather
 * than a fragment of a byte stream, so `deltas.join('')` is wrong here. The
 * `stream: 'stdin'` tag on `payload.data` is what lets the renderer keep input
 * and output distinct instead of smearing them into one blob.
 *
 * Empty stdin is a background-PTY liveness poll, not content — Codex's own TUI
 * routes it to a status indicator and never the transcript
 * (tui/src/chatwidget/command_lifecycle.rs:76). Dropping it is what keeps a
 * long-running background session from flooding the pane, and it is why this
 * method is handled here rather than left to the unknown-notification
 * diagnostic, which rendered a clipped `data={"params":{…}}` line per fire.
 */
function mapTerminalInteraction(
  params: Record<string, unknown>,
  heldAssistantCompletions: HeldAssistantCompletions
): MappedEvent[] {
  const turnId = stringValue(params['turnId'])
  const itemId = stringValue(params['itemId']) ?? stringValue(params['id'])
  const stdin = stringValue(params['stdin'])
  if (!turnId || !itemId) return []
  if (stdin === undefined || stdin.length === 0) return []
  return [
    ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
    {
      type: 'tool.call.delta',
      payload: {
        toolCallId: asToolCallId(itemId),
        text: stdin,
        data: { stream: 'stdin' },
      },
      extra: { turnId: asTurnId(turnId), itemId },
    },
  ]
}

function mapCodexNotificationInner(
  notification: JsonRpcNotification,
  heldAssistantCompletions: HeldAssistantCompletions,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const params = asRecord(notification.params)
  const notice = mapCodexNotice(notification.method, params)
  if (notice !== undefined) return notice

  switch (notification.method) {
    case 'turn/started': {
      const turnId = stringValue(params['turnId']) ?? stringValue(asRecord(params['turn'])['id'])
      if (!turnId) return []
      heldAssistantCompletions.delete(turnId)
      lastDiffSignatures.delete(turnId)
      return [
        {
          type: 'turn.started',
          payload: { turnId: asTurnId(turnId) },
          extra: { turnId: asTurnId(turnId) },
        },
      ]
    }

    case 'thread/tokenUsage/updated': {
      const usage = params['usage'] ?? params['tokenUsage'] ?? params['token_usage']
      return [{ type: 'usage.updated', payload: { usage } }]
    }

    case 'turn/plan/updated': {
      const rawPlan = params['plan']
      const steps = Array.isArray(rawPlan)
        ? rawPlan.flatMap((entry) => {
            const rec = asRecord(entry)
            const step = stringValue(rec['step'])
            return step !== undefined
              ? [{ step, status: stringValue(rec['status']) ?? 'pending' }]
              : []
          })
        : []
      if (steps.length === 0) return []
      const explanation = stringValue(params['explanation'])
      // Routed through `diagnostic` (no strict payload validator) rather than a
      // new protocol event type, so the renderer gets the structured plan without
      // a cross-repo protocol bump. `kind` discriminates it from a log line.
      return [
        {
          type: 'diagnostic',
          payload: {
            level: 'info',
            source: 'driver',
            kind: 'plan',
            message: `plan updated (${steps.length} step${steps.length === 1 ? '' : 's'})`,
            data: { steps, ...(explanation !== undefined ? { explanation } : {}) },
          },
        },
      ]
    }

    case 'turn/diff/updated':
      return mapDiffUpdated(params, lastDiffSignatures)

    // Summary deltas are aggregated by Codex into the completed reasoning item.
    // Do not emit one diagnostic per delta: that is high-volume UI/ledger spam.
    // Raw reasoning text is also intentionally excluded; only the provider's
    // user-facing reasoning summary is eligible for durable capture.
    case 'item/reasoning/summaryPartAdded':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return []

    case 'item/started': {
      const turnId = stringValue(params['turnId'])
      const item = asRecord(params['item'])
      const itemType = stringValue(item['type'])
      const itemId = stringValue(item['id'])
      if (!turnId || !itemType || !itemId) return []

      if (itemType === 'agentMessage') {
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          {
            type: 'assistant.message.started',
            payload: { messageId: asMessageId(itemId) },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        const input = normalizeToolInput(itemType, item)
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          {
            type: 'tool.call.started',
            payload: {
              toolCallId: asToolCallId(itemId),
              name: TOOL_NAMES[itemType] ?? itemType,
              ...(input !== undefined ? { input } : {}),
            },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }
      return []
    }

    case 'item/agentMessage/delta': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      const text = stringValue(params['text']) ?? stringValue(params['delta'])
      if (!turnId || !itemId || text === undefined) return []
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'assistant.message.delta',
          payload: { messageId: asMessageId(itemId), text },
          extra: { turnId: asTurnId(turnId), itemId },
        },
      ]
    }

    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      const text = stringValue(params['text']) ?? stringValue(params['delta'])
      if (!turnId || !itemId || text === undefined) return []
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'tool.call.delta',
          payload: { toolCallId: asToolCallId(itemId), text },
          extra: { turnId: asTurnId(turnId), itemId },
        },
      ]
    }

    case 'item/commandExecution/terminalInteraction':
      return mapTerminalInteraction(params, heldAssistantCompletions)

    case 'item/mcpToolCall/progress': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      if (!turnId || !itemId) return []
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'tool.call.delta',
          payload: {
            toolCallId: asToolCallId(itemId),
            ...(params['data'] !== undefined ? { data: params['data'] } : { data: params }),
          },
          extra: { turnId: asTurnId(turnId), itemId },
        },
      ]
    }

    case 'item/completed': {
      const turnId = stringValue(params['turnId'])
      const item = asRecord(params['item'])
      const itemType = stringValue(item['type'])
      const itemId = stringValue(item['id'])
      if (!turnId || !itemType || !itemId) return []

      if (itemType === 'agentMessage') {
        const previous = flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false)
        heldAssistantCompletions.set(
          turnId,
          assistantCompletionEvent(turnId, itemId, normalizeMessageContent(item), true)
        )
        return previous
      }

      if (itemType === 'reasoning') {
        const summary = normalizeReasoningSummary(item)
        if (summary === undefined) return []
        return [
          {
            type: 'diagnostic',
            payload: {
              level: 'debug',
              source: 'driver',
              kind: 'reasoning',
              message: 'Codex reasoning summary captured',
              data: summary,
            },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      // T-07726 — the provider compacted the thread's context mid-invocation.
      // Previously dropped with every other unmodelled item type, which hid a
      // real transcript discontinuity from the operator. The item carries only
      // its id, so the event is the fact itself.
      if (itemType === 'contextCompaction') {
        return [
          {
            type: 'diagnostic',
            payload: {
              level: 'info',
              source: 'driver',
              kind: 'compaction',
              message: 'Codex compacted the thread context',
            },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          mapToolItemCompleted(itemType, item, itemId, turnId),
        ]
      }

      return []
    }

    case 'turn/completed': {
      const turn = asRecord(params['turn'])
      const turnId = stringValue(params['turnId']) ?? stringValue(turn['id'])
      if (!turnId) return []
      const rawStatus = stringValue(params['status']) ?? stringValue(turn['status'])
      const status =
        rawStatus === 'failed'
          ? 'failed'
          : rawStatus === 'interrupted'
            ? 'interrupted'
            : 'completed'
      const finalOutput = stringValue(params['finalOutput']) ?? stringValue(turn['finalOutput'])
      const terminal: MappedEvent =
        status === 'failed'
          ? {
              type: 'turn.failed',
              payload: {
                turnId: asTurnId(turnId),
                status,
                message: failedTurnMessage(finalOutput),
                ...(finalOutput !== undefined ? { finalOutput } : {}),
              },
            }
          : status === 'interrupted'
            ? {
                type: 'turn.interrupted',
                payload: {
                  turnId: asTurnId(turnId),
                  status,
                  ...(finalOutput !== undefined ? { finalOutput } : {}),
                },
              }
            : {
                type: 'turn.completed',
                payload: {
                  turnId: asTurnId(turnId),
                  status,
                  ...(finalOutput !== undefined ? { finalOutput } : {}),
                },
              }
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, true),
        {
          ...terminal,
          extra: { turnId: asTurnId(turnId) },
        },
      ]
    }

    default:
      // Known high-frequency state-churn / telemetry methods carry no operator
      // value in the transcript. Explicitly classified as non-events (NOT the
      // same as silently dropping an unrecognized method) so the pane is not
      // flooded with rate-limit / thread-status / remote-control churn.
      if (SUPPRESSED_METHODS.has(notification.method)) return []
      // Any other unknown native notification: surface as a trace-level
      // diagnostic so it is observable but never leaks the native method name as
      // a normalized event `type`. The native method is preserved in
      // `extra.driver.rawType` (the single method authority — never duplicated
      // into `payload.data`); the raw params ride on `payload.data.params` so a
      // genuinely-novel method is legible on the durable stream and in-pane
      // instead of a bare method name (T-05219). Data-less debug diagnostics are
      // still folded out of the pane by the renderer.
      return [
        {
          type: 'diagnostic',
          payload: {
            level: 'debug',
            message: `Unhandled Codex notification: ${notification.method}`,
            source: 'driver',
            data: { params: notification.params ?? {} },
          },
        },
      ]
  }
}

function mapCodexNotice(
  method: string,
  params: Record<string, unknown>
): MappedEvent[] | undefined {
  switch (method) {
    case 'deprecationNotice':
    case 'configWarning': {
      const summary =
        stringValue(params['summary']) ??
        (method === 'deprecationNotice'
          ? 'Codex reported a deprecation.'
          : 'Codex reported a configuration warning.')
      const details = stringValue(params['details'])
      return [
        {
          type: 'driver.notice',
          payload: {
            message: summary,
            code: method,
            ...(details !== undefined ? { data: { details } } : {}),
          },
        },
      ]
    }
    // T-07726 — the provider's two generic user-facing warning channels. Same
    // treatment as the deprecation/config notices above: an operator-visible
    // `driver.notice`, never a debug diagnostic folded out of the pane.
    case 'warning':
    case 'guardianWarning': {
      const message = stringValue(params['message'])
      if (message === undefined || message.length === 0) return []
      return [{ type: 'driver.notice', payload: { message, code: method } }]
    }
    // T-07726 — the model actually serving the turn changed underneath the
    // operator. That is a decision-changing fact, not telemetry.
    case 'model/rerouted': {
      const fromModel = stringValue(params['fromModel'])
      const toModel = stringValue(params['toModel'])
      if (fromModel === undefined || toModel === undefined) return []
      const reason = stringValue(params['reason'])
      return [
        {
          type: 'driver.notice',
          payload: {
            message: `Codex rerouted the model ${fromModel} → ${toModel}${
              reason !== undefined ? ` (${reason})` : ''
            }`,
            code: method,
            data: { fromModel, toModel, ...(reason !== undefined ? { reason } : {}) },
          },
        },
      ]
    }
    case 'windows/worldWritableWarning': {
      const extraCount = numberValue(params['extraCount']) ?? 0
      const failedScan = params['failedScan'] === true
      const samplePaths = Array.isArray(params['samplePaths'])
        ? params['samplePaths'].filter((path): path is string => typeof path === 'string')
        : []
      return [
        {
          type: 'driver.notice',
          payload: {
            message: worldWritableWarningMessage(extraCount, failedScan, samplePaths),
            code: method,
            data: { extraCount, failedScan, samplePaths },
          },
        },
      ]
    }
    default:
      return undefined
  }
}

function worldWritableWarningMessage(
  extraCount: number,
  failedScan: boolean,
  samplePaths: string[]
): string {
  const pathSummary =
    samplePaths.length > 0
      ? ` Sample paths: ${samplePaths.join(', ')}.`
      : ' No sample paths were provided.'
  const extraSummary = ` ${extraCount} additional world-writable path${extraCount === 1 ? '' : 's'} were found.`
  const scanSummary = failedScan
    ? ' The world-writable path scan failed before completion.'
    : ' The world-writable path scan completed.'
  return `Codex detected world-writable paths.${pathSummary}${extraSummary}${scanSummary}`
}

function assistantCompletionEvent(
  turnId: string,
  itemId: string,
  content: Array<{ type: 'text'; text: string }>,
  final: boolean
): MappedEventFor<'assistant.message.completed'> {
  return {
    type: 'assistant.message.completed',
    payload: {
      messageId: asMessageId(itemId),
      content,
      final,
    },
    extra: {
      turnId: asTurnId(turnId),
      itemId,
      driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/completed' },
    },
  }
}

function flushHeldAssistantCompletion(
  heldAssistantCompletions: HeldAssistantCompletions,
  turnId: string,
  final: boolean
): MappedEvent[] {
  const held = heldAssistantCompletions.get(turnId)
  if (held === undefined) return []
  heldAssistantCompletions.delete(turnId)
  return [
    {
      ...held,
      payload: { ...held.payload, final },
    },
  ]
}

export function parseCodexError(params: unknown): CodexErrorInfo {
  const root = asRecord(params)
  const nested = asRecord(root['error'])
  const rawMessage = stringValue(root['message']) ?? stringValue(nested['message'])
  const message =
    rawMessage !== undefined && rawMessage.trim().length > 0 ? rawMessage : 'Codex app-server error'
  const codexErrorInfo = nested['codexErrorInfo']
  const code =
    stringValue(root['code']) ??
    stringValue(nested['code']) ??
    stringValue(codexErrorInfo) ??
    stringValue(asRecord(codexErrorInfo)['code']) ??
    'codex_app_server_error'
  const retryable = typeof root['willRetry'] === 'boolean' ? root['willRetry'] : undefined
  const reason = stringValue(root['reason']) ?? stringValue(nested['reason'])
  const data = { ...root, code }
  return {
    message,
    code,
    data,
    ...(retryable !== undefined ? { retryable } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

function failedTurnMessage(finalOutput: string | undefined): string {
  return finalOutput !== undefined && finalOutput.trim().length > 0
    ? finalOutput
    : 'Codex turn failed'
}

function normalizeMessageContent(
  item: Record<string, unknown>
): Array<{ type: 'text'; text: string }> {
  const content = item['content']
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      const record = asRecord(part)
      const text = stringValue(record['text'])
      return record['type'] === 'text' && text !== undefined
        ? [{ type: 'text' as const, text }]
        : []
    })
  }

  const text = stringValue(item['text']) ?? ''
  return [{ type: 'text', text }]
}

function normalizeReasoningSummary(
  item: Record<string, unknown>
): { summary: string; truncated: boolean } | undefined {
  const rawSummary = item['summary']
  if (!Array.isArray(rawSummary)) return undefined

  const parts = rawSummary.flatMap((part) => {
    const text = stringValue(part)?.trim()
    return text !== undefined && text.length > 0 ? [text] : []
  })
  if (parts.length === 0) return undefined

  const selected = parts.slice(0, MAX_REASONING_SUMMARY_PARTS)
  const joined = selected.join('\n\n')
  const truncated = parts.length > selected.length || joined.length > MAX_REASONING_SUMMARY_CHARS
  return {
    summary: joined.slice(0, MAX_REASONING_SUMMARY_CHARS),
    truncated,
  }
}

function normalizeToolInput(itemType: string, item: Record<string, unknown>): unknown {
  const explicitInput = item['input']

  switch (itemType) {
    case 'commandExecution':
      return (
        objectWithDefined({
          command: stringValue(item['command']),
          cwd: stringValue(item['cwd']),
        }) ?? explicitInput
      )
    case 'fileChange':
      return item['changes'] !== undefined ? { changes: item['changes'] } : explicitInput
    case 'mcpToolCall':
      return (
        objectWithDefined({
          server: stringValue(item['server']),
          tool: stringValue(item['tool']),
          arguments: item['arguments'],
        }) ?? explicitInput
      )
    case 'webSearch':
      return objectWithDefined({ query: stringValue(item['query']) }) ?? explicitInput
    case 'imageView':
      return objectWithDefined({ path: stringValue(item['path']) }) ?? explicitInput
    case 'imageGeneration':
      // `revisedPrompt` is null until the item completes; a started image
      // generation legitimately has no input to report.
      return (
        objectWithDefined({ prompt: clipImagePrompt(stringValue(item['revisedPrompt'])) }) ??
        explicitInput
      )
    default:
      return undefined
  }
}

function normalizeToolResult(itemType: string, item: Record<string, unknown>): unknown {
  const explicitResult = item['result']

  switch (itemType) {
    case 'commandExecution':
      return (
        objectWithDefined({
          output: stringValue(item['aggregatedOutput']),
          exitCode: numberValue(item['exitCode']),
        }) ?? explicitResult
      )
    case 'fileChange':
      return item['changes'] !== undefined ? { changes: item['changes'] } : explicitResult
    case 'mcpToolCall': {
      const error = item['error']
      if (error !== undefined && error !== null) {
        return {
          error,
          ...(explicitResult !== null && explicitResult !== undefined
            ? { result: explicitResult }
            : {}),
        }
      }
      return explicitResult !== null && explicitResult !== undefined ? explicitResult : undefined
    }
    case 'webSearch': {
      const query = stringValue(item['query'])
      return query !== undefined ? { query } : explicitResult
    }
    case 'imageGeneration': {
      // `result` is the RAW BASE64 IMAGE (~1.4MB observed). It must never reach
      // the durable event stream or the pane, so this case NEVER falls back to
      // `explicitResult`: report the on-disk artifact and the encoded size only.
      const encoded = stringValue(item['result'])
      const failure = item['failure']
      return objectWithDefined({
        savedPath: stringValue(item['savedPath']),
        prompt: clipImagePrompt(stringValue(item['revisedPrompt'])),
        encodedBytes: encoded !== undefined && encoded.length > 0 ? encoded.length : undefined,
        ...(failure !== undefined && failure !== null ? { failure } : {}),
      })
    }
    case 'imageView': {
      const path = stringValue(item['path'])
      return path !== undefined ? { path } : explicitResult
    }
    default:
      return undefined
  }
}

/** Bound the provider's revised image prompt; observed values run to ~2KB. */
const MAX_IMAGE_PROMPT_CHARS = 500

function clipImagePrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined || prompt.length === 0) return undefined
  return prompt.length > MAX_IMAGE_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_IMAGE_PROMPT_CHARS)}…`
    : prompt
}

/**
 * A completed Codex tool call reached its terminal RESULT BOUNDARY; a failed one
 * terminated WITHOUT a result. The `failed` variant carries the contract fields
 * (machine-readable `code`, human `message`) so the emission never has to
 * reconstruct them.
 */
type ToolOutcome = { kind: 'completed' } | { kind: 'failed'; code: string; message: string }

/**
 * Map a completed Codex tool `item/completed` to its single terminal event
 * (T-06550). A call that reached its result boundary is `tool.call.completed` —
 * a nonzero process exit STAYS completed (exitCode carried at the neutral
 * `result.exitCode`, never aliased to `failed` nor derived into `isError`). A
 * call that terminated WITHOUT a result boundary is `tool.call.failed`, emitting
 * the contract ToolCallFailedPayload (required `message`, always-populated
 * machine-readable `code`) — never the completed shape.
 */
function mapToolItemCompleted(
  itemType: string,
  item: Record<string, unknown>,
  itemId: string,
  turnId: string
): MappedEvent {
  const result = normalizeToolResult(itemType, item)
  const durationMs = numberValue(item['durationMs'])
  const name = stringValue(item['name']) ?? TOOL_NAMES[itemType] ?? itemType
  const extra = { turnId: asTurnId(turnId), itemId }
  const outcome = classifyToolOutcome(itemType, item)

  if (outcome.kind === 'failed') {
    const data = objectWithDefined({ result, durationMs })
    return {
      type: 'tool.call.failed',
      payload: {
        toolCallId: asToolCallId(itemId),
        name,
        message: outcome.message,
        code: outcome.code,
        ...(data !== undefined ? { data } : {}),
      },
      extra,
    }
  }

  return {
    type: 'tool.call.completed',
    payload: {
      toolCallId: asToolCallId(itemId),
      name,
      ...(result !== undefined ? { result } : {}),
      // isError reports a DOMAIN error signal only. Codex surfaces none on a
      // completed item (the mcpToolCall error channel is a FAILED path; a
      // process exitCode is not a domain error), so a completed Codex tool call
      // is always isError:false.
      isError: false,
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    extra,
  }
}

/**
 * Classify a Codex `item/completed` tool item into a terminal outcome
 * (T-06550, daedalus-ruled 2026-07-18). Rulings, recorded against real payload
 * evidence in the task's evidence comment:
 *
 * - Scope 2(a) PRECEDENCE (status vs exitCode): the upstream schema makes the
 *   commandExecution `status` a required enum that INCLUDES `failed`, but the
 *   repo has no real capture proving whether Codex sets `status:'failed'` for an
 *   ordinary nonzero exit vs only for a spawn/handler failure. The ambiguity is
 *   itself the evidence: acceptance 1 wins, so a commandExecution that carries a
 *   DEFINED `exitCode` has reached its result boundary → `completed`, REGARDLESS
 *   of status. `status !== 'completed'` maps to `failed` only when NO exitCode is
 *   present (never-ran / spawn failure / a `declined` pre-execution rejection).
 * - Scope 2(b) (mcpToolCall `error`): CONFIRMED the transport/execution error
 *   channel — `McpToolCallError` is `{ message }`, the `Err(String)` side of the
 *   upstream `Result<CallToolResult, String>`; the success `McpToolCallResult`
 *   has NO `isError`. Domain results-with-isError are structurally absent, so a
 *   non-null `error` is a transport/handler failure → `failed`.
 */
function classifyToolOutcome(itemType: string, item: Record<string, unknown>): ToolOutcome {
  // Result-boundary guard (scope 2a precedence): a defined exitCode means the
  // command ran to a result — a nonzero exit is a completed result, never
  // re-aliased to failed even if the provider also stamped a non-'completed'
  // status. This is the scope-1 regression tripwire.
  if (itemType === 'commandExecution' && numberValue(item['exitCode']) !== undefined) {
    return { kind: 'completed' }
  }

  // No result boundary + provider reports a non-'completed' terminal status →
  // failed, code derived from the status (e.g. `codex_failed`, `codex_declined`).
  const status = stringValue(item['status'])
  if (status !== undefined && status !== 'completed') {
    return {
      kind: 'failed',
      code: `codex_${status}`,
      message: `Codex reported the ${TOOL_NAMES[itemType] ?? itemType} tool as "${status}" without returning a result`,
    }
  }

  // mcpToolCall transport/execution error channel → failed.
  if (itemType === 'mcpToolCall') {
    const error = item['error']
    if (error !== undefined && error !== null) {
      return {
        kind: 'failed',
        code: 'codex_mcp_error',
        message: mcpErrorMessage(error),
      }
    }
  }

  return { kind: 'completed' }
}

/** Human message for a failed mcpToolCall from its `McpToolCallError` (`{ message }`) or a raw string. */
function mcpErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.length > 0) return error
  const message = stringValue(asRecord(error)['message'])
  return message !== undefined && message.length > 0 ? message : 'MCP tool call failed'
}

function objectWithDefined(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
