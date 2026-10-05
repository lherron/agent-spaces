import type { MessageId, TurnId } from 'spaces-harness-broker-protocol'
import type { MappedEvent } from './event-map'

export interface MuseProseSegmenter {
  /** Route one mapped event, emitting it (and any flushed prose) in order. */
  route(event: MappedEvent, emit: (event: MappedEvent) => void): void
  /** Completions still held when the invocation stops, flagged non-final. */
  takeHeldAsNonFinal(): MappedEvent[]
  reset(): void
}

/**
 * Split a muse turn's assistant prose into intermediate and final messages.
 *
 * Held completion (codex-app-server precedent): an agentMessage
 * item/completed cannot know whether the turn holds more prose, so the
 * newest completion is held back while the previously held one flushes as
 * final:false; the turn terminal flushes the last held one as final:true
 * ahead of itself. Without the hold every message would claim final:true and
 * the intermediate/final split would be unobservable.
 *
 * Delta runs: MSP streams assistant text as item/delta fragments and
 * finalizes at most one agentMessage item per turn, so without segmentation a
 * narrating turn would surface zero intermediate completions. Each text-delta
 * run accumulates per turn and flushes as
 * assistant.message.completed{final:false} at the next segment boundary (tool
 * start, next message start, or message completion) — verbatim provider
 * text, never synthesized prose.
 */
export function createMuseProseSegmenter(options: {
  currentTurnId: () => TurnId | undefined
}): MuseProseSegmenter {
  const heldAssistant = new Map<string, MappedEvent>()
  const deltaRuns = new Map<string, string>()
  let deltaRunSeq = 0

  function turnKeyOf(event: MappedEvent): string {
    const extra = event.extra as { turnId?: unknown } | undefined
    if (typeof extra?.turnId === 'string') return extra.turnId
    return (options.currentTurnId() ?? '') as string
  }

  function flushDeltaRun(key: string, emit: (event: MappedEvent) => void): void {
    const run = deltaRuns.get(key) ?? ''
    deltaRuns.delete(key)
    if (run.trim().length === 0) return
    deltaRunSeq += 1
    emit({
      type: 'assistant.message.completed',
      payload: {
        messageId: `${key}:run-${deltaRunSeq}` as MessageId,
        content: [{ type: 'text', text: run }],
        final: false,
      },
      extra: { turnId: key as TurnId },
    })
  }

  function releaseHeld(key: string, final: boolean, emit: (event: MappedEvent) => void): void {
    const previous = heldAssistant.get(key)
    if (previous === undefined) return
    heldAssistant.delete(key)
    emit(withFinal(previous, final))
  }

  function route(event: MappedEvent, emit: (event: MappedEvent) => void): void {
    const key = turnKeyOf(event)
    switch (event.type) {
      case 'assistant.message.delta': {
        const text = (event.payload as { text?: unknown }).text
        if (typeof text === 'string' && text.length > 0) {
          deltaRuns.set(key, (deltaRuns.get(key) ?? '') + text)
        }
        break
      }
      case 'assistant.message.started':
        flushDeltaRun(key, emit)
        break
      case 'assistant.message.completed':
        flushDeltaRun(key, emit)
        releaseHeld(key, false, emit)
        heldAssistant.set(key, event)
        return
      case 'tool.call.started':
        releaseHeld(key, false, emit)
        // Prose run before the tool call ends here; what streams after
        // belongs to the next segment.
        flushDeltaRun(key, emit)
        break
      case 'tool.call.completed':
      case 'tool.call.failed':
        releaseHeld(key, false, emit)
        break
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
        deltaRuns.delete(key)
        releaseHeld(key, true, emit)
        break
    }
    emit(event)
  }

  return {
    route,
    takeHeldAsNonFinal() {
      const held = [...heldAssistant.values()].map((event) => withFinal(event, false))
      heldAssistant.clear()
      return held
    },
    reset() {
      heldAssistant.clear()
      deltaRuns.clear()
      deltaRunSeq = 0
    },
  }
}

function withFinal(event: MappedEvent, final: boolean): MappedEvent {
  if (event.type !== 'assistant.message.completed') return event
  return { ...event, payload: { ...event.payload, final } }
}
