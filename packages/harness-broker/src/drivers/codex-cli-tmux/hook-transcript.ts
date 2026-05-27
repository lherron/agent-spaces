import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type {
  InvocationEventEnvelope,
  InvocationId,
  MessageId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import { CODEX_CLI_TMUX_DRIVER_KIND } from './hook-events'

/**
 * Hook-driven Codex rollout transcript reader (T-01710).
 *
 * Codex CLI has no `MessageDisplay`-equivalent hook, so the rollout transcript
 * JSONL is still the only source for interim agent prose. The defect this
 * replaces was a `setInterval` polling tailer that raced hook normalization;
 * this reader instead reads newly appended transcript bytes SYNCHRONOUSLY from
 * hook processing, in hook order, mirroring Claude's MessageDisplay held-latest
 * semantics: the latest agent message is held, superseded interims flush as
 * `assistant.message.completed{final:false}`, and the terminal message flushes
 * as `{final:true}` exactly once when the turn's `Stop` hook arrives.
 *
 * The driver calls {@link CodexHookTranscriptReader.handleHook} before
 * `normalizeCodexHookEnvelope`, emits the returned assistant-message events,
 * then emits the normalized hook events — so interim prose lands before the
 * triggering hook's event and the terminal message lands before `turn.completed`.
 */
export type CodexHookTranscriptReader = {
  /**
   * Process a single raw hook in hook order, returning any newly completed
   * assistant-message events. `SessionStart` only records/resets the transcript
   * path; every other hook reads newly appended rollout bytes; `Stop`
   * additionally classifies the held (last) message as the terminal `final:true`.
   */
  handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
  reset: () => void
}

export type CodexHookTranscriptReaderOptions = {
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}

type HeldAgentMessage = {
  messageId: MessageId
  content: string
}

type PendingDelta = {
  messageId: MessageId
  chunks: Map<number, string>
}

export function createCodexHookTranscriptReader(
  options: CodexHookTranscriptReaderOptions
): CodexHookTranscriptReader {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const buffer = Buffer.alloc(64 * 1024)

  let activePath: string | undefined
  let offset = 0
  let partial = ''
  let held: HeldAgentMessage | undefined
  let pendingDelta: PendingDelta | undefined
  let transcriptLastAgentMessage: string | undefined
  let messageCounter = 0
  const seenMessageIds = new Set<string>()

  const resetState = (): void => {
    offset = 0
    partial = ''
    held = undefined
    pendingDelta = undefined
    transcriptLastAgentMessage = undefined
    seenMessageIds.clear()
  }

  const completedEvent = (message: HeldAgentMessage, final: boolean): InvocationEventEnvelope => {
    const turnId = options.getCurrentTurnId()
    return sequencer.next(
      invocationId,
      'assistant.message.completed',
      {
        messageId: message.messageId,
        content: [{ type: 'text' as const, text: message.content }],
        final,
      },
      {
        ...(turnId !== undefined ? { turnId: turnId as TurnId } : {}),
        itemId: message.messageId,
        driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'agent_message' },
      }
    )
  }

  // A newly completed interim message: the previously held message (if any)
  // becomes final:false, then the new one is held as the latest candidate
  // terminal. Empty messages are never held or emitted.
  const holdMessage = (
    messageId: MessageId,
    content: string,
    into: InvocationEventEnvelope[]
  ): void => {
    if (content.length === 0) return
    if (held !== undefined) {
      into.push(completedEvent(held, false))
    }
    held = { messageId, content }
  }

  // Flush the held message as the terminal answer. Uses the held content
  // verbatim (never concatenates interim prose); falls back to the rollout /
  // Stop terminal text only when the held message is missing or empty.
  const flushTerminal = (
    fallback: string | undefined,
    into: InvocationEventEnvelope[]
  ): boolean => {
    if (held !== undefined) {
      const content = held.content.length > 0 ? held.content : (fallback ?? '')
      const message = { messageId: held.messageId, content }
      held = undefined
      if (content.length === 0) return false
      into.push(completedEvent(message, true))
      return true
    }
    if (fallback !== undefined && fallback.length > 0) {
      messageCounter += 1
      into.push(
        completedEvent(
          {
            messageId: `msg_${options.invocationId}_${messageCounter}` as MessageId,
            content: fallback,
          },
          true
        )
      )
      return true
    }
    return false
  }

  const coalescePendingDelta = (into: InvocationEventEnvelope[]): void => {
    if (pendingDelta === undefined) return
    const { messageId, chunks } = pendingDelta
    pendingDelta = undefined
    if (seenMessageIds.has(messageId)) return
    const content = [...chunks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('')
    if (content.length === 0) return
    seenMessageIds.add(messageId)
    holdMessage(messageId, content, into)
  }

  const messageIdFor = (
    entry: Record<string, unknown>,
    payload: Record<string, unknown>
  ): MessageId => {
    const id =
      getString(payload, 'id') ??
      getString(payload, 'message_id') ??
      getString(payload, 'item_id') ??
      getString(entry, 'id') ??
      getString(entry, 'message_id') ??
      getString(entry, 'item_id')
    if (id !== undefined) return id as MessageId
    messageCounter += 1
    return `msg_${options.invocationId}_${messageCounter}` as MessageId
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

    if (entry['type'] !== 'event_msg') return
    const payloadValue = entry['payload']
    if (payloadValue === null || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
      return
    }
    const payload = payloadValue as Record<string, unknown>
    const payloadType = getString(payload, 'type')

    if (payloadType === 'agent_message_delta') {
      const delta = getString(payload, 'delta')
      if (delta === undefined) return
      const idText =
        getString(payload, 'id') ??
        getString(payload, 'message_id') ??
        getString(payload, 'item_id')
      // A delta stream for a different message id completes the prior stream as
      // an interim message before this one begins.
      if (pendingDelta !== undefined && idText !== undefined && pendingDelta.messageId !== idText) {
        coalescePendingDelta(into)
      }
      if (pendingDelta === undefined) {
        pendingDelta = {
          messageId: messageIdFor(entry, payload),
          chunks: new Map<number, string>(),
        }
      }
      const index = getNumber(payload, 'index') ?? pendingDelta.chunks.size
      pendingDelta.chunks.set(index, delta)
      return
    }

    if (payloadType === 'agent_message') {
      const message = getString(payload, 'message')
      if (message === undefined) return
      const id = messageIdFor(entry, payload)
      // A consolidated agent_message supersedes its own streamed deltas; for a
      // different id, the streamed deltas complete as a prior interim first.
      if (pendingDelta !== undefined) {
        if (pendingDelta.messageId === id) {
          pendingDelta = undefined
        } else {
          coalescePendingDelta(into)
        }
      }
      if (seenMessageIds.has(id)) return
      seenMessageIds.add(id)
      transcriptLastAgentMessage = message
      holdMessage(id, message, into)
      return
    }

    if (payloadType === 'task_complete') {
      const lastAgent = getString(payload, 'last_agent_message')
      if (lastAgent !== undefined) transcriptLastAgentMessage = lastAgent
    }
  }

  const readNewBytes = (into: InvocationEventEnvelope[]): void => {
    if (activePath === undefined) return
    try {
      if (!existsSync(activePath)) return
      const stats = statSync(activePath)
      if (!stats.isFile()) return
      if (stats.size < offset) {
        offset = 0
        partial = ''
      }
      if (stats.size === offset) return

      const fd = openSync(activePath, 'r')
      try {
        while (offset < stats.size) {
          const bytesToRead = Math.min(buffer.length, stats.size - offset)
          const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset)
          if (bytesRead <= 0) break
          offset += bytesRead
          partial += buffer.subarray(0, bytesRead).toString('utf8')

          let newlineIndex = partial.indexOf('\n')
          while (newlineIndex >= 0) {
            const line = partial.slice(0, newlineIndex)
            partial = partial.slice(newlineIndex + 1)
            processLine(line, into)
            newlineIndex = partial.indexOf('\n')
          }
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    }
  }

  return {
    handleHook(hook: Record<string, unknown>): InvocationEventEnvelope[] {
      const into: InvocationEventEnvelope[] = []
      const rawType = getString(hook, 'hook_event_name')

      if (rawType === 'SessionStart') {
        const transcriptPath = getString(hook, 'transcript_path')
        if (
          transcriptPath !== undefined &&
          transcriptPath.length > 0 &&
          transcriptPath !== activePath
        ) {
          activePath = transcriptPath
          resetState()
        }
        return into
      }

      readNewBytes(into)

      if (rawType === 'Stop' || rawType === 'SubagentStop') {
        // Any in-flight delta stream completes; then the last agent message is
        // classified as the terminal answer. Stop.last_assistant_message (or the
        // rollout task_complete.last_agent_message) is only a fallback when the
        // transcript carried no usable terminal prose.
        coalescePendingDelta(into)
        const fallback = getString(hook, 'last_assistant_message') ?? transcriptLastAgentMessage
        flushTerminal(fallback, into)
      }

      return into
    },

    reset(): void {
      activePath = undefined
      messageCounter = 0
      resetState()
    },
  }
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}
