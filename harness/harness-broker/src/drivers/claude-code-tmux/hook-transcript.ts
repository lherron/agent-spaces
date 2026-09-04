import { existsSync } from 'node:fs'
import type {
  EventProvenance,
  InvocationEventPayloadMap,
  InvocationEventType,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import type { CaptureGate } from '../../capture/capture-gate'
import { getString, unwrapHookPayload } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { CLAUDE_CODE_TMUX_DRIVER_KIND, formatToolOutput } from './hook-events'
import {
  CLAUDE_IGNORED_ATTACHMENT_TYPES,
  CLAUDE_IGNORED_ROW_TYPES,
  CLAUDE_KNOWN_QUEUE_OPERATIONS,
  CLAUDE_KNOWN_SYSTEM_SUBTYPES,
  CLAUDE_UNKNOWN_ATTACHMENT_FAMILY,
  CLAUDE_UNKNOWN_ROW_FAMILY,
} from './native-types'

/**
 * Claude Code session-transcript reader (T-02027, T-07849 rev 12).
 *
 * The reader forwards queue operations, queued-command attachments, and plain
 * user rows to the driver's disposition mirror in strict transcript order. It
 * deliberately mints no prompt event by itself: enqueue is only harness-local
 * limbo, while remove+queued_command and a plain user row are context-entry
 * evidence and therefore the only points where attribution may be announced.
 *
 * It additionally surfaces Claude Code API-failure rows (T-05092). CC records
 * an API error as an `type:"assistant"` row with `isApiErrorMessage:true` whose
 * text lives under `message.content[].text`, plus top-level `requestId`/`error`.
 * Like the steered prompt, this NEVER arrives via a hook, so this transcript
 * reader is its only path to the broker. Each such row emits exactly one
 * non-terminal `diagnostic` (`level:'error'`, `source:'harness'`,
 * `data.code:'api_error'`) — it MUST NOT by itself mint a terminal/lifecycle
 * event (daedalus ruling, DM #9988). Because the byte-offset tailer never
 * re-reads a consumed row, no dedup is needed across hook reads and the stop()
 * drain.
 *
 * This reader mirrors the codex-cli-tmux transcript reader's synchronous
 * byte-offset JSONL tailer, but is far simpler — no held-latest / delta
 * coalescing / terminal classification. The driver calls
 * {@link ClaudeHookTranscriptReader.handleHook} before `normalizeHookEnvelope`
 * and also calls {@link ClaudeHookTranscriptReader.drain} from native file
 * notifications. Both call sites share the driver's serialized hook-drain
 * chain, preserving order while allowing a trailing interrupt marker to land
 * when Claude emits no subsequent hook.
 */
export type ClaudeHookTranscriptReader = {
  /**
   * Process a single raw hook in hook order. Transcript rows are committed to
   * the raw journal and normalized in strict file order; events reach the
   * broker through the injected `emit`, stamped with the provenance of the row
   * that produced them.
   */
  handleHook: (hook: Record<string, unknown>, turnId?: string | undefined) => void
  /**
   * Read any transcript bytes appended since the last read WITHOUT a triggering
   * hook, emitting the same events `handleHook` would. The driver calls this on
   * native file-change notifications and in `stop()` (before `reset()`). The
   * byte-offset tailer is the dedupe mechanism: rows already consumed by a
   * prior read are not replayed.
   */
  drain: () => void
  /**
   * Flush the held assistant message as this turn's TERMINAL prose, stamped
   * with the provenance of the transcript row that carried it.
   *
   * The Claude `Stop` hook is the synchronous CONTROL that says "the turn is
   * over"; the assistant ROW is the evidence of what was said. Claude writes
   * the turn's closing `system` rows only AFTER the Stop hooks return, so
   * without this seam a transcript-primary `conversation` would have no
   * successor row to flush against at the moment HRC needs the final message.
   * Returns TRUE when a terminal message was emitted.
   */
  flushTerminalAssistantMessage: () => boolean
  reset: () => void
}

export type ClaudeHookTranscriptReaderOptions = {
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
  /**
   * Emits a normalized event. The driver wires this to its provenance-stamping
   * emit wrapper, so an event minted while a raw row is being normalized
   * carries that row's provenance.
   */
  emit: <K extends InvocationEventType>(
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?:
      | { turnId?: TurnId | undefined; driver?: { kind: string; rawType?: string | undefined } }
      | undefined
  ) => void
  onApiError?: ((turnId: string) => void) | undefined
  /**
   * Observes one queue-operation / attachment / user row. Returns TRUE when the
   * row produced a broker fact (an attribution action), FALSE when it only
   * updated mirror state, or a narrow explicit disposition for a transcript
   * signature whose meaning depends on the mirror's current turn state.
   */
  onTranscriptEntry?:
    | ((
        entry: Record<string, unknown>,
        context: { precededByStopHookCancelled: boolean }
      ) => boolean | NormalizeOutcome | undefined)
    | undefined
  onAssistantMessageStarted?:
    | ((messageId: string, entry: Record<string, unknown>) => void)
    | undefined
  /** This invocation's normalization cursor. Absent in the isolated unit harness. */
  capture?: CaptureGate | undefined
  /**
   * Run `body` with `provenance` active on the driver's emit seam, restoring
   * whatever was active before. Transcript rows are normalized INSIDE a hook
   * record's normalization, so without this the events a transcript row mints
   * would inherit the HOOK record's provenance and report native evidence as
   * hook-observed — the exact falsehood §7.2 exists to prevent.
   */
  withProvenance?: (<T>(provenance: EventProvenance, body: () => T) => T) | undefined
  /**
   * Announces the transcript file selected by SessionStart. The driver uses
   * this to arm native append notifications; reads themselves still flow
   * through {@link ClaudeHookTranscriptReader.drain}, so the byte-offset
   * tailer remains the single source of ordering and deduplication.
   */
  onTranscriptPath?: ((path: string) => void) | undefined
  /**
   * Announces that a hook-driven tail read found the selected transcript file.
   * This is the lazy watcher-arm seam: it adds no wakeup of its own.
   */
  onTranscriptAvailable?: ((path: string) => void) | undefined
  /**
   * A continuation points SessionStart at a transcript that already contains
   * prior turns. Snapshot its EOF when SessionStart arrives so only rows from
   * this resumed launch enter the new invocation's canonical ledger.
   */
  resumeFromTranscriptEnd?: boolean | undefined
}

type ApiErrorClass = 'rate_limit' | 'overloaded' | 'server_error' | 'auth' | 'quota'

export function createClaudeHookTranscriptReader(
  options: ClaudeHookTranscriptReaderOptions
): ClaudeHookTranscriptReader {
  const sourceKey = `provider-jsonl:${options.invocationId}`
  const tailer = createJsonlByteOffsetTailer({
    // A replaced or truncated transcript is a new source epoch: byte offsets
    // recorded before it address a different file (§7.1).
    onEpochChange: () => options.capture?.rotateEpoch(sourceKey),
  })
  let previousWasStopHookCancelled = false
  let transcriptPath: string | undefined
  /**
   * Provenance of the row currently being normalized. Held separately from
   * `withProvenance` so a message assembled from SEVERAL rows can be flushed
   * later against the provenance of the row that actually carried its prose
   * (§7.2: a provider claim must name its record).
   */
  let currentRowProvenance: EventProvenance | undefined
  /**
   * The assistant message being assembled. Claude writes ONE ROW PER CONTENT
   * BLOCK, all rows of a message sharing one `message.id` and running along an
   * `apiBlockIndex` sequence — 155 rows carry 117 messages across the archived
   * corpus (38 of them multi-row), and a live seat under this task reached 246
   * rows for 137 messages, up to 3 rows each. A row is NOT a message. Rows of
   * one message are contiguous, so the message is flushed when a row belonging
   * to anything else arrives.
   */
  let heldAssistantMessage:
    | {
        messageId: string
        turnId?: string | undefined
        text: string
        stopReason?: string | undefined
        provenance?: EventProvenance | undefined
      }
    | undefined
  /**
   * Message ids whose usage has been reported. Every row of one message repeats
   * the SAME `message.usage` object (155/155 rows, 0 differing, measured over
   * the three archived sessions and one live one), so reporting per ROW would
   * multiply a turn's token counts by its block count.
   */
  const usageReportedMessageIds = new Set<string>()
  /**
   * `tool_use_id` -> tool name. `tool.call.completed` REQUIRES a name and the
   * `tool_result` block carries none, so the name is remembered from the
   * `tool_use` block that opened the call. Same id space as the hooks
   * (`PreToolUse.tool_use_id` == the `tool_use` block id, 16/16 on the first
   * real session), which is what lets `permission` stay hook and still
   * correlate onto a transcript-minted tool call.
   */
  const toolNamesById = new Map<string, string>()

  /**
   * Extract the human-readable API-error text from an assistant row. CC nests it
   * under `message.content[]` (array of `{type:'text', text}`), but tolerate a
   * plain-string `content` and a top-level `text` as fallbacks so the diagnostic
   * message is never `[object Object]` or empty.
   */
  const extractAssistantText = (entry: Record<string, unknown>): string => {
    const message = entry['message']
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>)['content']
      if (typeof content === 'string') return content.trim()
      if (Array.isArray(content)) {
        const text = content
          .map((part) =>
            part !== null && typeof part === 'object' && !Array.isArray(part)
              ? getString(part as Record<string, unknown>, 'text')
              : undefined
          )
          .filter((part): part is string => part !== undefined && part.length > 0)
          .join('')
        if (text.length > 0) return text.trim()
      }
    }
    return getString(entry, 'text')?.trim() ?? ''
  }

  const emitApiErrorDiagnostic = (
    entry: Record<string, unknown>,
    turnIdText?: string | undefined
  ): void => {
    const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined
    const message = extractAssistantText(entry)
    const requestId = getString(entry, 'requestId')
    const error = getString(entry, 'error')
    const status = entry['status']
    const errorClass = classifyApiError({
      message,
      error,
      status: typeof status === 'number' ? status : undefined,
    })
    if (turnIdText !== undefined) {
      options.onApiError?.(turnIdText)
    }
    options.emit(
      'diagnostic',
      {
        level: 'error',
        source: 'harness',
        message: message.length > 0 ? message : 'Claude Code API error',
        data: {
          code: 'api_error',
          rawType: 'assistant',
          isApiErrorMessage: true,
          ...(typeof status === 'number' ? { apiErrorStatus: status } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(errorClass !== undefined ? { errorClass } : {}),
        },
      },
      {
        ...(turnId !== undefined ? { turnId } : {}),
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'assistant' },
      }
    )
  }

  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined

  const contentBlocks = (entry: Record<string, unknown>): Record<string, unknown>[] => {
    const content = asRecord(entry['message'])?.['content']
    if (!Array.isArray(content)) return []
    return content
      .map((block) => asRecord(block))
      .filter((block): block is Record<string, unknown> => block !== undefined)
  }

  const emitWithProvenance = (provenance: EventProvenance | undefined, body: () => void): void => {
    if (provenance === undefined || options.withProvenance === undefined) {
      body()
      return
    }
    options.withProvenance(provenance, body)
  }

  /**
   * Emit the held assistant message. `final` says whether this is the turn's
   * terminal answer; when it is not supplied the row's own `stop_reason`
   * decides (`end_turn` is the model saying it is done).
   */
  const flushHeldAssistantMessage = (final?: boolean): boolean => {
    const message = heldAssistantMessage
    heldAssistantMessage = undefined
    if (message === undefined || message.text.length === 0) return false
    emitWithProvenance(message.provenance, () => {
      options.emit(
        'assistant.message.completed',
        {
          messageId: message.messageId as MessageId,
          content: [{ type: 'text', text: message.text }],
          final: final ?? message.stopReason === 'end_turn',
        },
        {
          ...(message.turnId !== undefined ? { turnId: message.turnId as TurnId } : {}),
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.assistant' },
        }
      )
    })
    return true
  }

  /**
   * Normalize one `type:'assistant'` row: usage, tool starts, and the prose
   * that accumulates into the held message. Returns TRUE when the ROW ITSELF
   * minted (a flush of the PREVIOUS message is attributed to that message's
   * own row, not to this one).
   */
  const processAssistantRow = (
    entry: Record<string, unknown>,
    turnIdText?: string | undefined
  ): boolean => {
    const message = asRecord(entry['message'])
    const messageId =
      (message !== undefined ? getString(message, 'id') : undefined) ?? getString(entry, 'uuid')
    // A message STARTS on the first row that carries its id, not on every row
    // of it — Claude writes one row per content block.
    const startsNewMessage =
      messageId !== undefined && heldAssistantMessage?.messageId !== messageId
    if (startsNewMessage) {
      flushHeldAssistantMessage()
      options.onAssistantMessageStarted?.(messageId as string, entry)
    }

    const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined
    let minted = false

    const usage = message?.['usage']
    if (usage !== undefined && messageId !== undefined && !usageReportedMessageIds.has(messageId)) {
      usageReportedMessageIds.add(messageId)
      options.emit(
        'usage.updated',
        { usage },
        {
          ...(turnId !== undefined ? { turnId } : {}),
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.assistant' },
        }
      )
      minted = true
    }

    const stopReason = message !== undefined ? getString(message, 'stop_reason') : undefined
    let text = ''
    for (const block of contentBlocks(entry)) {
      const blockType = getString(block, 'type')
      if (blockType === 'text') {
        text += getString(block, 'text') ?? ''
        continue
      }
      if (blockType !== 'tool_use') continue
      const toolCallId = getString(block, 'id')
      if (toolCallId === undefined) continue
      const name = getString(block, 'name') ?? 'tool'
      toolNamesById.set(toolCallId, name)
      options.emit(
        'tool.call.started',
        {
          toolCallId: toolCallId as ToolCallId,
          name,
          ...(block['input'] !== undefined ? { input: block['input'] } : {}),
        },
        {
          ...(turnId !== undefined ? { turnId } : {}),
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.assistant' },
        }
      )
      minted = true
    }

    if (messageId !== undefined) {
      const held = heldAssistantMessage ?? {
        messageId,
        ...(turnIdText !== undefined ? { turnId: turnIdText } : {}),
        text: '',
      }
      held.text += text
      if (stopReason !== undefined) held.stopReason = stopReason
      if (text.length > 0) held.provenance = currentRowProvenance
      else held.provenance ??= currentRowProvenance
      heldAssistantMessage = held
    }
    return minted
  }

  /** Emit `tool.call.completed` for every `tool_result` block on a user row. */
  const processToolResults = (
    entry: Record<string, unknown>,
    turnIdText?: string | undefined
  ): boolean => {
    const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined
    let minted = false
    for (const block of contentBlocks(entry)) {
      if (getString(block, 'type') !== 'tool_result') continue
      const toolCallId = getString(block, 'tool_use_id')
      if (toolCallId === undefined) continue
      const name = toolNamesById.get(toolCallId) ?? 'tool'
      toolNamesById.delete(toolCallId)
      const isError = block['is_error'] === true
      const { output, responseObject } = formatToolOutput({
        toolName: name,
        toolInput: undefined,
        // `toolUseResult` is the structured result Claude records alongside the
        // block (stdout/stderr/interrupted/…); the block's own `content` is the
        // text the model saw. Prefer the structured record, fall back to it.
        toolResponse: entry['toolUseResult'] ?? block['content'],
        isError,
      })
      options.emit(
        'tool.call.completed',
        {
          toolCallId: toolCallId as ToolCallId,
          name,
          isError,
          result: {
            content: [{ type: 'text', text: output ?? '' }],
            ...(responseObject !== undefined ? { details: responseObject } : {}),
          },
        },
        {
          ...(turnId !== undefined ? { turnId } : {}),
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.user' },
        }
      )
      minted = true
    }
    return minted
  }

  /** Session-cumulative cost/usage roll-up (`type:'cost-state'`). */
  const processCostStateRow = (
    entry: Record<string, unknown>,
    turnIdText?: string | undefined
  ): NormalizeOutcome => {
    // The row TYPE is carried by the raw record's provenance, so it is stripped
    // from the body rather than smuggled into the usage shape.
    const { type: _rowType, ...usage } = entry
    options.emit(
      'usage.updated',
      { usage },
      {
        ...(turnIdText !== undefined ? { turnId: turnIdText as TurnId } : {}),
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.cost-state' },
      }
    )
    return { disposition: 'normalized', detail: 'cost-state' }
  }

  /** `type:'system'` rows, dispositioned per pinned subtype (T-07873 §B). */
  const classifySystemRow = (entry: Record<string, unknown>): NormalizeOutcome => {
    const subtype = getString(entry, 'subtype')
    if (subtype === undefined || !CLAUDE_KNOWN_SYSTEM_SUBTYPES.has(subtype)) {
      return {
        disposition: 'blocked-unknown',
        family: CLAUDE_UNKNOWN_ROW_FAMILY,
        message: `Unknown Claude system row subtype: ${subtype ?? '(none)'}`,
      }
    }
    if (subtype === 'turn_duration' || subtype === 'stop_hook_summary') {
      // The transcript's turn terminal. READ and pinned, but NOT the primary:
      // `turn-bracket` stays `hook` because this row does not exist for an
      // interrupted turn and is written only after the Stop hooks return.
      // AUTHORITY.md "Phase 4" carries the measurement.
      return { disposition: 'duplicate', detail: describeTurnTerminalRow(entry, subtype) }
    }
    return { disposition: 'ignored-known', detail: `system:${subtype}` }
  }

  /** `type:'attachment'` rows the disposition mirror did not claim. */
  const classifyAttachmentRow = (entry: Record<string, unknown>): NormalizeOutcome => {
    const attachment = entry['attachment']
    const attachmentType =
      attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)
        ? getString(attachment as Record<string, unknown>, 'type')
        : undefined
    if (attachmentType === 'hook_blocking_error') {
      // The other side of the Stop DECISION bridge: when the broker BLOCKS a
      // Stop (the structured-output retry), Claude records the block as this
      // attachment and feeds the reason back into the conversation. Found by
      // the T-07873 structured-output live leg — the only path that exercises a
      // blocking hook decision, which is why no archived session contains one.
      // Ignored-known with the reason kept and the `command` (which carries
      // socket paths) deliberately dropped, exactly as `hook_cancelled` does.
      const attachmentRecord = attachment as Record<string, unknown>
      const blocking = asRecord(attachmentRecord['blockingError'])
      return {
        disposition: 'ignored-known',
        detail: JSON.stringify({
          hookName: getString(attachmentRecord, 'hookName') ?? null,
          hookEvent: getString(attachmentRecord, 'hookEvent') ?? null,
          blockingError:
            blocking !== undefined ? (getString(blocking, 'blockingError') ?? null) : null,
        }),
      }
    }
    if (attachmentType === 'hook_cancelled') {
      const attachmentRecord = attachment as Record<string, unknown>
      const hookName = getString(attachmentRecord, 'hookName')
      previousWasStopHookCancelled = hookName === 'Stop'
      return {
        disposition: 'ignored-known',
        detail: JSON.stringify({
          hookName: hookName ?? null,
          hookEvent: getString(attachmentRecord, 'hookEvent') ?? null,
          durationMs:
            typeof attachmentRecord['durationMs'] === 'number'
              ? attachmentRecord['durationMs']
              : null,
          timedOut:
            typeof attachmentRecord['timedOut'] === 'boolean' ? attachmentRecord['timedOut'] : null,
        }),
      }
    }
    if (attachmentType !== undefined && CLAUDE_IGNORED_ATTACHMENT_TYPES.has(attachmentType)) {
      return { disposition: 'ignored-known', detail: `attachment:${attachmentType}` }
    }
    if (attachmentType === 'queued_command') {
      // Seen by the mirror but not (yet) matched to a pending submission —
      // mirror state changed, no fact minted.
      return { disposition: 'state-only', detail: 'attachment:queued_command' }
    }
    return {
      disposition: 'blocked-unknown',
      family: CLAUDE_UNKNOWN_ATTACHMENT_FAMILY,
      message: `Unknown Claude attachment type: ${attachmentType ?? '(none)'}`,
    }
  }

  /**
   * Normalize ONE committed transcript row and report its disposition (§6.1).
   * Nothing here decides what a row MEANS beyond routing it: the disposition
   * mirror owns queue semantics, and this function only says whether the row
   * produced a fact, only moved state, was already owned by the hook path, is
   * known-and-ignorable, or is a vocabulary drift that must be surfaced.
   */
  const processLine = (line: string, turnIdText?: string | undefined): NormalizeOutcome => {
    const precededByStopHookCancelled = previousWasStopHookCancelled
    // Adjacency is literal transcript adjacency. Every row consumes the
    // signature; only a named Stop hook_cancelled row below arms it again.
    previousWasStopHookCancelled = false
    if (line.trim().length === 0) {
      return { disposition: 'ignored-known', detail: 'blank line' }
    }
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          disposition: 'blocked-unknown',
          family: CLAUDE_UNKNOWN_ROW_FAMILY,
          message: 'Claude transcript row is not a JSON object',
        }
      }
      entry = parsed as Record<string, unknown>
    } catch {
      return {
        disposition: 'blocked-unknown',
        family: CLAUDE_UNKNOWN_ROW_FAMILY,
        message: 'Claude transcript row is not valid JSON',
      }
    }

    const entryType = getString(entry, 'type')
    if (entryType === undefined) {
      return {
        disposition: 'blocked-unknown',
        family: CLAUDE_UNKNOWN_ROW_FAMILY,
        message: 'Claude transcript row has no type',
      }
    }

    // API failure: CC records an assistant row flagged isApiErrorMessage with no
    // hook. Emit a non-terminal diagnostic; never a terminal/lifecycle event.
    if (entryType === 'assistant' && entry['isApiErrorMessage'] === true) {
      emitApiErrorDiagnostic(entry, turnIdText)
      return { disposition: 'normalized' }
    }

    if (entryType === 'queue-operation') {
      // Check the operation NAME here, before the mirror sees it. The mirror
      // reports what it cannot match against its buffer; only this table knows
      // what Claude has ever emitted, and turn attribution is load-bearing, so
      // an operation outside the pinned vocabulary is reported as drift rather
      // than routed onward as a state change (T-07849 item 11 → law 6d04d5de,
      // as amended by T-07883: it warns loudly and the cursor advances).
      const operation = getString(entry, 'operation')
      if (operation === undefined || !CLAUDE_KNOWN_QUEUE_OPERATIONS.has(operation)) {
        return {
          disposition: 'blocked-unknown',
          family: 'submission-disposition',
          message: `Unknown Claude queue operation: ${operation ?? '(none)'}`,
        }
      }
    }

    // A message ends when a row belonging to something else arrives. Only
    // `user` and `system` rows do that: the TUI interleaves `attachment`,
    // `last-prompt` and friends between the block rows of ONE message, so
    // flushing on those would split a message in two.
    if (entryType === 'user' || entryType === 'system') {
      flushHeldAssistantMessage()
    }

    if (entryType === 'assistant') {
      // Assistant rows are the PRIMARY evidence for `conversation`, `tool`
      // starts and `usage` (T-07873 scope A). One row is one CONTENT BLOCK, so
      // the prose is held and flushed when the message ends.
      const abortedMidStream = entry['isAbortedMidStream'] === true
      const minted = processAssistantRow(entry, turnIdText)
      if (abortedMidStream) {
        // The model was cut off. No `Stop` fires, so the closing `system` rows
        // that would flush this message are never written (0 of 2 interrupted
        // turns in the archived corpus have them). Flush what was said as a
        // NON-final message rather than losing it, and name the record on the
        // disposition so the interrupt terminal points at its evidence.
        const flushed = flushHeldAssistantMessage(false)
        return {
          disposition: minted || flushed ? 'normalized' : 'state-only',
          detail: 'isAbortedMidStream',
        }
      }
      return minted
        ? { disposition: 'normalized' }
        : { disposition: 'state-only', detail: 'assistant prose held' }
    }

    if (entryType === 'cost-state') return processCostStateRow(entry, turnIdText)
    if (entryType === 'system') return classifySystemRow(entry)

    if (entryType === 'queue-operation' || entryType === 'attachment' || entryType === 'user') {
      // `tool_result` blocks are the primary evidence for `tool.call.completed`
      // (T-07873 scope A); the `PostToolUse` hook keeps firing as the
      // synchronous control and its fact is a duplicate.
      const mintedToolResults = entryType === 'user' ? processToolResults(entry, turnIdText) : false
      const observation = options.onTranscriptEntry?.(entry, {
        precededByStopHookCancelled,
      })
      if (typeof observation === 'object') return observation
      if (observation === true || mintedToolResults) {
        const interruptedMessageId = getString(entry, 'interruptedMessageId')
        // The interrupt terminal's evidence IS this row; carrying the id of the
        // message it cut off makes the ledger record say which one.
        return interruptedMessageId !== undefined
          ? { disposition: 'normalized', detail: JSON.stringify({ interruptedMessageId }) }
          : { disposition: 'normalized' }
      }
      if (entryType === 'attachment') return classifyAttachmentRow(entry)
      // A queue op or user row the mirror consumed without minting: it advanced
      // the deterministic mirror state (enqueue, dequeue, an echoed prompt).
      return { disposition: 'state-only', detail: entryType }
    }

    if (CLAUDE_IGNORED_ROW_TYPES.has(entryType)) {
      return { disposition: 'ignored-known', detail: entryType }
    }

    return {
      disposition: 'blocked-unknown',
      family: CLAUDE_UNKNOWN_ROW_FAMILY,
      message: `Unknown Claude transcript row type: ${entryType}`,
    }
  }

  /**
   * Commit every newly appended row verbatim and normalize it in file order.
   * When no capture gate is wired (the isolated driver unit harness) the row is
   * normalized directly — the classification is identical, only the durable
   * journal and disposition are absent.
   */
  const readRows = (turnIdText?: string | undefined): void => {
    tailer.readNewLines((line, cursor) => {
      const capture = options.capture
      if (capture === undefined) {
        // No capture gate (isolated driver unit harness): the classification is
        // identical, but nothing else will report a blocked-unknown row, so the
        // warning is emitted here rather than silently dropped.
        const outcome = processLine(line, turnIdText)
        if (outcome.disposition === 'blocked-unknown') {
          options.emit(
            'capture.warning',
            { message: outcome.message, raw: line },
            { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript' } }
          )
        }
        return
      }
      capture.ingest(
        {
          provider: 'anthropic',
          driverKind: CLAUDE_CODE_TMUX_DRIVER_KIND,
          sourceKind: 'provider-jsonl',
          sourceKey,
          sourceCursor: cursor,
          nativeType: nativeTypeOf(line),
          rawBytes: Buffer.from(line, 'utf8'),
        },
        (captured) => {
          const provenance = captured.provenance()
          const run = () => {
            const previous = currentRowProvenance
            currentRowProvenance = provenance
            try {
              return processLine(line, turnIdText)
            } finally {
              currentRowProvenance = previous
            }
          }
          return options.withProvenance === undefined
            ? run()
            : options.withProvenance(provenance, run)
        }
      )
    })
    if (transcriptPath !== undefined && existsSync(transcriptPath)) {
      options.onTranscriptAvailable?.(transcriptPath)
    }
  }

  return {
    handleHook(hook: Record<string, unknown>, explicitTurnId?: string | undefined): void {
      const unwrapped = unwrapHookPayload(hook)
      const rawType = getString(unwrapped, 'hook_event_name')

      if (rawType === 'SessionStart') {
        const selectedPath = getString(unwrapped, 'transcript_path')
        if (selectedPath !== undefined && selectedPath.length > 0) {
          if (
            tailer.retarget(selectedPath, {
              startAtEnd: options.resumeFromTranscriptEnd === true,
            })
          ) {
            transcriptPath = selectedPath
            options.onTranscriptPath?.(selectedPath)
          }
        }
        return
      }

      readRows(explicitTurnId ?? options.getCurrentTurnId())
    },

    drain(): void {
      readRows(options.getCurrentTurnId())
    },

    flushTerminalAssistantMessage(): boolean {
      return flushHeldAssistantMessage(true)
    },

    reset(): void {
      tailer.clear()
      transcriptPath = undefined
      previousWasStopHookCancelled = false
      currentRowProvenance = undefined
      heldAssistantMessage = undefined
      usageReportedMessageIds.clear()
      toolNamesById.clear()
    },
  }
}

function classifyApiError(options: {
  message: string
  error?: string | undefined
  status?: number | undefined
}): ApiErrorClass | undefined {
  const text = `${options.error ?? ''} ${options.message}`.toLowerCase()

  // Text wins over status because providers sometimes reuse 429 for both
  // rate-limiting and exhausted quota/billing states.
  if (/\bquota\b|billing|credit|balance|payment required|insufficient funds/.test(text)) {
    return 'quota'
  }
  if (
    /invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|auth[_ -]?error/.test(text)
  ) {
    return 'auth'
  }
  if (/rate[_ -]?limit|too many requests/.test(text)) {
    return 'rate_limit'
  }
  if (/overload|capacity/.test(text)) {
    return 'overloaded'
  }
  if (
    /server[_ -]?error|internal server|service unavailable|bad gateway|gateway timeout/.test(text)
  ) {
    return 'server_error'
  }

  switch (options.status) {
    case 401:
    case 403:
      return 'auth'
    case 402:
      return 'quota'
    case 429:
      return 'rate_limit'
    case 529:
      return 'overloaded'
    default:
      return options.status !== undefined && options.status >= 500 && options.status <= 599
        ? 'server_error'
        : undefined
  }
}

/**
 * Native type recorded on the raw record: the row's `type`, refined with the
 * discriminator that actually distinguishes its behaviour (queue operation,
 * attachment subtype). Parsing failures still get a type so the record is
 * addressable when an operator releases it.
 */
function nativeTypeOf(line: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return 'unparsable'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'non-object'
  }
  const entry = parsed as Record<string, unknown>
  const entryType = getString(entry, 'type') ?? 'untyped'
  if (entryType === 'queue-operation') {
    return `queue-operation:${getString(entry, 'operation') ?? '(none)'}`
  }
  if (entryType === 'attachment') {
    const attachment = entry['attachment']
    const attachmentType =
      attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)
        ? getString(attachment as Record<string, unknown>, 'type')
        : undefined
    return `attachment:${attachmentType ?? '(none)'}`
  }
  if (entryType === 'system') {
    // The subtype is what distinguishes the turn terminal from a cosmetic
    // notice, so it belongs on the ledger's native type (T-07873).
    return `system:${getString(entry, 'subtype') ?? '(none)'}`
  }
  return entryType
}

/**
 * Detail recorded on a turn-terminal `system` row's disposition. The row is a
 * `duplicate` — the `Stop` hook owns `turn-bracket` — but the numbers it
 * carries are why that decision was made, so they stay visible in the ledger
 * instead of being reduced to the row's name.
 */
function describeTurnTerminalRow(entry: Record<string, unknown>, subtype: string): string {
  const detail: Record<string, unknown> = { subtype }
  if (typeof entry['durationMs'] === 'number') detail['durationMs'] = entry['durationMs']
  if (typeof entry['messageCount'] === 'number') detail['messageCount'] = entry['messageCount']
  if (typeof entry['stopReason'] === 'string') detail['stopReason'] = entry['stopReason']
  if (typeof entry['preventedContinuation'] === 'boolean') {
    detail['preventedContinuation'] = entry['preventedContinuation']
  }
  return JSON.stringify(detail)
}
