import type { InvocationEventEnvelope, InvocationId, TurnId } from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import { getString, unwrapHookPayload } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { CLAUDE_CODE_TMUX_DRIVER_KIND } from './hook-events'

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
   * Process a single raw hook in hook order, returning events produced by the
   * transcript-observation callback plus transcript-only diagnostics.
   */
  handleHook: (
    hook: Record<string, unknown>,
    turnId?: string | undefined
  ) => InvocationEventEnvelope[]
  /**
   * Read any transcript bytes appended since the last read WITHOUT a triggering
   * hook, emitting the same events `handleHook` would. The driver calls this in
   * `stop()` (before `reset()`) so a trailing API-error row that no post-error
   * hook would surface still reaches the broker. The byte-offset tailer is the
   * dedupe mechanism: rows already consumed by a prior read are not replayed.
   */
  drain: () => InvocationEventEnvelope[]
  reset: () => void
}

export type ClaudeHookTranscriptReaderOptions = {
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
  onApiError?: ((turnId: string) => void) | undefined
  onAssistantMessageStarted?:
    | ((messageId: string, entry: Record<string, unknown>) => void)
    | undefined
  onTranscriptEntry?: ((entry: Record<string, unknown>) => void) | undefined
}

type ApiErrorClass = 'rate_limit' | 'overloaded' | 'server_error' | 'auth' | 'quota'

export function createClaudeHookTranscriptReader(
  options: ClaudeHookTranscriptReaderOptions
): ClaudeHookTranscriptReader {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const tailer = createJsonlByteOffsetTailer()

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

  const apiErrorDiagnosticEvent = (
    entry: Record<string, unknown>,
    turnIdText?: string | undefined
  ): InvocationEventEnvelope => {
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
    return sequencer.next(
      invocationId,
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

  const processLine = (
    line: string,
    into: InvocationEventEnvelope[],
    turnIdText?: string | undefined
  ): void => {
    if (line.trim().length === 0) return
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      entry = parsed as Record<string, unknown>
    } catch {
      return
    }

    const entryType = getString(entry, 'type')

    // API failure: CC records an assistant row flagged isApiErrorMessage with no
    // hook. Emit a non-terminal diagnostic; never a terminal/lifecycle event.
    if (entryType === 'assistant' && entry['isApiErrorMessage'] === true) {
      into.push(apiErrorDiagnosticEvent(entry, turnIdText))
      return
    }

    if (entryType === 'assistant') {
      const message = entry['message']
      const messageId =
        message !== null && typeof message === 'object' && !Array.isArray(message)
          ? getString(message as Record<string, unknown>, 'id')
          : undefined
      const fallbackId = getString(entry, 'uuid')
      const resolvedId = messageId ?? fallbackId
      if (resolvedId !== undefined) options.onAssistantMessageStarted?.(resolvedId, entry)
      return
    }

    if (entryType === 'queue-operation' || entryType === 'attachment' || entryType === 'user') {
      options.onTranscriptEntry?.(entry)
    }
  }

  return {
    handleHook(
      hook: Record<string, unknown>,
      explicitTurnId?: string | undefined
    ): InvocationEventEnvelope[] {
      const into: InvocationEventEnvelope[] = []
      const unwrapped = unwrapHookPayload(hook)
      const rawType = getString(unwrapped, 'hook_event_name')

      if (rawType === 'SessionStart') {
        const transcriptPath = getString(unwrapped, 'transcript_path')
        if (transcriptPath !== undefined && transcriptPath.length > 0) {
          tailer.retarget(transcriptPath)
        }
        return into
      }

      const turnIdText = explicitTurnId ?? options.getCurrentTurnId()
      tailer.readNewLines((line) => processLine(line, into, turnIdText))
      return into
    },

    drain(): InvocationEventEnvelope[] {
      const into: InvocationEventEnvelope[] = []
      const turnIdText = options.getCurrentTurnId()
      tailer.readNewLines((line) => processLine(line, into, turnIdText))
      return into
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
