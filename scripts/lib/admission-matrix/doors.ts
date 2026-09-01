/**
 * Admission conformance matrix — THE FOUR DOORS and seat states (T-07860).
 *
 * hcs T-07843 §5a: HRC exposes exactly four submit methods, one per admission
 * class, with the class in the METHOD NAME and never a parameter flag. This
 * module is the whole surface the matrix knocks on, so the four-door rule is
 * greppable here: four entries, four broker methods, no `whenBusy`.
 *
 * Expectations are DERIVED from `capabilities.admission.classes` plus the §3.1
 * class table — never hand-tabulated per driver. A driver that does not
 * advertise a class is expected to return a typed capability rejection, and
 * that rejection is a PASS.
 */
import type {
  InvocationCapabilities,
  InvocationId,
  SubmissionClass,
  SubmissionResponse,
} from 'spaces-harness-broker-protocol'

import type { Broker } from '../../../harness/harness-broker/src/broker'

export type DoorName = 'steer' | 'enqueue' | 'invoke' | 'preempt'

/**
 * Seat states a cell can be armed into.
 *   idle             — no active turn
 *   busy-in-tool     — inside a shell tool call (base prompt runs a 20s sleep)
 *   busy-generating  — emitting tokens with no tool open (base prompt counts)
 *   busy-fifo3       — busy-in-tool, three submissions through the door (FIFO proof)
 *   busy-ttl         — busy-in-tool, one submission carrying a short ttlMs
 */
export type SeatState = 'idle' | 'busy-in-tool' | 'busy-generating' | 'busy-fifo3' | 'busy-ttl'

export const DOOR_NAMES: readonly DoorName[] = ['steer', 'enqueue', 'invoke', 'preempt']
export const SEAT_STATES: readonly SeatState[] = [
  'idle',
  'busy-in-tool',
  'busy-generating',
  'busy-fifo3',
  'busy-ttl',
]

/** The admission class each door selects. The method name IS the class (§5a). */
export const DOOR_CLASS: Record<DoorName, SubmissionClass> = {
  steer: 'steer',
  enqueue: 'queue',
  invoke: 'exclusive',
  preempt: 'preempt',
}

/** The cells this matrix exercises: the four doors x the seat states each needs. */
export const CELLS: ReadonlyArray<{ door: DoorName; state: SeatState }> = [
  { door: 'steer', state: 'idle' },
  { door: 'steer', state: 'busy-in-tool' },
  { door: 'steer', state: 'busy-generating' },
  { door: 'enqueue', state: 'idle' },
  { door: 'enqueue', state: 'busy-in-tool' },
  { door: 'enqueue', state: 'busy-fifo3' },
  { door: 'enqueue', state: 'busy-ttl' },
  { door: 'invoke', state: 'idle' },
  { door: 'invoke', state: 'busy-in-tool' },
  { door: 'preempt', state: 'idle' },
  { door: 'preempt', state: 'busy-in-tool' },
  { door: 'preempt', state: 'busy-generating' },
]

export function isBusy(state: SeatState): boolean {
  return state !== 'idle'
}

/** How many submissions a cell pushes through its door. */
export function submissionCount(state: SeatState): number {
  return state === 'busy-fifo3' ? 3 : 1
}

/** TTL for the `busy-ttl` cell: short enough to expire while the base turn runs. */
export const TTL_CELL_MS = 4_000

/**
 * Base prompts that put a seat into a given state. Deterministic and
 * tool-explicit: `busy-in-tool` must be inside a shell tool call when the door
 * is knocked, `busy-generating` must be emitting tokens with no tool open.
 */
export function basePrompt(state: SeatState, marker: string): string | undefined {
  if (state === 'idle') return undefined
  if (state === 'busy-generating') {
    return 'Without using any tools, count from 1 to 2500, writing every number separated by a space. Do not stop early and do not summarize.'
  }
  return `Run this exact shell command with your shell tool and nothing else: sleep 20 && printf '${marker}'. Then reply with exactly ${marker}.`
}

export type Expectation =
  /** The class is unsupported for this driver: a typed rejection is the PASS. */
  | { kind: 'typed-rejection'; because: string }
  /** The submission originates its own turn (§4.1 obligation-bearing classes). */
  | { kind: 'own-turn' }
  /** §3.1 dual resolution: absorbed into the live turn, or executed if no boundary arrived. */
  | { kind: 'absorbed-or-executed' }
  /** Broker-HELD until idle, then injected -> guaranteed own turn. */
  | { kind: 'held-then-own-turn'; count: number }
  /** An undelivered broker-held submission whose ttl elapses -> `expired`. */
  | { kind: 'expired' }
  /** Exclusive on a busy seat: typed rejection carrying the state layer. */
  | { kind: 'rejected-busy' }
  /** Drive to quiescence, then the preempting submission executes on its own turn. */
  | { kind: 'preempt-then-own-turn'; mode: 'quiescence' | 'atomic' }

/**
 * Expected outcome derived from the invocation's COMPOSED capabilities (the
 * `invocation.start` response, which is what a client negotiates against) plus
 * the §3.1 class table.
 */
export function expectationFor(
  door: DoorName,
  state: SeatState,
  capabilities: InvocationCapabilities
): Expectation {
  const admissionClass = DOOR_CLASS[door]
  if (!capabilities.admission.classes.includes(admissionClass)) {
    return {
      kind: 'typed-rejection',
      because: `capabilities.admission.classes = ${JSON.stringify(capabilities.admission.classes)} does not advertise '${admissionClass}'`,
    }
  }
  if (state === 'busy-ttl') return { kind: 'expired' }
  if (!isBusy(state)) {
    // §3.1: on an idle seat every class degenerates to starting a turn. The
    // held classes still pass through the broker queue, but land as own turns.
    return door === 'enqueue' || door === 'preempt'
      ? { kind: 'held-then-own-turn', count: 1 }
      : { kind: 'own-turn' }
  }
  switch (door) {
    case 'steer':
      return { kind: 'absorbed-or-executed' }
    case 'enqueue':
      return { kind: 'held-then-own-turn', count: submissionCount(state) }
    case 'invoke':
      return { kind: 'rejected-busy' }
    case 'preempt': {
      const mode = capabilities.preempt.mode
      return mode === null
        ? {
            kind: 'typed-rejection',
            because: 'capabilities.preempt.mode is null, so the driver cannot execute the class',
          }
        : { kind: 'preempt-then-own-turn', mode }
    }
  }
}

export type SubmitOutcome =
  | { admitted: true; response: SubmissionResponse }
  | { admitted: false; submissionId?: string | undefined; reason: string }

export type KnockOptions = {
  invocationId: InvocationId
  body: string
  principalRef: string
  ttlMs?: number | undefined
}

/**
 * Knock on one door. Four methods, class in the name, no policy flag anywhere —
 * this function IS the §5a arity constraint made testable.
 */
export async function knock(
  door: DoorName,
  broker: Broker,
  options: KnockOptions
): Promise<SubmitOutcome> {
  const base = {
    invocationId: options.invocationId,
    origin: {
      principalRef: options.principalRef,
      scopeRef: 'agent:clod:project:agent-spaces:task:T-07860',
    },
    body: options.body,
  }
  const ttl = options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}
  try {
    const response = await (door === 'steer'
      ? broker.steer(base)
      : door === 'enqueue'
        ? broker.enqueue({ ...base, ...ttl })
        : door === 'invoke'
          ? broker.invoke(base)
          : broker.preempt({ ...base, ...ttl }))
    return response.admission === 'admitted'
      ? { admitted: true, response }
      : {
          admitted: false,
          submissionId: response.submissionId,
          reason: response.reason ?? 'rejected',
        }
  } catch (error) {
    return { admitted: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
