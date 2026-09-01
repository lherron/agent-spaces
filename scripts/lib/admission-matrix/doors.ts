/**
 * Admission conformance matrix — DOORS and SEAT STATES (T-07860).
 *
 * LANDING 1 (this file's current shape) speaks the protocol that exists today:
 * `invocation.input` with an optional `InputPolicy.whenBusy`. Two of the four
 * columns of hcs T-07843 §5a are expressible on it — `input` (the idle
 * own-turn door) and `steer` (`whenBusy: 'steer'`).
 *
 * LANDING 2 replaces the `submit` bodies with the four real methods
 * (`steer` / `enqueue` / `invoke` / `preempt`) the moment T-07859 publishes,
 * and adds the `enqueue` / `invoke` / `preempt` columns plus the ttl cell. The
 * expectation table below is already written against the §3.1 class table, so
 * that landing changes the CALL, not the contract this harness checks.
 */
import type {
  InvocationCapabilities,
  InvocationId,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
} from 'spaces-harness-broker-protocol'

export type DoorName = 'input' | 'steer'
export type SeatState = 'idle' | 'busy-in-tool' | 'busy-generating'

export const DOOR_NAMES: readonly DoorName[] = ['input', 'steer']
export const SEAT_STATES: readonly SeatState[] = ['idle', 'busy-in-tool', 'busy-generating']

/** The (door, seat state) cells this landing exercises. */
export const CELLS: ReadonlyArray<{ door: DoorName; state: SeatState }> = [
  { door: 'input', state: 'idle' },
  { door: 'steer', state: 'idle' },
  { door: 'steer', state: 'busy-in-tool' },
  { door: 'steer', state: 'busy-generating' },
]

/**
 * Base prompts that put a seat into a given state. Deterministic and
 * tool-explicit: `busy-in-tool` must be inside a shell tool call when the door
 * is knocked, `busy-generating` must be emitting tokens with no tool open.
 */
export function basePrompt(state: SeatState, marker: string): string | undefined {
  switch (state) {
    case 'idle':
      return undefined
    case 'busy-in-tool':
      return `Run this exact shell command with your shell tool and nothing else: sleep 20 && printf '${marker}'. Then reply with exactly ${marker}.`
    case 'busy-generating':
      return 'Without using any tools, count from 1 to 2500, writing every number separated by a space. Do not stop early and do not summarize.'
  }
}

export type Expectation =
  /** The class is unsupported for this driver: a typed rejection is the PASS. */
  | { kind: 'typed-rejection'; because: string }
  /** The submission originates its own turn. */
  | { kind: 'own-turn' }
  /**
   * Steer into a live turn: dual resolution per §3.1 — `absorbed(turnId)` when
   * the boundary arrived, `executed(turnId)` when it did not. Both are truthful.
   */
  | { kind: 'absorbed-or-executed' }

/**
 * Expected outcome DERIVED from the driver's advertised capabilities plus the
 * §3.1 class table — never hand-tabulated per driver.
 *
 * `capabilities` is the invocation's COMPOSED capability set (the
 * `invocation.start` response), which is what a client actually negotiates
 * against; `input.busyPolicies` is the broker's own statement of the classes
 * this broker process can execute for this invocation.
 */
export function expectationFor(
  door: DoorName,
  state: SeatState,
  capabilities: InvocationCapabilities
): Expectation {
  if (state === 'idle') {
    // §3.1: every class degenerates to starting a turn on an idle seat.
    return { kind: 'own-turn' }
  }
  if (door === 'steer') {
    const supported = capabilities.input.busyPolicies?.includes('steer') === true
    return supported
      ? { kind: 'absorbed-or-executed' }
      : {
          kind: 'typed-rejection',
          because: `capabilities.input.busyPolicies = ${JSON.stringify(capabilities.input.busyPolicies ?? null)} does not advertise 'steer'`,
        }
  }
  // `input` with no policy on a busy seat is the legacy no-policy rejection.
  return {
    kind: 'typed-rejection',
    because: 'invocation.input with no policy is rejected while a turn is active',
  }
}

export type SubmitOutcome =
  | { accepted: true; response: InvocationInputResponse }
  | { accepted: false; error: { code?: unknown; message: string } }

export type Submitter = (req: InvocationInputRequest) => Promise<InvocationInputResponse>

/** Knock on one door. Landing 2 swaps these bodies for the four real methods. */
export async function knock(
  door: DoorName,
  submit: Submitter,
  invocationId: InvocationId,
  input: InvocationInput
): Promise<SubmitOutcome> {
  try {
    const response =
      door === 'steer'
        ? await submit({ invocationId, input, policy: { whenBusy: 'steer' } })
        : await submit({ invocationId, input })
    if (!response.accepted) {
      return {
        accepted: false,
        error: { code: 'input.rejected', message: response.reason ?? 'rejected' },
      }
    }
    return { accepted: true, response }
  } catch (error) {
    const record = error as { code?: unknown; message?: unknown }
    return {
      accepted: false,
      error: { code: record.code, message: String(record.message ?? error) },
    }
  }
}
