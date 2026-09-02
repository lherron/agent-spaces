import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

/**
 * T-07906 — the model behind the pane's queue drawer.
 *
 * A submission that is WAITING has no home in an append-only transcript: it is
 * not history yet, and by the time it becomes history it is no longer waiting.
 * Committing a line for it instead produces the worst of both — a permanent
 * "queued" row in scrollback describing a state that ended seconds later, and
 * nothing at all on screen while the wait is actually happening.
 *
 * So the drawer is a FOLD, not a log: this module tracks which submissions are
 * currently in the broker queue, and the ephemeral footer paints them for exactly
 * as long as that is true. An entry appears on `queue.enqueued` and leaves the
 * moment the submission reaches a turn or dies — at which point the transcript
 * above says what happened to it.
 *
 * What it can and cannot show: the queue events carry `submissionId`, `position`
 * and `ttlMs`, and `admission.requested` carries the `origin` — but NOTHING in the
 * admission or queue vocabulary carries the message BODY. The text first exists on
 * the durable stream at `user.message`, which is delivery, i.e. exactly when the
 * wait ends. A drawer row can therefore honestly say who is waiting and for how
 * long, and nothing about what they said.
 */

/** Origins are remembered only for submissions that can still enqueue. */
const QUEUEABLE_CLASSES = new Set(['queue', 'preempt'])
/**
 * Ceiling on remembered origins. A submission that never enqueues (rejected at
 * admission, or admitted straight into a turn) leaves its pending origin behind,
 * and a long-lived pane sees thousands of submissions. Bounded rather than
 * perfect: the map exists only to label a row that appears milliseconds later.
 */
const MAX_PENDING_ORIGINS = 64

export interface QueueDrawerEntry {
  submissionId: string
  /** Display label for the sender, derived from `origin.principalRef`. */
  principal: string
  class: string
  /** Queue position as last reported by the broker. */
  position: number
  /** Wall-clock ms of the `queue.enqueued` event, from the envelope's own time. */
  enqueuedAtMs: number
  ttlMs?: number | undefined
}

export interface QueueDrawer {
  /** Fold one event. Returns true when the drawer's contents changed. */
  observe: (event: InvocationEventEnvelope) => boolean
  /** Currently-waiting submissions, in queue order. */
  entries: () => QueueDrawerEntry[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The operator-facing name of a submission. Broker submission ids are
 * `submission_<invocationId>_<n>` — the invocation half is constant for the whole
 * pane and carries no information, so only the trailing counter is rendered.
 */
export function shortSubmissionId(submissionId: string): string {
  const counter = /_(\d+)$/.exec(submissionId)
  if (counter?.[1] !== undefined) return `#${counter[1]}`
  const tail = submissionId.split('_').pop() ?? submissionId
  return tail.length <= 8 ? tail : `${tail.slice(0, 8)}…`
}

/**
 * The sender, from a principal ref. Canonical caller authority is `agent:<id>`,
 * optionally carrying runtime scope (`agent:cody:project:hrc-runtime`); the pane
 * wants the actor, not the scope it happens to be sitting in.
 */
export function shortPrincipal(principalRef: string): string {
  if (principalRef.length === 0) return 'unknown'
  const segments = principalRef.split(':')
  if (segments[0] === 'agent' && segments[1] !== undefined && segments[1].length > 0) {
    return segments[1]
  }
  return principalRef.length <= 16 ? principalRef : `${principalRef.slice(0, 15)}…`
}

/**
 * Every event that takes a submission OUT of the queue, whether it went on to run
 * or died waiting. The transcript renders the ones that are news; the drawer only
 * needs to know the wait is over.
 */
const DRAIN_EVENTS = new Set([
  'submission.executed',
  'submission.absorbed',
  'submission.rejected',
  'submission.expired',
  'submission.withdrawn',
  'submission.cancelled',
  'queue.cancelled',
  'queue.expired',
  'queue.withdrawn',
])

export function createQueueDrawer(): QueueDrawer {
  /** submissionId → principal, learned from `admission.requested`. */
  const pendingOrigins = new Map<string, string>()
  const waiting = new Map<string, QueueDrawerEntry>()

  function remember(submissionId: string, principal: string): void {
    if (pendingOrigins.size >= MAX_PENDING_ORIGINS) {
      const oldest = pendingOrigins.keys().next()
      if (!oldest.done) pendingOrigins.delete(oldest.value)
    }
    pendingOrigins.set(submissionId, principal)
  }

  return {
    observe(event: InvocationEventEnvelope): boolean {
      const payload = asRecord(event.payload)
      const submissionId = readString(payload['submissionId'])

      switch (event.type) {
        case 'admission.requested': {
          if (submissionId.length === 0) return false
          if (!QUEUEABLE_CLASSES.has(readString(payload['class']))) return false
          remember(
            submissionId,
            shortPrincipal(readString(asRecord(payload['origin'])['principalRef']))
          )
          return false
        }

        case 'queue.enqueued': {
          if (submissionId.length === 0) return false
          const ttl = payload['ttlMs']
          const enqueuedAt = Date.parse(event.time)
          waiting.set(submissionId, {
            submissionId,
            principal: pendingOrigins.get(submissionId) ?? 'unknown',
            class: readString(payload['class']) || 'queue',
            position: typeof payload['position'] === 'number' ? payload['position'] : 0,
            enqueuedAtMs: Number.isFinite(enqueuedAt) ? enqueuedAt : 0,
            ...(typeof ttl === 'number' ? { ttlMs: ttl } : {}),
          })
          pendingOrigins.delete(submissionId)
          return true
        }

        case 'queue.jumped': {
          const entry = waiting.get(submissionId)
          if (entry === undefined) return false
          const to = payload['toPosition']
          if (typeof to !== 'number') return false
          waiting.set(submissionId, { ...entry, position: to })
          return true
        }

        // The invocation is gone: nothing is still waiting on a harness that has
        // stopped, whatever the queue believed a moment ago.
        case 'invocation.exited':
        case 'invocation.failed':
        case 'invocation.disposed': {
          if (waiting.size === 0) return false
          waiting.clear()
          pendingOrigins.clear()
          return true
        }

        default: {
          if (!DRAIN_EVENTS.has(event.type)) return false
          pendingOrigins.delete(submissionId)
          return waiting.delete(submissionId)
        }
      }
    },

    entries(): QueueDrawerEntry[] {
      // Position is the broker's own ordering and is authoritative; enqueue time
      // only breaks ties, which happens when two submissions report the same slot
      // across a jump the drawer saw out of order.
      return [...waiting.values()].sort(
        (a, b) => a.position - b.position || a.enqueuedAtMs - b.enqueuedAtMs
      )
    },
  }
}
