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

    // Mid-turn/steered prompt: the ONLY transcript record is a queue-operation
    // enqueue carrying the typed text. A queue/remove (dequeue) follows but
    // carries no new prompt — only enqueue surfaces a typed prompt.
    if (getString(entry, 'type') !== 'queue-operation') return
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

    reset(): void {
      tailer.clear()
    },
  }
}
