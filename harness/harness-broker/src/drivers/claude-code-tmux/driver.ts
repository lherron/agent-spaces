import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
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
    usage: false,
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
  const structuredTurns = new Map<string, StructuredTurnState>()
  const completedStructuredTurns = new Set<string>()
  const apiErrorTurns = new Set<string>()

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

  return {
    kind: CLAUDE_CODE_TMUX_DRIVER_KIND,
    version: CLAUDE_CODE_TMUX_DRIVER_VERSION,
    bracketMintingMode: 'harness-evidence',

    capabilities(): InvocationCapabilities {
      return CLAUDE_CODE_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
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

      const emitAttributionActions = (
        actions: ClaudeAttributionAction[],
        rawType: string
      ): void => {
        for (const action of actions) {
          const inputExtra =
            'inputId' in action && action.inputId !== undefined ? { inputId: action.inputId } : {}
          if (action.kind === 'executed') {
            normalizer.activateTurn(action.turnId)
            driverCtx.emit(
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
            driverCtx.emit(
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
            driverCtx.emit(
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
            driverCtx.emit(
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
            driverCtx.emit(
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
            driverCtx.emit(
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
            driverCtx.emit(
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
              driverCtx.emit(event.type, event.payload, {
                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                ...(event.driver !== undefined ? { driver: event.driver } : {}),
              })
            }
            continue
          }
          driverCtx.emit(
            'capture.warning',
            { message: action.message, raw: action.raw },
            { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType } }
          )
        }
      }

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      hookDrain = Promise.resolve(undefined)
      const reader = createClaudeHookTranscriptReader({
        invocationId: driverCtx.invocationId,
        now,
        getCurrentTurnId: () => turnAttribution.activeTurnId,
        onApiError: (turnId) => apiErrorTurns.add(turnId),
        onTranscriptEntry: (entry) => {
          const entryType = getString(entry, 'type')
          if (entryType === 'queue-operation') {
            emitAttributionActions(
              turnAttribution.observeQueueOperation(entry as ClaudeTranscriptQueueOperation),
              'queue-operation'
            )
            return
          }
          if (entryType === 'attachment') {
            const attachment = asHookRecord(entry['attachment'])
            if (getString(attachment, 'type') !== 'queued_command') return
            emitAttributionActions(
              turnAttribution.observeQueuedCommand(getString(attachment, 'prompt'), entry),
              'queued_command'
            )
            return
          }
          const userObservation = classifyTranscriptUserEntry(entry)
          if (userObservation?.kind === 'interrupted') {
            emitAttributionActions(turnAttribution.observeInterrupt(entry), 'transcript.interrupt')
          } else if (userObservation?.kind === 'prompt') {
            emitAttributionActions(
              turnAttribution.observePlainUser(userObservation.content, entry),
              'transcript.user'
            )
          }
        },
      })
      transcriptReader = reader
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
        for (const event of reader.handleHook(
          rawHook,
          envelope.turnId ?? turnAttribution.activeTurnId
        )) {
          driverCtx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
        }
        const rawType = getString(rawHook, 'hook_event_name')
        if (rawType === 'UserPromptSubmit') {
          emitAttributionActions(
            turnAttribution.observePromptHook(
              getString(rawHook, 'prompt'),
              envelope.turnId as TurnId | undefined
            ),
            rawType
          )
          return
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
          return structuredDecision.decision
        }
        effectiveEnvelope = structuredDecision.envelope
        for (const event of normalizeHookEnvelope(effectiveEnvelope, { normalizer })) {
          driverCtx.emit(event.type, event.payload, {
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

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      // Parity with codex-cli-tmux: a stopped driver clears `surface`, so an
      // interrupt after stop reports no_active_turn rather than firing a stray
      // C-c at a pane the driver no longer considers live.
      if (surface === undefined || paneController === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      await paneController.interrupt()
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
        for (const event of transcriptReader.drain()) {
          ctx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
        }
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
        for (const event of transcriptReader.drain()) {
          ctx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
        }
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
  return text === '[Request interrupted by user]' ? { kind: 'interrupted' } : undefined
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
