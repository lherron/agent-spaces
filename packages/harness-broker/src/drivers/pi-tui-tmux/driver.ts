import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
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
  PI_TUI_TMUX_DRIVER_KIND,
  type PiTuiTmuxHookEventNormalizer,
  createPiTuiTmuxHookEventNormalizer,
  normalizePiHookEnvelope,
} from './hook-events'
import type { PiTuiTmuxHookEnvelope } from './hook-ingestion'

const PI_TUI_TMUX_DRIVER_VERSION = '0.1.0'
const PI_HOOK_GENERATION = 1
const INPUT_SUBMIT_GAP_MS = 1_000

const PI_TUI_TMUX_CAPABILITIES: InvocationCapabilities = {
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

export type PiHookListenerHandle = HookListenerHandle

export interface PiHookListenerContext {
  invocationId: string
  runtimeId?: string | undefined
}

export type PiHookEnvelopeHandler = (envelope: PiTuiTmuxHookEnvelope) => Promise<void>

export interface PiTuiTmuxDriverOptions {
  tmux: {
    socketPath?: string | undefined
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (
      handler: PiHookEnvelopeHandler,
      context: PiHookListenerContext
    ) => Promise<PiHookListenerHandle>
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

export function createPiTuiTmuxDriver(options: PiTuiTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: PiHookListenerHandle | undefined
  let hookDrain: Promise<void> = Promise.resolve()
  let paneController: TmuxPaneController | undefined
  let activeTurnId: string | undefined
  let turnCounter = 0

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

  async function deliverInput(input: InvocationInput): Promise<void> {
    requireCtx()
    requireSurface()
    const controller = requirePaneController()
    await controller.sendLiteral(extractText(input))
    await sleep(INPUT_SUBMIT_GAP_MS)
    await controller.sendEnter()
  }

  return {
    kind: PI_TUI_TMUX_DRIVER_KIND,
    version: PI_TUI_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return PI_TUI_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      const leased = await consumePaneLease(driverCtx, {
        driverKind: PI_TUI_TMUX_DRIVER_KIND,
        ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
      })

      ctx = driverCtx
      paneController = leased.controller
      surface = leased.surface

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      const normalizer: PiTuiTmuxHookEventNormalizer = createPiTuiTmuxHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
        allocateTurnId,
      })
      hookDrain = Promise.resolve()
      const handleHookEnvelope = (envelope: PiTuiTmuxHookEnvelope): void => {
        if (envelope.invocationId !== driverCtx.invocationId) return
        if (
          expectedRuntimeId !== undefined &&
          envelope.runtimeId !== undefined &&
          envelope.runtimeId !== expectedRuntimeId
        ) {
          return
        }
        if (envelope.generation !== undefined && envelope.generation !== PI_HOOK_GENERATION) {
          return
        }
        if (hookListener !== undefined && envelope.callbackSocket !== hookListener.socketPath) {
          return
        }
        const effectiveEnvelope =
          envelope.turnId === undefined && activeTurnId !== undefined
            ? { ...envelope, turnId: activeTurnId }
            : envelope
        for (const event of normalizePiHookEnvelope(effectiveEnvelope, { normalizer })) {
          driverCtx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
          if (event.type === 'turn.started' && event.turnId !== undefined) {
            activeTurnId = event.turnId
          } else if (event.type === 'turn.completed' && activeTurnId === event.turnId) {
            activeTurnId = undefined
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
        { driver: { kind: PI_TUI_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      const hookCliPath = await writePiHookBridgeWrapper({
        callbackSocket: hookListener.socketPath,
        bridgeCommand: options.hooks.bridgeCommand,
      })
      const launchCommand = await buildLaunchCommandLine(spec, driverCtx, {
        callbackSocket: hookListener.socketPath,
        hookCliPath,
        ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
      })
      await paneController.sendPastedLine(launchCommand)
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      const turnId = allocateTurnId()
      activeTurnId = turnId
      await deliverInput(input)
      return { turnId: turnId as ApplyInputResult['turnId'] }
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
      await closeHookListener()
      surface = undefined
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await closeHookListener()
      ctx = undefined
      surface = undefined
      paneController = undefined
      activeTurnId = undefined
    },
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
    HARNESS_BROKER_HOOK_GENERATION: String(PI_HOOK_GENERATION),
    ...(hookEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: hookEnv.runtimeId } : {}),
  }
  const launch = await writeTmuxLaunchExecFiles(`${hookEnv.callbackSocket}.pi`, {
    argv: [spec.process.command, ...spec.process.args],
    cwd: spec.process.cwd,
    env,
    ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
  })
  return launch.commandLine
}

const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker pi-hook'

async function writePiHookBridgeWrapper(options: {
  callbackSocket: string
  bridgeCommand?: string | undefined
}): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND
  const wrapperPath = `${options.callbackSocket}.pi-hook.ts`
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
      '  process.stderr.write(`pi-hook wrapper failed: ${error instanceof Error ? error.message : String(error)}\\n`)',
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

export function createDefaultPiTuiTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker')
): Driver {
  return createPiTuiTmuxDriver({
    tmux: {},
    hooks: {
      listen: (handler, context) =>
        listenForHookEnvelopes<PiTuiTmuxHookEnvelope>(
          buildPiHookSocketPath(socketDir, context),
          handler
        ),
    },
  })
}

export function buildPiHookSocketPath(socketDir: string, context: PiHookListenerContext): string {
  return buildHookSocketPath(socketDir, 'pi-hooks', context)
}
