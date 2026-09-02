import { type FSWatcher, existsSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type {
  EventProvenance,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  MessageId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { CLAUDE_CODE_TMUX_AUTHORITY } from '../evidence-authority'
import { asRecord as asHookRecord, getString } from '../hook-json'
import {
  type HookEnvelopeDecision,
  type HookEnvelopeResult,
  type HookListenerHandle,
  buildHookSocketPath,
  consumePaneLease,
  extractText,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
  shellQuote,
} from '../tmux-shared'
import {
  CLAUDE_CODE_TMUX_DRIVER_KIND,
  type ClaudeCodeHookEnvelope,
  createClaudeCodeHookEventNormalizer,
  normalizeHookEnvelope,
} from './hook-events'
import {
  type ClaudeHookTranscriptReader,
  createClaudeHookTranscriptReader,
} from './hook-transcript'
import { CLAUDE_KNOWN_HOOK_NAMES, CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS } from './native-types'
import {
  type ClaudeAttributionAction,
  type ClaudeTranscriptQueueOperation,
  type ClaudeTurnAttribution,
  createClaudeTurnAttribution,
} from './turn-attribution'

const CLAUDE_CODE_TMUX_DRIVER_VERSION = '0.1.0'

/**
 * Live hook generation stamped into the launch env (HARNESS_BROKER_HOOK_GENERATION)
 * and used to fence out-of-band hook envelopes. A durable broker restart would
 * bump this; envelopes carrying a stale generation are rejected (T-01794 Phase D).
 */
const CLAUDE_HOOK_GENERATION = 1

const CLAUDE_CODE_TMUX_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'harness-evidence',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'quiescence' },
  steer: { landingEvidence: 'transcript' },
  interrupt: { landingEvidence: 'transcript' },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    // Busy user input is accepted by the broker, then applied through
    // applySteerNow as an attempted steer. The TUI decides whether that text
    // affects the active turn, queues internally, or becomes a later prompt.
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'process',
  },
  continuation: {
    supported: true,
    provider: 'anthropic',
    keyKind: 'session',
  },
  finalResponse: {
    jsonSchema: true,
    perTurn: true,
    strict: false,
    parsedResult: false,
  },
  events: {
    assistantDeltas: false,
    toolCalls: true,
    // T-07873: `usage.updated` is minted from every assistant row's
    // `message.usage` and from `cost-state` rows. Declared `native` since
    // Phase 0 and emitting nothing until now.
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    // T-01794 Phase D: `attach` means an OPERATOR can `tmux attach` to the
    // live TUI. It does NOT imply the broker can restart this driver and
    // reattach it to an already-live surface — that distinct capability is
    // explicitly false (no driver attach-to-existing-surface impl in scope).
    driverAttachExistingSurface: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export type { HookListenerHandle }

export interface HookListenerContext {
  invocationId: string
  runtimeId?: string | undefined
}

/** Receives normalized hook envelopes posted by the in-pane Claude hook CLI. */
export type HookEnvelopeHandler = (
  envelope: ClaudeCodeHookEnvelope
) => Promise<HookEnvelopeResult> | HookEnvelopeResult

export type TranscriptWatch = (
  path: string,
  options: { persistent: false },
  listener: () => void
) => FSWatcher

export interface ClaudeCodeTmuxDriverOptions {
  tmux: {
    /**
     * Default tmux server socket — IGNORED by the lease-consuming driver path
     * (Phase C, T-01725). Retained on the options shape only for backward
     * compatibility with construction sites that still pass it; the live
     * socket is ALWAYS `runtime.terminalSurface.socketPath` from the pane
     * lease handed in on start.
     */
    socketPath?: string | undefined
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (
      handler: HookEnvelopeHandler,
      context: HookListenerContext
    ) => Promise<HookListenerHandle>
    /**
     * Executable that the in-pane Claude hook settings overlay invokes to POST
     * each hook payload to the broker callback socket. Broker-owned (H3); no
     * hrc-runtime dependency. Defaults to the broker's `claude-hook` subcommand.
     */
    bridgeCommand?: string | undefined
  }
  now?: (() => Date) | undefined
  /** Test seam for watcher error/re-arm lifecycle; production uses node:fs. */
  watchTranscript?: TranscriptWatch | undefined
}

interface SurfaceState {
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName?: string | undefined
  windowName?: string | undefined
}

interface StructuredTurnState {
  turnId: string
  schema: Record<string, unknown>
  attempts: number
  validator: ValidateFunction
}

const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 3

// Broker-synthesized structured-output enforcement for claude-code-tmux uses
// Ajv draft-07 defaults with strict schema linting disabled, allErrors enabled,
// and schema validation enabled. This intentionally mirrors the advertised
// strict:false capability: Claude is prompted, then the driver validates the
// Stop-hook candidate before allowing final capture.
const structuredOutputAjv = new Ajv({
  strict: false,
  allErrors: true,
})

/**
 * Phase 3 broker driver: launches an OPERATOR-ATTACHABLE interactive Claude
 * Code in a tmux session (pty transport, terminal host = tmux), delivers turns
 * via send-keys, normalizes the out-of-band Claude hook stream into broker
 * events, and reports the runtime tmux attach surface.
 *
 * AD-008: NO live reattach / NO event replay / NO claim HRC can recover a broker
 * invocation after restart — operator attach is plain `tmux attach`.
 */
export function createClaudeCodeTmuxDriver(options: ClaudeCodeTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: HookListenerHandle | undefined
  let transcriptReader: ClaudeHookTranscriptReader | undefined
  let transcriptWatcher: FSWatcher | undefined
  let transcriptPath: string | undefined
  let watcherRecoveryUsed = false
  let nativeWakeupLostReason: string | undefined
  let attribution: ClaudeTurnAttribution | undefined
  let hookDrain: Promise<HookEnvelopeResult> = Promise.resolve(undefined)
  // The runtime hands the driver a pane LEASE — `runtime.terminalSurface`
  // (kind: 'tmux-pane', ownership: 'hrc', T-01723 Phase A). The driver
  // attaches to that lease through a TmuxPaneController (T-01724 Phase B)
  // and NEVER constructs or owns a tmux session/server. All capability gates
  // (inspect, sendInput, sendInterrupt, capture, resize) come from the
  // lease's `allowedOps` set.
  let paneController: TmuxPaneController | undefined
  let turnCounter = 0
  /**
   * Provenance of the raw record currently being normalized (§7.2). Set by the
   * capture gate's normalize callback and stamped onto every event minted while
   * it is set; broker-authored facts outside any record leave it undefined and
   * the invocation manager stamps broker provenance instead.
   */
  let activeProvenance: EventProvenance | undefined
  /**
   * Events minted while normalizing the current raw record. It is what decides
   * `normalized` vs `state-only` for that record, so it is counted at the single
   * emit seam rather than at each of the ~20 call sites.
   */
  let mintedForRecord = 0

  /**
   * Run `body` with `provenance` active on {@link emitCaptured}, restoring the
   * previous value afterwards. This is a STACK, not a slot: transcript rows are
   * normalized inside a hook record's normalization, and the inner row's
   * provenance must not leak out to what the outer hook mints afterwards.
   */
  function withProvenance<T>(provenance: EventProvenance, body: () => T): T {
    const previousProvenance = activeProvenance
    const previousMinted = mintedForRecord
    activeProvenance = provenance
    mintedForRecord = 0
    try {
      return body()
    } finally {
      activeProvenance = previousProvenance
      mintedForRecord = previousMinted
    }
  }
  const structuredTurns = new Map<string, StructuredTurnState>()
  const completedStructuredTurns = new Set<string>()
  const apiErrorTurns = new Set<string>()
  const startedAssistantMessages = new Set<string>()

  // Single shared per-invocation turn-id allocator (cody's blessed scheme,
  // C-02755). BOTH applyInputNow (manager path) and the hook normalizer (which
  // mints for turn-id-less operator prompts) call THIS closure so manager- and
  // normalizer-minted ids never collide and stay monotonic in turn-open order.
  function allocateTurnId(): string {
    turnCounter += 1
    return `turn_${requireCtx().invocationId}_${turnCounter}`
  }

  /**
   * The driver's ONLY emit seam. Stamps the raw record's provenance and counts
   * the mint, so provenance and disposition cannot drift apart per call site.
   */
  function emitCaptured<K extends InvocationEventType>(
    driverCtx: DriverContext,
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: Parameters<DriverContext['emit']>[2]
  ): ReturnType<DriverContext['emit']> {
    mintedForRecord += 1
    return driverCtx.emit(type, payload, {
      ...extra,
      ...(activeProvenance !== undefined ? { provenance: activeProvenance } : {}),
    })
  }

  /** Disposition for a record whose normalization minted (or did not mint). */
  function mintOutcome(detail: string): NormalizeOutcome {
    if (mintedForRecord > 0) return { disposition: 'normalized', detail }
    // A hook whose FACT the transcript now owns is not "state only" — it is
    // real evidence of a fact another record already carried (T-07873 scope A).
    const duplicated = CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS.get(detail)
    if (duplicated !== undefined) return { disposition: 'duplicate', detail: duplicated }
    return { disposition: 'state-only', detail }
  }

  function requireCtx(): DriverContext {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function requireSurface(): SurfaceState {
    if (surface === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established')
    }
    return surface
  }

  function requirePaneController(): TmuxPaneController {
    if (paneController === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established')
    }
    return paneController
  }

  function emitDriverTeardownDispositions(rawType: string): void {
    if (ctx === undefined || attribution === undefined) return
    for (const action of attribution.teardown()) {
      if (action.kind !== 'cancelled') continue
      ctx.emit(
        'submission.cancelled',
        { submissionId: action.submissionId, reason: action.reason },
        {
          ...(action.inputId !== undefined ? { inputId: action.inputId } : {}),
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
        }
      )
    }
  }

  const transcriptWatch: TranscriptWatch =
    options.watchTranscript ??
    ((path, watchOptions, listener) => watch(path, watchOptions, listener))

  function enqueueTranscriptDrain(): void {
    const drain = (): HookEnvelopeResult => {
      transcriptReader?.drain()
      return undefined
    }
    // Native transcript notifications and hooks share ONE chain. A
    // notification reads to EOF; a hook queued beside it then sees the
    // byte-offset tailer already advanced (or vice versa), so rows are ordered
    // once and never double-normalized.
    hookDrain = hookDrain.then(drain, drain)
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  function isEnoent(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    )
  }

  function degradeNativeWakeup(path: string, error: unknown): void {
    if (nativeWakeupLostReason !== undefined) return
    const detail = describeError(error)
    nativeWakeupLostReason = 'native_wakeup_lost'
    transcriptWatcher?.close()
    transcriptWatcher = undefined
    ctx?.emit(
      'capture.warning',
      {
        kind: 'native_wakeup_lost',
        message: `Claude transcript native wakeup lost: ${detail}`,
        raw: { transcriptPath: path, detail },
      },
      { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.watch' } }
    )
    ctx?.admissionStateChanged?.()
  }

  function armTranscriptWatcher(path: string, phase: 'session-start' | 'hook' | 'rearm'): boolean {
    if (
      nativeWakeupLostReason !== undefined ||
      transcriptPath !== path ||
      transcriptWatcher !== undefined
    ) {
      return transcriptWatcher !== undefined
    }
    try {
      const watcher = transcriptWatch(path, { persistent: false }, enqueueTranscriptDrain)
      transcriptWatcher = watcher
      watcher.on('error', (error) => {
        if (transcriptWatcher !== watcher || transcriptPath !== path) return
        watcher.close()
        transcriptWatcher = undefined
        if (watcherRecoveryUsed) {
          degradeNativeWakeup(path, error)
          return
        }
        watcherRecoveryUsed = true
        if (armTranscriptWatcher(path, 'rearm')) enqueueTranscriptDrain()
      })
      return true
    } catch (error) {
      // Claude names the eventual transcript path before creating the file.
      // That SessionStart ENOENT is an expected lazy-arm state, not capture
      // degradation and must never escape through the hook normalizer.
      if (phase === 'session-start' && isEnoent(error)) return false
      degradeNativeWakeup(path, error)
      return false
    }
  }

  return {
    kind: CLAUDE_CODE_TMUX_DRIVER_KIND,
    version: CLAUDE_CODE_TMUX_DRIVER_VERSION,
    bracketMintingMode: 'harness-evidence',
    evidenceAuthority: CLAUDE_CODE_TMUX_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: 'quiescence',
    steerLandingEvidence: 'transcript',
    interruptLandingEvidence: 'transcript',

    capabilities(): InvocationCapabilities {
      return CLAUDE_CODE_TMUX_CAPABILITIES
    },

    admissionRejectionReason(admissionClass) {
      return admissionClass === 'preempt' ? nativeWakeupLostReason : undefined
    },

    runtimeHealth() {
      return nativeWakeupLostReason === undefined
        ? ({ state: 'healthy' } as const)
        : ({ state: 'degraded', reason: nativeWakeupLostReason } as const)
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      transcriptWatcher?.close()
      transcriptWatcher = undefined
      transcriptPath = undefined
      watcherRecoveryUsed = false
      nativeWakeupLostReason = undefined
      // T-01725 Phase C: the driver consumes a pane LEASE supplied on the
      // dispatch envelope as `runtime.terminalSurface` (kind: 'tmux-pane',
      // ownership: 'hrc'). It reads ONLY this field — never the legacy
      // `runtime.tmux.socketPath` boundary shim — so capability scope is
      // explicit and the driver cannot fall through to a server it owns.
      // consumePaneLease validates the lease shape, constructs the pane
      // controller (allowedOps-gated, capability-safe verbs only — never a
      // lifecycle command), inspects the leased pane, and fails loudly if the
      // tmux server's reported ids do not match the lease.
      const leased = await consumePaneLease(driverCtx, {
        driverKind: 'claude-code-tmux',
        ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
      })

      ctx = driverCtx
      paneController = leased.controller
      surface = leased.surface
      const lease = leased.surface

      const normalizer = createClaudeCodeHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
        allocateTurnId,
        hasApiErrorForTurn: (turnId) => apiErrorTurns.has(turnId),
        clearApiErrorForTurn: (turnId) => apiErrorTurns.delete(turnId),
      })
      const turnAttribution = createClaudeTurnAttribution({
        invocationId: driverCtx.invocationId,
        allocateTurnId,
      })
      attribution = turnAttribution

      /**
       * Mirror warnings raised while normalizing the CURRENT raw record. The
       * record's normalize callback drains this into exactly one
       * blocked-unknown disposition, so the halt and the warning come from the
       * single place that owns both.
       */
      const unclassified: Array<{ message: string; raw: unknown }> = []

      /**
       * Turn the disposition mirror's actions into broker events. Returns TRUE
       * when the batch produced at least one action, which is how the raw row
       * that triggered it earns `normalized` rather than `state-only`.
       */
      const emitAttributionActions = (
        actions: ClaudeAttributionAction[],
        rawType: string
      ): boolean => {
        for (const action of actions) {
          const inputExtra =
            'inputId' in action && action.inputId !== undefined ? { inputId: action.inputId } : {}
          if (action.kind === 'prompt-echo') {
            // `conversation` is transcript-primary: the prompt text is minted
            // from the `user` row, not from the hook that disposed it.
            emitCaptured(
              driverCtx,
              'user.message',
              { content: action.content, turnId: action.turnId },
              {
                turnId: action.turnId,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            continue
          }
          if (action.kind === 'executed') {
            normalizer.activateTurn(action.turnId)
            emitCaptured(
              driverCtx,
              'turn.started',
              {
                turnId: action.turnId,
                source: 'hook-observed',
                ...(action.inputId !== undefined ? { inputId: action.inputId } : {}),
              },
              {
                turnId: action.turnId,
                ...inputExtra,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            if (action.mintsConversation) {
              emitCaptured(
                driverCtx,
                'user.message',
                {
                  content: action.content,
                  turnId: action.turnId,
                  ...(action.inputId !== undefined ? { inputId: action.inputId } : {}),
                },
                {
                  turnId: action.turnId,
                  ...inputExtra,
                  driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
                }
              )
            }
            emitCaptured(
              driverCtx,
              'submission.executed',
              { submissionId: action.submissionId, turnId: action.turnId },
              {
                turnId: action.turnId,
                ...inputExtra,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            continue
          }
          if (action.kind === 'absorbed') {
            emitCaptured(
              driverCtx,
              'user.message',
              {
                content: action.content,
                turnId: action.turnId,
                ...(action.inputId !== undefined ? { inputId: action.inputId } : {}),
              },
              {
                turnId: action.turnId,
                ...inputExtra,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            emitCaptured(
              driverCtx,
              'submission.absorbed',
              { submissionId: action.submissionId, turnId: action.turnId },
              {
                turnId: action.turnId,
                ...inputExtra,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            continue
          }
          if (action.kind === 'cancelled') {
            emitCaptured(
              driverCtx,
              'submission.cancelled',
              { submissionId: action.submissionId, reason: action.reason },
              {
                ...inputExtra,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            continue
          }
          if (action.kind === 'started') {
            normalizer.activateTurn(action.turnId)
            emitCaptured(
              driverCtx,
              'turn.started',
              { turnId: action.turnId, source: 'hook-observed' },
              {
                turnId: action.turnId,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
              }
            )
            continue
          }
          if (action.kind === 'interrupted') {
            for (const event of normalizer.normalizeInterrupted(action.turnId)) {
              emitCaptured(driverCtx, event.type, event.payload, {
                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                ...(event.driver !== undefined ? { driver: event.driver } : {}),
              })
            }
            continue
          }
          // A mirror warning is a blocked-unknown in `submission-disposition`
          // (T-07849 item 11). Do NOT emit a bare capture.warning here — the
          // capture gate owns that event so it can ALSO halt the cursor and
          // record the durable disposition; emitting one here too would put two
          // warnings on the stream for one fact.
          unclassified.push({ message: action.message, raw: action.raw })
        }
        return actions.length > 0
      }

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      hookDrain = Promise.resolve(undefined)
      const reader = createClaudeHookTranscriptReader({
        invocationId: driverCtx.invocationId,
        now,
        getCurrentTurnId: () => turnAttribution.activeTurnId,
        ...(driverCtx.capture !== undefined ? { capture: driverCtx.capture } : {}),
        withProvenance,
        onTranscriptPath: (selectedPath) => {
          transcriptWatcher?.close()
          transcriptWatcher = undefined
          transcriptPath = selectedPath
          watcherRecoveryUsed = false
          if (existsSync(selectedPath)) armTranscriptWatcher(selectedPath, 'session-start')
        },
        onTranscriptAvailable: (availablePath) => {
          if (transcriptPath === availablePath && transcriptWatcher === undefined) {
            armTranscriptWatcher(availablePath, 'hook')
          }
        },
        emit: (type, payload, extra) => {
          emitCaptured(driverCtx, type, payload, extra)
        },
        onApiError: (turnId) => apiErrorTurns.add(turnId),
        onAssistantMessageStarted: (messageId) => {
          const turnId = turnAttribution.activeTurnId
          if (turnId === undefined || startedAssistantMessages.has(messageId)) return
          startedAssistantMessages.add(messageId)
          // MUST go through `emitCaptured`: the plain `driverCtx.emit` skips the
          // provenance stamp, and this event was reporting `sourceKind:'hook'`
          // for a fact read out of the session JSONL — the exact falsehood §7.2
          // exists to prevent (observed on a live seat, 25/25 events).
          emitCaptured(
            driverCtx,
            'assistant.message.started',
            { messageId: messageId as MessageId },
            {
              turnId,
              itemId: messageId,
              driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.assistant' },
            }
          )
        },
        onTranscriptEntry: (entry, context) => {
          const entryType = getString(entry, 'type')
          if (entryType === 'queue-operation') {
            const actions = turnAttribution.observeQueueOperation(
              entry as ClaudeTranscriptQueueOperation
            )
            const minted = emitAttributionActions(actions, 'queue-operation')
            driverCtx.admissionStateChanged?.()
            return minted
          }
          if (entryType === 'attachment') {
            const attachment = asHookRecord(entry['attachment'])
            if (getString(attachment, 'type') !== 'queued_command') return false
            return emitAttributionActions(
              turnAttribution.observeQueuedCommand(getString(attachment, 'prompt'), entry),
              'queued_command'
            )
          }
          const userObservation = classifyTranscriptUserEntry(entry)
          if (userObservation?.kind === 'interrupted') {
            const hadActiveTurn = turnAttribution.activeTurnId !== undefined
            const minted = emitAttributionActions(
              turnAttribution.observeInterrupt(entry, context),
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
            return emitAttributionActions(
              turnAttribution.observePlainUser(userObservation.content, entry),
              'transcript.user'
            )
          }
          return false
        },
      })
      transcriptReader = reader
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
        reader.handleHook(rawHook, envelope.turnId ?? turnAttribution.activeTurnId)
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
          if (unclassified.length > 0) {
            const message = unclassified.map((entry) => entry.message).join('; ')
            const raw =
              unclassified.length === 1 ? unclassified[0]?.raw : unclassified.map((e) => e.raw)
            unclassified.length = 0
            pendingUnclassifiedRaw = raw
            // Turn attribution is load-bearing, so an unclassifiable queue
            // signal halts the cursor rather than warning and continuing
            // (T-07849 item 11 → law 6d04d5de).
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
            // Reported, never dropped — but NOT halting. A hook name the
            // normalizer does not handle mints nothing, so it cannot be shown
            // to be load-bearing, and the first live pi session proved the
            // "the broker registers every hook it can receive" premise wrong
            // in general. Unknown queue OPERATIONS still halt (above).
            return {
              outcome: {
                disposition: 'blocked-unknown',
                family: 'diagnostic',
                message: `Unknown Claude hook: ${rawType ?? '(none)'}`,
              } as NormalizeOutcome,
              decision,
            }
          }
          return { outcome: mintOutcome(rawType), decision }
        }

        if (rawType === 'UserPromptSubmit') {
          emitAttributionActions(
            turnAttribution.observePromptHook(
              getString(rawHook, 'prompt'),
              envelope.turnId as TurnId | undefined
            ),
            rawType
          )
          return finish()
        }
        if (rawType === 'Stop') {
          emitAttributionActions(turnAttribution.settleOutstandingRemovals(rawHook), rawType)
        }
        let effectiveEnvelope =
          envelope.turnId === undefined && turnAttribution.activeTurnId !== undefined
            ? { ...envelope, turnId: turnAttribution.activeTurnId }
            : envelope
        const structuredDecision = handleStructuredOutputHook(effectiveEnvelope)
        if (structuredDecision.action === 'drop') {
          return finish(structuredDecision.decision)
        }
        effectiveEnvelope = structuredDecision.envelope
        for (const event of normalizeHookEnvelope(effectiveEnvelope, { normalizer })) {
          emitCaptured(driverCtx, event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
          if (event.type === 'turn.started' && event.turnId !== undefined) {
            turnAttribution.observeTurnStarted(event.turnId)
          } else if (
            event.type === 'turn.completed' ||
            event.type === 'turn.failed' ||
            event.type === 'turn.interrupted'
          ) {
            if (event.turnId !== undefined) turnAttribution.observeTurnTerminal(event.turnId)
          }
        }
        return finish()
      }

      /**
       * The raw op behind the most recent blocked-unknown outcome, so the
       * no-capture-gate path can still put the verbatim evidence on the warning.
       */
      let pendingUnclassifiedRaw: unknown

      /**
       * Warn on a blocked-unknown outcome when NO capture gate is wired (the
       * isolated driver unit harness). With a gate the gate owns this event —
       * it is the only place that can also halt the cursor and record the
       * durable disposition — so emitting here too would double-report it.
       */
      const warnWithoutCapture = (outcome: NormalizeOutcome, rawType: string): void => {
        if (outcome.disposition !== 'blocked-unknown') return
        emitCaptured(
          driverCtx,
          'capture.warning',
          { message: outcome.message, raw: pendingUnclassifiedRaw ?? outcome.message },
          { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType } }
        )
        pendingUnclassifiedRaw = undefined
      }

      const handleHookEnvelope = async (
        envelope: ClaudeCodeHookEnvelope
      ): Promise<HookEnvelopeResult> => {
        if (envelope.invocationId !== driverCtx.invocationId) {
          return
        }
        if (
          expectedRuntimeId !== undefined &&
          envelope.runtimeId !== undefined &&
          envelope.runtimeId !== expectedRuntimeId
        ) {
          return
        }
        // T-01794 Phase D: durable identity fencing. Reject an envelope whose
        // generation does not match the live launch generation — but STRICTLY
        // only when the field is present, so legacy/stdio rows that omit it are
        // never rejected for an absent field.
        if (envelope.generation !== undefined && envelope.generation !== CLAUDE_HOOK_GENERATION) {
          return
        }
        if (hookListener !== undefined && envelope.callbackSocket !== hookListener.socketPath) {
          return
        }
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
            ...(envelope.turnId !== undefined
              ? { correlationHints: { turnId: envelope.turnId } }
              : {}),
          },
          (captured) =>
            withProvenance(captured.provenance(), () => {
              const result = normalizeHookRecord(envelope, rawHook)
              decision = result.decision
              return result.outcome
            })
        )
        return decision
      }

      hookListener = await options.hooks.listen(
        (envelope) => {
          hookDrain = hookDrain.then(
            () => handleHookEnvelope(envelope),
            () => handleHookEnvelope(envelope)
          )
          return hookDrain
        },
        {
          invocationId: driverCtx.invocationId,
          ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
        }
      )

      // T-01725 Q3: report-back. Echo the lease ids exactly so consumers can
      // confirm the lease the driver is operating from matches what HRC
      // handed out.
      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-pane' as const,
          socketPath: lease.socketPath,
          sessionId: lease.sessionId,
          windowId: lease.windowId,
          paneId: lease.paneId,
          ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
          ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
        },
        { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      // Launch Claude inside the LEASED pane (stdio inherits the pty —
      // attachable). H1: the launch installs a broker-owned Claude hook
      // settings overlay so the REAL runtime posts UserPromptSubmit /
      // PreToolUse / PostToolUse / Stop… to the broker callback socket
      // OUT-OF-BAND (not via stdout). Env vars alone do not make Claude
      // invoke hooks.
      const launchCommand = await buildLaunchCommandLine(spec, driverCtx, {
        invocationId: driverCtx.invocationId,
        ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
        callbackSocket: hookListener.socketPath,
        bridgeCommand: options.hooks.bridgeCommand,
      })
      // Deliver the launch via the hardened paste-confirm-submit path (T-01747),
      // matching codex-cli-tmux: (re)paste until the command renders at the
      // leased pane's prompt, then confirm the line advanced past it. A blind
      // send-keys + fixed sleep + Enter can drop on a cold pane's not-yet-reading
      // shell PTY or swallow the Enter; sendPastedLine observes the pane and
      // degrades to a single blind paste+gap+Enter only when capture is denied.
      await paneController.sendPastedLine(launchCommand)

      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      requireCtx()
      requireSurface()
      const text = extractText(input)
      // This id authoritatively correlates the submission, but does not open a
      // turn bracket. Blind keystroke delivery is not harness evidence: the
      // transcript disposition mirror will either open this id on a plain user
      // row or announce that the submission joined the live turn.
      const turnId = allocateTurnId()
      const prompt = promptForStructuredOutput(input, text, turnId)
      attribution?.trackBrokerSubmission({
        ...(input.inputId !== undefined
          ? { submissionId: input.inputId, inputId: input.inputId }
          : {}),
        content: prompt,
        allocatedTurnId: turnId as TurnId,
      })
      // terminal-literal-input turn delivery: literal text, a short TUI-friendly
      // pause, then Enter so shell expansion / key interpretation never mangles
      // the prompt and Claude reliably submits it.
      await requirePaneController().sendKeys(prompt)
      return { turnId: turnId as ApplyInputResult['turnId'] }
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      requireCtx()
      requireSurface()
      const text = extractText(input)
      attribution?.trackBrokerSubmission({
        ...(input.inputId !== undefined
          ? { submissionId: input.inputId, inputId: input.inputId }
          : {}),
        content: text,
      })
      await requirePaneController().sendKeys(text)
    },

    probeAdmissionState() {
      return { harnessLocalQueueDepth: attribution?.harnessLocalQueueDepth ?? 0 }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (nativeWakeupLostReason !== undefined) {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: nativeWakeupLostReason,
        }
      }
      // Parity with codex-cli-tmux: a stopped driver clears `surface`, so an
      // interrupt after stop reports no_active_turn rather than firing a stray
      // C-c at a pane the driver no longer considers live.
      if (surface === undefined || paneController === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      const expectationId = attribution?.expectInterrupt()
      try {
        await paneController.interrupt()
      } catch (error) {
        if (expectationId !== undefined) attribution?.cancelExpectedInterrupt(expectationId)
        throw error
      }
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      // T-01725: the driver does NOT own the tmux session/server and so does
      // not kill anything during stop. Pane lifecycle (kill-session, server
      // teardown) belongs to HRC / the pre-HRC harness — the driver simply
      // releases its hook listener. It also drops the surface so post-stop
      // interrupt/applyInputNow observe a not-live driver (codex parity); the
      // pane controller ref is retained until dispose, like codex-cli-tmux.
      await closeHookListener()
      // T-05092: final transcript drain BEFORE reset/turn-id loss, so a trailing
      // API-error row that no post-error hook would surface still reaches the
      // broker. The byte-offset tailer dedupes — already-read rows are not
      // replayed. Emitted through the live ctx so the broker sequences them.
      if (transcriptReader !== undefined && ctx !== undefined) {
        // The reader now emits through the driver's provenance-stamping seam,
        // so the drain reaches the broker without the caller re-emitting.
        transcriptReader.drain()
      }
      emitDriverTeardownDispositions('driver.stop')
      transcriptReader?.reset()
      transcriptReader = undefined
      surface = undefined
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      // T-01725: dispose releases driver-owned resources only — the hook
      // listener and the in-memory pane controller. tmux server / session
      // lifecycle stays with the runtime control plane.
      await closeHookListener()
      // T-05092: drain a trailing API-error row on a dispose-without-stop path.
      // After stop() the reader is already nulled, so a stop→dispose sequence
      // does not double-emit; the byte-offset tailer dedupes either way.
      if (transcriptReader !== undefined && ctx !== undefined) {
        // The reader now emits through the driver's provenance-stamping seam,
        // so the drain reaches the broker without the caller re-emitting.
        transcriptReader.drain()
      }
      emitDriverTeardownDispositions('driver.dispose')
      transcriptReader?.reset()
      transcriptReader = undefined
      attribution = undefined
      ctx = undefined
      surface = undefined
      paneController = undefined
      structuredTurns.clear()
      completedStructuredTurns.clear()
      apiErrorTurns.clear()
      startedAssistantMessages.clear()
    },
  }

  function promptForStructuredOutput(input: InvocationInput, text: string, turnId: string): string {
    if (input.responseFormat?.kind !== 'json_schema') {
      return text
    }
    const schema = input.responseFormat.schema
    const validator = structuredOutputAjv.compile(schema)
    structuredTurns.set(turnId, {
      turnId,
      schema,
      attempts: 0,
      validator,
    })
    completedStructuredTurns.delete(turnId)
    return `${text}\n\nreturn ONLY JSON matching this schema, no prose/markdown.\nSchema:\n${JSON.stringify(schema)}`
  }

  type StructuredHookDecision =
    | { action: 'continue'; envelope: ClaudeCodeHookEnvelope }
    | { action: 'drop'; decision?: HookEnvelopeDecision | undefined }

  function handleStructuredOutputHook(envelope: ClaudeCodeHookEnvelope): StructuredHookDecision {
    const hook = asHookRecord(envelope.hookData)
    const rawType =
      typeof hook['hook_event_name'] === 'string' ? hook['hook_event_name'] : undefined
    const mailDecision = rawType === 'Stop' ? envelope.mailStopDecision : undefined
    const turnId = envelope.turnId
    if (
      turnId !== undefined &&
      completedStructuredTurns.has(turnId) &&
      rawType === 'MessageDisplay'
    ) {
      return { action: 'drop' }
    }
    if (turnId === undefined) {
      return mailDecision === undefined
        ? { action: 'continue', envelope }
        : { action: 'drop', decision: mailDecision }
    }
    const state = structuredTurns.get(turnId)
    if (state === undefined) {
      return mailDecision === undefined
        ? { action: 'continue', envelope }
        : { action: 'drop', decision: mailDecision }
    }

    if (rawType === 'MessageDisplay') {
      // T-05145 invariant: for claude-code-tmux a structured turn may NOT pass
      // final capture unless its turn-local validator positively cleared the
      // candidate. MessageDisplay is racy with Stop and is never authoritative
      // for structured final capture; Stop's last_assistant_message is the gate.
      return { action: 'drop' }
    }
    if (rawType !== 'Stop') {
      if (rawType === 'SessionEnd') {
        failStructuredTurn(state, 'Structured output ended before Stop validation cleared')
        return { action: 'drop' }
      }
      return { action: 'continue', envelope }
    }

    const candidate =
      typeof hook['last_assistant_message'] === 'string' ? hook['last_assistant_message'] : ''
    const validation = validateStructuredCandidate(state, candidate)
    if (validation.valid) {
      if (mailDecision !== undefined) {
        return { action: 'drop', decision: mailDecision }
      }
      structuredTurns.delete(turnId)
      completedStructuredTurns.add(turnId)
      return {
        action: 'continue',
        envelope: {
          ...envelope,
          hookData: {
            ...hook,
            last_assistant_message: validation.normalized,
          },
        },
      }
    }

    state.attempts += 1
    const reason = formatValidationErrors(validation.errors)
    emitStructuredValidationNotice(state, reason, validation.errors)
    if (state.attempts < STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
      return {
        action: 'drop',
        decision: {
          decision: 'block',
          reason:
            mailDecision === undefined
              ? reason
              : `${reason}\n\nMailbox drain is also required:\n${mailDecision.reason}`,
        },
      }
    }

    emitStructuredDiagnostic(state, candidate)
    failStructuredTurn(state, reason, validation.errors)
    return { action: 'drop' }
  }

  function validateStructuredCandidate(
    state: StructuredTurnState,
    candidate: string
  ):
    | { valid: true; normalized: string }
    | { valid: false; errors: ErrorObject[]; parsed?: unknown | undefined } {
    const parsed = parseStructuredJsonCandidate(candidate)
    if (!parsed.valid) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '',
            schemaPath: '',
            keyword: 'parse',
            params: {},
            message: parsed.message,
          } as ErrorObject,
        ],
      }
    }
    if (state.validator(parsed.value)) {
      return { valid: true, normalized: JSON.stringify(parsed.value) }
    }
    return { valid: false, errors: [...(state.validator.errors ?? [])], parsed: parsed.value }
  }

  function parseStructuredJsonCandidate(
    candidate: string
  ): { valid: true; value: unknown } | { valid: false; message: string } {
    const trimmed = candidate.trim()
    const bare = tryParseJson(trimmed)
    if (bare.valid) {
      return bare
    }
    const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
    if (fenced?.[1] !== undefined) {
      const fencedJson = tryParseJson(fenced[1].trim())
      if (fencedJson.valid) {
        return fencedJson
      }
      return { valid: false, message: 'must be valid JSON matching schema' }
    }
    const prefixed = tryParsePrefixedJsonRoot(trimmed)
    if (prefixed.valid) {
      return prefixed
    }
    return { valid: false, message: 'must be valid JSON matching schema' }
  }

  function tryParseJson(raw: string): { valid: true; value: unknown } | { valid: false } {
    try {
      return { valid: true, value: JSON.parse(raw) as unknown }
    } catch {
      return { valid: false }
    }
  }

  function tryParsePrefixedJsonRoot(
    raw: string
  ): { valid: true; value: unknown } | { valid: false } {
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index]
      if (char !== '{' && char !== '[') {
        continue
      }
      const endIndex = findJsonRootEnd(raw, index)
      if (endIndex === undefined) {
        continue
      }
      const json = raw.slice(index, endIndex)
      const parsed = tryParseJson(json)
      if (!parsed.valid) {
        continue
      }
      if (raw.slice(endIndex).trim().length > 0) {
        return { valid: false }
      }
      return parsed
    }
    return { valid: false }
  }

  function findJsonRootEnd(raw: string, startIndex: number): number | undefined {
    const stack: string[] = []
    let inString = false
    let escaped = false

    for (let index = startIndex; index < raw.length; index += 1) {
      const char = raw[index]
      if (char === undefined) {
        return undefined
      }
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{') {
        stack.push('}')
        continue
      }
      if (char === '[') {
        stack.push(']')
        continue
      }
      if (char === '}' || char === ']') {
        if (stack.pop() !== char) {
          return undefined
        }
        if (stack.length === 0) {
          return index + 1
        }
      }
    }
    return undefined
  }

  function formatValidationErrors(errors: ErrorObject[]): string {
    if (errors.length === 0) {
      return 'must match schema'
    }
    return errors
      .slice(0, 3)
      .map((error) => {
        const path = error.instancePath.length > 0 ? error.instancePath : '/'
        return `${path} ${error.message ?? error.keyword}`.trim()
      })
      .join('; ')
  }

  function emitStructuredValidationNotice(
    state: StructuredTurnState,
    reason: string,
    errors: ErrorObject[]
  ): void {
    ctx?.emit(
      'driver.notice',
      {
        message: reason,
        code: 'structured_output_validation_retry',
        data: { validation: formatValidationData(errors), attempts: state.attempts },
      },
      {
        turnId: state.turnId as ApplyInputResult['turnId'],
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
      }
    )
  }

  function emitStructuredDiagnostic(state: StructuredTurnState, candidate: string): void {
    const code = apiErrorTurns.has(state.turnId)
      ? 'provider_error_truncated_output'
      : 'StructuredOutputValidationFailed'
    ctx?.emit(
      'diagnostic',
      {
        level: 'warn',
        source: 'harness',
        message: 'Structured output validation failed after retry cap',
        data: {
          code,
          rawCandidate: candidate,
        },
      },
      {
        turnId: state.turnId as ApplyInputResult['turnId'],
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
      }
    )
  }

  function failStructuredTurn(
    state: StructuredTurnState,
    reason: string,
    errors: ErrorObject[] = []
  ): void {
    const providerError = apiErrorTurns.has(state.turnId)
    const code = providerError
      ? 'provider_error_truncated_output'
      : 'StructuredOutputValidationFailed'
    structuredTurns.delete(state.turnId)
    completedStructuredTurns.add(state.turnId)
    apiErrorTurns.delete(state.turnId)
    ctx?.emit(
      'turn.failed',
      {
        turnId: state.turnId as TurnId,
        status: 'failed',
        message: reason,
        code,
        retryable: false,
        data: {
          validation: formatValidationData(errors),
          attempts: state.attempts,
        },
      },
      {
        turnId: state.turnId as ApplyInputResult['turnId'],
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
      }
    )
    attribution?.observeTurnTerminal(state.turnId as TurnId)
  }

  function formatValidationData(errors: ErrorObject[]): Array<Record<string, unknown>> {
    return errors.map((error) => ({
      path: error.instancePath.length > 0 ? error.instancePath : '/',
      keyword: error.keyword,
      message: error.message ?? error.keyword,
      params: error.params,
    }))
  }

  async function closeHookListener(): Promise<void> {
    transcriptWatcher?.close()
    transcriptWatcher = undefined
    await hookDrain.catch(() => undefined)
    if (hookListener !== undefined) {
      const handle = hookListener
      hookListener = undefined
      await handle.close()
    }
  }
}

/** Claude Code hook events the broker overlay subscribes to. */
const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'MessageDisplay',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SubagentStop',
  'SessionEnd',
] as const

const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker claude-hook'

/**
 * Build the Claude Code `--settings` overlay (H1). Env vars alone do NOT make
 * Claude invoke hooks; the runtime needs an actual `hooks` settings block whose
 * commands POST each hook payload to the broker callback socket. The bridge
 * command reads the hook JSON on stdin and the `HARNESS_BROKER_*` env to build
 * the envelope, then writes it to the callback socket (broker-owned, H3).
 */
export function buildClaudeHookSettingsOverlay(options: {
  callbackSocket: string
  bridgeCommand?: string | undefined
}): { hooks: Record<string, unknown> } {
  const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND
  const command = `${bridge} --socket ${shellQuote(options.callbackSocket)}`
  const legacyCommandMarker = `${bridge} --socket ${options.callbackSocket}`
  const decisionCommand = `${toDecisionBridgeCommand(bridge)} --socket ${shellQuote(
    options.callbackSocket
  )} --legacy-command ${shellQuote(legacyCommandMarker)}`
  const matchAll = ['PreToolUse', 'PostToolUse']
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENT_NAMES) {
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command: event === 'Stop' ? decisionCommand : command }],
    }
    if (matchAll.includes(event)) {
      entry['matcher'] = '*'
    }
    hooks[event] = [entry]
  }
  return { hooks }
}

function toDecisionBridgeCommand(bridgeCommand: string): string {
  return bridgeCommand.replace(/\bclaude-hook\b/, 'claude-hook-decision')
}

function classifyTranscriptUserEntry(
  entry: Record<string, unknown>
): { kind: 'prompt'; content: string } | { kind: 'interrupted' } | undefined {
  const message = asHookRecord(entry['message'])
  const content = message['content']
  if (typeof content === 'string') {
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

async function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  ctx: DriverContext,
  hookEnv: {
    invocationId: string
    runtimeId?: string | undefined
    callbackSocket: string
    bridgeCommand?: string | undefined
  }
): Promise<string> {
  const env = {
    ...spec.process.lockedEnv,
    ...(ctx.dispatchEnv ?? {}),
    HARNESS_BROKER_INVOCATION_ID: hookEnv.invocationId,
    HARNESS_BROKER_CALLBACK_SOCKET: hookEnv.callbackSocket,
    HARNESS_BROKER_HOOK_EVENTS: HOOK_EVENT_NAMES.join(','),
    HARNESS_BROKER_HOOK_GENERATION: String(CLAUDE_HOOK_GENERATION),
    ...(hookEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: hookEnv.runtimeId } : {}),
  }
  const launchArgs = await buildArgsWithMergedSettings(spec.process.args, hookEnv)
  const launch = await writeTmuxLaunchExecFiles(`${hookEnv.callbackSocket}.claude`, {
    argv: [spec.process.command, ...launchArgs],
    cwd: spec.process.cwd,
    env,
    pathPrepend: spec.process.pathPrepend,
    ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
  })
  return launch.commandLine
}

async function buildArgsWithMergedSettings(
  args: string[],
  hookEnv: { callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string[]> {
  const separatorIndex = args.indexOf('--')
  const preSeparatorArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const postSeparatorArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex)
  const durableSettingsPaths: string[] = []
  const cleanedPreSeparatorArgs: string[] = []

  for (let i = 0; i < preSeparatorArgs.length; i += 1) {
    const arg = preSeparatorArgs[i]
    if (arg === undefined) continue
    if (arg === '--settings') {
      const settingsPath = preSeparatorArgs[i + 1]
      if (settingsPath !== undefined) {
        durableSettingsPaths.push(settingsPath)
        i += 1
      }
      continue
    }
    cleanedPreSeparatorArgs.push(arg)
  }

  const mergedSettingsPath = await writeMergedSettingsFile(durableSettingsPaths, hookEnv)
  return [...cleanedPreSeparatorArgs, '--settings', mergedSettingsPath, ...postSeparatorArgs]
}

async function writeMergedSettingsFile(
  durableSettingsPaths: string[],
  hookEnv: { callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string> {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const mergedSettings: Record<string, unknown> = {}
  for (const settingsPath of durableSettingsPaths) {
    const raw = await readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    Object.assign(mergedSettings, parsed)
  }
  Object.assign(
    mergedSettings,
    buildClaudeHookSettingsOverlay({
      callbackSocket: hookEnv.callbackSocket,
      bridgeCommand: hookEnv.bridgeCommand,
    })
  )

  const settingsPath = `${hookEnv.callbackSocket}.settings.json`
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8')
  return settingsPath
}

/**
 * Default-configured driver for registry registration. Uses the real tmux
 * binary and a real Unix-domain hook callback socket. The socket is bound
 * lazily inside `start()` (construction is side-effect-free), so registering
 * this driver performs no I/O. T-01725: no default tmux socket — the live
 * pane lease (`runtime.terminalSurface`) supplies it on start.
 */
export function createDefaultClaudeCodeTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker')
): Driver {
  return createClaudeCodeTmuxDriver({
    tmux: {},
    hooks: {
      listen: (handler, context) =>
        listenForHookEnvelopes<ClaudeCodeHookEnvelope>(
          buildClaudeHookSocketPath(socketDir, context),
          handler
        ),
    },
  })
}

export function buildClaudeHookSocketPath(socketDir: string, context: HookListenerContext): string {
  return buildHookSocketPath(socketDir, 'claude-hooks', context)
}
