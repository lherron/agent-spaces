import type { InvocationEventEnvelope, InvocationId, TurnId } from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import { getString, unwrapHookPayload } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { CLAUDE_CODE_TMUX_DRIVER_KIND } from './hook-events'

/**
 * Hook-driven Claude Code session-transcript reader (T-02027).
 *
 * `UserPromptSubmit` fires ONLY for prompts submitted while the agent is idle.
 * A prompt typed while the agent is MID-TURN (actively running tools) is queued
 * /steered into the active turn by Claude and fires NO `UserPromptSubmit` — so
 * the broker never sees it and no `turn.user_prompt`/viewer row appears.
 *
 * Verified against a live e2e transcript: the steered prompt's ONLY record is a
 * `queue-operation`/`enqueue` line carrying the typed text in `content`:
 *   {"type":"queue-operation","operation":"enqueue","content":"<typed text>"}
 * (a `queue-operation`/`remove` follows at dequeue). Idle prompts instead appear
 * as `type:"user"` entries AND fire `UserPromptSubmit`; the two channels are
 * DISJOINT, so emitting `user.message` on `enqueue` does NOT double-count idle
 * prompts and needs NO dedup against `UserPromptSubmit`.
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
 * and emits the returned `user.message` events first, so a mid-turn prompt lands
 * in hook order ahead of the triggering hook's normalized events. The emitted
 * `user.message` reuses the EXISTING hop-3 map (`user.message → turn.user_prompt`)
 * verbatim — no new event type, no downstream change.
 */
export type ClaudeHookTranscriptReader = {
  /**
   * Process a single raw hook in hook order, returning any newly observed
   * mid-turn user-prompt events. `SessionStart` only records/resets the
   * transcript path; every other hook reads newly appended transcript bytes and
   * emits one `user.message` per `queue-operation`/`enqueue` line.
   */
  handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
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
}

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

  const apiErrorDiagnosticEvent = (entry: Record<string, unknown>): InvocationEventEnvelope => {
    const turnIdText = options.getCurrentTurnId()
    const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined
    const message = extractAssistantText(entry)
    const requestId = getString(entry, 'requestId')
    const error = getString(entry, 'error')
    const status = entry['status']
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
        },
      },
      {
        ...(turnId !== undefined ? { turnId } : {}),
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'assistant' },
      }
    )
  }

  const userMessageEvent = (content: string): InvocationEventEnvelope => {
    const turnIdText = options.getCurrentTurnId()
    const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined
    return sequencer.next(
      invocationId,
      'user.message',
      {
        content,
        ...(turnId !== undefined ? { turnId } : {}),
      },
      {
        ...(turnId !== undefined ? { turnId } : {}),
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'queue-operation' },
      }
    )
  }

  const processLine = (line: string, into: InvocationEventEnvelope[]): void => {
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
      into.push(apiErrorDiagnosticEvent(entry))
      return
    }

    // Mid-turn/steered prompt: the ONLY transcript record is a queue-operation
    // enqueue carrying the typed text. A queue/remove (dequeue) follows but
    // carries no new prompt — only enqueue surfaces a typed prompt.
    if (entryType !== 'queue-operation') return
    if (getString(entry, 'operation') !== 'enqueue') return
    const content = getString(entry, 'content')
    if (content === undefined || content.length === 0) return
    into.push(userMessageEvent(content))
  }

  return {
    handleHook(hook: Record<string, unknown>): InvocationEventEnvelope[] {
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

      tailer.readNewLines((line) => processLine(line, into))
      return into
    },

    drain(): InvocationEventEnvelope[] {
      const into: InvocationEventEnvelope[] = []
      tailer.readNewLines((line) => processLine(line, into))
      return into
    },

    reset(): void {
      tailer.clear()
    },
  }
}
