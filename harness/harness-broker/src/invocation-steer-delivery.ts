import type { InputId, InvocationInputResponse, TurnId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { DeliveryEvidence } from './drivers/driver'
import { deliveryEvidenceOf, steerRequiresOwnTurnOf, withDeliveryEvidence } from './drivers/driver'
import { BrokerError, errorMessage } from './errors'
import { REASON_STEER_NOT_SUPPORTED } from './invocation-constants'
import type { InvocationDelivery } from './invocation-delivery'
import type {
  EmitFn,
  Invocation,
  InvocationInputWithId,
  SubmissionRecord,
} from './invocation-model'
import type { SubmissionTerminals } from './invocation-submission-terminals'
import { TmuxPaneNotQuiescentError } from './runtime/tmux'

export interface SteerDeliveryDeps {
  emit: EmitFn
  delivery: Pick<InvocationDelivery, 'applyAndEmit'>
  terminals: Pick<SubmissionTerminals, 'rejectAdmittedExecution' | 'rejectQueueInput'>
  /** Delay between steer attempts a pane refused before paste. */
  steerRetryIntervalMs: number
}

export type SteerDelivery = ReturnType<typeof createSteerDelivery>

/** Tool calls that put a question to the human; a steer must not answer them. */
const ASK_TOOL_NAMES = new Set(['AskUserQuestion', 'request_user_input'])

/** States that can never deliver a held steer again. */
const STEER_CLOSED_STATES = new Set(['stopping', 'exited', 'failed', 'disposed'])

/**
 * Outcome of one steer attempt. `retry` and `again` are silent: the broker holds
 * the steer and tries again, and only a `final` failure is reported.
 */
type SteerAttempt =
  | { kind: 'delivered'; started?: { turnId?: TurnId | undefined } | undefined }
  | { kind: 'retry' }
  | { kind: 'again' }
  | { kind: 'final'; error: unknown; evidence: DeliveryEvidence }

/** A pane refusal raised before the first paste: nothing was written, so it can be retried. */
function paneNotReadyBeforePaste(error: unknown): boolean {
  return error instanceof TmuxPaneNotQuiescentError && error.phase === 'before_paste'
}

/** Whether this driver lacks a steer door and so takes steers through its queue. */
export function steerRoutesThroughQueue(inv: Invocation): boolean {
  const classes = inv.capabilities.admission.classes
  return (
    classes.includes('queue') &&
    (!classes.includes('steer') || inv.driver.applySteerNow === undefined)
  )
}

function ownTurnSlotHeldByOther(inv: Invocation, inputId: InputId): boolean {
  return inv.pendingOwnTurnSubmissionId !== undefined && inv.pendingOwnTurnSubmissionId !== inputId
}

function invocationClosed(inv: Invocation): boolean {
  return inv.terminalEmitted || (inv.state !== 'ready' && inv.state !== 'turn_active')
}

function steerClosed(inv: Invocation): boolean {
  return inv.terminalEmitted || STEER_CLOSED_STATES.has(inv.state)
}

/** An open prompt a pasted steer would answer: a permission request or an ask tool. */
function promptOpen(inv: Invocation): boolean {
  if (inv.pendingPermissions.size > 0) return true
  if ((inv.openPermissionRequests?.size ?? 0) > 0) return true
  for (const call of inv.startedToolCalls.values()) {
    if (ASK_TOOL_NAMES.has(call.name)) return true
  }
  return false
}

/**
 * A paste driver (harness-evidence brackets: both Claude drivers) with another
 * submission's own-turn delivery handed over and no harness turn running yet:
 * that body may still sit in the composer, so a pasted steer would merge into
 * it and lose its own identity. The steer waits for that turn to start (or the
 * slot to change), then injects (T-13689, mable ruling EN-57033). Hosts that
 * own the window themselves, such as arris-resident, keep injecting at once.
 */
function pasteWouldMergeIntoPendingTurn(inv: Invocation): boolean {
  return (
    inv.driver.bracketMintingMode === 'harness-evidence' &&
    inv.state === 'ready' &&
    inv.pendingOwnTurnSubmissionId !== undefined
  )
}

/** Whether a held steer may be attempted now. */
function steerGateOpen(inv: Invocation): boolean {
  if (inv.state === 'starting' || inv.startSettled !== true) return false
  if (promptOpen(inv)) return false
  if (pasteWouldMergeIntoPendingTurn(inv)) return false
  return !(inv.state === 'turn_active' && inv.currentTurnPolicy === 'guarded')
}

/** Register a change-driven watcher until `settle` returns a verdict. */
function watchSteerState(
  inv: Invocation,
  settle: (event: { type: string }) => boolean | undefined,
  timeoutMs?: number
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    inv.steerWatchers ??= new Set()
    const watchers = inv.steerWatchers
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: boolean): void => {
      watchers.delete(watcher)
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    const watcher = (event: { type: string }): void => {
      const outcome = settle(event)
      if (outcome !== undefined) finish(outcome)
    }
    watchers.add(watcher)
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(true), timeoutMs)
  })
}

/** Resolve true once the steer gate opens, false once the invocation closes. */
function waitForSteerGate(inv: Invocation): Promise<boolean> {
  if (steerClosed(inv)) return Promise.resolve(false)
  if (steerGateOpen(inv)) return Promise.resolve(true)
  return watchSteerState(inv, () =>
    steerClosed(inv) ? false : steerGateOpen(inv) ? true : undefined
  )
}

/**
 * Resolve true at the next turn start or own-turn slot change, false once
 * the invocation stops accepting input. Change-driven: never a timer, and a
 * turn already active when the wait begins does not satisfy it.
 */
function waitForPendingWindowChange(inv: Invocation): Promise<boolean> {
  if (invocationClosed(inv)) return Promise.resolve(false)
  const held = inv.pendingOwnTurnSubmissionId
  return watchSteerState(inv, (event) => {
    if (invocationClosed(inv)) return false
    if (event.type === 'turn.started' || inv.pendingOwnTurnSubmissionId !== held) return true
    return undefined
  })
}

/** Serialize steer deliveries per invocation: one pane write at a time, FIFO. */
function withSteerLock<T>(inv: Invocation, work: () => Promise<T>): Promise<T> {
  const previous = inv.steerPromise ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(work)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  inv.steerPromise = tail
  return run.finally(() => {
    if (inv.steerPromise === tail) inv.steerPromise = undefined
  })
}

function closedWhileHeld(): BrokerError {
  return new BrokerError(
    BrokerErrorCode.InvalidInvocationState,
    'Invocation closed while the broker held the steer'
  )
}

/**
 * Steer delivery (agent-spaces.broker-steer-one-door): the hold gate, silent
 * pane retries, the own-turn fallback, and the legacy one-shot busy steer.
 */
export function createSteerDelivery(deps: SteerDeliveryDeps) {
  const { emit, steerRetryIntervalMs } = deps
  const { applyAndEmit } = deps.delivery
  const { rejectAdmittedExecution, rejectQueueInput } = deps.terminals

  /**
   * Legacy invocation.input busy steer: one attempt, reported immediately.
   * The broker-held retries of submission.steer do not apply here.
   */
  async function attemptSteerAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<InvocationInputResponse> {
    if (inv.driver.applySteerNow === undefined) {
      // Reachable from the public steer RPC: admission.classes is a driver
      // DECLARATION and is not cross-checked against applySteerNow presence
      // (only input.busyPolicies is), so a driver can admit a steer it cannot
      // execute. Record the evidence so the admitted-execution rejection stays
      // a truthful TERMINAL refusal instead of defaulting to possibly-written
      // and leaving a submission that never reached a driver undisposed.
      const refused = inv.submissions.get(input.inputId)
      if (refused !== undefined) refused.deliveryEvidence = 'not_written'
      return rejectQueueInput(inv, input.inputId, REASON_STEER_NOT_SUPPORTED, 'not_written')
    }
    return withSteerLock(inv, async () => {
      const progress = { possiblyWritten: false }
      for (;;) {
        const attempt = await attemptSteerOnce(inv, input, progress, false)
        if (attempt.kind === 'again') continue
        if (attempt.kind === 'delivered') {
          return attempt.started !== undefined
            ? {
                inputId: input.inputId,
                accepted: true,
                disposition: 'started',
                turnId: attempt.started.turnId,
              }
            : { inputId: input.inputId, accepted: true, disposition: 'attempted_steer' }
        }
        const failure =
          attempt.kind === 'final'
            ? attempt
            : {
                error: new TmuxPaneNotQuiescentError('before_paste'),
                evidence: 'not_written' as const,
              }
        const failed = inv.submissions.get(input.inputId)
        if (failed !== undefined) failed.deliveryEvidence = failure.evidence
        return rejectQueueInput(inv, input.inputId, errorMessage(failure.error), failure.evidence)
      }
    })
  }

  /**
   * Deliver an admitted submission.steer (agent-spaces.broker-steer-one-door).
   * The admission reply has already gone out; from here the broker holds the
   * steer while the invocation is starting, a guarded turn runs or a prompt is
   * open, retries a pane that refused before paste, and then starts a turn
   * (idle) or injects into the live one (busy). Holds and retries are silent:
   * only the final attempt is reported, and the steer reaches one terminal.
   */
  function deliverSteer(inv: Invocation, record: SubmissionRecord): Promise<void> {
    // Held from admission, so a steer still queued behind an earlier one is
    // cancelled, not lost, if the invocation ends first.
    inv.heldSteers ??= new Set()
    const held = inv.heldSteers
    held.add(record)
    return withSteerLock(inv, async () => {
      const progress = { possiblyWritten: false }
      try {
        for (;;) {
          if (record.terminal) return
          if (!progress.possiblyWritten) held.add(record)
          const open = await waitForSteerGate(inv)
          if (record.terminal) return
          if (!open) {
            finishSteer(inv, record, closedWhileHeld(), progress.possiblyWritten)
            return
          }
          held.delete(record)
          const attempt = await attemptSteerOnce(inv, record.input, progress, true)
          if (attempt.kind === 'delivered') return
          if (attempt.kind === 'final') {
            // Teardown may already have settled it while the attempt waited.
            if (!record.terminal) {
              rejectAdmittedExecution(inv, record, attempt.error, {
                deliveryEvidence: attempt.evidence,
              })
            }
            return
          }
          if (attempt.kind === 'retry') {
            if (!progress.possiblyWritten) held.add(record)
            if (!(await waitForSteerRetry(inv))) {
              if (!record.terminal) {
                finishSteer(inv, record, closedWhileHeld(), progress.possiblyWritten)
              }
              return
            }
          }
        }
      } finally {
        held.delete(record)
      }
    })
  }

  function finishSteer(
    inv: Invocation,
    record: SubmissionRecord,
    error: unknown,
    possiblyWritten: boolean
  ): void {
    rejectAdmittedExecution(inv, record, error, {
      deliveryEvidence: possiblyWritten ? 'possibly_written' : 'not_written',
    })
  }

  /**
   * One steer attempt through whichever path the seat's current state calls
   * for. `allowIdleStart` lets an idle seat start the steer's own turn; the
   * legacy busy path never does.
   */
  async function attemptSteerOnce(
    inv: Invocation,
    input: InvocationInputWithId,
    progress: { possiblyWritten: boolean },
    allowIdleStart: boolean
  ): Promise<SteerAttempt> {
    const idle =
      allowIdleStart &&
      inv.state === 'ready' &&
      inv.pendingOwnTurnSubmissionId === undefined &&
      inv.driver.resolvesSteerAtActuation !== true &&
      inv.driver.steerNeverStartsTurn !== true
    if (idle) return startSteerTurn(inv, input)
    if (inv.driver.applySteerNow === undefined) {
      return {
        kind: 'final',
        error: new Error(REASON_STEER_NOT_SUPPORTED),
        evidence: 'not_written',
      }
    }
    try {
      await inv.driver.applySteerNow(input)
    } catch (err) {
      if (paneNotReadyBeforePaste(err)) return { kind: 'retry' }
      let failure = err
      if (steerRequiresOwnTurnOf(err)) {
        if (deliveryEvidenceOf(err) !== 'not_written') progress.possiblyWritten = true
        // T-13687 C: another submission holds the own-turn slot and the
        // harness has no turn yet. A steer is never refused busy and never
        // starts a second own turn: it waits for that turn to start (or the
        // slot to release), then goes back through the gate, since the turn
        // that starts may be guarded.
        if (ownTurnSlotHeldByOther(inv, input.inputId)) {
          if (await waitForPendingWindowChange(inv)) return { kind: 'again' }
          failure = withDeliveryEvidence(
            new BrokerError(
              BrokerErrorCode.InvalidInvocationState,
              'Invocation closed while the steer waited for the pending turn to start'
            ),
            progress.possiblyWritten ? 'possibly_written' : 'not_written'
          )
        } else {
          return startSteerTurn(inv, input)
        }
      }
      // The driver says what its failure proves about the body. A refusal
      // raised before the first paste is a real no-write; everything from the
      // paste onward may have landed.
      return {
        kind: 'final',
        error: failure,
        evidence: deliveryEvidenceOf(failure) ?? 'possibly_written',
      }
    }
    emit(
      inv,
      'input.accepted',
      { inputId: input.inputId, disposition: 'attempted_steer' },
      { inputId: input.inputId }
    )
    return { kind: 'delivered' }
  }

  /** Start the steer's own turn: an idle seat, or a driver's own-turn fallback. */
  async function startSteerTurn(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<SteerAttempt> {
    try {
      const result = await applyAndEmit(inv, input)
      return { kind: 'delivered', started: { turnId: result.turnId } }
    } catch (error) {
      if (paneNotReadyBeforePaste(error)) return { kind: 'retry' }
      return { kind: 'final', error, evidence: deliveryEvidenceOf(error) ?? 'possibly_written' }
    }
  }

  /** Wait out one pane retry interval; false if the invocation closes first. */
  function waitForSteerRetry(inv: Invocation): Promise<boolean> {
    if (steerClosed(inv)) return Promise.resolve(false)
    return watchSteerState(inv, () => (steerClosed(inv) ? false : undefined), steerRetryIntervalMs)
  }

  /** Tell held steers that start() settled; no event marks that moment. */
  function releaseStartHeldSteers(inv: Invocation): void {
    inv.startSettled = true
    for (const watcher of [...(inv.steerWatchers ?? [])]) watcher({ type: 'broker.start.settled' })
  }

  return { attemptSteerAndEmit, deliverSteer, releaseStartHeldSteers }
}
