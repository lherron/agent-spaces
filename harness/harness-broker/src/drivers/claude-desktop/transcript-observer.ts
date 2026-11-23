import type {
  EventProvenance,
  InvocationEventType,
  MessageId,
  RawProviderRecord,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { CaptureGate, CapturedRecord, NormalizeOutcome } from '../../capture/capture-gate'
import type { RawJournalAppendInput } from '../../capture/raw-journal'
import {
  type CapturedEmit,
  createClaudeAttributionEventSink,
} from '../claude-code-tmux/attribution-events'
import { createClaudeCodeHookEventNormalizer } from '../claude-code-tmux/hook-events'
import { createClaudeHookTranscriptReader } from '../claude-code-tmux/hook-transcript'
import { createClaudeRecordProvenance } from '../claude-code-tmux/record-provenance'
import {
  type ClaudeTurnAttribution,
  createClaudeTurnAttribution,
} from '../claude-code-tmux/turn-attribution'
import type { DriverContext } from '../driver'
import { asRecord, getString } from '../hook-json'
import {
  CLAUDE_DESKTOP_DRIVER_KIND,
  CLAUDE_DESKTOP_DRIVER_VERSION,
  type ClaudeDesktopReplayPlan,
  isTurnOpenerRow,
  isTurnTerminalRow,
  parseRow,
} from './transcript-plan'

/** What Claude puts in front of a message another session (or the broker) sent. */
const PEER_PREAMBLE = 'Another Claude session sent a message:\n'

/**
 * Event types the shared transcript reader stamps with the turn that was active
 * when its read BATCH began. A desktop drain can span two turns, so the turn is
 * re-read from attribution at emit time, which is per row.
 */
const READER_TURN_SCOPED_TYPES: ReadonlySet<InvocationEventType> = new Set([
  'usage.updated',
  'tool.call.started',
  'tool.call.completed',
  'assistant.message.completed',
  'diagnostic',
])

export interface ClaudeDesktopObserver {
  /** Point at the transcript and normalize every row in it per `plan`. */
  open(path: string, plan: ClaudeDesktopReplayPlan): void
  /** Read rows appended since the last read. */
  drain(): void
  readonly activeTurnId: TurnId | undefined
}

/**
 * Transcript-as-truth observation for one desktop session. The shared Claude
 * modules do the normalizing; this layer adds what a desktop session needs and
 * a hook-driven seat does not: turn terminals read from the transcript, peer
 * message unwrapping, turn-origin attribution and muted replay up to a byte
 * boundary.
 */
export function createClaudeDesktopObserver(options: {
  ctx: DriverContext
  now: () => Date
  /** A row at or past the boundary was published; `nextByte` is just past its newline. */
  onRowPublished?: ((nextByte: number) => void) | undefined
}): ClaudeDesktopObserver {
  const { ctx, now } = options
  const invocationId = ctx.invocationId
  const provenance = createClaudeRecordProvenance()
  let plan: ClaudeDesktopReplayPlan = {
    mode: 'first-join',
    liveFromByte: 0,
    pendingOffsets: new Set(),
    journaled: new Map(),
  }
  /** False while a row before the live boundary is rebuilding state. */
  let publishing = true
  /** The promptId of the row being normalized; it names the turn it opens. */
  let currentPromptId: string | undefined
  let turnCounter = 0
  const usedTurnIds = new Set<string>()
  const apiErrorTurns = new Set<string>()
  const apiErrorLatestTurns = new Set<string>()
  const startedAssistantMessages = new Set<string>()
  /** Bodies of recent queue enqueues, to unwrap a peer row back to what was sent. */
  const enqueuedBodies: string[] = []

  /**
   * `turn_<promptId>` when the row names its prompt, so a turn keeps its id
   * across a broker restart and matches the UserPromptSubmit `prompt_id`.
   */
  function allocateTurnId(): string {
    const named = currentPromptId === undefined ? undefined : `turn_${currentPromptId}`
    if (named !== undefined && !usedTurnIds.has(named)) {
      usedTurnIds.add(named)
      return named
    }
    turnCounter += 1
    const counted = `turn_${invocationId}_${turnCounter}`
    usedTurnIds.add(counted)
    return counted
  }

  const base = createClaudeTurnAttribution({ invocationId, allocateTurnId })
  // A Proxy rather than a spread: the attribution's `activeTurnId` and queue
  // depths are getters, and only `observePlainUser` changes.
  const attribution: ClaudeTurnAttribution = new Proxy(base, {
    get(target, property) {
      if (property === 'observePlainUser') {
        return (content: string, raw: unknown) =>
          target.observePlainUser(peerBody(content, raw), raw)
      }
      return Reflect.get(target, property, target)
    },
  })

  const emit: CapturedEmit = (type, payload, extra) => {
    if (!publishing) return
    const active = attribution.activeTurnId
    provenance.emit(
      ctx,
      type,
      payload,
      READER_TURN_SCOPED_TYPES.has(type) && active !== undefined
        ? { ...extra, turnId: active }
        : extra
    )
  }

  const normalizer = createClaudeCodeHookEventNormalizer({
    invocationId,
    now,
    allocateTurnId,
    hasApiErrorForTurn: (turnId) => apiErrorTurns.has(turnId),
    isApiErrorLatestForTurn: (turnId) =>
      apiErrorTurns.has(turnId) && apiErrorLatestTurns.has(turnId),
    clearApiErrorForTurn: (turnId) => {
      apiErrorTurns.delete(turnId)
      apiErrorLatestTurns.delete(turnId)
    },
  })
  const sink = createClaudeAttributionEventSink({
    emit,
    normalizer,
    attribution,
    admissionStateChanged: () => ctx.admissionStateChanged?.(),
  })

  const gate = {
    ...(ctx.capture ?? {}),
    ingest: ingestRow,
    rotateEpoch: (sourceKey: string) => ctx.capture?.rotateEpoch(sourceKey),
  } as CaptureGate

  const reader = createClaudeHookTranscriptReader({
    invocationId,
    now,
    getCurrentTurnId: () => attribution.activeTurnId,
    capture: gate,
    withProvenance: provenance.withProvenance,
    emit,
    onApiError: () => {
      const turnId = attribution.activeTurnId
      if (turnId === undefined) return
      apiErrorTurns.add(turnId)
      apiErrorLatestTurns.add(turnId)
    },
    onTurnEvidence: () => {
      const turnId = attribution.activeTurnId
      if (turnId !== undefined) apiErrorLatestTurns.delete(turnId)
    },
    onAssistantMessageStarted: (messageId) => {
      const turnId = attribution.activeTurnId
      if (turnId === undefined || startedAssistantMessages.has(messageId)) return
      startedAssistantMessages.add(messageId)
      emit(
        'assistant.message.started',
        { messageId: messageId as MessageId },
        { turnId, itemId: messageId, driver: desktopDriver('transcript.assistant') }
      )
    },
    onTranscriptEntry: sink.observeTranscriptEntry,
  })

  function peerBody(content: string, raw: unknown): string {
    const origin = asRecord(asRecord(raw)['origin'])
    if (getString(origin, 'kind') !== 'peer' || !content.startsWith(PEER_PREAMBLE)) return content
    let best = -1
    for (let index = 0; index < enqueuedBodies.length; index += 1) {
      const body = enqueuedBodies[index] as string
      if (
        content.includes(body) &&
        (best < 0 || body.length > (enqueuedBodies[best] as string).length)
      )
        best = index
    }
    if (best < 0) return content
    return enqueuedBodies.splice(best, 1)[0] as string
  }

  /**
   * Close the active turn from transcript evidence: the turn's own terminal
   * row, or the next turn's opening row when that terminal never came (an
   * API-error turn writes none). Same normalizer path as a Stop hook.
   */
  function closeActiveTurn(rawType: string): boolean {
    const turnId = attribution.activeTurnId
    if (turnId === undefined) return false
    if (reader.flushTerminalAssistantMessage()) normalizer.noteTranscriptTerminalMessage()
    for (const event of normalizer.normalizeHook({ hook_event_name: 'Stop', turn_id: turnId })) {
      emit(event.type, event.payload, {
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
        driver: desktopDriver(rawType),
      })
    }
    attribution.observeTurnTerminal(turnId)
    return true
  }

  function attributeTurn(turnId: TurnId, entry: Record<string, unknown>): void {
    const turnOrigin = getString(entry, 'turnOrigin') as string
    const origin = asRecord(entry['origin'])
    const originKind = getString(origin, 'kind')
    const human = turnOrigin === 'human'
    const peer = originKind === 'peer'
    const driver = desktopDriver('transcript.user')
    emit(
      'turn.attributed',
      {
        turnId,
        // A peer message may be HRC's own delivery; only its marker can say so.
        ownership: peer ? 'unknown' : 'foreign',
        origin: human ? 'human' : 'autonomous',
      },
      { turnId, driver }
    )
    const verifiedPeerPid = origin['verifiedPeerPid']
    emit(
      'driver.notice',
      {
        message: `Claude desktop turn origin: ${turnOrigin}`,
        code: 'CLAUDE_DESKTOP_TURN_ORIGIN',
        data: {
          turnOrigin,
          ...(originKind !== undefined ? { originKind } : {}),
          ...(currentPromptId !== undefined ? { promptId: currentPromptId } : {}),
          ...(peer && getString(origin, 'from') !== undefined
            ? { peerFrom: getString(origin, 'from') }
            : {}),
          ...(peer && typeof verifiedPeerPid === 'number' ? { verifiedPeerPid } : {}),
        },
      },
      { turnId, driver }
    )
  }

  /** Desktop-only rows the shared native-type table does not know. */
  function desktopOnlyDisposition(
    entry: Record<string, unknown> | undefined
  ): NormalizeOutcome | undefined {
    if (entry === undefined) return undefined
    const type = getString(entry, 'type')
    // Plugin data-flow bookkeeping, and the lineage row of a session another
    // session launched. Found in live max3 desktop transcripts, 2026-11-23.
    if (type === 'data-flow-records' || type === 'derived-from') {
      return { disposition: 'ignored-known', detail: type }
    }
    if (type === 'attachment') {
      const attachment = asRecord(entry['attachment'])
      if (getString(attachment, 'type') !== 'hook_non_blocking_error') return undefined
      // The hook's command and output can carry paths; keep only its identity.
      return {
        disposition: 'ignored-known',
        detail: JSON.stringify({
          hookName: getString(attachment, 'hookName') ?? null,
          hookEvent: getString(attachment, 'hookEvent') ?? null,
        }),
      }
    }
    if (type !== 'user' || typeof entry['turnOrigin'] === 'string') return undefined
    // The meta row Claude writes just before a turn's real opening row, and
    // harness reminders: neither is a prompt, and a turn opened from one would
    // carry the wrong text.
    if (entry['turnCompanion'] === true) {
      return { disposition: 'ignored-known', detail: 'turn companion' }
    }
    if (entry['isMeta'] === true && !hasToolResult(entry)) {
      return { disposition: 'ignored-known', detail: 'meta user row' }
    }
    return undefined
  }

  function normalizeRow(
    entry: Record<string, unknown> | undefined,
    captured: CapturedRecord,
    normalize: (captured: CapturedRecord) => NormalizeOutcome
  ): NormalizeOutcome {
    const desktopOnly = desktopOnlyDisposition(entry)
    if (desktopOnly !== undefined) return desktopOnly
    const opener = isTurnOpenerRow(entry)
    currentPromptId = opener && entry !== undefined ? getString(entry, 'promptId') : undefined
    try {
      return provenance.withProvenance(captured.provenance(), () => {
        // A new turn's opening row proves the previous turn is over.
        const closedPrevious = opener && closeActiveTurn('transcript.next-turn')
        if (entry?.['type'] === 'queue-operation' && entry['operation'] === 'enqueue') {
          const body = entry['content']
          if (typeof body === 'string' && body.length > 0) {
            enqueuedBodies.push(body)
            if (enqueuedBodies.length > 64) enqueuedBodies.shift()
          }
        }
        const before = attribution.activeTurnId
        const outcome = normalize(captured)
        const after = attribution.activeTurnId
        if (opener && entry !== undefined && after !== undefined && after !== before) {
          attributeTurn(after, entry)
        }
        if (isTurnTerminalRow(entry) && closeActiveTurn('transcript.turn-terminal')) {
          return { disposition: 'normalized', detail: 'transcript turn terminal' }
        }
        return closedPrevious && outcome.disposition !== 'blocked-unknown'
          ? { disposition: 'normalized', detail: outcome.detail ?? 'next turn closed previous' }
          : outcome
      })
    } finally {
      currentPromptId = undefined
    }
  }

  function ingestRow(
    input: RawJournalAppendInput,
    normalize: (captured: CapturedRecord) => NormalizeOutcome
  ): void {
    const line = Buffer.from(input.rawBytes).toString('utf8')
    const entry = parseRow(line)
    const relabeled = { ...input, driverKind: CLAUDE_DESKTOP_DRIVER_KIND }
    const offset = input.sourceCursor?.byteOffset ?? 0
    const run = (captured: CapturedRecord) => normalizeRow(entry, captured, normalize)
    if (offset >= plan.liveFromByte) {
      if (ctx.capture !== undefined) {
        ctx.capture.ingest(relabeled, run)
      } else {
        const outcome = run(uncommitted(relabeled))
        if (outcome.disposition === 'blocked-unknown') {
          emit(
            'capture.warning',
            { message: outcome.message, raw: line },
            { driver: desktopDriver('transcript') }
          )
        }
      }
      options.onRowPublished?.(offset + input.rawBytes.length + 1)
      return
    }
    const journaled = plan.journaled.get(offset)
    publishing = plan.pendingOffsets.has(offset)
    try {
      run(journaled !== undefined ? fromJournal(journaled) : uncommitted(relabeled))
    } finally {
      publishing = true
    }
  }

  return {
    open(path, nextPlan) {
      plan = nextPlan
      reader.handleHook({ hook_event_name: 'SessionStart', transcript_path: path })
      reader.drain()
    },
    drain() {
      reader.drain()
    },
    get activeTurnId() {
      return attribution.activeTurnId
    },
  }
}

function desktopDriver(rawType: string): { kind: string; rawType: string } {
  return { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType }
}

function hasToolResult(entry: Record<string, unknown>): boolean {
  const content = asRecord(entry['message'])['content']
  return (
    Array.isArray(content) &&
    content.some((block) => getString(asRecord(block), 'type') === 'tool_result')
  )
}

const NORMALIZER = { name: CLAUDE_DESKTOP_DRIVER_KIND, version: CLAUDE_DESKTOP_DRIVER_VERSION }

/** A row the previous broker journaled, re-normalized under its own record id. */
function fromJournal(record: RawProviderRecord): CapturedRecord {
  return {
    record,
    provenance: (): EventProvenance => ({
      rawRecordId: record.rawRecordId,
      sourceKind: record.sourceKind,
      sourceEpoch: record.sourceEpoch,
      sourceCursor: record.sourceCursor as Record<string, number>,
      nativeType: record.nativeType,
      rawSha256: record.sha256,
      normalizer: NORMALIZER,
    }),
  }
}

/**
 * A row with no journal record: history before a first join, or any row when
 * no capture gate is wired. Its provenance names no record, so the broker
 * reports anything minted from it as broker-sourced rather than provider.
 */
function uncommitted(input: RawJournalAppendInput): CapturedRecord {
  return {
    record: {
      rawRecordId: '',
      invocationId: '' as RawProviderRecord['invocationId'],
      provider: input.provider,
      driverKind: input.driverKind,
      sourceKind: input.sourceKind,
      sourceEpoch: '',
      sourceCursor: input.sourceCursor ?? {},
      nativeType: input.nativeType,
      observedAt: new Date().toISOString() as RawProviderRecord['observedAt'],
      sha256: '',
      rawBytes: input.rawBytes,
    },
    provenance: (): EventProvenance => ({
      sourceKind: input.sourceKind,
      nativeType: input.nativeType,
      normalizer: NORMALIZER,
    }),
  }
}
