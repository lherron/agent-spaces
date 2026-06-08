import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { EventIterator } from './event-iterator'

/**
 * Owns the per-invocation event-stream lifecycle for {@link BrokerClient}:
 * live {@link EventIterator} streams, buffered events that arrived before a
 * stream was requested, and duplicate-seq suppression.
 *
 * De-dupe contract: replayed events (attach/eventsSince) can overlap live
 * notifications, so an event whose `seq` is `<=` the highest already surfaced
 * for its invocation is dropped — a stream never sees the same seq twice or
 * goes backwards.
 */
export class InvocationEventHub {
  #events = new Map<string, EventIterator<InvocationEventEnvelope>>()
  #pendingEvents = new Map<string, InvocationEventEnvelope[]>()
  // Highest event seq already surfaced per invocation.
  #lastEventSeq = new Map<string, number>()

  /** Surface an event to its stream, dropping duplicates by (invocationId, seq). */
  ingest(event: InvocationEventEnvelope): void {
    const lastSeq = this.#lastEventSeq.get(event.invocationId)
    if (lastSeq !== undefined && event.seq <= lastSeq) {
      return
    }
    this.#lastEventSeq.set(event.invocationId, event.seq)

    const stream = this.#events.get(event.invocationId)
    if (stream) {
      stream.push(event)
      return
    }

    const pending = this.#pendingEvents.get(event.invocationId) ?? []
    pending.push(event)
    this.#pendingEvents.set(event.invocationId, pending)
  }

  /** Get (or create) the live stream for an invocation, flushing any buffered events. */
  stream(invocationId: string): EventIterator<InvocationEventEnvelope> {
    const existing = this.#events.get(invocationId)
    if (existing) {
      return existing
    }

    const stream = new EventIterator<InvocationEventEnvelope>()
    this.#events.set(invocationId, stream)
    const pending = this.#pendingEvents.get(invocationId)
    if (pending) {
      this.#pendingEvents.delete(invocationId)
      for (const event of pending) {
        stream.push(event)
      }
    }
    return stream
  }

  /** Close and forget the stream for a single invocation (start-rollback path). */
  drop(invocationId: string): void {
    this.#events.delete(invocationId)
  }

  /** Close the stream and release all per-invocation state (dispose path). */
  dispose(invocationId: string): void {
    const events = this.#events.get(invocationId)
    events?.close()
    this.#events.delete(invocationId)
    this.#lastEventSeq.delete(invocationId)
  }

  /** Close every live stream and clear all buffered/dedup state (client close). */
  closeAll(): void {
    for (const events of this.#events.values()) {
      events.close()
    }
    this.#events.clear()
    this.#pendingEvents.clear()
    this.#lastEventSeq.clear()
  }
}
