import type {
  EventProvenance,
  InputId,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationFailedPayload,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { EVENT_FAMILY_BY_TYPE, validateEventEnvelope } from 'spaces-harness-broker-protocol'
import type { InvocationEventExtra } from './events'
import type { InvocationAdmission } from './invocation-admission'
import {
  BROKER_DECISION_TYPES,
  BROKER_PROVENANCE,
  INVOCATION_TEARDOWN_TYPES,
  SESSION_LEAVE_REASONS,
  SUBMISSION_TERMINAL_TYPES,
  TOOL_CALL_TEARDOWN_CODE,
  TOOL_CALL_UNTERMINATED_CODE,
  TURN_TERMINAL_TYPES,
  asStartedToolCall,
} from './invocation-constants'
import { buildInspectionSummary } from './invocation-inspection'
import type { Invocation, InvocationManagerOptions, StartedToolCall } from './invocation-model'
import { createStateProjection } from './invocation-state'
import { normalizeEventPayload } from './runtime/event-normalize'
import { HARNESS_BROKER_VERSION } from './version'

export interface InvocationEventsDeps {
  sequencer: InvocationManagerOptions['sequencer']
  onEvent: InvocationManagerOptions['onEvent']
  admission: InvocationAdmission
}

export type InvocationEvents = ReturnType<typeof createInvocationEvents>

/**
 * The one seam every invocation event passes through: provenance, bracket
 * invariants, sequencing, validation, delivery, then state projection.
 */
export function createInvocationEvents(deps: InvocationEventsDeps) {
  const { sequencer, onEvent } = deps
  const { scheduleDrain, scheduleAdmissionDrain } = deps.admission
  const applyEventState = createStateProjection({
    emit,
    observePendingOwnTurnStart,
    admission: deps.admission,
  })

  /**
   * Provenance for a fact the BROKER authored rather than observed: input
   * dispositions, lifecycle policy acceptance, synthesized tool terminals,
   * control dispositions. §6 keeps these broker-authoritative, so they carry
   * `sourceKind: 'broker'` rather than borrowing a provider's cursor.
   */
  const brokerProvenance: EventProvenance = {
    sourceKind: 'broker',
    normalizer: { name: 'harness-broker', version: HARNESS_BROKER_VERSION },
  }

  /**
   * Provenance for an event a DRIVER emitted without attaching a committed raw
   * record. Derived from that driver's DECLARED authority for the event's
   * family (§6) rather than defaulting to `broker`, because calling a
   * provider-observed fact broker-authored would be a false provenance — the
   * one thing §7.2 exists to prevent.
   *
   * A driver that has been wired to the capture gate supplies real record
   * provenance instead, and that always wins. This is the honest floor for the
   * rest: it says which SOURCE owns the fact, and omits the record id / cursor
   * it genuinely does not have yet.
   */
  function declaredProvenance(
    inv: Invocation,
    type: InvocationEventType,
    rawType?: string
  ): EventProvenance {
    // A `broker.*` rawType is a driver ECHOING a broker decision (the user
    // message it was handed, a steer it was asked to deliver), not something it
    // observed the provider do. It stays broker-authored whatever the family's
    // declared authority says — otherwise the envelope would claim the provider
    // reported a fact the provider never saw.
    if (rawType?.startsWith('broker.') === true) {
      return brokerProvenance
    }
    // A driver with no declaration (an in-test stand-in; the Driver interface
    // requires one of every real driver) cannot be attributed to a provider, so
    // it falls back to broker provenance rather than guessing a source.
    const family = EVENT_FAMILY_BY_TYPE[type]
    const authority = family === undefined ? undefined : inv.driver.evidenceAuthority?.[family]
    if (authority === undefined || authority === 'broker') {
      return brokerProvenance
    }
    return {
      sourceKind:
        authority === 'hook'
          ? ('hook' as const)
          : (inv.driver.nativeSourceKind ?? 'provider-jsonl'),
      ...(rawType !== undefined ? { nativeType: rawType } : {}),
      normalizer: { name: inv.driver.kind, version: inv.driver.version },
    }
  }

  /**
   * Provenance truthfulness, enforced for EVERY driver at the one seam every
   * event passes through (T-07870, T-07853 §7.2).
   *
   * A `provider-*` `sourceKind` is a claim that the provider's own transcript or
   * protocol stream reported this fact, and §7.1 makes the committed raw record
   * the only thing that can substantiate that claim. An envelope that claims a
   * provider source but names no record is unfalsifiable: nothing on disk can be
   * opened to check it, which is exactly how a well-formed ledger stayed
   * indistinguishable from a working one under T-07868.
   *
   * So the claim degrades to what is actually true of such an event — the broker
   * minted it from a broker-side path — while the driver's `nativeType` and
   * normalizer are preserved, because those ARE known. This is a floor, not a
   * fix: the fix is to commit the record (what the codex-app-server permission
   * path now does), and `scripts/capture-parity.ts` plus
   * `test/capture/provenance-truthfulness.test.ts` fail on any violation rather
   * than letting the degrade hide one.
   */
  function truthfulProvenance(provenance: EventProvenance): EventProvenance {
    if (!provenance.sourceKind.startsWith('provider-')) return provenance
    if (provenance.rawRecordId !== undefined) return provenance
    return { ...provenance, sourceKind: 'broker' }
  }

  // ---------------------------------------------------------------------------
  // Tool-call terminal-outcome invariant (T-06550)
  // ---------------------------------------------------------------------------
  /**
   * Synthesize a broker-owned `tool.call.failed` for every open tool call
   * matching `predicate`, closing the started→exactly-one-terminal bracket when
   * the provider tore down without emitting a terminal. Snapshots the matching
   * entries first (the recursive `emit` deletes them from `startedToolCalls`),
   * so mutation during iteration is safe. Each synthesized event is tagged with
   * a machine-readable `code`, `data.synthesized:true`, and a `broker` driver
   * kind so it is traceable as broker-originated, mirroring how the T-04846
   * bracket marks a synthesized `turn.started` with `source:'broker-delivery'`.
   */
  function synthesizeOpenToolFailures(
    inv: Invocation,
    code: string,
    message: string,
    predicate: (call: StartedToolCall) => boolean
  ): void {
    if (inv.startedToolCalls.size === 0) return
    const open = [...inv.startedToolCalls.values()].filter(predicate)
    for (const call of open) {
      inv.startedToolCalls.delete(call.toolCallId)
      emit(
        inv,
        'tool.call.failed',
        {
          toolCallId: call.toolCallId,
          name: call.name,
          message,
          code,
          data: { synthesized: true, reason: code },
        },
        {
          ...(call.turnId !== undefined ? { turnId: call.turnId } : {}),
          itemId: call.toolCallId,
          driver: { kind: 'broker', rawType: 'tool-call-invariant' },
        }
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Emit helper
  // ---------------------------------------------------------------------------
  function emit<K extends InvocationEventType>(
    inv: Invocation,
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope<K> {
    return emitEvent(inv, { type, payload }, extra)
  }

  function submissionDispositionContext(
    inv: Invocation,
    type: InvocationEventType,
    payload: unknown
  ): { submissionId?: string; existing?: InvocationEventEnvelope } {
    if (!SUBMISSION_TERMINAL_TYPES.has(type)) return {}
    const submissionId = (payload as { submissionId?: string }).submissionId
    if (submissionId === undefined) return {}
    const existing = inv.submissionDispositions.get(submissionId)
    return {
      submissionId,
      ...(existing !== undefined ? { existing } : {}),
    }
  }

  function buildEventExtra(
    inv: Invocation,
    type: InvocationEventType,
    payload: unknown,
    extra?: InvocationEventExtra
  ): InvocationEventExtra {
    // Provenance precedence (T-07853 §7.2):
    //   1. what the EMITTER supplied — it holds the committed raw record this
    //      event was normalized from, which no default can reconstruct;
    //   2. the broker-decision default for the admission/queue/interrupt types
    //      that are broker facts by construction (T-07860);
    //   3. the driver's DECLARED authority for the family, so a
    //      provider-observed fact is never labelled broker-authored.
    //
    // Order 1-before-2 is the ruling on wrkq T-07863: the ledger must never
    // carry a rewritten provenance. `submission.absorbed`/`executed`/`cancelled`
    // are DISPOSITIONS — on claude-code-tmux they are minted from session-JSONL
    // queue evidence (T-07849 rev 11) and carry that row's real record — so the
    // schema requires provenance on them without dictating its source.
    const suppliedProvenance = truthfulProvenance(
      extra?.provenance ??
        (BROKER_DECISION_TYPES.has(type) ? BROKER_PROVENANCE : undefined) ??
        declaredProvenance(inv, type, extra?.driver?.rawType)
    )
    let withProvenance: InvocationEventExtra = { ...extra, provenance: suppliedProvenance }
    if (
      type === 'turn.started' &&
      withProvenance.inputId === undefined &&
      inv.pendingOwnTurnSubmissionId !== undefined &&
      inv.driver.bracketMintingMode === 'harness-evidence'
    ) {
      const pending = inv.submissions.get(inv.pendingOwnTurnSubmissionId)
      if (
        pending !== undefined &&
        inv.driver.correlatePendingOwnTurnStart?.(
          payload as InvocationEventPayloadMap['turn.started'],
          pending.input
        ) === true
      ) {
        withProvenance = {
          ...withProvenance,
          inputId: inv.pendingOwnTurnSubmissionId,
        }
      }
    }
    // Harness-evidence drivers correlate a submission only when their hook or
    // transcript mirror supplies the inputId. A pending delivery may coexist
    // with an unrelated harness-owned turn (for example, launch priming), so
    // borrowing the pending id here would turn that stranger into evidence.
    if (
      type !== 'turn.started' ||
      withProvenance.inputId !== undefined ||
      inv.pendingOwnTurnSubmissionId === undefined ||
      inv.driver.bracketMintingMode === 'harness-evidence' ||
      inv.driver.bracketMintingMode === 'observed' ||
      (payload as { source?: unknown } | undefined)?.source === 'observed'
    ) {
      return withProvenance
    }
    return {
      ...withProvenance,
      inputId: inv.pendingOwnTurnSubmissionId as InputId,
    }
  }

  function settleOwnTurnAtTerminal(inv: Invocation, terminalTurnId?: TurnId): void {
    if (terminalTurnId === undefined) return
    const pendingSubmissionId = inv.pendingOwnTurnSubmissionId
    if (pendingSubmissionId === undefined) return
    // T-08514: an OBSERVED-source turn can neither correlate this delivery nor
    // record a contest, because observePendingOwnTurnStart is skipped for it.
    // `codex-app-server` in TUI mode mints `observed` and declares neither
    // cancel/failPendingOwnTurnOnForeignTurn, so it could never satisfy the
    // contested gate — and both recovery paths required it. A queued delivery
    // whose turn was attributed `foreign` then pinned the seat at `starting`
    // permanently (astra@hrc-runtime:primary, 84 minutes, every delivery
    // refused by seatCanDispatch). Its terminal is the hard boundary.
    //
    // This stays distinct from the harness-evidence hold: those drivers DO get
    // observePendingOwnTurnStart, so a delivery may still correlate on a later
    // turn and its reservation must survive an unrelated terminal.
    //
    // A healthy delivery never reaches here at all: submission.executed is
    // emitted synchronously in applyAndEmit and clears the marker through the
    // disposition path long before the turn terminal.
    const contested = inv.pendingOwnTurnContestedByTurnId === terminalTurnId
    const uncorrelatable = inv.pendingOwnTurnUncorrelatableTurnId === terminalTurnId
    if (!contested && !uncorrelatable) return
    if (
      contested &&
      (inv.driver.failPendingOwnTurnOnForeignTurn === true ||
        inv.driver.bracketMintingMode === 'observed') &&
      !inv.submissionDispositions.has(pendingSubmissionId)
    ) {
      emit(
        inv,
        'submission.lost',
        { submissionId: pendingSubmissionId, reason: 'turn-correlation-lost' },
        { turnId: terminalTurnId, inputId: pendingSubmissionId }
      )
      emitTerminal(inv, 'invocation.failed', {
        message: 'Codex turn completed without evidence correlating the pending submission',
        code: 'submission_correlation_lost',
        reason: 'submission-correlation-lost',
        retryable: false,
      })
      return
    }
    // T-08204: releasing an admission slot is INDEPENDENT of settling its
    // input. The terminal of a turn we could not correlate to this submission
    // is evidence about that turn, never about our body — Claude queues an
    // injected input while a turn runs and executes it on a LATER turn, so this
    // moment is when the body is closest to executing, not lost. Proven on
    // inv-d604db0e: _10 was cancelled here at seq 862 and natively started at
    // seq 867. The slot is freed so the seat keeps accepting input; the
    // submission stays UNDISPOSED until its own native evidence (executed,
    // absorbed, recall or teardown) settles it exactly once.
    inv.pendingOwnTurnSubmissionId = undefined
    inv.pendingOwnTurnContestedByTurnId = undefined
    inv.pendingOwnTurnUncorrelatableTurnId = undefined
    scheduleDrain(inv)
    scheduleAdmissionDrain(inv)
  }

  /**
   * T-08514: an observed-source turn.started never reaches
   * `observePendingOwnTurnStart`, so it can neither correlate a pending
   * delivery nor mark it contested. Remember the first such turn so its
   * terminal can release the reservation — otherwise the seat reports
   * `starting` forever and `seatCanDispatch` refuses every delivery to the
   * scope.
   */
  function observeUncorrelatableOwnTurnStart(inv: Invocation, turnId: TurnId): void {
    if (inv.pendingOwnTurnSubmissionId === undefined) return
    if (inv.pendingOwnTurnUncorrelatableTurnId !== undefined) return
    inv.pendingOwnTurnUncorrelatableTurnId = turnId
  }

  function observePendingOwnTurnStart(inv: Invocation, turnId: TurnId, inputId?: InputId): void {
    if (inputId !== undefined && inv.pendingOwnTurnSubmissionId === inputId) {
      inv.pendingOwnTurnSubmissionId = undefined
      inv.pendingOwnTurnContestedByTurnId = undefined
      return
    }
    if (
      inv.driver.cancelPendingOwnTurnOnForeignTurn !== true &&
      inv.driver.failPendingOwnTurnOnForeignTurn !== true
    ) {
      return
    }
    if (
      inv.pendingOwnTurnSubmissionId !== undefined &&
      inv.pendingOwnTurnContestedByTurnId === undefined
    ) {
      inv.pendingOwnTurnContestedByTurnId = turnId
    }
  }

  function emitEvent<K extends InvocationEventType>(
    inv: Invocation,
    descriptor: InvocationEventFor<K>,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope<K>
  function emitEvent(
    inv: Invocation,
    descriptor: InvocationEvent,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope {
    const { type, payload } = descriptor
    const disposition = submissionDispositionContext(inv, type, payload)
    if (disposition.existing !== undefined) return disposition.existing
    const submissionId = disposition.submissionId
    const eventExtra = buildEventExtra(inv, type, payload, extra)
    const isTurnTerminal = TURN_TERMINAL_TYPES.has(type)
    const terminalTurnId = isTurnTerminal
      ? (eventExtra.turnId ?? (payload as { turnId?: TurnId } | undefined)?.turnId)
      : undefined

    // Exactly-one turn-terminal bracket. An error callback and a late recovery
    // completion can race for the same turn; only the first terminal may reach
    // sequencing, state projection, and queue draining. Input redelivery itself
    // remains governed by the existing inputId disposition ledger.
    if (terminalTurnId !== undefined) {
      const existing = inv.terminalTurns.get(terminalTurnId)
      if (existing !== undefined) {
        return existing
      }
    }

    // Tool-call exactly-one-terminal bracket (T-06550). A turn or invocation
    // teardown is the point every open `tool.call.started` MUST have closed; any
    // still open is the burn-in-19 vanished-call defect. Synthesize its `failed`
    // BEFORE this boundary event is sequenced so the synthesized terminal lands
    // with a lower seq — inside the closing bracket, ahead of the turn/invocation
    // terminal. The synthesized `tool.call.failed` re-enters `emit`, but it is
    // neither a turn nor an invocation terminal, so it cannot re-trigger this.
    if (isTurnTerminal) {
      synthesizeOpenToolFailures(
        inv,
        TOOL_CALL_UNTERMINATED_CODE,
        'Tool call did not report a terminal result before the turn ended',
        (call) => terminalTurnId === undefined || call.turnId === terminalTurnId
      )
    } else if (
      INVOCATION_TEARDOWN_TYPES.has(type) &&
      !(type === 'invocation.failed' && (payload as InvocationFailedPayload).retryable === true)
    ) {
      synthesizeOpenToolFailures(
        inv,
        TOOL_CALL_TEARDOWN_CODE,
        'Tool call did not report a terminal result before the invocation terminated',
        () => true
      )
    }

    // Exactly-once `turn.started` bracket (T-04846). A turn may be started from
    // two seams — the broker synthesizing it from a delivered input
    // (`source:'broker-delivery'`) and a driver/hook observing the harness open
    // the turn — and both flow through here. Dedupe by turnId so the turn is
    // opened exactly once: the first start wins and is recorded; a later start
    // for the same turn is suppressed (not sequenced, not projected) and the
    // original winning envelope is returned to the (return-ignoring) caller.
    if (descriptor.type === 'turn.started') {
      const turnId = eventExtra.turnId ?? descriptor.payload.turnId
      if (turnId !== undefined) {
        const existing = inv.startedTurns.get(turnId)
        if (existing !== undefined) {
          return existing
        }
      }
    }

    // Single central event-safety path before sequencing: constrain/normalize
    // well-known payloads and truncate oversized payloads against maxEventBytes.
    const { payload: safePayload, diagnostics } = normalizeEventPayload({
      type,
      payload,
      maxEventBytes: inv.spec.process.limits?.maxEventBytes,
    })

    // Provenance is composed in buildEventExtra, so every sequenced envelope
    // carries it whether or not the call site thought about it.
    const sequencedEvent = sequencer.next(inv.invocationId, type, safePayload, eventExtra)
    // Runtime producer boundary: validate the fully normalized, sequenced
    // envelope before it can reach state projection, observers, or the durable
    // ledger. The protocol package owns both the map and these validators.
    const candidate: unknown = {
      ...sequencedEvent,
      payload: safePayload,
    }
    const event = validateEventEnvelope(candidate)
    if (inv.spec.correlation !== undefined) {
      event.correlation = inv.spec.correlation
    }
    // Record the winning `turn.started` so any subsequent start for this turn
    // (e.g. a hook-observed start after a broker-delivery synthesis) is deduped
    // above and resolves back to this same envelope (T-04846).
    if (event.type === 'turn.started' && event.turnId !== undefined) {
      inv.startedTurns.set(event.turnId, event)
      const observed = event.payload.source === 'observed'
      if (!observed) {
        const record = event.inputId !== undefined ? inv.submissions.get(event.inputId) : undefined
        const policy = record?.class === 'steer' ? 'open' : (record?.turnPolicy ?? 'open')
        inv.currentTurnPolicy = policy
        inv.turnManifests.set(event.turnId, {
          invocationId: inv.invocationId,
          turnId: event.turnId,
          policy,
          submissionIds: [],
        })
        observePendingOwnTurnStart(inv, event.turnId, event.inputId)
      } else {
        observeUncorrelatableOwnTurnStart(inv, event.turnId)
      }
    }
    if (event.type === 'turn.attributed') {
      const turnId = event.turnId ?? event.payload.turnId
      const inputId = event.payload.ownership === 'own' ? event.payload.inputId : undefined
      const record = inputId !== undefined ? inv.submissions.get(inputId) : undefined
      const policy = record?.class === 'steer' ? 'open' : (record?.turnPolicy ?? 'open')
      inv.currentTurnPolicy = policy
      inv.turnManifests.set(turnId, {
        invocationId: inv.invocationId,
        turnId,
        policy,
        submissionIds: [],
      })
    }
    if (TURN_TERMINAL_TYPES.has(event.type) && event.turnId !== undefined) {
      inv.terminalTurns.set(event.turnId, event)
    }
    if (submissionId !== undefined) {
      inv.submissionDispositions.set(submissionId, event)
      const record = inv.submissions.get(submissionId)
      if (record !== undefined) record.terminal = true
      if (inv.pendingOwnTurnSubmissionId === submissionId) {
        inv.pendingOwnTurnSubmissionId = undefined
        inv.pendingOwnTurnContestedByTurnId = undefined
      }
      if (
        (event.type === 'submission.absorbed' || event.type === 'submission.executed') &&
        event.payload.turnId !== undefined
      ) {
        const existingManifest = inv.turnManifests.get(event.payload.turnId)
        const policy = existingManifest?.policy ?? record?.turnPolicy ?? 'open'
        const submissionIds = existingManifest?.submissionIds ?? []
        if (!submissionIds.includes(submissionId)) submissionIds.push(submissionId)
        inv.turnManifests.set(event.payload.turnId, {
          invocationId: inv.invocationId,
          turnId: event.payload.turnId,
          policy,
          submissionIds,
        })
      }
    }
    // Tool-call bracket bookkeeping (T-06550): open the bracket on a start, close
    // it on either terminal. A real driver terminal AND a broker-synthesized one
    // both flow through here, so a synthesized close deletes the same entry the
    // synthesizer already snapshotted — exactly one terminal per started call.
    if (event.type === 'tool.call.started') {
      const started = asStartedToolCall(event.payload, event.turnId)
      if (started !== undefined) {
        inv.startedToolCalls.set(started.toolCallId, started)
      }
    } else if (event.type === 'tool.call.completed' || event.type === 'tool.call.failed') {
      inv.startedToolCalls.delete(event.payload.toolCallId)
    }
    // Deliver BEFORE projecting state: applyEventState can synchronously emit
    // follow-on events (turn terminal → drain dequeues input.accepted /
    // user.message; invocation.stopping → queue eviction input.rejected). If
    // delivery ran after projection, those cascade events (seq N+1…) would hit
    // the ledger/wire before this event (seq N), and downstream monotonic-seq
    // dedup (harness-broker-client InvocationEventHub) would then drop seq N as
    // a duplicate — T-06088: a queued input at turn end lost the active turn's
    // terminal. onEvent reads only the envelope, never invocation state.
    onEvent(event)
    applyEventState(inv, event)

    // A harness-evidence delivery can be pasted into text the operator was
    // already typing. If attribution cannot prove that merge, the resulting
    // foreign turn contests the reservation. Its terminal is the hard boundary:
    // the delivery did not start a distinct later turn, so release the seat and
    // give the submission an explicit terminal disposition. An OBSERVED-source
    // turn records no contest and can never correlate, so its terminal releases
    // the reservation too (T-08514). A harness-evidence delivery still holds
    // across an unrelated terminal, because its evidence may arrive on a later
    // turn.
    settleOwnTurnAtTerminal(inv, terminalTurnId)

    // Follow-on diagnostics (e.g. truncation notices) are emitted as their own
    // events. Their payloads are small, so they never re-trigger truncation.
    if (diagnostics) {
      for (const diagnostic of diagnostics) {
        emit(inv, 'diagnostic', diagnostic, eventExtra)
      }
    }

    // Graceful-exit summary push: on the user-exit continuation.cleared, push one
    // authoritative invocation.summary on the SAME ordered stream — recorded
    // downstream BEFORE the lease is reaped, so the operator shutdown report reads
    // a pushed-and-recorded summary instead of pulling the (by-then gone) live
    // broker read model. Guarded so it fires exactly once per invocation.
    if (event.type === 'continuation.cleared' && !inv.summaryEmitted) {
      const reason = event.payload.reason
      if (typeof reason === 'string' && SESSION_LEAVE_REASONS.has(reason)) {
        inv.summaryEmitted = true
        emit(inv, 'invocation.summary', {
          summary: buildInspectionSummary(inv),
          reason,
        })
      }
    }

    return event
  }

  function emitTerminal<K extends 'invocation.exited' | 'invocation.failed'>(
    inv: Invocation,
    type: K,
    payload: InvocationEventPayloadMap[K]
  ): void {
    if (type === 'invocation.failed' && (payload as InvocationFailedPayload).retryable === true) {
      emit(inv, type, payload)
      return
    }
    if (inv.terminalEmitted) {
      return
    }
    inv.terminalEmitted = true
    emit(inv, type, payload)
  }

  return { brokerProvenance, emit, emitEvent, emitTerminal }
}
