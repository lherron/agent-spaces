import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { museHomeEnv, prepareMuseHome } from 'spaces-harness-muse'
import type { PreparedMuseHome } from 'spaces-harness-muse'
import { BrokerError } from '../../errors'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import type { TmuxHelperLauncher } from '../../runtime/tmux-launch-exec'
import { tmuxHelperRunner, writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { MUSE_CLI_TMUX_AUTHORITY } from '../evidence-authority'
import { consumePaneLease, extractText, getInvocationRuntimeId, sleep } from '../tmux-shared'
import { MUSE_CLI_TMUX_DRIVER_KIND, createMuseCliTmuxLogEventNormalizer } from './log-events'
import { createMuseCliSessionTranscriptReader } from './transcript'

const MUSE_CLI_TMUX_DRIVER_VERSION = '0.1.0'

/**
 * TUI settle gap between pasting literal input and pressing Enter. Proven
 * live (T-08601 spike): a combined single `send-keys 'text' Enter` left the
 * text sitting unsubmitted in the muse input box; a separate Enter after a
 * gap submits. Same discipline as the Codex/Claude tmux drivers.
 */
const INPUT_SUBMIT_GAP_MS = 1_000

/**
 * Poll cadence for the session-log tail. Muse emits no hooks, so unlike the
 * hook-driven Codex/Claude/Pi drivers this driver polls `session.jsonl`
 * (incrementally flushed by the TUI — observed growing across a live turn).
 */
const SESSION_LOG_POLL_MS = 500

const MUSE_CLI_TMUX_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive'] },
  bracketMintingMode: 'harness-evidence',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  // Busy pastes land in the TUI's native inbox as `inbox_item_queued`
  // (source user_steer) and drain as the next turn — observed in the log, so
  // steer landing is transcript-evidenced, not asserted.
  steer: { landingEvidence: 'transcript' },
  // Escape retracts the running turn and the log records `run_retracted`.
  interrupt: { landingEvidence: 'transcript' },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    // Busy user input is accepted by the broker, then applied through
    // applySteerNow as a paste. The TUI serializes it as the next turn via
    // its native inbox; it never joins the running turn.
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'process',
  },
  continuation: {
    supported: true,
    provider: 'muse',
    keyKind: 'session',
  },
  events: {
    // The log carries committed messages only — no streaming deltas.
    assistantDeltas: false,
    toolCalls: true,
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    // `attach` is OPERATOR `tmux attach`. It does NOT mean the broker can
    // restart this driver and reattach to an already-live surface.
    driverAttachExistingSurface: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export interface MuseCliTmuxDriverOptions {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  /** Same-payload launcher for the release-owned tmux launch helper. */
  helperLauncher?: TmuxHelperLauncher | undefined
  /** Base dir for per-invocation isolated HOMEs. Defaults to the OS temp dir. */
  homeBaseDir?: string | undefined
  /** Session-log poll cadence. Defaults to 500 ms. */
  pollIntervalMs?: number | undefined
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

export function createMuseCliTmuxDriver(options: MuseCliTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())
  const pollIntervalMs = options.pollIntervalMs ?? SESSION_LOG_POLL_MS

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let paneController: TmuxPaneController | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined

  function requireCtx(): DriverContext {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
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
    const controller = requirePaneController()
    await controller.sendLiteral(extractText(input))
    await sleep(INPUT_SUBMIT_GAP_MS)
    await controller.sendEnter()
  }

  function publish(envelopes: InvocationEventEnvelope[]): void {
    const driverCtx = ctx
    if (driverCtx === undefined) return
    for (const event of envelopes) {
      driverCtx.emit(event.type, event.payload, {
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
        ...(event.driver !== undefined ? { driver: event.driver } : {}),
      })
    }
  }

  return {
    kind: MUSE_CLI_TMUX_DRIVER_KIND,
    version: MUSE_CLI_TMUX_DRIVER_VERSION,
    bracketMintingMode: 'harness-evidence',
    failPendingOwnTurnOnForeignTurn: true,
    /**
     * Correlate an observed turn to our pending submission by CONTAINMENT.
     * Same shared-pane loss modes as codex-cli-tmux (dropped paste-buffer,
     * swallowed Enter, interleaved writers): exact equality made every one
     * of those a correlation failure that kills the invocation, so the
     * observed prompt containing our whole delivered text claims the turn.
     * `delivered.length > 0` keeps that from being every turn.
     */
    correlatePendingOwnTurnStart(observed, pendingInput): boolean {
      const prompt = observed.prompt
      const delivered = extractText(pendingInput)
      return prompt !== undefined && delivered.length > 0 && prompt.includes(delivered)
    },
    evidenceAuthority: MUSE_CLI_TMUX_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: null,
    steerLandingEvidence: 'transcript',
    interruptLandingEvidence: 'transcript',

    capabilities(): InvocationCapabilities {
      return MUSE_CLI_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      const leased = await consumePaneLease(driverCtx, {
        driverKind: 'muse-cli-tmux',
        ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
      })
      const controller = leased.controller

      ctx = driverCtx
      paneController = controller
      surface = leased.surface

      // Per-invocation isolated HOME (same recipe as muse-serve): state,
      // skills seeding, and session logs live under the HOME the TUI sees,
      // so the sessions tree holds exactly this invocation's session and
      // discovery is a single-session scan.
      const home = await prepareMuseHome(driverCtx.invocationId, {
        ...(options.homeBaseDir !== undefined ? { baseDir: options.homeBaseDir } : {}),
      })

      const normalizer = createMuseCliTmuxLogEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
      })
      const reader = createMuseCliSessionTranscriptReader({
        dataDir: home.dataDir,
        normalizer,
      })
      pollTimer = setInterval(() => {
        try {
          publish(reader.poll())
        } catch {
          // A failed poll is a missed beat, not a dead driver; the tailer
          // retains its offset and the next beat resumes where it left off.
        }
      }, pollIntervalMs)
      if (typeof pollTimer.unref === 'function') pollTimer.unref()

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
        { driver: { kind: MUSE_CLI_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      await controller.sendPastedLine(
        await buildLaunchCommandLine(spec, driverCtx, {
          home,
          ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
          ...(options.helperLauncher !== undefined
            ? { helperLauncher: options.helperLauncher }
            : {}),
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
      // The muse TUI interrupts on Escape (`esc to interrupt`), not C-c.
      await paneController.sendNamedKey('Escape')
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      stopPolling()
      surface = undefined
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      stopPolling()
      ctx = undefined
      surface = undefined
      paneController = undefined
    },
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
}

async function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  ctx: DriverContext,
  homeEnv: {
    home: PreparedMuseHome
    runtimeId?: string | undefined
    helperLauncher?: TmuxHelperLauncher | undefined
  }
): Promise<string> {
  const env = {
    ...spec.process.lockedEnv,
    ...(ctx.dispatchEnv ?? {}),
    // HOME/XDG overrides ride the tmux launch-exec env (not lockedEnv — HOME
    // is ambient-class, so the driver stamps the prepared home explicitly,
    // mirroring the muse-serve spawn composition).
    ...museHomeEnv(homeEnv.home),
    HARNESS_BROKER_INVOCATION_ID: ctx.invocationId,
    ...(homeEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: homeEnv.runtimeId } : {}),
  }
  const launch = await writeTmuxLaunchExecFiles(
    `${tmpdir()}/muse-cli-tmux-${ctx.invocationId}`,
    {
      argv: [spec.process.command, ...spec.process.args],
      cwd: spec.process.cwd,
      env,
      pathPrepend: spec.process.pathPrepend,
      ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
    },
    homeEnv.helperLauncher !== undefined
      ? { runner: tmuxHelperRunner(homeEnv.helperLauncher, 'tmux-launch') }
      : {}
  )
  return launch.commandLine
}

export function createDefaultMuseCliTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker'),
  helperLauncher?: TmuxHelperLauncher | undefined
): Driver {
  return createMuseCliTmuxDriver({
    tmux: { socketPath: join(socketDir, 'muse-tmux.sock') },
    ...(helperLauncher !== undefined ? { helperLauncher } : {}),
  })
}
