import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlNegativeAck,
  AgentHarnessControlRequest,
  AgentHarnessSessionConfig,
  DriverPermissionPolicy,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationEvent,
  InvocationEventEnvelope,
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
  validateAgentHarnessControlFrame,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { PiSdkStoredCredentialReader } from '../../runtime/pi-sdk-auth'
import { resolvePiSdkAuth } from '../../runtime/pi-sdk-auth'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import {
  type PaneLeaseSurface,
  buildHookSocketPath,
  consumePaneLease,
  extractText,
  getInvocationRuntimeId,
  sleep,
} from '../tmux-shared'
import {
  type AgentHarnessControlListenerContext,
  type AgentHarnessControlListenerHandle,
  listenForAgentHarnessControl,
} from './control-listener'

export type {
  AgentHarnessControlListenerContext,
  AgentHarnessControlListenerHandle,
} from './control-listener'

export const AGENT_HARNESS_TMUX_DRIVER_KIND = 'agent-harness-tmux'
const AGENT_HARNESS_TMUX_DRIVER_VERSION = '0.1.0'
const INPUT_SUBMIT_GAP_MS = 1_000

/**
 * Capabilities are deliberately identical to `pi-tui-tmux`: the same pane-leased
 * interactive shape, one turn at a time, resumable, attachable by the operator.
 */
const AGENT_HARNESS_TMUX_CAPABILITIES: InvocationCapabilities = {
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
    provider: 'openai',
    keyKind: 'session',
  },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: false,
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

export interface AgentHarnessTmuxDriverOptions {
  tmux: {
    socketPath?: string | undefined
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  control: {
    listen: (
      handler: (frame: AgentHarnessControlFrame) => Promise<void>,
      context: AgentHarnessControlListenerContext
    ) => Promise<AgentHarnessControlListenerHandle>
  }
  /**
   * Supplies the pi auth-store reader used by oauth-mode auth resolution. The
   * broker package cannot import `@earendil-works/pi-coding-agent` without
   * inverting the `spaces-harness-broker-pi-sdk -> spaces-harness-broker` edge,
   * so the `agent-harness` binary injects it at registration.
   */
  auth?:
    | {
        readStoredCredential?: PiSdkStoredCredentialReader | undefined
      }
    | undefined
  /**
   * Accepted for factory-shape parity with the other tmux drivers. This driver
   * stamps no timestamps of its own: every event it emits is timestamped by the
   * broker's sequencer, and every event it forwards was already stamped by the
   * child's mapper.
   */
  now?: (() => Date) | undefined
}

/**
 * Interactive `agent-harness` driver: a structural analog of `pi-tui-tmux` whose
 * observation seam is the bidirectional `agent-harness-control/v1` socket rather
 * than a hook bridge. The child is first-party and holds the live session, so it
 * maps events with the SAME `PiSdkTurnEventMapper` the headless driver uses and
 * ships already-mapped envelopes; this driver validates, re-sequences through the
 * broker, and emits.
 */
export function createAgentHarnessTmuxDriver(options: AgentHarnessTmuxDriverOptions): Driver {
  let ctx: DriverContext | undefined
  let spec: HarnessInvocationSpec | undefined
  let surface: PaneLeaseSurface | undefined
  let paneController: TmuxPaneController | undefined
  let channel: AgentHarnessControlListenerHandle | undefined
  let turnCounter = 0
  let requestCounter = 0

  /**
   * Outbound gate. Inbound `event` frames are held while an `applyInputNow` call
   * is in flight and flushed only after it has returned AND the broker's
   * synchronous `turn.started` continuation has run — a macrotask hop, which is
   * strictly after every microtask the returned promise schedules. This keeps
   * body events behind the bracket by construction instead of by assuming the
   * model is slower than a function return.
   */
  let gateDepth = 0
  const gated: Array<() => void> = []

  function requireCtx(): DriverContext {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function requireSpec(): HarnessInvocationSpec {
    if (spec === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return spec
  }

  function requireChannel(): AgentHarnessControlListenerHandle {
    if (channel === undefined) {
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        'agent-harness control channel is not bound'
      )
    }
    return channel
  }

  function requirePaneController(): TmuxPaneController {
    if (paneController === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established')
    }
    return paneController
  }

  function allocateTurnId(): string {
    turnCounter += 1
    return `turn_${requireCtx().invocationId}_${turnCounter}`
  }

  function allocateRequestId(verb: string): string {
    requestCounter += 1
    return `${requireCtx().invocationId}:${verb}:${requestCounter}`
  }

  function openGate(): void {
    gateDepth += 1
  }

  function closeGate(): void {
    gateDepth -= 1
    if (gateDepth > 0 || gated.length === 0) return
    setTimeout(() => {
      if (gateDepth > 0) return
      for (const release of gated.splice(0)) release()
    }, 0)
  }

  /** Send an ack-bearing frame; the returned promise settles on the child's ack. */
  async function request(frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck> {
    const channelHandle = requireChannel()
    validateAgentHarnessControlFrame(frame)
    return await channelHandle.request(frame)
  }

  /**
   * `session.config` has no recoverable negative answer: the child fails closed
   * and destroys the channel rather than nacking it, so a negative ack here is
   * a protocol violation and not a turn-scoped outcome.
   */
  async function requestAcknowledged(frame: AgentHarnessControlRequest): Promise<void> {
    const ack = await request(frame)
    if (ack.ack === false) {
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        `agent-harness child refused ${frame.verb}: ${ack.code} — ${ack.message}`
      )
    }
  }

  /**
   * Project the hash-covered spec into `session.config`. Every field is copied
   * from the broker's own value; nothing here is re-derived by the child, and no
   * credential material crosses the wire — `auth` is selectors plus a path.
   */
  async function sendSessionConfig(): Promise<void> {
    const currentSpec = requireSpec()
    const driverCtx = requireCtx()
    const auth = await resolvePiSdkAuth(currentSpec, driverCtx, {
      ...(options.auth?.readStoredCredential !== undefined
        ? { readStoredCredential: options.auth.readStoredCredential }
        : {}),
    })
    const sdk = currentSpec.sdk
    if (sdk === undefined) {
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        'agent-harness-tmux requires spec.sdk to project session.config'
      )
    }
    const permissionPolicy = (
      currentSpec.driver as { permissionPolicy?: DriverPermissionPolicy | undefined }
    ).permissionPolicy
    if (permissionPolicy === undefined || permissionPolicy === null) {
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        'agent-harness-tmux requires spec.driver.permissionPolicy to project session.config'
      )
    }
    const agent = currentSpec.agent
    if (agent === undefined) {
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        'agent-harness-tmux requires spec.agent to project session.config'
      )
    }
    // No continuation is the FRESH-launch case, which is the only case a first
    // launch can be. Projecting a synthetic key here would name a session file
    // that does not exist, and the child opens-or-throws on it (T-07585).
    const continuationKey = currentSpec.continuation?.key

    const payload: AgentHarnessSessionConfig = {
      permissionPolicy,
      auth,
      sdk: {
        modelId: sdk.modelId,
        ...(sdk.thinkingLevel !== undefined ? { thinkingLevel: sdk.thinkingLevel } : {}),
      },
      agent,
      ...(continuationKey !== undefined ? { continuation: { key: continuationKey } } : {}),
    }
    await requestAcknowledged({
      verb: 'session.config',
      requestId: allocateRequestId('session.config'),
      payload,
    })
  }

  /** Record the child's reported session file as the resumable continuation. */
  function captureContinuation(reportedSessionFile: string): void {
    const driverCtx = requireCtx()
    const provider = requireSpec().sdk?.provider
    if (provider === undefined) return
    driverCtx.emit(
      'continuation.updated',
      { provider, key: reportedSessionFile, kind: 'session' },
      { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'ready' } }
    )
  }

  /** Re-emit a child-mapped envelope through broker sequencing, gate permitting. */
  function ingestEvent(envelope: InvocationEventEnvelope): void {
    const driverCtx = requireCtx()
    const event: InvocationEvent = {
      type: envelope.type,
      payload: envelope.payload,
    } as InvocationEvent
    const extra = {
      ...(envelope.turnId !== undefined ? { turnId: envelope.turnId as TurnId } : {}),
      ...(envelope.inputId !== undefined ? { inputId: envelope.inputId as InputId } : {}),
      ...(envelope.itemId !== undefined ? { itemId: envelope.itemId } : {}),
      ...(envelope.harnessGeneration !== undefined
        ? { harnessGeneration: envelope.harnessGeneration }
        : {}),
      ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
      driver: envelope.driver ?? { kind: AGENT_HARNESS_TMUX_DRIVER_KIND },
    }
    const release = (): void => {
      driverCtx.emitEvent(event, extra)
    }
    if (gateDepth > 0) {
      gated.push(release)
      return
    }
    release()
  }

  async function handleControlFrame(rawFrame: AgentHarnessControlFrame): Promise<void> {
    // Validate at the driver seam, not only at the transport: an invalid frame
    // must never reach the ledger regardless of how it arrived.
    const frame = validateAgentHarnessControlFrame(rawFrame)
    switch (frame.verb) {
      case 'hello':
        await sendSessionConfig()
        return
      case 'ready':
        // D8: the mapper reads `session.sessionFile` in-process, but the driver
        // still captures it here so a runtime that dies before its first turn
        // completes is still resumable.
        captureContinuation(frame.payload.sessionFile)
        return
      case 'event':
        ingestEvent(frame.payload)
        return
      default:
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `agent-harness control verb ${frame.verb} is driver-to-TUI only`
        )
    }
  }

  /**
   * Queue the refused turn's terminal on the SAME outbound gate body events use.
   * The gate flushes one macrotask after `applyInputNow` returns, which is
   * strictly after the broker's synchronous `turn.started` continuation — so the
   * bracket is always opened before it is failed, without this driver having to
   * know anything about the broker's internal ordering.
   */
  function failRefusedTurn(
    turnId: string,
    inputId: InputId,
    ack: AgentHarnessControlNegativeAck
  ): void {
    const driverCtx = requireCtx()
    gated.push(() => {
      driverCtx.emit(
        'turn.failed',
        {
          turnId: turnId as TurnId,
          status: 'failed',
          code: ack.code,
          message: ack.message,
          // The runtime is intact and the input was never delivered, so the same
          // content is safe to send again under a NEW inputId.
          retryable: true,
        },
        {
          turnId: turnId as TurnId,
          inputId,
          driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'turn.begin.nack' },
        }
      )
    })
  }

  async function deliverInput(input: InvocationInput): Promise<void> {
    const controller = requirePaneController()
    await controller.sendLiteral(extractText(input))
    await sleep(INPUT_SUBMIT_GAP_MS)
    await controller.sendEnter()
  }

  return {
    kind: AGENT_HARNESS_TMUX_DRIVER_KIND,
    version: AGENT_HARNESS_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return AGENT_HARNESS_TMUX_CAPABILITIES
    },

    async start(
      nextSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      const leased = await consumePaneLease(driverCtx, {
        driverKind: AGENT_HARNESS_TMUX_DRIVER_KIND,
        ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
      })

      ctx = driverCtx
      spec = nextSpec
      paneController = leased.controller
      surface = leased.surface

      const expectedRuntimeId = getInvocationRuntimeId(nextSpec)
      // Bind the control socket BEFORE the launch command is pasted: the child
      // connects and says `hello` as soon as it starts.
      channel = await options.control.listen((frame) => handleControlFrame(frame), {
        invocationId: driverCtx.invocationId,
        ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
      })

      const lease = leased.surface
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
        { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      const launchCommand = await buildLaunchCommandLine(nextSpec, driverCtx, channel.socketPath)
      await leased.controller.sendPastedLine(launchCommand)
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      const inputId = input.inputId
      if (inputId === undefined) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'agent-harness-tmux requires an inputId to open a turn'
        )
      }
      const turnId = allocateTurnId()
      openGate()
      try {
        // The child's event mapper discards everything until `beginTurn`, so the
        // ack — not a timer — is what makes the paste safe to send.
        const ack = await request({
          verb: 'turn.begin',
          requestId: allocateRequestId('turn.begin'),
          payload: { turnId, inputId, structured: false },
        })
        if (ack.ack === false) {
          // A refusal is a TURN failure, not an INPUT failure. Returning
          // normally with the allocated turnId is what preserves the broker's
          // accepted-input boundary: `input.accepted{started}` was already
          // emitted, and only a normal return lets the broker record the
          // inputId disposition, open the turn bracket, and then close it on
          // the terminal below. Throwing here would strand a started input that
          // never started and leave the same inputId re-drivable.
          failRefusedTurn(turnId, inputId, ack)
          return { turnId: turnId as ApplyInputResult['turnId'] }
        }
        await deliverInput(input)
        return { turnId: turnId as ApplyInputResult['turnId'] }
      } finally {
        closeGate()
      }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (surface === undefined || paneController === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      // Esc is the Pi TUI's interrupt; C-c would quit the TUI outright.
      await paneController.sendNamedKey('Escape')
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      await closeChannel()
      surface = undefined
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await closeChannel()
      ctx = undefined
      spec = undefined
      surface = undefined
      paneController = undefined
      gated.length = 0
      gateDepth = 0
    },
  }

  async function closeChannel(): Promise<void> {
    if (channel === undefined) return
    const handle = channel
    channel = undefined
    await handle.close()
  }
}

/**
 * Argv is exactly `tui --broker-control-socket <path>`. Nothing semantic or
 * authoritative rides here: every such value arrives in `session.config`, so
 * there is no second source of truth for argv to win.
 */
async function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  ctx: DriverContext,
  controlSocket: string
): Promise<string> {
  const launch = await writeTmuxLaunchExecFiles(`${controlSocket}.agent-harness`, {
    argv: [spec.process.command, 'tui', '--broker-control-socket', controlSocket],
    cwd: spec.process.cwd,
    env: { ...spec.process.lockedEnv, ...(ctx.dispatchEnv ?? {}) },
    pathPrepend: spec.process.pathPrepend,
    ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
  })
  return launch.commandLine
}

export function createDefaultAgentHarnessTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker'),
  auth?: { readStoredCredential?: PiSdkStoredCredentialReader | undefined } | undefined
): Driver {
  return createAgentHarnessTmuxDriver({
    tmux: {},
    control: {
      listen: (handler, context) =>
        listenForAgentHarnessControl(
          buildAgentHarnessControlSocketPath(socketDir, context),
          handler
        ),
    },
    ...(auth !== undefined ? { auth } : {}),
  })
}

export function buildAgentHarnessControlSocketPath(
  socketDir: string,
  context: AgentHarnessControlListenerContext
): string {
  return buildHookSocketPath(socketDir, 'agent-harness-control', context)
}
