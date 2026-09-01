import type {
  InvocationEventPayloadMap,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import type { CaptureGate } from '../../capture/capture-gate'
import { getString, unwrapHookPayload } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { CLAUDE_CODE_TMUX_DRIVER_KIND } from './hook-events'
import {
  CLAUDE_IGNORED_ATTACHMENT_TYPES,
  CLAUDE_IGNORED_ROW_TYPES,
  CLAUDE_KNOWN_QUEUE_OPERATIONS,
  CLAUDE_UNKNOWN_ATTACHMENT_FAMILY,
  CLAUDE_UNKNOWN_ROW_FAMILY,
} from './native-types'

/**
 * Hook-driven Claude Code session-transcript reader (T-02027).
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
 * This reader mirrors the codex-cli-tmux transcript reader's synchronous,
 * hook-driven, byte-offset JSONL tailer, but is far simpler — no held-latest /
 * delta coalescing / terminal classification. The driver calls
 * {@link ClaudeHookTranscriptReader.handleHook} BEFORE `normalizeHookEnvelope`
 * and consumes the returned disposition events before the triggering hook's
 * normalized events.
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
   * hook, emitting the same events `handleHook` would. The driver calls this in
   * `stop()` (before `reset()`) so a trailing API-error row that no post-error
   * hook would surface still reaches the broker. The byte-offset tailer is the
   * dedupe mechanism: rows already consumed by a prior read are not replayed.
   */
  drain: () => void
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
   * updated mirror state — which is how the row's raw disposition is decided.
   */
  onTranscriptEntry?: ((entry: Record<string, unknown>) => boolean) | undefined
  /** This invocation's normalization cursor. Absent in the isolated unit harness. */
  capture?: CaptureGate | undefined
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

  /**
   * Normalize ONE committed transcript row and report its disposition (§6.1).
   * Nothing here decides what a row MEANS beyond routing it: the disposition
   * mirror owns queue semantics, and this function only says whether the row
   * produced a fact, only moved state, was already owned by the hook path, is
   * known-and-ignorable, or is a vocabulary drift that must be surfaced.
   */
  const processLine = (line: string, turnIdText?: string | undefined): NormalizeOutcome => {
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
      // an operation outside the pinned vocabulary halts the cursor rather than
      // being routed onward as a state change (T-07849 item 11 → law 6d04d5de).
      const operation = getString(entry, 'operation')
      if (operation === undefined || !CLAUDE_KNOWN_QUEUE_OPERATIONS.has(operation)) {
        return {
          disposition: 'blocked-unknown',
          family: 'submission-disposition',
          message: `Unknown Claude queue operation: ${operation ?? '(none)'}`,
        }
      }
    }

    if (entryType === 'queue-operation' || entryType === 'attachment' || entryType === 'user') {
      const producedFact = options.onTranscriptEntry?.(entry) ?? false
      if (producedFact) {
        return { disposition: 'normalized' }
      }
      if (entryType === 'attachment') {
        const attachment = entry['attachment']
        const attachmentType =
          attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)
            ? getString(attachment as Record<string, unknown>, 'type')
            : undefined
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
      // A queue op or user row the mirror consumed without minting: it advanced
      // the deterministic mirror state (enqueue, dequeue, an echoed prompt).
      return { disposition: 'state-only', detail: entryType }
    }

    if (entryType === 'assistant') {
      // Assistant prose is the HOOK path's fact for this driver (AUTHORITY.md).
      // The row is real evidence of the same semantic fact, so it is a
      // duplicate — not something ignored.
      return { disposition: 'duplicate', detail: 'assistant prose owned by the hook path' }
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
        () => processLine(line, turnIdText)
      )
    })
  }

  return {
    handleHook(hook: Record<string, unknown>, explicitTurnId?: string | undefined): void {
      const unwrapped = unwrapHookPayload(hook)
      const rawType = getString(unwrapped, 'hook_event_name')

      if (rawType === 'SessionStart') {
        const transcriptPath = getString(unwrapped, 'transcript_path')
        if (transcriptPath !== undefined && transcriptPath.length > 0) {
          tailer.retarget(transcriptPath)
        }
        return
      }

      readRows(explicitTurnId ?? options.getCurrentTurnId())
    },

    drain(): void {
      readRows(options.getCurrentTurnId())
    },

    reset(): void {
      tailer.clear()
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
  return entryType
}
