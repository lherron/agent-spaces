import type { TurnId } from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import { asRecord as asHookRecord, getString } from '../hook-json'
import type { HookEnvelopeResult } from '../tmux-shared'
import {
  type CapturedEmit,
  type ClaudeAttributionEventSink,
  forwardNormalizedEvent,
} from './attribution-events'
import {
  CLAUDE_CODE_TMUX_DRIVER_KIND,
  type ClaudeCodeHookEnvelope,
  type ClaudeCodeHookEventNormalizer,
  normalizeHookEnvelope,
} from './hook-events'
import type { ClaudeHookTranscriptReader } from './hook-transcript'
import { CLAUDE_HOOK_GENERATION } from './launch'
import { CLAUDE_KNOWN_HOOK_NAMES } from './native-types'
import type { ClaudeRecordProvenance } from './record-provenance'
import type { ClaudeStructuredOutputGate } from './structured-output'
import type { ClaudeTurnAttribution } from './turn-attribution'

export interface ClaudeHookRecordHandlerOptions {
  driverCtx: DriverContext
  expectedRuntimeId: string | undefined
  /** The live callback socket; envelopes posted to any other socket are stale. */
  getListenerSocketPath: () => string | undefined
  provenance: ClaudeRecordProvenance
  emit: CapturedEmit
  reader: ClaudeHookTranscriptReader
  normalizer: ClaudeCodeHookEventNormalizer
  attribution: ClaudeTurnAttribution
  attributionEvents: ClaudeAttributionEventSink
  structuredOutput: ClaudeStructuredOutputGate
}

/**
 * Receive one hook envelope from the in-pane bridge: fence it to this live
 * invocation, commit it verbatim through the capture gate, normalize it into
 * broker events, and return the synchronous decision the hook is waiting for.
 */
export function createClaudeHookRecordHandler(
  options: ClaudeHookRecordHandlerOptions
): (envelope: ClaudeCodeHookEnvelope) => Promise<HookEnvelopeResult> {
  const {
    driverCtx,
    expectedRuntimeId,
    provenance,
    emit,
    reader,
    normalizer,
    attribution,
    attributionEvents,
    structuredOutput,
  } = options

  /**
   * The raw op behind the most recent blocked-unknown outcome, so the
   * no-capture-gate path can still put the verbatim evidence on the warning.
   */
  let pendingUnclassifiedRaw: unknown

  /**
   * Normalize ONE hook payload. Runs inside the capture gate's normalize
   * callback (or directly, in the isolated unit harness), so everything it
   * emits carries the hook record's provenance and its return value is the
   * record's durable disposition.
   */
  const normalizeHookRecord = (
    envelope: ClaudeCodeHookEnvelope,
    rawHook: Record<string, unknown>
  ): { outcome: NormalizeOutcome; decision: HookEnvelopeResult } => {
    const rawType = getString(rawHook, 'hook_event_name')
    // Transcript rows are their OWN raw records: this read commits and
    // normalizes each appended line before the hook's own normalization
    // continues, which is the true arrival order.
    reader.handleHook(rawHook, envelope.turnId ?? attribution.activeTurnId)
    if (rawType === 'Stop' || rawType === 'SessionEnd') {
      // Claude writes a turn's closing `system` rows only AFTER the Stop
      // hooks return, so nothing in the transcript will end the held
      // message at the moment the terminal is needed. The hook is the
      // synchronous CONTROL that says the turn is over; the flushed event
      // still names the `assistant` row that carried the prose.
      if (reader.flushTerminalAssistantMessage()) {
        normalizer.noteTranscriptTerminalMessage()
      }
    }

    const finish = (decision: HookEnvelopeResult = undefined) => {
      const unclassified = attributionEvents.takeUnclassified()
      if (unclassified.length > 0) {
        const message = unclassified.map((entry) => entry.message).join('; ')
        pendingUnclassifiedRaw =
          unclassified.length === 1 ? unclassified[0]?.raw : unclassified.map((e) => e.raw)
        // Turn attribution is load-bearing, so an unclassifiable queue
        // signal is reported at the loudest level (T-07849 item 11 → law
        // 6d04d5de). Since T-07883 that is a warning, not a stop: capture
        // advances and the seat keeps being observed.
        return {
          outcome: {
            disposition: 'blocked-unknown',
            family: 'submission-disposition',
            message,
          } as NormalizeOutcome,
          decision,
        }
      }
      if (rawType === undefined || !CLAUDE_KNOWN_HOOK_NAMES.has(rawType)) {
        // Reported, never dropped, in the quieter class. A hook name the
        // normalizer does not handle mints nothing, so it cannot be shown
        // to be load-bearing, and the first live pi session proved the
        // "the broker registers every hook it can receive" premise wrong
        // in general. Unknown queue OPERATIONS are load-bearing (above).
        return {
          outcome: {
            disposition: 'blocked-unknown',
            family: 'diagnostic',
            message: `Unknown Claude hook: ${rawType ?? '(none)'}`,
          } as NormalizeOutcome,
          decision,
        }
      }
      return { outcome: provenance.mintOutcome(rawType), decision }
    }

    if (rawType === 'UserPromptSubmit') {
      attributionEvents.emitActions(
        attribution.observePromptHook(
          getString(rawHook, 'prompt'),
          envelope.turnId as TurnId | undefined
        ),
        rawType
      )
      return finish()
    }
    if (rawType === 'Stop') {
      attributionEvents.emitActions(attribution.settleOutstandingRemovals(rawHook), rawType)
    }
    let effectiveEnvelope =
      envelope.turnId === undefined && attribution.activeTurnId !== undefined
        ? { ...envelope, turnId: attribution.activeTurnId }
        : envelope
    const structuredDecision = structuredOutput.handleHook(effectiveEnvelope)
    if (structuredDecision.action === 'drop') {
      return finish(structuredDecision.decision)
    }
    effectiveEnvelope = structuredDecision.envelope
    for (const event of normalizeHookEnvelope(effectiveEnvelope, { normalizer })) {
      forwardNormalizedEvent(emit, event)
      if (event.type === 'turn.started' && event.turnId !== undefined) {
        attribution.observeTurnStarted(event.turnId, event.inputId)
      } else if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
      ) {
        if (event.turnId !== undefined) attribution.observeTurnTerminal(event.turnId)
      }
    }
    return finish()
  }

  /**
   * Warn on a blocked-unknown outcome when NO capture gate is wired (the
   * isolated driver unit harness). With a gate the gate owns this event —
   * it is the only place that also records the durable disposition and the
   * broker.err line — so emitting here too would double-report it.
   */
  const warnWithoutCapture = (outcome: NormalizeOutcome, rawType: string): void => {
    if (outcome.disposition !== 'blocked-unknown') return
    emit(
      'capture.warning',
      { message: outcome.message, raw: pendingUnclassifiedRaw ?? outcome.message },
      { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType } }
    )
    pendingUnclassifiedRaw = undefined
  }

  const isForThisInvocation = (envelope: ClaudeCodeHookEnvelope): boolean => {
    if (envelope.invocationId !== driverCtx.invocationId) return false
    if (
      expectedRuntimeId !== undefined &&
      envelope.runtimeId !== undefined &&
      envelope.runtimeId !== expectedRuntimeId
    ) {
      return false
    }
    // T-01794 Phase D: durable identity fencing. Reject an envelope whose
    // generation does not match the live launch generation — but STRICTLY
    // only when the field is present, so legacy/stdio rows that omit it are
    // never rejected for an absent field.
    if (envelope.generation !== undefined && envelope.generation !== CLAUDE_HOOK_GENERATION) {
      return false
    }
    const listenerSocketPath = options.getListenerSocketPath()
    return listenerSocketPath === undefined || envelope.callbackSocket === listenerSocketPath
  }

  return async (envelope) => {
    if (!isForThisInvocation(envelope)) return
    const rawHook = asHookRecord(envelope.hookData)
    const capture = driverCtx.capture
    if (capture === undefined) {
      const result = normalizeHookRecord(envelope, rawHook)
      warnWithoutCapture(result.outcome, getString(rawHook, 'hook_event_name') ?? '(none)')
      return result.decision
    }

    // Commit the hook payload verbatim BEFORE normalizing it (§7.1). The
    // synchronous decision a PreToolUse hook is waiting for is returned
    // from inside the same callback, so a blocked cursor cannot leave the
    // harness hanging on a permission answer — a deferred record simply
    // returns no decision, exactly as an unhandled hook does today.
    let decision: HookEnvelopeResult
    capture.ingest(
      {
        provider: 'anthropic',
        driverKind: CLAUDE_CODE_TMUX_DRIVER_KIND,
        sourceKind: 'hook',
        sourceKey: `hook:${driverCtx.invocationId}`,
        nativeType: getString(rawHook, 'hook_event_name') ?? '(none)',
        rawBytes: Buffer.from(JSON.stringify(envelope.hookData ?? null), 'utf8'),
        ...(envelope.turnId !== undefined ? { correlationHints: { turnId: envelope.turnId } } : {}),
      },
      (captured) =>
        provenance.withProvenance(captured.provenance(), () => {
          const result = normalizeHookRecord(envelope, rawHook)
          decision = result.decision
          return result.outcome
        })
    )
    return decision
  }
}
