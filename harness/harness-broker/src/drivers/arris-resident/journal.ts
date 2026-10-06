import type {
  ArrisHostDescriptor,
  ArrisJournalRecord,
  MessageId,
  RawProviderRecord,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord, NormalizeOutcome } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { ARRIS_RESIDENT_DRIVER_KIND } from './driver-spec'
import { type ArrisResidentState, neutralTurnFor } from './resident-state'

/**
 * Journal kinds that carry no broker turn, delivery or lifecycle fact and are
 * recorded as `ignored-known` capture records.
 */
const KNOWN_IGNORED_EVENTS = new Set([
  'event_journal_opened',
  'control_ledger_opened',
  'control_channel_bound',
  'priming_turn_seeded',
  'host_turn_admitted',
  'resumable_confirmed',
  'control_request',
  'control_input_admitted',
  'control_input_reopened',
  'control_input_converged',
  'control_outcome',
  'control_input_turn_completed',
  'child_turn_completed_ignored',
  // App-server admission diagnostics explain attached TUI traffic but carry
  // no broker turn, delivery, or lifecycle fact. They are deliberately
  // state-only so a real resident's ordinary attach path does not accumulate
  // blocked-unknown capture records.
  'attached_request_passed_through',
  'attached_request_normalized',
  'attached_turn_admitted',
  'attached_request_refused',
  // Arris 6e43a1fd renamed the pass-through admission diagnostic; same
  // rationale as the attached_request_* kinds above.
  'attached_request_allowed',
  // Attached-proxy traffic: an answer from a client that does not own the
  // request, and a forwarded unsubscribe. No turn, delivery or lifecycle fact.
  'attached_answer_ignored',
  'attached_thread_unsubscribe_forwarded',
  // Duplicates a fact already surfaced: the host also writes helper_observed
  // (an ARRIS_HELPER_OBSERVED notice) for every attached client it sees.
  'attached_client_observed',
  // Precedes dynamic_tool_call_answered, which carries the tool call itself.
  'dynamic_tool_call_admitted',
  // A late notification for a turn the host already correlated; the turn's
  // own turn_started/turn_completed already carried the bracket.
  'turn_started_already_bound',
  'turn_completed_already_bound',
  // Event-drain and responder-delay instrumentation for Arris routing
  // experiments; neither changes a turn or the host's lifecycle.
  'event_drain_resumed',
  'resident_responder_delay_started',
])

/**
 * Journal kinds surfaced verbatim as `driver.notice{code: ARRIS_<KIND>}` with
 * the record's detail as `data`. Each is a host lifecycle, approval, mail or
 * failure fact an operator reading the invocation needs, but none maps to a
 * turn, message or tool event.
 */
const ARRIS_NOTICE_EVENTS = new Set([
  'native_approval_offered',
  'helper_observed',
  'resident_rebound',
  'control_submission_fenced',
  'uncertain_bound_to_turn',
  'uncertain_resolved',
  // Codex app-server child lifecycle (T-09954 supervisor): pid and
  // incarnation_seq on start, exit status and whether it was planned on exit,
  // the restart's reconciliation, re-injected settled effects, the resume.
  'codex_child_started',
  'codex_child_exited',
  'child_exit_reconciled',
  'settled_effect_surfaced',
  'codex_child_resumed',
  // Why the host stopped serving: product_owner, sigint, deadline, control_stop.
  'shutdown_signal',
  // The host's own stop decision for a managed-stop request, or its refusal.
  'control_stop_decided',
  'control_stop_refused',
  // Who must answer a native approval, and that it was answered or released.
  'approval_ownership_held',
  'approval_ownership_transferred',
  'native_approval_answered',
  'native_approval_deferral_resolved',
  // The resident answered, or refused to answer, an addressed mail.
  'mail_reply_sent',
  'mail_reply_refused',
  // The resident thread's context was compacted under the host.
  'resident_compacted',
  // Turns that ran without broker-visible correlation, and a dynamic tool
  // call the host refused because no admitted turn owned it.
  'turn_started_without_admission',
  'turn_completed_without_active_turn',
  'dynamic_tool_call_unattributed',
  'attached_turn_admission_failed_open',
  // Host faults: a durable write that did not land, a descriptor the host
  // could not republish, a rebind or resumability check that failed, an
  // unparseable child frame, a server request nobody answers, a fence probe
  // that learned nothing, and a turn that never settled.
  'control_presentation_not_recorded',
  'control_completion_not_recorded',
  'control_resolution_failed',
  'control_resolution_unmatched',
  'host_descriptor_publication_failed',
  'resident_rebind_failed',
  'resumable_check_failed',
  'child_frame_untyped',
  'server_request_unhandled',
  'uncertain_probe_failed',
  'uncertain_unresolved',
  'turn_settle_deadline',
  // A deliberately injected turn-start fault is armed or applied; an operator
  // must be able to tell an injected loss from a real one.
  'turn_start_fault_armed',
  'turn_start_fault_applied',
])

export interface ArrisJournalDeps {
  ctx(): DriverContext
  descriptor(): ArrisHostDescriptor
}

/**
 * The host's event journal as the broker reads it: tails the NDJSON file into
 * the capture gate, de-duplicates by journal sequence, and normalizes each
 * record of the closed Arris vocabulary into broker turn, message, tool and
 * notice events, correlating neutral turns with the inputs that caused them.
 */
export interface ArrisJournal {
  normalize(captured: CapturedRecord): NormalizeOutcome
  /** Ingests every journal line appended since the last read. */
  readNew(descriptor: ArrisHostDescriptor): void
  retarget(path: string): void
  /** Forgets seen sequences except those already captured for this driver. */
  resetSeen(captured: readonly RawProviderRecord[]): void
  clear(): void
}

export function createArrisJournal(
  state: ArrisResidentState,
  deps: ArrisJournalDeps
): ArrisJournal {
  const assistantText = new Map<string, string>()
  const assistantStarted = new Set<string>()
  const seenSequences = new Set<number>()
  const tailer = createJsonlByteOffsetTailer()

  // EXCEPTION(T-08503): one auditable switch keeps the closed Arris journal vocabulary and its stateful correlations together.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event vocabulary mapper
  function normalizeRecord(captured: CapturedRecord): NormalizeOutcome {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(captured.record.rawBytes).toString('utf8'))
    } catch {
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic',
        message: 'Invalid Arris journal JSON',
      }
    }
    if (!isJournalRecord(parsed)) {
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic',
        message: 'Invalid Arris journal record',
      }
    }
    const record = parsed
    const expected = deps.descriptor().host_incarnation.host_incarnation_id
    if (record.host_incarnation_id !== expected) {
      state.healthReason = `foreign Arris journal incarnation ${record.host_incarnation_id}`
      return { disposition: 'blocked-unknown', family: 'diagnostic', message: state.healthReason }
    }
    if (seenSequences.has(record.sequence)) return { disposition: 'duplicate', detail: record.kind }
    seenSequences.add(record.sequence)
    const extra = {
      driver: { kind: ARRIS_RESIDENT_DRIVER_KIND, rawType: record.kind },
      sourceTime: new Date(record.at_ms).toISOString(),
      provenance: captured.provenance(),
    }
    const detail = record.detail
    if (record.kind === 'host_readiness_changed') {
      const to = asRecord(detail['to'])
      if (to?.['accepts_input'] === true) {
        state.retryHold = false
        deps.ctx().admissionStateChanged?.()
      }
      return { disposition: 'state-only', detail: record.kind }
    }
    if (record.kind === 'turn_started') {
      const neutral = stringValue(detail['neutral_turn_id'])
      const codex = stringValue(detail['codex_turn_id'])
      if (neutral === undefined)
        return {
          disposition: 'blocked-unknown',
          family: 'turn-bracket',
          message: 'Arris turn_started lacks neutral_turn_id',
        }
      state.currentNeutralTurnId = neutral
      if (codex !== undefined) state.neutralByCodexTurn.set(codex, neutral)
      const inputId = state.inputByNeutralTurn.get(neutral)
      deps.ctx().emit(
        'turn.started',
        {
          turnId: neutral as TurnId,
          source: 'observed',
          sessionId: deps.descriptor().resident_binding.thread_id,
          ...(inputId !== undefined ? { inputId } : {}),
        },
        { ...extra, turnId: neutral as TurnId, ...(inputId !== undefined ? { inputId } : {}) }
      )
      const origin = stringValue(detail['origin'])
      // A historical control turn can be replayed before this broker has seen
      // the matching control_input_presented record. Do not claim broker/own
      // attribution without its input id; the later presentation record
      // upgrades attribution once the durable identity is available.
      const owned = inputId !== undefined
      deps.ctx().emit(
        'turn.attributed',
        {
          turnId: neutral as TurnId,
          ownership: owned ? 'own' : 'foreign',
          origin: owned ? 'broker' : origin === 'attached_client' ? 'human' : 'autonomous',
          ...(inputId !== undefined ? { inputId } : {}),
        },
        { ...extra, turnId: neutral as TurnId, ...(inputId !== undefined ? { inputId } : {}) }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'control_input_presented') {
      const hostInputId = stringValue(detail['input_id'])
      const inputId =
        hostInputId === undefined ? undefined : state.brokerInputByHostInput.get(hostInputId)
      const codex = stringValue(detail['codex_turn_id'])
      const neutral = neutralTurnFor(state, codex)
      if (inputId === undefined || neutral === undefined)
        return { disposition: 'state-only', detail: 'presentation-awaiting-turn-correlation' }
      state.inputByNeutralTurn.set(neutral, inputId)
      deps.ctx().emit(
        'turn.attributed',
        {
          turnId: neutral as TurnId,
          ownership: 'own',
          origin: 'broker',
          inputId,
        },
        { ...extra, turnId: neutral as TurnId, inputId }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'assistant_text_delta') {
      const codex = stringValue(detail['codex_turn_id'])
      const neutral = neutralTurnFor(state, codex)
      const delta = stringValue(detail['delta'])
      if (neutral === undefined || delta === undefined)
        return { disposition: 'state-only', detail: record.kind }
      const messageId = `arris-assistant:${neutral}` as MessageId
      if (!assistantStarted.has(neutral)) {
        assistantStarted.add(neutral)
        deps
          .ctx()
          .emit(
            'assistant.message.started',
            { messageId },
            { ...extra, turnId: neutral as TurnId, itemId: messageId }
          )
      }
      assistantText.set(neutral, `${assistantText.get(neutral) ?? ''}${delta}`)
      deps
        .ctx()
        .emit(
          'assistant.message.delta',
          { messageId, text: delta },
          { ...extra, turnId: neutral as TurnId, itemId: messageId }
        )
      return { disposition: 'normalized', detail: record.kind }
    }
    // turn_ended_by_child_exit is the host closing its active turn as
    // interrupted because the Codex child died; no turn_completed follows it.
    if (record.kind === 'turn_completed' || record.kind === 'turn_ended_by_child_exit') {
      const neutral = stringValue(detail['neutral_turn_id']) ?? state.currentNeutralTurnId
      if (neutral === undefined)
        return {
          disposition: 'blocked-unknown',
          family: 'turn-bracket',
          message: `Arris ${record.kind} lacks neutral turn correlation`,
        }
      const text = assistantText.get(neutral) ?? ''
      if (assistantStarted.has(neutral)) {
        const messageId = `arris-assistant:${neutral}` as MessageId
        deps.ctx().emit(
          'assistant.message.completed',
          {
            messageId,
            content: [{ type: 'text', text }],
            final: true,
          },
          { ...extra, turnId: neutral as TurnId, itemId: messageId }
        )
      }
      const status =
        record.kind === 'turn_ended_by_child_exit'
          ? 'interrupted'
          : stringValue(detail['status'])?.toLowerCase()
      deps.ctx().emit(
        'turn.completed',
        {
          turnId: neutral as TurnId,
          status:
            status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed',
          ...(text.length > 0 ? { finalOutput: text } : {}),
          producedContent: text.length > 0,
        },
        { ...extra, turnId: neutral as TurnId }
      )
      if (state.currentNeutralTurnId === neutral) state.currentNeutralTurnId = undefined
      state.retryHold = false
      deps.ctx().admissionStateChanged?.()
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'event_gap') {
      state.healthReason = 'Arris runtime event stream reported a gap'
      deps.ctx().emit(
        'capture.warning',
        {
          message: state.healthReason,
          kind: 'arris_event_gap',
          raw: detail,
        },
        extra
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'item_observed') {
      deps.ctx().emit(
        'driver.notice',
        {
          code: 'ARRIS_ITEM_OBSERVED',
          message: `Arris observed ${stringValue(detail['item_type']) ?? 'native item'}`,
          data: detail,
        },
        {
          ...extra,
          ...(state.currentNeutralTurnId !== undefined
            ? { turnId: state.currentNeutralTurnId as TurnId }
            : {}),
        }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'dynamic_tool_call_answered') {
      const toolCallId = (stringValue(detail['action_id']) ??
        `arris-action:${record.sequence}`) as ToolCallId
      const name = stringValue(detail['tool']) ?? 'dynamic_tool'
      const turnExtra = {
        ...extra,
        ...(state.currentNeutralTurnId !== undefined
          ? { turnId: state.currentNeutralTurnId as TurnId }
          : {}),
        itemId: toolCallId,
      }
      deps.ctx().emit('tool.call.started', { toolCallId, name, input: detail }, turnExtra)
      deps.ctx().emit(
        'tool.call.completed',
        {
          toolCallId,
          name,
          result: detail,
          isError: detail['success'] !== true,
        },
        turnExtra
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (ARRIS_NOTICE_EVENTS.has(record.kind)) {
      deps.ctx().emit(
        'driver.notice',
        {
          code: `ARRIS_${record.kind.toUpperCase()}`,
          message: `Arris ${record.kind.replaceAll('_', ' ')}`,
          data: detail,
        },
        extra
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (KNOWN_IGNORED_EVENTS.has(record.kind))
      return { disposition: 'ignored-known', detail: record.kind }
    return {
      disposition: 'blocked-unknown',
      family: 'diagnostic',
      message: `Unknown Arris journal kind ${record.kind}`,
    }
  }

  function readNew(active: ArrisHostDescriptor): void {
    tailer.readNewLines((line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = undefined
      }
      const sequence = isJournalRecord(parsed) ? parsed.sequence : -1
      if (sequence >= 0 && seenSequences.has(sequence)) return
      deps.ctx().capture?.ingest(
        {
          provider: 'openai',
          driverKind: ARRIS_RESIDENT_DRIVER_KIND,
          sourceKind: 'provider-jsonl',
          sourceKey: `arris:${active.host_incarnation.host_incarnation_id}`,
          sourceCursor: sequence >= 0 ? { nativeSequence: String(sequence) } : {},
          nativeType: isJournalRecord(parsed) ? parsed.kind : 'unparseable',
          rawBytes: Buffer.from(line, 'utf8'),
          correlationHints: { hostIncarnationId: active.host_incarnation.host_incarnation_id },
        },
        normalizeRecord
      )
    })
  }

  function resetSeen(captured: readonly RawProviderRecord[]): void {
    seenSequences.clear()
    for (const record of captured) {
      if (record.driverKind !== ARRIS_RESIDENT_DRIVER_KIND) continue
      const sequence = record.sourceCursor.nativeSequence
      if (typeof sequence === 'string' && /^\d+$/.test(sequence)) {
        seenSequences.add(Number(sequence))
      }
    }
  }

  return {
    normalize: normalizeRecord,
    readNew,
    retarget: (path) => tailer.retarget(path),
    resetSeen,
    clear: () => tailer.clear(),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isJournalRecord(value: unknown): value is ArrisJournalRecord {
  const row = asRecord(value)
  return (
    row !== undefined &&
    typeof row['host_incarnation_id'] === 'string' &&
    Number.isInteger(row['sequence']) &&
    typeof row['at_ms'] === 'number' &&
    typeof row['kind'] === 'string' &&
    asRecord(row['detail']) !== undefined
  )
}
