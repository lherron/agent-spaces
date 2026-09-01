import type {
  EventProvenance,
  InvocationEventEnvelope,
  InvocationId,
  MessageId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { CaptureGate, NormalizeOutcome } from '../../capture/capture-gate'
import { createInvocationEventSequencer } from '../../events'
import { getNumber, getString } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
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
  /**
   * This invocation's normalization cursor (T-07853 §§7.1, 6.1). Each rollout
   * row is committed verbatim and dispositioned before it is normalized. Absent
   * in the isolated unit harness, where the reader behaves exactly as before.
   */
  capture?: CaptureGate | undefined
}

type HeldAgentMessage = {
  messageId: MessageId
  content: string
  /**
   * Provenance of the LAST rollout row that contributed this message's content.
   * A held-latest message is assembled from several rows and flushed at a hook
   * boundary, so without this the flushed event would report the HOOK as its
   * source when the evidence is the rollout transcript.
   */
  provenance?: EventProvenance | undefined
}

type PendingDelta = {
  messageId: MessageId
  chunks: Map<number, string>
  provenance?: EventProvenance | undefined
}

export function createCodexHookTranscriptReader(
  options: CodexHookTranscriptReaderOptions
): CodexHookTranscriptReader {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const sourceKey = `provider-jsonl:${options.invocationId}`
  const tailer = createJsonlByteOffsetTailer({
    onEpochChange: () => options.capture?.rotateEpoch(sourceKey),
  })
  /** Provenance of the rollout row currently being normalized, if any. */
  let currentRowProvenance: EventProvenance | undefined

  let held: HeldAgentMessage | undefined
  let pendingDelta: PendingDelta | undefined
  let transcriptLastAgentMessage: string | undefined
  let messageCounter = 0
  const seenMessageIds = new Set<string>()

  // Reset the per-line state machine. Offset/partial rewinding is owned by the
  // shared tailer (via retarget/clear).
  const resetState = (): void => {
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
  /**
   * Attach the provenance of the rollout row that is the EVIDENCE for an event.
   * Codex holds assistant prose and flushes it at a hook boundary, so without
   * this the flushed envelope would report the hook as its source when the
   * evidence is the rollout transcript — and the driver declares `conversation`
   * native precisely because the transcript owns it.
   */
  const stamped = (
    event: InvocationEventEnvelope,
    provenance: EventProvenance | undefined
  ): InvocationEventEnvelope => {
    if (provenance !== undefined) event.provenance = provenance
    return event
  }

  const holdMessage = (
    messageId: MessageId,
    content: string,
    into: InvocationEventEnvelope[]
  ): void => {
    if (content.length === 0) return
    if (held !== undefined) {
      into.push(stamped(completedEvent(held, false), held.provenance))
    }
    // The row being normalized right now is the evidence for this content, and
    // it is remembered because the message is FLUSHED later, at a hook boundary.
    held = { messageId, content, provenance: currentRowProvenance }
  }

  const flushHeldInterim = (into: InvocationEventEnvelope[]): void => {
    if (held === undefined) return
    const message = held
    held = undefined
    into.push(stamped(completedEvent(message, false), message.provenance))
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
      const provenance = held.provenance
      held = undefined
      if (content.length === 0) return false
      into.push(stamped(completedEvent(message, true), provenance))
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
    const { messageId, chunks, provenance: deltaProvenance } = pendingDelta
    pendingDelta = undefined
    if (seenMessageIds.has(messageId)) return
    const content = [...chunks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('')
    if (content.length === 0) return
    seenMessageIds.add(messageId)
    // A coalesced delta stream belongs to the LAST row that fed it, which may
    // be several rows back by the time a new message id forces the coalesce.
    const restore = currentRowProvenance
    currentRowProvenance = deltaProvenance ?? restore
    try {
      holdMessage(messageId, content, into)
    } finally {
      currentRowProvenance = restore
    }
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

  const processAgentMessage = (
    entry: Record<string, unknown>,
    messageRecord: Record<string, unknown>,
    message: string,
    phase: string | undefined,
    into: InvocationEventEnvelope[]
  ): void => {
    const id = messageIdFor(entry, messageRecord)
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
    if (phase === 'commentary') {
      flushHeldInterim(into)
      into.push(completedEvent({ messageId: id, content: message }, false))
      return
    }
    holdMessage(id, message, into)
  }

  const itemCompletedAgentMessage = (
    payload: Record<string, unknown>
  ): { item: Record<string, unknown>; message: string; phase: string | undefined } | undefined => {
    const itemValue = payload['item']
    if (itemValue === null || typeof itemValue !== 'object' || Array.isArray(itemValue)) {
      return undefined
    }
    const item = itemValue as Record<string, unknown>
    if (getString(item, 'type') !== 'AgentMessage') return undefined
    const content = item['content']
    if (!Array.isArray(content)) return undefined
    const message = content
      .flatMap((part) => {
        if (part === null || typeof part !== 'object' || Array.isArray(part)) return []
        const text = getString(part as Record<string, unknown>, 'text')
        return text === undefined ? [] : [text]
      })
      .join('')
    return { item, message, phase: getString(item, 'phase') }
  }

  /**
   * Normalize ONE committed rollout row and report its disposition (§6.1).
   *
   * NOTE ON THE VOCABULARY GAP: unlike claude-code-tmux, this driver's rollout
   * vocabulary has NOT been pinned from archived real sessions, so a row this
   * reader does not consume is dispositioned `ignored-known` (carrying its type
   * in `detail`) rather than `blocked-unknown`. Inventing a "known types" table
   * without evidence would either halt real sessions on ordinary rows or give a
   * false assurance of completeness. The raw journal now captures every row, so
   * pinning the table from real captures is the concrete Phase-3 prerequisite —
   * see AUTHORITY.md.
   */
  const processLine = (line: string, into: InvocationEventEnvelope[]): NormalizeOutcome => {
    if (line.trim().length === 0) {
      return { disposition: 'ignored-known', detail: 'blank line' }
    }
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { disposition: 'ignored-known', detail: 'non-object row' }
      }
      entry = parsed as Record<string, unknown>
    } catch {
      return { disposition: 'ignored-known', detail: 'unparsable row' }
    }

    const before = into.length
    const rowType = getString(entry, 'type') ?? '(none)'
    if (entry['type'] !== 'event_msg') {
      return { disposition: 'ignored-known', detail: rowType }
    }
    const payloadValue = entry['payload']
    if (payloadValue === null || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
      return { disposition: 'ignored-known', detail: 'event_msg with no payload object' }
    }
    const payload = payloadValue as Record<string, unknown>
    const payloadType = getString(payload, 'type')
    const outcome = (): NormalizeOutcome =>
      into.length > before
        ? { disposition: 'normalized', detail: `event_msg:${payloadType ?? '(none)'}` }
        : { disposition: 'state-only', detail: `event_msg:${payloadType ?? '(none)'}` }

    if (payloadType === 'agent_message_delta') {
      const delta = getString(payload, 'delta')
      if (delta === undefined) return outcome()
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
      pendingDelta.provenance = currentRowProvenance
      return outcome()
    }

    if (payloadType === 'agent_message') {
      const message = getString(payload, 'message')
      if (message === undefined) return outcome()
      processAgentMessage(entry, payload, message, getString(payload, 'phase'), into)
      return outcome()
    }

    // Codex CLI 0.149 emits visible prose as item_completed/AgentMessage rather
    // than the earlier agent_message record. Preserve its phase: commentary is
    // an intermediate completion, while final_answer remains held for Stop.
    if (payloadType === 'item_completed') {
      const agentMessage = itemCompletedAgentMessage(payload)
      if (agentMessage === undefined) return outcome()
      processAgentMessage(entry, agentMessage.item, agentMessage.message, agentMessage.phase, into)
      return outcome()
    }

    if (payloadType === 'task_complete') {
      const lastAgent = getString(payload, 'last_agent_message')
      if (lastAgent !== undefined) transcriptLastAgentMessage = lastAgent
    }
    return outcome()
  }

  /**
   * Commit every newly appended rollout row verbatim, then normalize it in file
   * order with its provenance active. Without a capture gate (the isolated unit
   * harness) the row is normalized directly and behaviour is unchanged.
   */
  const readRows = (into: InvocationEventEnvelope[]): void => {
    tailer.readNewLines((line, cursor) => {
      const capture = options.capture
      if (capture === undefined) {
        processLine(line, into)
        return
      }
      capture.ingest(
        {
          provider: 'openai',
          driverKind: CODEX_CLI_TMUX_DRIVER_KIND,
          sourceKind: 'provider-jsonl',
          sourceKey,
          sourceCursor: cursor,
          nativeType: codexNativeTypeOf(line),
          rawBytes: Buffer.from(line, 'utf8'),
        },
        (captured) => {
          const before = into.length
          currentRowProvenance = captured.provenance()
          try {
            const result = processLine(line, into)
            // Anything this row minted that a flush helper did not already
            // attribute to an EARLIER row belongs to this row.
            for (let index = before; index < into.length; index += 1) {
              const event = into[index]
              if (event !== undefined && event.provenance === undefined) {
                event.provenance = currentRowProvenance
              }
            }
            return result
          } finally {
            currentRowProvenance = undefined
          }
        }
      )
    })
  }

  return {
    handleHook(hook: Record<string, unknown>): InvocationEventEnvelope[] {
      const into: InvocationEventEnvelope[] = []
      const rawType = getString(hook, 'hook_event_name')

      if (rawType === 'SessionStart') {
        const transcriptPath = getString(hook, 'transcript_path')
        if (transcriptPath !== undefined && transcriptPath.length > 0) {
          if (tailer.retarget(transcriptPath)) resetState()
        }
        return into
      }

      readRows(into)

      if (rawType === 'PreToolUse' || rawType === 'PostToolUse') {
        // A pending assistant message at a tool boundary cannot be the terminal
        // answer for this turn. Flush it before the normalized tool event so
        // prose that Codex logged before a function_call appears before
        // tool.call.started when the transcript has reached the hook.
        coalescePendingDelta(into)
        flushHeldInterim(into)
      }

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
      tailer.clear()
      messageCounter = 0
      resetState()
    },
  }
}

/** Native type recorded on a rollout raw record: row type refined by payload type. */
function codexNativeTypeOf(line: string): string {
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
  const rowType = getString(entry, 'type') ?? 'untyped'
  const payload = entry['payload']
  if (
    rowType === 'event_msg' &&
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  ) {
    return `event_msg:${getString(payload as Record<string, unknown>, 'type') ?? '(none)'}`
  }
  return rowType
}
