import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { getString } from '../hook-json'
import {
  type HookListenerHandle,
  buildHookSocketPath,
  consumePaneLease,
  extractText,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
  shellQuote,
  sleep,
} from '../tmux-shared'
import {
  CODEX_CLI_TMUX_DRIVER_KIND,
  type CodexCliTmuxHookEnvelope,
  type CodexCliTmuxHookEventNormalizer,
  createCodexCliTmuxHookEventNormalizer,
  extractCodexHookRecord,
  normalizeCodexHookEnvelope,
} from './hook-events'
import { type CodexHookTranscriptReader, createCodexHookTranscriptReader } from './hook-transcript'

const CODEX_CLI_TMUX_DRIVER_VERSION = '0.1.0'

/**
 * Live hook generation stamped into the launch env (HARNESS_BROKER_HOOK_GENERATION)
 * and used to fence out-of-band hook envelopes against stale durable runtimes
 * (T-01794 Phase D).
 */
const CODEX_HOOK_GENERATION = 1

/**
 * TUI settle gap between pasting literal input and pressing Enter. The Codex CLI
 * needs a brief pause so the pasted line is fully rendered/accepted before the
 * Enter submits it; pressing Enter too early can submit a partial line.
 */
const INPUT_SUBMIT_GAP_MS = 1_000

const CODEX_CLI_TMUX_CAPABILITIES: InvocationCapabilities = {
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
    // T-01794 Phase D: `attach` is OPERATOR `tmux attach`. It does NOT mean the
    // broker can restart this driver and reattach to an already-live surface;
    // that distinct capability is explicitly false (no impl in scope).
    driverAttachExistingSurface: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export type CodexHookListenerHandle = HookListenerHandle

/**
 * Per-invocation/runtime identity handed to the hook listener so a durable
 * broker binds a UNIQUE callback socket per invocation under its runtime hooks
 * dir (T-01794 Phase D) — never the legacy single global codex-hooks.sock.
 */
export interface CodexHookListenerContext {
  invocationId: string
  runtimeId?: string | undefined
}

export type CodexHookEnvelopeHandler = (envelope: CodexCliTmuxHookEnvelope) => Promise<void>

export interface CodexCliTmuxDriverOptions {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (
      handler: CodexHookEnvelopeHandler,
      context: CodexHookListenerContext
    ) => Promise<CodexHookListenerHandle>
    /**
     * Broker-owned receiver command invoked by the generated HRC_LAUNCH_HOOK_CLI
     * wrapper. Defaults to the installed `harness-broker codex-hook` CLI.
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

export function createCodexCliTmuxDriver(options: CodexCliTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: CodexHookListenerHandle | undefined
  let transcriptReader: CodexHookTranscriptReader | undefined
  let hookDrain: Promise<void> = Promise.resolve()
  let currentTurnId: string | undefined
  let paneController: TmuxPaneController | undefined

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

  // Shared literal-input delivery for both applyInputNow and applySteerNow:
  // paste the literal text, settle, then submit with Enter.
  async function deliverInput(input: InvocationInput): Promise<void> {
    requireCtx()
    requireSurface()
    const controller = requirePaneController()
    await controller.sendLiteral(extractText(input))
    await sleep(INPUT_SUBMIT_GAP_MS)
    await controller.sendEnter()
  }

  return {
    kind: CODEX_CLI_TMUX_DRIVER_KIND,
    version: CODEX_CLI_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return CODEX_CLI_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      const leased = await consumePaneLease(driverCtx, {
        driverKind: 'codex-cli-tmux',
        ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
      })
      const controller = leased.controller
      const leaseSurface = leased.surface

      ctx = driverCtx
      paneController = controller

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      const normalizer: CodexCliTmuxHookEventNormalizer = createCodexCliTmuxHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
      })
      currentTurnId = undefined
      hookDrain = Promise.resolve()
      // Hook-driven rollout transcript reader (T-01710): reads newly appended
      // transcript bytes synchronously from hook processing — NO polling timer —
      // so interim agent prose is emitted in hook order, attributed to the live
      // turn, and the terminal message lands before turn.completed.
      const reader = createCodexHookTranscriptReader({
        invocationId: driverCtx.invocationId,
        now,
        getCurrentTurnId: () => currentTurnId,
      })
      transcriptReader = reader
      const emit = (event: InvocationEventEnvelope): void => {
        driverCtx.emit(event.type, event.payload, {
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
          ...(event.driver !== undefined ? { driver: event.driver } : {}),
        })
      }
      const handleHookEnvelope = (envelope: CodexCliTmuxHookEnvelope): void => {
        // T-01794 Phase D: durable identity fencing. Reject an envelope whose
        // invocation/runtime/generation/callback-socket does not match the live
        // invocation — but STRICTLY only for fields the durable unix mode
        // actually provides, so legacy/stdio rows that omit generation/runtimeId
        // are never rejected for an absent field.
        if (
          envelope.invocationId !== undefined &&
          envelope.invocationId !== driverCtx.invocationId
        ) {
          return
        }
        if (
          expectedRuntimeId !== undefined &&
          envelope.runtimeId !== undefined &&
          envelope.runtimeId !== expectedRuntimeId
        ) {
          return
        }
        if (envelope.generation !== undefined && envelope.generation !== CODEX_HOOK_GENERATION) {
          return
        }
        if (
          envelope.callbackSocket !== undefined &&
          hookListener !== undefined &&
          envelope.callbackSocket !== hookListener.socketPath
        ) {
          return
        }
        const hook = extractCodexHookRecord(envelope)
        const envelopeTurnId = getString(hook, 'turn_id') ?? envelope.turnId
        if (envelopeTurnId !== undefined) {
          currentTurnId = envelopeTurnId
        }
        if (
          getString(hook, 'hook_event_name') === 'SessionStart' &&
          (getString(hook, 'transcript_path') ?? '').length === 0
        ) {
          emitTranscriptDiagnostic(driverCtx, undefined, undefined)
        }
        // Read the transcript BEFORE normalizing the triggering hook so interim
        // assistant messages land first and the terminal message precedes
        // turn.completed on Stop.
        for (const event of reader.handleHook(hook)) emit(event)
        for (const event of normalizeCodexHookEnvelope(envelope, { normalizer })) emit(event)
      }
      // Serialize hook processing like the Claude driver's hookDrain so transcript
      // reads and hook normalization stay strictly ordered.
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

      surface = leaseSurface

      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-pane' as const,
          socketPath: surface.socketPath,
          sessionId: surface.sessionId,
          windowId: surface.windowId,
          paneId: surface.paneId,
          ...(surface.sessionName !== undefined ? { sessionName: surface.sessionName } : {}),
          ...(surface.windowName !== undefined ? { windowName: surface.windowName } : {}),
        },
        { driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      const hookCliPath = await writeCodexHookBridgeWrapper({
        callbackSocket: hookListener.socketPath,
        bridgeCommand: options.hooks.bridgeCommand,
      })
      // Shell-readiness is handled deterministically inside sendPastedLine: it
      // (re)pastes until the command renders at the prompt, so a paste dropped
      // before the leased pane's shell PTY is reading is retried rather than lost.
      // No blind pre-paste sleep (T-01747) — that masked the race and cost ~1.5s
      // every launch; a dropped paste used to fall through to a 10s timeout +
      // bare-shell pane.
      await controller.sendPastedLine(
        await buildLaunchCommandLine(spec, driverCtx, {
          callbackSocket: hookListener.socketPath,
          hookCliPath,
          ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
        })
      )
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      await deliverInput(input)
      return {}
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      await deliverInput(input)
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (surface === undefined || paneController === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      await paneController.interrupt()
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      await terminateSession()
      resetTranscriptReader()
      await closeHookListener()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await terminateSession()
      resetTranscriptReader()
      await closeHookListener()
      ctx = undefined
      surface = undefined
      currentTurnId = undefined
      paneController = undefined
    },
  }

  async function terminateSession(): Promise<void> {
    surface = undefined
  }

  async function closeHookListener(): Promise<void> {
    await hookDrain.catch(() => undefined)
    if (hookListener !== undefined) {
      const handle = hookListener
      hookListener = undefined
      await handle.close()
    }
  }

  function resetTranscriptReader(): void {
    transcriptReader?.reset()
    transcriptReader = undefined
  }
}

function emitTranscriptDiagnostic(
  ctx: DriverContext,
  transcriptPath: string | undefined,
  error: unknown
): void {
  ctx.emit(
    'diagnostic',
    {
      level: 'warn',
      source: 'driver',
      message:
        'Codex SessionStart did not provide a usable transcript_path; relying on Stop finalOutput',
      data: {
        ...(transcriptPath !== undefined ? { transcriptPath } : {}),
        ...(error !== undefined
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      },
    },
    { driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'SessionStart' } }
  )
}

async function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  ctx: DriverContext,
  hookEnv: { callbackSocket: string; hookCliPath: string; runtimeId?: string | undefined }
): Promise<string> {
  const env = {
    ...spec.process.lockedEnv,
    ...(ctx.dispatchEnv ?? {}),
    HRC_LAUNCH_HOOK_CLI: hookEnv.hookCliPath,
    HARNESS_BROKER_INVOCATION_ID: ctx.invocationId,
    HARNESS_BROKER_CALLBACK_SOCKET: hookEnv.callbackSocket,
    HARNESS_BROKER_HOOK_GENERATION: String(CODEX_HOOK_GENERATION),
    // Codex CLI emits no SessionEnd hook (and no session-end OTEL) on /quit — it
    // just exits cleanly. Opt the shared tmux launch runner into synthesizing a
    // SessionEnd on harness exit so this driver gets the continuation.cleared
    // teardown the claude driver gets from its native SessionEnd hook. The runner
    // posts to HARNESS_BROKER_CALLBACK_SOCKET above; see postSyntheticSessionEnd.
    HARNESS_BROKER_SYNTH_SESSION_END: '1',
    // Authoritatively stamp the invocation's runtimeId so an inherited/leaked
    // HARNESS_BROKER_RUNTIME_ID from an outer broker session (the launch runner
    // spreads `process.env`) cannot poison the hook envelope and trip the
    // T-01794 Phase D identity fence — which silently drops EVERY hook,
    // yielding zero events (T-01798). Mirrors the claude-code-tmux driver.
    ...(hookEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: hookEnv.runtimeId } : {}),
  }
  const launch = await writeTmuxLaunchExecFiles(`${hookEnv.callbackSocket}.codex`, {
    argv: [spec.process.command, ...spec.process.args],
    cwd: spec.process.cwd,
    env,
    pathPrepend: spec.process.pathPrepend,
    ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
  })
  return launch.commandLine
}

const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker codex-hook'

async function writeCodexHookBridgeWrapper(options: {
  callbackSocket: string
  bridgeCommand?: string | undefined
}): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND
  const wrapperPath = `${options.callbackSocket}.codex-hook.ts`
  const shellCommand = `${bridge} --socket ${shellQuote(options.callbackSocket)}`
  await mkdir(dirname(wrapperPath), { recursive: true })
  await writeFile(
    wrapperPath,
    [
      '#!/usr/bin/env bun',
      "import { spawn } from 'node:child_process'",
      '',
      `const child = spawn('/bin/sh', ['-lc', ${JSON.stringify(`exec ${shellCommand}`)}], {`,
      "  stdio: 'inherit',",
      '  env: process.env,',
      '})',
      "child.on('error', (error) => {",
      '  process.stderr.write(`codex-hook wrapper failed: ${error instanceof Error ? error.message : String(error)}\\n`)',
      '  process.exit(0)',
      '})',
      "child.on('exit', (code, signal) => {",
      '  if (signal) process.kill(process.pid, signal)',
      '  else process.exit(code ?? 0)',
      '})',
      '',
    ].join('\n'),
    'utf8'
  )
  return wrapperPath
}

export function createDefaultCodexCliTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker')
): Driver {
  return createCodexCliTmuxDriver({
    tmux: { socketPath: join(socketDir, 'codex-tmux.sock') },
    hooks: {
      // T-01794 Phase D: per-invocation/runtime hook socket under the runtime
      // hooks dir — kills the single global /tmp/harness-broker/codex-hooks.sock
      // that two durable broker runtimes would otherwise collide on.
      listen: (handler, context) =>
        listenForHookEnvelopes<CodexCliTmuxHookEnvelope>(
          buildCodexHookSocketPath(socketDir, context),
          handler
        ),
    },
  })
}

/**
 * Build a SHORT, per-invocation/runtime codex hook socket path under
 * `socketDir`. Mirrors `buildClaudeHookSocketPath`: a 16-hex digest of
 * invocationId+runtimeId keeps the basename short so the relocated socket and
 * its derived wrapper/launch-artifact paths stay within the unix socket path
 * budget (Phase B).
 */
export function buildCodexHookSocketPath(
  socketDir: string,
  context: CodexHookListenerContext
): string {
  return buildHookSocketPath(socketDir, 'codex-hooks', context)
}
