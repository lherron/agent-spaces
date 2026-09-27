import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { spawnHarnessProcess } from '../../runtime/process-runner'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { DriverContext, DriverStartResult } from '../driver'
import { hasChildHarnessProcess } from '../driver'
import {
  buildHookSocketPath,
  consumePaneLease,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
} from '../tmux-shared'
import { buildCodexTuiWrapperArgvPrefix } from './codex-tui-wrapper'
import type { CodexDriverControl } from './driver-control'
import type { CodexDriverEvents } from './driver-events'
import type { CodexDriverNormalizer } from './driver-normalize'
import type {
  CodexAppServerDriverOptions,
  CodexDriverState,
  RendererControlEnvelope,
} from './driver-state'
import {
  buildRendererControlSocketPath,
  codexTuiSocketDir,
  connectCodexTuiRpc,
  emitTerminalSurface,
  isCodexTuiSpec,
  readCodexTuiPid,
  resolveRendererObserverSocket,
  validateInitializeHandshake,
  writeCodexTuiHookBridgeWrapper,
} from './driver-support'
import type { PermissionHandlerContext, createPermissionRequestIdAllocator } from './permissions'
import { buildRendererLaunchCommand } from './renderer'
import { CodexRpcClient } from './rpc-client'

/** `start()`: transport + presentation bring-up, handshake and thread acquisition. */
export function createCodexDriverStart(
  s: CodexDriverState,
  options: CodexAppServerDriverOptions,
  permissionRequestIds: ReturnType<typeof createPermissionRequestIdAllocator>,
  events: CodexDriverEvents,
  control: CodexDriverControl,
  normalizer: CodexDriverNormalizer
) {
  const {
    rotateCaptureEpoch,
    requireCtx,
    emitDiagnostic,
    emitTerminalFailure,
    settleAllPendingSteers,
  } = events
  const {
    rendererEnvelopeMatchesFence,
    handleRendererQuit,
    handleAppServerStderr,
    handleRendererExited,
    startThread,
    ensureCodexHookTrust,
    startCodexTuiHookListener,
  } = control
  const { onNotification, handleServerRequest, onExit, handleRpcError } = normalizer

  async function start(
    startSpec: HarnessInvocationSpec,
    driverCtx: DriverContext
  ): Promise<DriverStartResult> {
    if (startSpec.driver.kind !== 'codex-app-server') {
      throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Codex driver spec')
    }
    if (!hasChildHarnessProcess(startSpec)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        'codex-app-server requires a child harness process'
      )
    }

    s.ctx = driverCtx
    s.spec = startSpec
    s.driverSpec = startSpec.driver as CodexAppServerDriverSpec
    const activeDriverSpec = s.driverSpec
    s.codexTui = isCodexTuiSpec(activeDriverSpec)
    if (s.codexTui && (activeDriverSpec.approvalPolicy ?? 'never') !== 'never') {
      emitDiagnostic('error', 'Codex TUI cannot attach while app-server approvals are enabled', {
        requiredApprovalPolicy: 'never',
        requestedApprovalPolicy: activeDriverSpec.approvalPolicy,
      })
      throw new BrokerError(
        BrokerErrorCode.CapabilityDenied,
        'Codex TUI presentation requires approvalPolicy=never'
      )
    }
    if (s.codexTui && activeDriverSpec.transport !== 'websocket-unix') {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        'Codex TUI presentation requires transport=websocket-unix'
      )
    }
    const expectedRuntimeId = getInvocationRuntimeId(startSpec)
    s.terminalEmitted = false
    s.startedEmitted = false
    s.stopping = false
    s.starting = true
    s.rendererQuitAccepted = false
    s.reportedTranscriptPaths.clear()
    s.ungatedFrames.length = 0
    s.pendingBrokerInputs.clear()
    settleAllPendingSteers('target-terminal')
    s.retiredSteerTurnsByInput.clear()
    s.observedUserItems.clear()
    s.queuedSubmissions.clear()
    s.attributionByTurn.clear()
    s.firstItemSeen.clear()
    s.attributionWaiters.clear()
    // A fresh app-server process is a fresh JSON-RPC stream, so its cursors
    // belong to a new epoch — never to the one a previous connection wrote.
    rotateCaptureEpoch(driverCtx)

    if (s.codexTui) {
      const leased = await consumePaneLease(driverCtx, {
        driverKind: 'codex-app-server',
        ...(options.codexTui?.tmuxBin !== undefined ? { tmuxBin: options.codexTui.tmuxBin } : {}),
        ...(options.codexTui?.tmuxExec !== undefined ? { exec: options.codexTui.tmuxExec } : {}),
      })
      s.paneController = leased.controller
      emitTerminalSurface(driverCtx, leased.surface)
      // HRC's leased tmux sockets live below a deliberately descriptive runtime
      // hierarchy. Deriving the app-server UDS from that directory exceeds
      // macOS SUN_LEN on real scopes, so the codex-tui transport gets a short,
      // identity-hashed /private/tmp broker namespace (Codex rejects macOS's
      // /tmp symlink as a socket directory). The headless renderer path below is
      // unchanged.
      const socketBase = buildHookSocketPath(
        options.codexTui?.socketDir ?? codexTuiSocketDir(),
        'hb-codex-tui',
        {
          invocationId: driverCtx.invocationId,
          runtimeId: expectedRuntimeId,
        }
      ).replace(/\.sock$/, '')
      const controlSocketPath = `${socketBase}.control.sock`
      const websocketPath = `${socketBase}.app.sock`
      s.websocketSocketPath = websocketPath
      s.attachTokenPath = `${socketBase}.attach`
      s.rendererControlListener = await listenForHookEnvelopes<RendererControlEnvelope>(
        controlSocketPath,
        async (envelope) => {
          if (!rendererEnvelopeMatchesFence(envelope, expectedRuntimeId)) return
          if (envelope.type === 'app-server-renderer.quit') {
            if (envelope.reason !== 'prompt_input_exit') return
            await handleRendererQuit()
            return
          }
          if (envelope.type === 'app-server-renderer.stderr') {
            handleAppServerStderr(envelope)
            return
          }
          handleRendererExited(envelope)
        }
      )
      s.hookListener = await startCodexTuiHookListener(
        driverCtx,
        expectedRuntimeId,
        options.codexTui?.socketDir
      )
      const hookCliPath = await writeCodexTuiHookBridgeWrapper(
        s.hookListener.socketPath,
        options.codexTuiLauncher
      )
      const launch = await writeTmuxLaunchExecFiles(
        `${socketBase}.codex-tui`,
        {
          argv: [
            ...buildCodexTuiWrapperArgvPrefix(options.codexTuiLauncher),
            '--command',
            startSpec.process.command,
            '--socket',
            websocketPath,
            '--attach-token',
            s.attachTokenPath,
            '--control-socket',
            s.rendererControlListener.socketPath,
            '--invocation-id',
            driverCtx.invocationId,
            ...(expectedRuntimeId !== undefined ? ['--runtime-id', expectedRuntimeId] : []),
          ],
          cwd: startSpec.process.cwd,
          env: {
            ...startSpec.process.lockedEnv,
            ...(driverCtx.dispatchEnv ?? {}),
            HRC_LAUNCH_HOOK_CLI: hookCliPath,
            HARNESS_BROKER_INVOCATION_ID: driverCtx.invocationId,
            HARNESS_BROKER_CALLBACK_SOCKET: s.hookListener.socketPath,
            HARNESS_BROKER_HOOK_GENERATION: '1',
            ...(expectedRuntimeId !== undefined
              ? { HARNESS_BROKER_RUNTIME_ID: expectedRuntimeId }
              : {}),
          },
          pathPrepend: startSpec.process.pathPrepend,
          ...(startSpec.launch !== undefined ? { prompts: startSpec.launch } : {}),
        },
        // T-08556: a release worker runs the launch runner from its own payload.
        options.codexTuiLauncher !== undefined
          ? { runner: { command: options.codexTuiLauncher.command, args: ['tmux-launch'] } }
          : {}
      )
      await leased.controller.sendPastedLine(launch.commandLine)
      s.rpc = await (options.codexTui?.connect ?? connectCodexTuiRpc)(websocketPath, {
        onNotification,
        onRequest: async (request, rawFrame) =>
          handleServerRequest(request, rawFrame, {
            ctx: requireCtx(),
            driver: activeDriverSpec,
            currentTurnId: s.currentTurnId,
            currentInputId: s.currentInputId,
            permissionRequestIds,
          }),
        onError: handleRpcError,
      })
    } else if (
      driverCtx.runtime?.terminalSurface !== undefined ||
      driverCtx.runtime?.terminalSurfaceRequired === true
    ) {
      const leased = await consumePaneLease(driverCtx, {
        driverKind: 'codex-app-server',
      })
      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-pane' as const,
          socketPath: leased.surface.socketPath,
          sessionId: leased.surface.sessionId,
          windowId: leased.surface.windowId,
          paneId: leased.surface.paneId,
          ...(leased.surface.sessionName !== undefined
            ? { sessionName: leased.surface.sessionName }
            : {}),
          ...(leased.surface.windowName !== undefined
            ? { windowName: leased.surface.windowName }
            : {}),
        },
        { driver: { kind: 'codex-app-server', rawType: 'tmux.surface' } }
      )

      const controlSocketPath = buildRendererControlSocketPath(
        driverCtx,
        leased.surface,
        expectedRuntimeId
      )
      s.rendererControlListener = await listenForHookEnvelopes<RendererControlEnvelope>(
        controlSocketPath,
        async (envelope) => {
          if (!rendererEnvelopeMatchesFence(envelope, expectedRuntimeId)) return
          if (envelope.type === 'app-server-renderer.quit') {
            if (envelope.reason !== 'prompt_input_exit') return
            await handleRendererQuit()
            return
          }
          if (envelope.type === 'app-server-renderer.exited') {
            handleRendererExited(envelope)
          }
        }
      )

      // Launch the DRIVER-OWNED renderer into the leased pane. The renderer is
      // a presentation/observation process: it reads the broker's DURABLE
      // event surface (invocation.eventsSince + live invocation.event), NOT a
      // driver-pushed feed, so it stays coherent with HRC attach/replay. The
      // app-server JSON-RPC child started below remains the harness transport;
      // this never routes through codex-cli-tmux.
      const observerSocketPath = resolveRendererObserverSocket(driverCtx, leased.surface)
      await leased.controller.sendPastedLine(
        buildRendererLaunchCommand({
          invocationId: driverCtx.invocationId,
          observerSocketPath,
          controlSocketPath: s.rendererControlListener.socketPath,
          ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
          ...(options.rendererLauncher !== undefined ? { launcher: options.rendererLauncher } : {}),
        })
      )
    }

    s.startupFailure = new Promise<never>((_resolve, reject) => {
      s.rejectStartup = reject
    })
    // Prevent unhandled rejection when startupFailure outlives the race
    s.startupFailure.catch(() => {})

    // Codex credentials live on disk (auth.json via CODEX_HOME, a lockedEnv
    // path) — the credentials channel is empty. Only the per-invocation
    // dispatchEnv rides alongside the lockedEnv from the spec.
    if (!s.codexTui) {
      s.proc = await spawnHarnessProcess(startSpec.process, {
        credentials: {},
        ...(driverCtx.dispatchEnv !== undefined ? { dispatchEnv: driverCtx.dispatchEnv } : {}),
      })
      s.proc.on('exit', onExit)
      createInterface({ input: s.proc.stderr }).on('line', (line) => {
        if (line.trim().length > 0) emitDiagnostic('info', line)
      })
      s.rpc = new CodexRpcClient(s.proc, {
        onNotification,
        onRequest: async (request, rawFrame) => {
          const permCtx: PermissionHandlerContext = {
            ctx: requireCtx(),
            driver: activeDriverSpec,
            currentTurnId: s.currentTurnId,
            currentInputId: s.currentInputId,
            permissionRequestIds,
          }
          return handleServerRequest(request, rawFrame, permCtx)
        },
        onError: handleRpcError,
      })
    }
    const rpcClient = s.rpc
    if (rpcClient === undefined) {
      throw new BrokerError(BrokerErrorCode.HarnessError, 'Codex RPC transport was not created')
    }

    // Wire startup timeout — timer starts when the first RPC is written,
    // so process boot time doesn't count against the limit.
    const startupTimeoutMs = startSpec.process.limits?.startupTimeoutMs
    let startupTimedOut = false
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let startedThreadId = ''

    function armStartupTimer(): void {
      if (startupTimer !== undefined) clearTimeout(startupTimer)
      if (startupTimeoutMs === undefined || startupTimeoutMs <= 0) return
      startupTimer = setTimeout(() => {
        if (!s.starting) return
        startupTimedOut = true
        emitTerminalFailure('Startup timed out', 'Timeout')
        s.rpc?.close(new Error('Startup timed out'))
        if (s.proc && s.proc.exitCode === null) s.proc.kill('SIGTERM')
        s.rejectStartup?.(new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out'))
      }, startupTimeoutMs)
    }

    try {
      armStartupTimer()
      const initializeResult = await withStartupRace(
        rpcClient.sendRequest('initialize', {
          clientInfo: { name: 'harness-broker', version: '0.1.0' },
          ...(s.codexTui ? { capabilities: { experimentalApi: true } } : {}),
        })
      )
      validateInitializeHandshake(initializeResult, emitDiagnostic)
      armStartupTimer() // re-arm after successful initialize
      await withStartupRace(rpcClient.sendNotification('initialized', {}))
      if (s.codexTui) await withStartupRace(ensureCodexHookTrust())
      armStartupTimer() // re-arm after initialized notification
      startedThreadId = await withStartupRace(startThread())
      s.threadId = startedThreadId
    } catch (startupErr) {
      if (startupTimer !== undefined) clearTimeout(startupTimer)
      if (startupTimedOut) {
        throw new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out')
      }
      throw startupErr
    }
    if (startupTimer !== undefined) clearTimeout(startupTimer)

    const startedPid = s.codexTui ? await readCodexTuiPid(s.websocketSocketPath) : s.proc?.pid
    requireCtx().emit('invocation.started', {
      ...(startedPid !== undefined ? { pid: startedPid } : {}),
      command: startSpec.process.command ?? process.execPath,
      args: startSpec.process.args,
      cwd: startSpec.process.cwd,
    })
    s.startedEmitted = true
    requireCtx().emit('continuation.updated', {
      provider: 'codex',
      kind: 'thread',
      key: startedThreadId,
    })
    if (s.codexTui && s.attachTokenPath !== undefined) {
      await writeFile(s.attachTokenPath, `${startedThreadId}\n`, 'utf8')
    }
    requireCtx().emit('invocation.ready', { state: 'ready' })
    s.starting = false
    s.rejectStartup = undefined
    s.startupFailure = undefined

    return { ok: true }
  }

  async function withStartupRace<T>(work: Promise<T>): Promise<T> {
    if (!s.startupFailure) return work
    // Attach no-op catch to both sides so the loser doesn't trigger unhandled rejection
    work.catch(() => {})
    return Promise.race([work, s.startupFailure])
  }

  return { start }
}
