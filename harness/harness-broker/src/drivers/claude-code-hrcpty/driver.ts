import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
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
import type { CaptureGate } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import { type HrcptyConnect, HrcptyPtyController } from '../../runtime/hrcpty'
import { TmuxPaneNotQuiescentError } from '../../runtime/tmux'
import { type TmuxHelperLauncher, tmuxHelperCommand } from '../../runtime/tmux-launch-exec'
import {
  type CapturedEmit,
  createClaudeAttributionEventSink,
} from '../claude-code-tmux/attribution-events'
import {
  type HookEnvelopeHandler,
  type HookListenerContext,
  buildClaudeHookSocketPath,
} from '../claude-code-tmux/driver'
import {
  CLAUDE_CODE_TMUX_DRIVER_KIND,
  type ClaudeCodeHookEnvelope,
  createClaudeCodeHookEventNormalizer,
} from '../claude-code-tmux/hook-events'
import {
  CLAUDE_STOP_TRANSCRIPT_WAIT_MS,
  createClaudeHookRecordHandler,
} from '../claude-code-tmux/hook-record-handler'
import {
  type ClaudeHookTranscriptReader,
  createClaudeHookTranscriptReader,
} from '../claude-code-tmux/hook-transcript'
import { createClaudeRecordProvenance } from '../claude-code-tmux/record-provenance'
import { createClaudeStructuredOutputGate } from '../claude-code-tmux/structured-output'
import {
  type ClaudeTranscriptWakeup,
  type TranscriptWatch,
  createClaudeTranscriptWakeup,
} from '../claude-code-tmux/transcript-wakeup'
import {
  type ClaudeTurnAttribution,
  createClaudeTurnAttribution,
} from '../claude-code-tmux/turn-attribution'
import type {
  ApplyInputResult,
  DeliveryEvidence,
  Driver,
  DriverContext,
  DriverStartResult,
} from '../driver'
import { hasChildHarnessProcess, withDeliveryEvidence } from '../driver'
import { CLAUDE_CODE_HRCPTY_AUTHORITY } from '../evidence-authority'
import {
  type HookEnvelopeResult,
  type HookListenerHandle,
  extractText,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
  selectClaudeCodePaneInput,
} from '../tmux-shared'
import { buildClaudeHrcptySpawnRequest } from './launch'

export const CLAUDE_CODE_HRCPTY_DRIVER_KIND = 'claude-code-hrcpty'
const CLAUDE_CODE_HRCPTY_DRIVER_VERSION = '0.1.0'

/** How long the first delivery waits for Claude to draw an empty input box. */
const DEFAULT_INPUT_READY_TIMEOUT_MS = 30_000
/**
 * How long after an interrupt Claude may still put the interrupted prompt back
 * in the box. Measured from the interrupt, not from the next delivery. The
 * spike saw a cold first turn take over 5 s (T-12047 E3).
 */
const DEFAULT_INTERRUPT_RESTORE_WAIT_MS = 8_000

/** Same classification as the tmux driver: only a pre-write refusal proves nothing was written. */
function claudeWriteEvidence(error: unknown): DeliveryEvidence {
  return error instanceof TmuxPaneNotQuiescentError && error.phase === 'before_paste'
    ? 'not_written'
    : 'possibly_written'
}

/**
 * The tmux driver's declaration with the host swapped: the same Claude TUI,
 * hooks and transcript. `control.attach` is `hrc-pty attach` on the socket.
 */
const CLAUDE_CODE_HRCPTY_CAPABILITIES: InvocationCapabilities = {
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
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    driverAttachExistingSurface: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export interface ClaudeCodeHrcptyDriverOptions {
  hrcpty?:
    | {
        /** Test seam for the ops socket; production dials `socketPath`. */
        connect?: HrcptyConnect | undefined
        /**
         * The attach token for `hello`. The durable broker passes the one its
         * `--attach-token-file` names; absent, hrc-pty's own default file
         * beside the socket is read.
         */
        token?: (() => Promise<string>) | undefined
      }
    | undefined
  /** Same-payload launcher for the release-owned hook bridge. */
  helperLauncher?: TmuxHelperLauncher | undefined
  hooks: {
    listen: (
      handler: HookEnvelopeHandler,
      context: HookListenerContext
    ) => Promise<HookListenerHandle>
    bridgeCommand?: string | undefined
  }
  now?: (() => Date) | undefined
  watchTranscript?: TranscriptWatch | undefined
  stopTranscriptWaitMs?: number | undefined
  inputReadyTimeoutMs?: number | undefined
  interruptRestoreWaitMs?: number | undefined
}

/**
 * Relabel the shared Claude modules' events and raw records with this
 * driver's kind. They stamp `claude-code-tmux`, which is the tmux driver's
 * name, not a fact about the Claude evidence; everything else passes through.
 */
function withHrcptyDriverKind(ctx: DriverContext): DriverContext {
  const relabel = <
    E extends { driver?: { kind: string; rawType?: string | undefined } | undefined },
  >(
    extra: E | undefined
  ): E | undefined =>
    extra?.driver?.kind === CLAUDE_CODE_TMUX_DRIVER_KIND
      ? { ...extra, driver: { ...extra.driver, kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND } }
      : extra
  const capture: CaptureGate | undefined =
    ctx.capture === undefined
      ? undefined
      : {
          ...ctx.capture,
          ingest: (input, normalize) =>
            ctx.capture?.ingest(
              input.driverKind === CLAUDE_CODE_TMUX_DRIVER_KIND
                ? { ...input, driverKind: CLAUDE_CODE_HRCPTY_DRIVER_KIND }
                : input,
              normalize
            ),
        }
  return {
    ...ctx,
    ...(capture !== undefined ? { capture } : {}),
    emit: (type, payload, extra) => ctx.emit(type, payload, relabel(extra)),
    emitEvent: (event, extra) => ctx.emitEvent(event, relabel(extra)),
  }
}

/**
 * Claude Code on an hrc-pty supervisor (T-12046 §5 step 4). Hook and
 * transcript handling are the `claude-code-tmux` modules, imported; the
 * terminal is an hrc-pty ops socket instead of a tmux pane. The driver spawns
 * Claude into the supervisor's pty, delivers turns as bracketed input plus
 * `\r`, confirms them by reading the input row back through `capture`, and
 * reports the socket as its terminal surface. hrc-pty, not the driver, owns
 * the pty, Claude and their lifetimes.
 */
export function createClaudeCodeHrcptyDriver(options: ClaudeCodeHrcptyDriverOptions): Driver {
  const now = options.now ?? (() => new Date())
  const inputReadyTimeoutMs = options.inputReadyTimeoutMs ?? DEFAULT_INPUT_READY_TIMEOUT_MS
  const interruptRestoreWaitMs = options.interruptRestoreWaitMs ?? DEFAULT_INTERRUPT_RESTORE_WAIT_MS

  let ctx: DriverContext | undefined
  let socketPath: string | undefined
  let controller: HrcptyPtyController | undefined
  let hookListener: HookListenerHandle | undefined
  let transcriptReader: ClaudeHookTranscriptReader | undefined
  let attribution: ClaudeTurnAttribution | undefined
  let hookDrain: Promise<HookEnvelopeResult> = Promise.resolve(undefined)
  let turnCounter = 0
  /** Claude has drawn an empty input box at least once since spawn. */
  let inputReady = false
  /** Set by our own interrupt: until then Claude may refill the box. */
  let restoreDeadline: number | undefined
  const provenance = createClaudeRecordProvenance()
  const apiErrorTurns = new Set<string>()
  const apiErrorLatestTurns = new Set<string>()
  const startedAssistantMessages = new Set<string>()
  const structuredOutput = createClaudeStructuredOutputGate({
    getContext: () => ctx,
    apiErrorTurns,
    onTurnFailed: (turnId) => attribution?.observeTurnTerminal(turnId),
  })

  function allocateTurnId(): string {
    turnCounter += 1
    return `turn_${requireCtx().invocationId}_${turnCounter}`
  }

  function requireCtx(): DriverContext {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function requireController(): HrcptyPtyController {
    if (controller === undefined || socketPath === undefined) {
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        'hrcpty surface not established'
      )
    }
    return controller
  }

  /**
   * Before any body is written: the first turn waits for Claude's empty input
   * box (a steer's own quiescence check already requires one), and a delivery
   * after our own interrupt clears the prompt Claude put back. Both refuse as
   * `before_paste`, so nothing of the body was written.
   */
  async function prepareInputBox(
    pty: HrcptyPtyController,
    awaitReady: 'await-ready' | 'steer'
  ): Promise<void> {
    if (!inputReady && awaitReady === 'await-ready') {
      if (!(await pty.waitForInputReady(selectClaudeCodePaneInput, inputReadyTimeoutMs))) {
        throw new TmuxPaneNotQuiescentError('before_paste')
      }
      inputReady = true
    }
    if (restoreDeadline !== undefined) {
      const deadline = restoreDeadline
      restoreDeadline = undefined
      await pty.clearRestoredInput(selectClaudeCodePaneInput, { restoreDeadline: deadline })
    }
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
          driver: { kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND, rawType },
        }
      )
    }
  }

  const transcriptWakeup: ClaudeTranscriptWakeup = createClaudeTranscriptWakeup({
    watch: options.watchTranscript,
    onChange: () => {
      const drain = (): HookEnvelopeResult => {
        transcriptReader?.drain()
        return undefined
      }
      hookDrain = hookDrain.then(drain, drain)
    },
    onLost: (path, detail) => {
      ctx?.emit(
        'capture.warning',
        {
          kind: 'native_wakeup_lost',
          message: `Claude transcript native wakeup lost: ${detail}`,
          raw: { transcriptPath: path, detail },
        },
        { driver: { kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND, rawType: 'transcript.watch' } }
      )
      ctx?.admissionStateChanged?.()
    },
  })

  return {
    kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND,
    version: CLAUDE_CODE_HRCPTY_DRIVER_VERSION,
    bracketMintingMode: 'harness-evidence',
    cancelPendingOwnTurnOnForeignTurn: true,
    evidenceAuthority: CLAUDE_CODE_HRCPTY_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: 'quiescence',
    steerLandingEvidence: 'transcript',
    interruptLandingEvidence: 'transcript',

    capabilities(): InvocationCapabilities {
      return CLAUDE_CODE_HRCPTY_CAPABILITIES
    },

    admissionRejectionReason(admissionClass) {
      return admissionClass === 'preempt' ? transcriptWakeup.lostReason : undefined
    },

    runtimeHealth() {
      const lostReason = transcriptWakeup.lostReason
      return lostReason === undefined
        ? ({ state: 'healthy' } as const)
        : ({ state: 'degraded', reason: lostReason } as const)
    },

    async start(spec: HarnessInvocationSpec, brokerCtx: DriverContext): Promise<DriverStartResult> {
      if (!hasChildHarnessProcess(spec)) {
        throw new BrokerError(
          BrokerErrorCode.DispatchValidationFailed,
          'claude-code-hrcpty requires a child harness process'
        )
      }
      const lease = brokerCtx.runtime?.terminalSurface
      if (lease?.kind !== 'hrcpty' || lease.ownership !== 'hrc') {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `claude-code-hrcpty requires an hrc-owned hrcpty lease: runtime.terminalSurface.kind === 'hrcpty' and ownership === 'hrc' (got kind ${String(
            (lease as { kind?: unknown } | undefined)?.kind
          )}, ownership ${String((lease as { ownership?: unknown } | undefined)?.ownership)})`
        )
      }
      transcriptWakeup.reset()
      inputReady = false
      restoreDeadline = undefined

      const pty = new HrcptyPtyController({
        socketPath: lease.socketPath,
        allowedOps: lease.allowedOps,
        ...(options.hrcpty?.token !== undefined ? { token: options.hrcpty.token } : {}),
        ...(options.hrcpty?.connect !== undefined ? { connect: options.hrcpty.connect } : {}),
      })
      let hello: Awaited<ReturnType<HrcptyPtyController['hello']>>
      try {
        hello = await pty.hello()
      } catch (error) {
        pty.close()
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `leased hrcpty supervisor unreachable at ${lease.socketPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      const driverCtx = withHrcptyDriverKind(brokerCtx)
      ctx = driverCtx
      controller = pty
      socketPath = lease.socketPath

      const normalizer = createClaudeCodeHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
        allocateTurnId,
        hasApiErrorForTurn: (turnId) => apiErrorTurns.has(turnId),
        isApiErrorLatestForTurn: (turnId) =>
          apiErrorTurns.has(turnId) && apiErrorLatestTurns.has(turnId),
        clearApiErrorForTurn: (turnId) => {
          apiErrorTurns.delete(turnId)
          apiErrorLatestTurns.delete(turnId)
        },
        onFallbackTerminalMessage: (text) => transcriptReader?.coverTerminalMessage(text),
      })
      const turnAttribution = createClaudeTurnAttribution({
        invocationId: driverCtx.invocationId,
        allocateTurnId,
      })
      attribution = turnAttribution

      const emit: CapturedEmit = (type, payload, extra) => {
        provenance.emit(driverCtx, type, payload, extra)
      }
      const attributionEvents = createClaudeAttributionEventSink({
        emit,
        normalizer,
        attribution: turnAttribution,
        admissionStateChanged: () => driverCtx.admissionStateChanged?.(),
      })

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      hookDrain = Promise.resolve(undefined)
      const reader = createClaudeHookTranscriptReader({
        invocationId: driverCtx.invocationId,
        now,
        getCurrentTurnId: () => turnAttribution.activeTurnId,
        resumeFromTranscriptEnd: spec.continuation !== undefined,
        ...(driverCtx.capture !== undefined ? { capture: driverCtx.capture } : {}),
        withProvenance: provenance.withProvenance,
        onTranscriptPath: (selectedPath) => transcriptWakeup.select(selectedPath),
        onTranscriptAvailable: (availablePath) => transcriptWakeup.available(availablePath),
        emit,
        onApiError: (turnId) => {
          apiErrorTurns.add(turnId)
          apiErrorLatestTurns.add(turnId)
        },
        onTurnEvidence: (turnId) => apiErrorLatestTurns.delete(turnId),
        onAssistantMessageStarted: (messageId) => {
          const turnId = turnAttribution.activeTurnId
          if (turnId === undefined || startedAssistantMessages.has(messageId)) return
          startedAssistantMessages.add(messageId)
          emit(
            'assistant.message.started',
            { messageId: messageId as MessageId },
            {
              turnId,
              itemId: messageId,
              driver: { kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND, rawType: 'transcript.assistant' },
            }
          )
        },
        onTranscriptEntry: attributionEvents.observeTranscriptEntry,
      })
      transcriptReader = reader
      const handleHookEnvelope = createClaudeHookRecordHandler({
        driverCtx,
        expectedRuntimeId,
        getListenerSocketPath: () => hookListener?.socketPath,
        provenance,
        emit,
        reader,
        normalizer,
        attribution: turnAttribution,
        attributionEvents,
        structuredOutput,
        stopTranscriptWaitMs: options.stopTranscriptWaitMs ?? CLAUDE_STOP_TRANSCRIPT_WAIT_MS,
      })

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

      driverCtx.emit(
        'terminal.surface.reported',
        { kind: 'hrcpty-socket' as const, socketPath: lease.socketPath },
        { driver: { kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND, rawType: 'hrcpty.surface' } }
      )

      const request = await buildClaudeHrcptySpawnRequest(
        spec,
        driverCtx,
        {
          invocationId: driverCtx.invocationId,
          ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
          callbackSocket: hookListener.socketPath,
          bridgeCommand: options.hooks.bridgeCommand,
          helperLauncher: options.helperLauncher,
        },
        hello.size
      )
      await pty.spawn(request)

      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      requireCtx()
      const pty = requireController()
      const text = extractText(input)
      try {
        await prepareInputBox(pty, 'await-ready')
      } catch (error) {
        throw withDeliveryEvidence(error, claudeWriteEvidence(error))
      }
      // As on tmux, this id correlates the submission without opening a turn
      // bracket; the transcript disposition mirror decides that.
      const turnId = allocateTurnId()
      const prompt = structuredOutput.promptFor(input, text, turnId)
      attribution?.trackBrokerSubmission({
        ...(input.inputId !== undefined
          ? { submissionId: input.inputId, inputId: input.inputId }
          : {}),
        content: prompt,
        allocatedTurnId: turnId as TurnId,
      })
      try {
        await pty.sendPastedLine(prompt, { selectInput: selectClaudeCodePaneInput })
      } catch (error) {
        const evidence = claudeWriteEvidence(error)
        if (evidence === 'not_written' && input.inputId !== undefined) {
          attribution?.cancelBrokerSubmission(input.inputId)
        }
        throw withDeliveryEvidence(error, evidence)
      }
      return { turnId: turnId as ApplyInputResult['turnId'] }
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      requireCtx()
      const pty = requireController()
      const text = extractText(input)
      attribution?.trackBrokerSubmission({
        ...(input.inputId !== undefined
          ? { submissionId: input.inputId, inputId: input.inputId }
          : {}),
        content: text,
      })
      try {
        await prepareInputBox(pty, 'steer')
        await pty.sendSteer(text, { selectInput: selectClaudeCodePaneInput })
        inputReady = true
      } catch (error) {
        const evidence = claudeWriteEvidence(error)
        if (evidence === 'not_written' && input.inputId !== undefined) {
          attribution?.cancelBrokerSubmission(input.inputId)
        }
        throw withDeliveryEvidence(error, evidence)
      }
    },

    probeAdmissionState() {
      return { harnessLocalQueueDepth: attribution?.harnessLocalQueueDepth ?? 0 }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (transcriptWakeup.lostReason !== undefined) {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: transcriptWakeup.lostReason,
        }
      }
      if (socketPath === undefined || controller === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      const expectationId = attribution?.expectInterrupt()
      try {
        await controller.interrupt()
      } catch (error) {
        if (expectationId !== undefined) attribution?.cancelExpectedInterrupt(expectationId)
        throw error
      }
      restoreDeadline = Date.now() + interruptRestoreWaitMs
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      // hrc-pty owns the pty and Claude; ending them is the lease's business
      // (§4.6), so stop only releases what the driver holds.
      await releaseCapture('driver.stop')
      socketPath = undefined
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await releaseCapture('driver.dispose')
      controller?.close()
      attribution = undefined
      ctx = undefined
      socketPath = undefined
      controller = undefined
      structuredOutput.clear()
      apiErrorTurns.clear()
      apiErrorLatestTurns.clear()
      startedAssistantMessages.clear()
    },
  }

  /** The tmux driver's teardown: close hooks, drain the transcript once more, settle dispositions. */
  async function releaseCapture(rawType: 'driver.stop' | 'driver.dispose'): Promise<void> {
    await closeHookListener()
    if (transcriptReader !== undefined && ctx !== undefined) {
      transcriptReader.drain()
    }
    emitDriverTeardownDispositions(rawType)
    transcriptReader?.reset()
    transcriptReader = undefined
  }

  async function closeHookListener(): Promise<void> {
    transcriptWakeup.close()
    await hookDrain.catch(() => undefined)
    if (hookListener !== undefined) {
      const handle = hookListener
      hookListener = undefined
      await handle.close()
    }
  }
}

/**
 * Default-configured driver for registry registration: a real Unix-domain
 * hook socket under `socketDir`, bound lazily in `start()`, and the real ops
 * socket the lease names.
 */
export function createDefaultClaudeCodeHrcptyDriver(
  socketDir: string = join(tmpdir(), 'harness-broker'),
  helperLauncher?: TmuxHelperLauncher | undefined,
  attachToken?: string | undefined
): Driver {
  return createClaudeCodeHrcptyDriver({
    ...(attachToken !== undefined ? { hrcpty: { token: async () => attachToken } } : {}),
    ...(helperLauncher !== undefined ? { helperLauncher } : {}),
    hooks: {
      listen: (handler, context) =>
        listenForHookEnvelopes<ClaudeCodeHookEnvelope>(
          buildClaudeHookSocketPath(socketDir, context),
          handler
        ),
      ...(helperLauncher !== undefined
        ? { bridgeCommand: tmuxHelperCommand(helperLauncher, 'claude-hook') }
        : {}),
    },
  })
}
