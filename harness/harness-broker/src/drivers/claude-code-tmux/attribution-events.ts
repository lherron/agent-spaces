import type {
  InvocationEventEnvelope,
  InvocationEventPayloadMap,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import { asRecord as asHookRecord, getString } from '../hook-json'
import { CLAUDE_CODE_TMUX_DRIVER_KIND, type ClaudeCodeHookEventNormalizer } from './hook-events'
import { CLAUDE_STOP_HOOK_FEEDBACK_PREFIX } from './native-types'
import type {
  ClaudeAttributionAction,
  ClaudeTranscriptQueueOperation,
  ClaudeTurnAttribution,
} from './turn-attribution'

/** The driver's provenance-stamping emit seam. */
export type CapturedEmit = <K extends InvocationEventType>(
  type: K,
  payload: InvocationEventPayloadMap[K],
  extra?: Parameters<DriverContext['emit']>[2]
) => void

/** Re-emit one event the hook normalizer produced, keeping its correlation. */
export function forwardNormalizedEvent(emit: CapturedEmit, event: InvocationEventEnvelope): void {
  emit(event.type, event.payload, {
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
    ...(event.driver !== undefined ? { driver: event.driver } : {}),
  })
}

export interface ClaudeAttributionEventSink {
  /**
   * Turn the disposition mirror's actions into broker events. Returns TRUE
   * when the batch produced at least one action, which is how the raw row
   * that triggered it earns `normalized` rather than `state-only`.
   */
  emitActions(actions: ClaudeAttributionAction[], rawType: string): boolean
  /** Route one queue-operation / attachment / user transcript row to the mirror. */
  observeTranscriptEntry(
    entry: Record<string, unknown>,
    context: { precededByStopHookCancelled: boolean }
  ): boolean | NormalizeOutcome
  /**
   * Take the mirror warnings raised while normalizing the CURRENT raw record.
   * The record's normalize callback turns them into exactly one blocked-unknown
   * disposition, so the durable disposition and the warning come from the
   * single place that owns both.
   */
  takeUnclassified(): Array<{ message: string; raw: unknown }>
}

export function createClaudeAttributionEventSink(options: {
  emit: CapturedEmit
  normalizer: ClaudeCodeHookEventNormalizer
  attribution: ClaudeTurnAttribution
  admissionStateChanged: () => void
}): ClaudeAttributionEventSink {
  const { emit, normalizer, attribution } = options
  let unclassified: Array<{ message: string; raw: unknown }> = []

  function emitActions(actions: ClaudeAttributionAction[], rawType: string): boolean {
    const driver = { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType }
    for (const action of actions) {
      const inputId = 'inputId' in action ? action.inputId : undefined
      const inputField = inputId !== undefined ? { inputId } : {}
      const extra = (turnId?: TurnId) => ({
        ...(turnId !== undefined ? { turnId } : {}),
        ...inputField,
        driver,
      })
      switch (action.kind) {
        case 'prompt-echo':
          // `conversation` is transcript-primary: the prompt text is minted
          // from the `user` row, not from the hook that disposed it.
          emit(
            'user.message',
            { content: action.content, turnId: action.turnId },
            extra(action.turnId)
          )
          break
        case 'executed':
          normalizer.activateTurn(action.turnId)
          emit(
            'turn.started',
            { turnId: action.turnId, source: 'hook-observed', ...inputField },
            extra(action.turnId)
          )
          if (action.mintsConversation) {
            emit(
              'user.message',
              { content: action.content, turnId: action.turnId, ...inputField },
              extra(action.turnId)
            )
          }
          emit(
            'submission.executed',
            { submissionId: action.submissionId, turnId: action.turnId },
            extra(action.turnId)
          )
          break
        case 'absorbed':
          emit(
            'user.message',
            { content: action.content, turnId: action.turnId, ...inputField },
            extra(action.turnId)
          )
          emit(
            'submission.absorbed',
            { submissionId: action.submissionId, turnId: action.turnId },
            extra(action.turnId)
          )
          break
        case 'cancelled':
          emit(
            'submission.cancelled',
            { submissionId: action.submissionId, reason: action.reason },
            extra()
          )
          break
        case 'started':
          normalizer.activateTurn(action.turnId)
          emit(
            'turn.started',
            { turnId: action.turnId, source: 'hook-observed' },
            extra(action.turnId)
          )
          break
        case 'interrupted':
          for (const event of normalizer.normalizeInterrupted(action.turnId)) {
            forwardNormalizedEvent(emit, event)
          }
          break
        case 'warning':
          // A mirror warning is a blocked-unknown in `submission-disposition`
          // (T-07849 item 11). Do NOT emit a bare capture.warning here — the
          // capture gate owns that event so it can ALSO record the durable
          // disposition and the broker.err line; emitting one here too would
          // put two warnings on the stream for one fact.
          unclassified.push({ message: action.message, raw: action.raw })
          break
      }
    }
    return actions.length > 0
  }

  function observeTranscriptEntry(
    entry: Record<string, unknown>,
    context: { precededByStopHookCancelled: boolean }
  ): boolean | NormalizeOutcome {
    const entryType = getString(entry, 'type')
    if (entryType === 'queue-operation') {
      const actions = attribution.observeQueueOperation(entry as ClaudeTranscriptQueueOperation)
      const minted = emitActions(actions, 'queue-operation')
      options.admissionStateChanged()
      return minted
    }
    if (entryType === 'attachment') {
      const attachment = asHookRecord(entry['attachment'])
      if (getString(attachment, 'type') !== 'queued_command') return false
      return emitActions(
        attribution.observeQueuedCommand(getString(attachment, 'prompt'), entry),
        'queued_command'
      )
    }
    const userObservation = classifyTranscriptUserEntry(entry)
    if (userObservation?.kind === 'hook-feedback') {
      return { disposition: 'ignored-known', detail: 'stop hook feedback' }
    }
    if (userObservation?.kind === 'interrupted') {
      const hadActiveTurn = attribution.activeTurnId !== undefined
      const minted = emitActions(
        attribution.observeInterrupt(entry, context),
        'transcript.interrupt'
      )
      if (!minted && !hadActiveTurn && context.precededByStopHookCancelled) {
        return {
          disposition: 'ignored-known',
          detail: 'late interrupt marker; Stop hook cancelled after delivery',
        }
      }
      return minted
    }
    if (userObservation?.kind === 'prompt') {
      return emitActions(
        attribution.observePlainUser(userObservation.content, entry),
        'transcript.user'
      )
    }
    return false
  }

  return {
    emitActions,
    observeTranscriptEntry,
    takeUnclassified() {
      const taken = unclassified
      unclassified = []
      return taken
    },
  }
}

function classifyTranscriptUserEntry(
  entry: Record<string, unknown>
):
  | { kind: 'prompt'; content: string }
  | { kind: 'interrupted' }
  | { kind: 'hook-feedback' }
  | undefined {
  const message = asHookRecord(entry['message'])
  const content = message['content']
  if (typeof content === 'string') {
    // A hook the broker BLOCKED writes its reason back into the conversation as
    // an ordinary user row. It is harness feedback about a broker decision, not
    // an operator prompt — routing it to the disposition mirror would warn
    // "a plain user row arrived while a turn is active" on every retry.
    if (content.startsWith(CLAUDE_STOP_HOOK_FEEDBACK_PREFIX)) return { kind: 'hook-feedback' }
    return content.length > 0 ? { kind: 'prompt', content } : undefined
  }
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) =>
      part !== null && typeof part === 'object' && !Array.isArray(part)
        ? getString(part as Record<string, unknown>, 'text')
        : undefined
    )
    .filter((part): part is string => part !== undefined)
    .join('')
    .trim()
  return text === '[Request interrupted by user]' ||
    text === '[Request interrupted by user for tool use]'
    ? { kind: 'interrupted' }
    : undefined
}
