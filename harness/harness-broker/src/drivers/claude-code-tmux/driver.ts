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
import { BrokerError } from '../../errors'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import { TmuxPaneNotQuiescentError } from '../../runtime/tmux'
import { type TmuxHelperLauncher, tmuxHelperCommand } from '../../runtime/tmux-launch-exec'
import type {
  ApplyInputResult,
  DeliveryEvidence,
  Driver,
  DriverContext,
  DriverStartResult,
} from '../driver'
import { hasChildHarnessProcess, withDeliveryEvidence } from '../driver'
import { CLAUDE_CODE_TMUX_AUTHORITY } from '../evidence-authority'
import {
  type HookEnvelopeResult,
  type HookListenerHandle,
  buildHookSocketPath,
  consumePaneLease,
  extractText,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
  selectClaudeCodePaneInput,
} from '../tmux-shared'
import { type CapturedEmit, createClaudeAttributionEventSink } from './attribution-events'
import {
  CLAUDE_CODE_TMUX_DRIVER_KIND,
  type ClaudeCodeHookEnvelope,
  createClaudeCodeHookEventNormalizer,
} from './hook-events'
import { createClaudeHookRecordHandler } from './hook-record-handler'
import {
  type ClaudeHookTranscriptReader,
  createClaudeHookTranscriptReader,
} from './hook-transcript'
import { buildClaudeLaunchCommandLine } from './launch'
import { createClaudeRecordProvenance } from './record-provenance'
import { createClaudeStructuredOutputGate } from './structured-output'
import {
  type ClaudeTranscriptWakeup,
  type TranscriptWatch,
  createClaudeTranscriptWakeup,
} from './transcript-wakeup'
import { type ClaudeTurnAttribution, createClaudeTurnAttribution } from './turn-attribution'

const CLAUDE_CODE_TMUX_DRIVER_VERSION = '0.1.0'

/**
 * Classify what a failed `sendSteer` proves about the body.
 *
 * `sendSteer` refuses before pasting when the lease forbids capture or the
 * input region never goes quiet; both raise `before_paste`, and nothing has
 * crossed the PTY. Every other outcome — `after_submit`, or any untyped
 * failure — happens at or after the paste, so the body may already be in the
 * harness and the attempt is only ever `possibly_written`.
 */
function claudeSteerWriteEvidence(error: unknown): DeliveryEvidence {
  return error instanceof TmuxPaneNotQuiescentError && error.phase === 'before_paste'
    ? 'not_written'
    : 'possibly_written'
}

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
  /** Same-payload launcher for release-owned hook and tmux helpers. */
  helperLauncher?: TmuxHelperLauncher | undefined
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
  const provenance = createClaudeRecordProvenance()
  const apiErrorTurns = new Set<string>()
  const startedAssistantMessages = new Set<string>()
  const structuredOutput = createClaudeStructuredOutputGate({
    getContext: () => ctx,
    apiErrorTurns,
    onTurnFailed: (turnId) => attribution?.observeTurnTerminal(turnId),
  })

  // Single shared per-invocation turn-id allocator (cody's blessed scheme,
  // C-02755). BOTH applyInputNow (manager path) and the hook normalizer (which
  // mints for turn-id-less operator prompts) call THIS closure so manager- and
  // normalizer-minted ids never collide and stay monotonic in turn-open order.
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

  const transcriptWakeup: ClaudeTranscriptWakeup = createClaudeTranscriptWakeup({
    watch: options.watchTranscript,
    // Native transcript notifications and hooks share ONE chain. A
    // notification reads to EOF; a hook queued beside it then sees the
    // byte-offset tailer already advanced (or vice versa), so rows are ordered
    // once and never double-normalized.
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
        { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.watch' } }
      )
      ctx?.admissionStateChanged?.()
    },
  })

  return {
    kind: CLAUDE_CODE_TMUX_DRIVER_KIND,
    version: CLAUDE_CODE_TMUX_DRIVER_VERSION,
    bracketMintingMode: 'harness-evidence',
    cancelPendingOwnTurnOnForeignTurn: true,
    evidenceAuthority: CLAUDE_CODE_TMUX_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: 'quiescence',
    steerLandingEvidence: 'transcript',
    interruptLandingEvidence: 'transcript',

    capabilities(): InvocationCapabilities {
      return CLAUDE_CODE_TMUX_CAPABILITIES
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

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      if (!hasChildHarnessProcess(spec)) {
        throw new BrokerError(
          BrokerErrorCode.DispatchValidationFailed,
          'claude-code-tmux requires a child harness process'
        )
      }
      transcriptWakeup.reset()
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
        // SessionStart names the existing JSONL when this launch resumes a
        // Claude session. The new invocation owns only rows appended after
        // that start boundary; fresh launches retain byte-zero capture.
        resumeFromTranscriptEnd: spec.continuation !== undefined,
        ...(driverCtx.capture !== undefined ? { capture: driverCtx.capture } : {}),
        withProvenance: provenance.withProvenance,
        onTranscriptPath: (selectedPath) => transcriptWakeup.select(selectedPath),
        onTranscriptAvailable: (availablePath) => transcriptWakeup.available(availablePath),
        emit,
        onApiError: (turnId) => apiErrorTurns.add(turnId),
        onAssistantMessageStarted: (messageId) => {
          const turnId = turnAttribution.activeTurnId
          if (turnId === undefined || startedAssistantMessages.has(messageId)) return
          startedAssistantMessages.add(messageId)
          // MUST go through the provenance seam: the plain `driverCtx.emit` skips the
          // provenance stamp, and this event was reporting `sourceKind:'hook'`
          // for a fact read out of the session JSONL — the exact falsehood §7.2
          // exists to prevent (observed on a live seat, 25/25 events).
          emit(
            'assistant.message.started',
            { messageId: messageId as MessageId },
            {
              turnId,
              itemId: messageId,
              driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'transcript.assistant' },
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
      const launchCommand = await buildClaudeLaunchCommandLine(spec, driverCtx, {
        invocationId: driverCtx.invocationId,
        ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
        callbackSocket: hookListener.socketPath,
        bridgeCommand: options.hooks.bridgeCommand,
        helperLauncher: options.helperLauncher,
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
      const prompt = structuredOutput.promptFor(input, text, turnId)
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
      try {
        await requirePaneController().sendKeys(prompt)
      } catch (error) {
        // sendKeys pastes the body and only then sends Enter. Any failure from
        // here on may have left the body in the pane, so the correlation is
        // RETAINED and the attempt is reported as possibly written.
        throw withDeliveryEvidence(error, 'possibly_written')
      }
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
      try {
        await requirePaneController().sendSteer(text, {
          selectInput: selectClaudeCodePaneInput,
        })
      } catch (error) {
        // Only a refusal raised BEFORE the first paste proves nothing was
        // written; that one may release its correlation. A failure after the
        // paste began — including `after_submit` — may have left the body in
        // the TUI, so the pending identity is RETAINED for later native
        // evidence rather than cancelled (T-08204 rev 3 §5).
        const evidence = claudeSteerWriteEvidence(error)
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
      await releaseCapture('driver.stop')
      surface = undefined
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      // T-01725: dispose releases driver-owned resources only — the hook
      // listener and the in-memory pane controller. tmux server / session
      // lifecycle stays with the runtime control plane.
      await releaseCapture('driver.dispose')
      attribution = undefined
      ctx = undefined
      surface = undefined
      paneController = undefined
      structuredOutput.clear()
      apiErrorTurns.clear()
      startedAssistantMessages.clear()
    },
  }

  /**
   * Shared stop/dispose teardown: close the hook listener, then drain the
   * transcript one last time BEFORE reset/turn-id loss (T-05092), so a
   * trailing API-error row that no post-error hook would surface still reaches
   * the broker through the live ctx. The byte-offset tailer dedupes, and after
   * stop() the reader is already nulled, so stop→dispose never double-emits.
   */
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
 * Default-configured driver for registry registration. Uses the real tmux
 * binary and a real Unix-domain hook callback socket. The socket is bound
 * lazily inside `start()` (construction is side-effect-free), so registering
 * this driver performs no I/O. T-01725: no default tmux socket — the live
 * pane lease (`runtime.terminalSurface`) supplies it on start.
 */
export function createDefaultClaudeCodeTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker'),
  helperLauncher?: TmuxHelperLauncher | undefined
): Driver {
  return createClaudeCodeTmuxDriver({
    tmux: {},
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

export function buildClaudeHookSocketPath(socketDir: string, context: HookListenerContext): string {
  return buildHookSocketPath(socketDir, 'claude-hooks', context)
}
