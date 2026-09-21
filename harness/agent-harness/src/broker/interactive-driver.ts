import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BrokerError,
  buildHookSocketPath,
  consumePaneLease,
  tmuxHelperRunner,
  writeTmuxLaunchExecFiles,
} from 'spaces-harness-broker'
import type {
  ApplyInputResult,
  Driver,
  DriverContext,
  DriverStartResult,
  TmuxExec,
  TmuxHelperLauncher,
  TmuxPaneController,
} from 'spaces-harness-broker'
import { BrokerClient } from 'spaces-harness-broker-client'
import type {
  AspReleaseIdentity,
  EvidenceAuthorityMatrix,
  HarnessInvocationSpec,
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
  SUPPORTED_BROKER_PROTOCOL_VERSIONS,
} from 'spaces-harness-broker-protocol'

export const AGENT_HARNESS_TMUX_DRIVER_KIND = 'agent-harness-tmux'
const DRIVER_VERSION = '0.2.0'
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000

const CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'delivery-acknowledged',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'atomic' },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: 'ack' },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
  },
  turns: { concurrency: 'single', interrupt: 'protocol' },
  continuation: { supported: true, keyKind: 'session' },
  events: { assistantDeltas: true, toolCalls: true, usage: true, diagnostics: true },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    liveness: 'cached',
    driverAttachExistingSurface: false,
  },
  permissions: { brokerToClientRequests: true, eventAudit: true },
  finalResponse: { jsonSchema: true, perTurn: true, strict: true, parsedResult: false },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

const AUTHORITY: EvidenceAuthorityMatrix = {
  'invocation-lifecycle': 'broker',
  'harness-lifecycle': 'broker',
  continuation: 'native',
  'input-admission': 'broker',
  'submission-disposition': 'broker',
  'turn-bracket': 'broker',
  'turn-supervision': 'broker',
  conversation: 'native',
  tool: 'native',
  usage: 'native',
  permission: 'broker',
  diagnostic: 'native',
  'terminal-surface': 'broker',
  'provider-artifact': 'native',
}

export interface AgentHarnessTmuxDriverOptions {
  childLauncher: TmuxHelperLauncher
  releaseIdentity?: AspReleaseIdentity | undefined
  socketDir?: string | undefined
  tmux?: { tmuxBin?: string | undefined; exec?: TmuxExec | undefined } | undefined
  connect?: typeof BrokerClient.connectUnix | undefined
}

/** HRC-facing driver; its child is another standard harness-broker endpoint. */
export function createAgentHarnessTmuxDriver(
  options: AgentHarnessTmuxDriverOptions = { childLauncher: defaultChildLauncher() }
): Driver {
  let ctx: DriverContext | undefined
  let client: BrokerClient | undefined
  let eventPump: Promise<void> | undefined
  let paneController: TmuxPaneController | undefined
  let childTerminalSeen = false
  let cleanChildLeave = false
  let closing = false
  let gateDepth = 0
  const gated: Array<() => void> = []

  const requireCtx = (): DriverContext => {
    if (ctx === undefined) throw new Error('agent-harness-tmux driver has not started')
    return ctx
  }
  const requireClient = (): BrokerClient => {
    if (client === undefined) throw new Error('agent-harness-tmux child is unavailable')
    return client
  }
  const emitGated = (release: () => void): void => {
    if (gateDepth > 0) gated.push(release)
    else release()
  }
  const closeGate = (): void => {
    gateDepth -= 1
    if (gateDepth !== 0 || gated.length === 0) return
    setTimeout(() => {
      if (gateDepth !== 0) return
      for (const release of gated.splice(0)) release()
    }, 0)
  }

  function forward(envelope: InvocationEventEnvelope): void {
    if (envelope.type === 'invocation.started' || envelope.type === 'invocation.ready') return
    if (
      envelope.type === 'input.accepted' ||
      envelope.type === 'input.rejected' ||
      envelope.type.startsWith('submission.') ||
      envelope.type.startsWith('queue.')
    )
      return
    // The outer broker owns delivered-input brackets. Operator brackets have no inputId.
    if (envelope.type === 'turn.started' && envelope.inputId !== undefined) return
    if (envelope.type === 'continuation.cleared') cleanChildLeave = true
    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.failed')
      childTerminalSeen = true
    const event = { type: envelope.type, payload: envelope.payload } as InvocationEvent
    emitGated(() => {
      requireCtx().emitEvent(event, {
        ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
        ...(envelope.inputId !== undefined ? { inputId: envelope.inputId } : {}),
        ...(envelope.itemId !== undefined ? { itemId: envelope.itemId } : {}),
        ...(envelope.harnessGeneration !== undefined
          ? { harnessGeneration: envelope.harnessGeneration }
          : {}),
        ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
        sourceTime: envelope.time,
        driver: envelope.driver ?? { kind: AGENT_HARNESS_TMUX_DRIVER_KIND },
      })
    })
  }

  function reportUnexpectedClose(error?: Error): void {
    if (closing || ctx === undefined || childTerminalSeen) return
    childTerminalSeen = true
    emitGated(() => {
      if (!cleanChildLeave) {
        ctx?.emit(
          'invocation.failed',
          {
            message: error?.message ?? 'agent-harness TUI child disconnected',
            code: 'child-disconnected',
          },
          { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'broker.disconnect' } }
        )
      }
      ctx?.emit(
        'invocation.exited',
        { reason: cleanChildLeave ? 'prompt_input_exit' : 'process-exit' },
        { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'broker.disconnect' } }
      )
    })
  }

  return {
    kind: AGENT_HARNESS_TMUX_DRIVER_KIND,
    version: DRIVER_VERSION,
    bracketMintingMode: 'delivery-acknowledged',
    evidenceAuthority: AUTHORITY,
    nativeSourceKind: 'provider-jsonrpc',
    preemptMode: 'atomic',
    steerLandingEvidence: null,
    interruptLandingEvidence: 'ack',
    capabilities: () => CAPABILITIES,

    async start(
      nextSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      assertSpec(nextSpec)
      ctx = driverCtx
      closing = false
      childTerminalSeen = false
      cleanChildLeave = false
      const leased = await consumePaneLease(driverCtx, {
        driverKind: AGENT_HARNESS_TMUX_DRIVER_KIND,
        ...(options.tmux?.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux?.exec !== undefined ? { exec: options.tmux.exec } : {}),
      })
      const surface = leased.surface
      paneController = leased.controller
      driverCtx.emit(
        'invocation.started',
        {
          command: options.childLauncher.command,
          args: options.childLauncher.args ?? [],
          cwd: nextSpec.process.cwd,
        },
        { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND } }
      )
      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-pane',
          socketPath: surface.socketPath,
          sessionId: surface.sessionId,
          windowId: surface.windowId,
          paneId: surface.paneId,
          ...(surface.sessionName !== undefined ? { sessionName: surface.sessionName } : {}),
          ...(surface.windowName !== undefined ? { windowName: surface.windowName } : {}),
        },
        { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      const socketPath = buildHookSocketPath(options.socketDir ?? join(tmpdir(), 'ahb'), 'child', {
        invocationId: driverCtx.invocationId,
        runtimeId: nextSpec.correlation?.['runtimeId'],
      })
      const launch = await writeTmuxLaunchExecFiles(
        `${socketPath}.agent-harness`,
        {
          argv: [
            options.childLauncher.command,
            ...(options.childLauncher.args ?? []),
            'run',
            '--transport',
            'unix',
            '--socket',
            socketPath,
            '--agent-harness-role',
            'tui-child',
          ],
          cwd: nextSpec.process.cwd,
          env: { ...nextSpec.process.lockedEnv, ...(driverCtx.dispatchEnv ?? {}) },
          pathPrepend: nextSpec.process.pathPrepend,
          ...(nextSpec.launch !== undefined ? { prompts: nextSpec.launch } : {}),
        },
        { runner: tmuxHelperRunner(options.childLauncher, 'tmux-launch') }
      )

      try {
        await leased.controller.sendPastedLine(launch.commandLine)
        client = await connectWithRetry(
          options.connect ?? BrokerClient.connectUnix,
          socketPath,
          nextSpec.process.limits?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
        )
        client.onClose((error) => reportUnexpectedClose(error))
        client.onPermissionRequest(async (request) => {
          if (driverCtx.requestPermission === undefined)
            throw new Error('No outer permission client is connected')
          return driverCtx.requestPermission(request)
        })
        const hello = await client.hello({
          clientInfo: { name: 'agent-harness-tmux-parent', version: DRIVER_VERSION },
          protocolVersions: [...SUPPORTED_BROKER_PROTOCOL_VERSIONS],
          capabilities: { permissionRequests: true },
        })
        verifyChildHello(hello, options.releaseIdentity)
        const started = await client.startInvocationFromRequest(
          { spec: nextSpec },
          { dispatchEnv: driverCtx.dispatchEnv }
        )
        eventPump = (async () => {
          for await (const event of started.events) forward(event)
        })()
        void eventPump.catch((error: unknown) =>
          reportUnexpectedClose(error instanceof Error ? error : new Error(String(error)))
        )
        driverCtx.emit(
          'invocation.ready',
          { state: 'ready' },
          { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND } }
        )
        return { ok: true }
      } catch (error) {
        closing = true
        await Promise.allSettled([
          client?.close() ?? Promise.resolve(),
          leased.controller.sendNamedKey('C-c'),
        ])
        client = undefined
        throw error
      }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      gateDepth += 1
      try {
        const response = await requireClient().input({
          invocationId: requireCtx().invocationId,
          input,
          policy: { whenBusy: 'queue' },
        })
        if (!response.accepted || response.disposition === 'rejected') {
          return {
            ...(response.turnId !== undefined ? { turnId: response.turnId } : {}),
            deliveryDisposition: 'rejected',
            rejectionReason: response.reason ?? 'child-broker-rejected',
          }
        }
        if (response.disposition !== 'started' || response.turnId === undefined) {
          throw new BrokerError(
            BrokerErrorCode.InvalidInvocationState,
            `agent-harness child returned ${response.disposition} without a started turn`
          )
        }
        return { turnId: response.turnId as TurnId }
      } finally {
        closeGate()
      }
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      return requireClient().interrupt({ ...req, invocationId: requireCtx().invocationId })
    },
    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      return requireClient().stop({ ...req, invocationId: requireCtx().invocationId })
    },
    async dispose(): Promise<void> {
      closing = true
      if (client !== undefined) {
        await client.dispose({ invocationId: requireCtx().invocationId }).catch(() => undefined)
        await client.close().catch(() => undefined)
      }
      await paneController?.sendNamedKey('C-c').catch(() => undefined)
      await eventPump?.catch(() => undefined)
      client = undefined
      eventPump = undefined
      paneController = undefined
      ctx = undefined
      gated.length = 0
      gateDepth = 0
    },
  }
}

function defaultChildLauncher(): TmuxHelperLauncher {
  const script = process.argv[1]
  return script === undefined
    ? { command: process.execPath }
    : { command: process.execPath, args: [script] }
}

function assertSpec(spec: HarnessInvocationSpec): void {
  if (spec.driver.kind !== AGENT_HARNESS_TMUX_DRIVER_KIND)
    throw new Error(`agent-harness-tmux cannot start spec for ${spec.driver.kind}`)
  if (spec.process.execution !== 'native-worker')
    throw new Error('agent-harness-tmux requires native-worker process execution')
  if (spec.process.harnessTransport.kind !== 'native-worker')
    throw new Error('agent-harness-tmux requires native-worker harness transport')
}

async function connectWithRetry(
  connect: typeof BrokerClient.connectUnix,
  socketPath: string,
  timeoutMs: number
): Promise<BrokerClient> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await connect({ socketPath, timeoutMs: Math.min(1_000, timeoutMs) })
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new BrokerError(
    BrokerErrorCode.Timeout,
    `agent-harness TUI child did not bind its broker socket within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

function verifyChildHello(
  hello: Awaited<ReturnType<BrokerClient['hello']>>,
  expectedRelease: AspReleaseIdentity | undefined
): void {
  const driver = hello.drivers.find(
    (candidate) => candidate.kind === AGENT_HARNESS_TMUX_DRIVER_KIND
  )
  if (driver?.available !== true) {
    throw new BrokerError(
      BrokerErrorCode.DriverUnavailable,
      driver?.unavailableReason ?? 'agent-harness TUI child did not register its driver'
    )
  }
  if (
    expectedRelease !== undefined &&
    JSON.stringify(hello.release) !== JSON.stringify(expectedRelease)
  ) {
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `agent-harness TUI child release mismatch: expected ${expectedRelease.releaseId}, got ${hello.release?.releaseId ?? '(none)'}`
    )
  }
}
