/**
 * muse-serve broker driver (T-08589, campaign P-00522).
 *
 * Serve-only, protocol-native, headless: owns a `muse serve` stdio child and
 * speaks MSP per the §3 contract table (spikes 2-7, probed live against muse
 * 1.3.0). No presentation files — the operator view comes from the broker
 * renderer (T-08590).
 *
 * Lifecycle: validate kind → prepare isolated HOME (prepare-home.ts) → spawn
 * with HOME/XDG overrides (isolated HOME is mandatory and cannot ride
 * lockedEnv — HOME is ambient-class, so the driver spawns directly with
 * buildProcessEnv composition plus the HOME override) → initialize (structural
 * schema gate, schema-compat.ts) → initialized → session/start|resume →
 * turn/start per input (broker owns queueing; never ifBusy) → turn/steer with the
 * expectedTurnId fence (an accepted steer absorbed after a native turn roll
 * re-arms to the absorbing turn instead of failing) → turn/interrupt for
 * broker interrupt.
 *
 * Owned-host consequence: serve grants this client the ONLY connection, so no
 * foreign turn can ever exist — turnActive tracking is exact and there is no
 * attribution machinery.
 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type {
  EventProvenance,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  MuseServeDriverSpec,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode as BrokerCodes } from 'spaces-harness-broker-protocol'
import { museHomeEnv, prepareMuseHome } from 'spaces-harness-muse'
import type { CaptureNormalizer } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import { buildProcessEnv } from '../../runtime/env'
import { terminateProcess } from '../../runtime/signals'
import type {
  ApplyInputResult,
  BracketMintingMode,
  Driver,
  DriverContext,
  DriverStartResult,
  InterruptLandingEvidence,
  PreemptMode,
  SteerLandingEvidence,
} from '../driver'
import { hasChildHarnessProcess, withDeliveryEvidence } from '../driver'
import { MUSE_SERVE_AUTHORITY } from '../evidence-authority'
import { MUSE_CAPABILITIES } from './capabilities'
import { createMuseCaptureIngest } from './capture-ingest'
import { newMuseCommandId } from './command-id'
import { MUSE_DRIVER_KIND, mapMuseNotification } from './event-map'
import type { MappedEvent } from './event-map'
import { buildMuseTurnStartParams, extractMuseText } from './input'
import { createPermissionRequestIdAllocator, handleMuseApprovalRequest } from './permissions'
import type { PermissionRequestIdAllocator } from './permissions'
import { createMuseProseSegmenter } from './prose-segments'
import { type MuseRendererControlSlot, launchMuseRendererSurface } from './renderer-surface'
import { MuseRpcClient } from './rpc-client'
import type { MuseJsonRpcNotification, MuseJsonRpcRequest, MuseRpcPeer } from './rpc-client'
import { startMuseSession } from './session-startup'
import { createMuseSteerFence } from './steer'
import { findMuseWorkspaceSkillsDir } from './workspace'

export const MUSE_SERVE_DRIVER_VERSION = '0.1.0'

export interface MuseServeDriverOptions {
  /** Base dir for per-invocation isolated HOMEs. */
  homeBaseDir?: string | undefined
  /** Test-only override for the bounded renderer startup acknowledgement wait. */
  rendererStartAckTimeoutMs?: number | undefined
}

export function createMuseServeDriver(options: MuseServeDriverOptions = {}): Driver {
  let ctx: DriverContext | undefined
  let spec: HarnessInvocationSpec | undefined
  let driverSpec: MuseServeDriverSpec | undefined
  let proc: ChildProcessWithoutNullStreams | undefined
  let rpc: MuseRpcPeer | undefined
  let sessionId: string | undefined
  let currentInputId: InputId | undefined
  let currentTurnId: TurnId | undefined
  let turnActive = false
  let turnTimeout: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let starting = false
  let terminalEmitted = false
  let rendererQuitAccepted = false
  const rendererControl: MuseRendererControlSlot = { listener: undefined }
  let mintedForRecord = 0
  let activeProvenance: EventProvenance | undefined
  const proseSegments = createMuseProseSegmenter({ currentTurnId: () => currentTurnId })
  const permissionRequestIds: PermissionRequestIdAllocator = createPermissionRequestIdAllocator()
  let rejectStartup: ((error: Error) => void) | undefined

  function requireCtx(): DriverContext {
    if (!ctx) throw new BrokerError(BrokerCodes.InvalidInvocationState, 'Driver has not started')
    return ctx
  }

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

  function selfMintedProvenance(rawRecordId?: string): EventProvenance {
    return {
      ...(rawRecordId !== undefined ? { rawRecordId } : {}),
      sourceKind: 'broker',
      normalizer: { name: MUSE_DRIVER_KIND, version: MUSE_SERVE_DRIVER_VERSION },
    }
  }

  function emitCaptured<K extends InvocationEventType>(
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: Parameters<DriverContext['emit']>[2]
  ): ReturnType<DriverContext['emit']> {
    mintedForRecord += 1
    return requireCtx().emit(type, payload, {
      ...extra,
      provenance: activeProvenance ?? selfMintedProvenance(),
    })
  }

  function emitDiagnostic(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    extra?: Parameters<DriverContext['emit']>[2] & { data?: unknown }
  ): void {
    if (!ctx) return
    const { data, ...eventExtra } = extra ?? {}
    emitCaptured(
      'diagnostic',
      {
        level,
        message,
        source: 'driver',
        kind: MUSE_DRIVER_KIND,
        ...(data !== undefined ? { data } : {}),
      },
      eventExtra
    )
  }

  /**
   * Renderer `/quit` ends the session (codex-app-server precedent): clear the
   * continuation with the user-initiated reason, then terminate the serve
   * child. Downstream session-leave handling keys off
   * `continuation.cleared`/`prompt_input_exit` and is driver-agnostic, so
   * session-end metrics follow the same path as the codex renderer.
   */
  async function handleRendererQuit(): Promise<void> {
    if (rendererQuitAccepted || terminalEmitted) return
    rendererQuitAccepted = true
    stopping = true
    if (turnTimeout !== undefined) {
      clearTimeout(turnTimeout)
      turnTimeout = undefined
    }
    requireCtx().emit(
      'continuation.cleared',
      { reason: 'prompt_input_exit' },
      {
        driver: {
          kind: MUSE_DRIVER_KIND,
          rawType: 'muse-serve-renderer.quit',
        },
      }
    )
    if (proc !== undefined) {
      await terminateProcess({
        proc,
        graceMs: spec?.process.limits?.stopGraceMs ?? 1000,
      })
    }
    const listener = rendererControl.listener
    rendererControl.listener = undefined
    setTimeout(() => {
      void listener?.close().catch(() => undefined)
    }, 0)
  }

  const steerFence = createMuseSteerFence({ emitDiagnostic })

  function emitOne(event: MappedEvent, notification: MuseJsonRpcNotification): void {
    const extra = {
      ...(event.extra ?? {}),
      ...(currentInputId !== undefined &&
      (event.type === 'turn.started' ||
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted')
        ? { inputId: currentInputId }
        : {}),
      driver: { kind: MUSE_DRIVER_KIND, rawType: notification.method },
    }
    emitCaptured(
      event.type as 'diagnostic',
      event.payload as InvocationEventPayloadMap['diagnostic'],
      extra
    )
  }

  function emitMapped(notification: MuseJsonRpcNotification): void {
    const mapped = mapMuseNotification(notification, { onAgentText: steerFence.observeAgentText })
    for (const event of mapped) {
      proseSegments.route(event, (routed) => emitOne(routed, notification))
    }
  }

  function trackTurnLifecycle(notification: MuseJsonRpcNotification): void {
    if (notification.method === 'turn/started') {
      const params = (notification.params ?? {}) as Record<string, unknown>
      if (typeof params['turnId'] === 'string') {
        currentTurnId = params['turnId'] as TurnId
        turnActive = true
      }
      return
    }
    if (notification.method === 'turn/completed') {
      turnActive = false
      return
    }
    if (notification.method === 'turn/retracted') {
      const params = (notification.params ?? {}) as Record<string, unknown>
      steerFence.retractTurn(params['turnId'] as TurnId | undefined)
    }
  }

  /** Track and map one notification; returns how many events it minted. */
  function applyNotification(notification: MuseJsonRpcNotification): number {
    trackTurnLifecycle(notification)
    const before = mintedForRecord
    emitMapped(notification)
    return mintedForRecord - before
  }

  const captureIngest = createMuseCaptureIngest({
    getContext: () => ctx,
    getSessionId: () => sessionId,
    withProvenance,
    applyNotification,
    noteReplayedRequest: (method) => {
      emitCaptured('diagnostic', {
        level: 'debug',
        message: `muse-serve server request replayed without answer: ${method}`,
        source: 'driver',
        kind: MUSE_DRIVER_KIND,
      })
    },
  })

  async function answerServerRequest(
    request: MuseJsonRpcRequest,
    rawFrame: string | undefined
  ): Promise<unknown> {
    if (request.method === 'approval/request') {
      const requestRecordId = captureIngest.ingestApprovalRequest(request, rawFrame)
      const activeRpc = rpc
      if (!activeRpc) throw new BrokerError(BrokerCodes.InvalidInvocationState, 'RPC unavailable')
      const result = await handleMuseApprovalRequest(
        request,
        activeRpc,
        {
          ctx: requireCtx(),
          driver: driverSpec as MuseServeDriverSpec,
          currentTurnId,
          currentInputId,
          permissionRequestIds,
        },
        {
          requested: (payload) => {
            emitCaptured('permission.requested', payload, {
              turnId: currentTurnId,
              inputId: currentInputId,
              ...(requestRecordId !== undefined
                ? { provenance: selfMintedProvenance(requestRecordId) }
                : {}),
            })
          },
          resolved: (payload) => {
            emitCaptured('permission.resolved', payload, {
              turnId: currentTurnId,
              inputId: currentInputId,
              ...(requestRecordId !== undefined
                ? { provenance: selfMintedProvenance(requestRecordId) }
                : {}),
            })
          },
          diagnostic: (payload) => {
            emitCaptured('diagnostic', { ...payload, kind: MUSE_DRIVER_KIND })
          },
        }
      )
      return result
    }
    if (request.method === 'userInput/request') {
      emitDiagnostic(
        'warn',
        'muse-serve userInput/request has no broker question path; leaving to server auto-resolution'
      )
      return { presented: true }
    }
    throw new Error(`muse-serve cannot answer server request: ${request.method}`)
  }

  return {
    kind: MUSE_DRIVER_KIND,
    version: MUSE_SERVE_DRIVER_VERSION,
    bracketMintingMode: 'delivery-acknowledged' as BracketMintingMode,
    evidenceAuthority: MUSE_SERVE_AUTHORITY,
    nativeSourceKind: 'provider-jsonrpc',
    preemptMode: null as PreemptMode | null,
    steerLandingEvidence: 'transcript' as SteerLandingEvidence | null,
    interruptLandingEvidence: 'ack' as InterruptLandingEvidence | null,

    capabilities(): InvocationCapabilities {
      return MUSE_CAPABILITIES
    },

    captureNormalizer(): CaptureNormalizer {
      return captureIngest.normalizeCommitted
    },

    async start(
      startSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      if (startSpec.driver.kind !== MUSE_DRIVER_KIND) {
        throw new BrokerError(BrokerCodes.DriverUnavailable, 'Invalid muse-serve driver spec')
      }
      if (!hasChildHarnessProcess(startSpec)) {
        throw new BrokerError(
          BrokerCodes.DispatchValidationFailed,
          'muse-serve requires a child harness process'
        )
      }
      ctx = driverCtx
      spec = startSpec
      driverSpec = startSpec.driver as MuseServeDriverSpec
      const activeDriverSpec = driverSpec
      stopping = false
      starting = true
      terminalEmitted = false
      await rendererControl.listener?.close().catch(() => undefined)
      rendererControl.listener = undefined
      sessionId = undefined
      currentInputId = undefined
      currentTurnId = undefined
      turnActive = false
      steerFence.clear()
      proseSegments.reset()
      captureIngest.reset(driverCtx)

      try {
        await stat(startSpec.process.cwd)
      } catch (error) {
        throw new BrokerError(BrokerCodes.ResourceError, `Invalid cwd: ${startSpec.process.cwd}`, {
          cause: error instanceof Error ? error.message : String(error),
        })
      }

      const workspaceSkills = await findMuseWorkspaceSkillsDir(activeDriverSpec.workspace)

      const home = await prepareMuseHome(driverCtx.invocationId, {
        ...(workspaceSkills ? { workspaceSkillsDir: workspaceSkills } : {}),
        ...(options.homeBaseDir ? { homeBaseDir: options.homeBaseDir } : {}),
        ...(activeDriverSpec.homeMode !== undefined ? { homeMode: activeDriverSpec.homeMode } : {}),
      })
      for (const warning of home.warnings) {
        emitDiagnostic('warn', warning)
      }

      const command = activeDriverSpec.serveBin ?? startSpec.process.command
      const env = {
        ...buildProcessEnv({
          lockedEnv: startSpec.process.lockedEnv,
          ...(driverCtx.dispatchEnv !== undefined ? { dispatchEnv: driverCtx.dispatchEnv } : {}),
          pathPrepend: startSpec.process.pathPrepend,
        }),
        ...museHomeEnv(home),
      }
      const child = spawn(command, startSpec.process.args, {
        cwd: startSpec.process.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc = child as ChildProcessWithoutNullStreams
      proc.on('exit', (code, signal) => {
        if (code === 0) terminalEmitted = true
        if (!terminalEmitted && !stopping) {
          emitDiagnostic(
            'error',
            `muse serve exited unexpectedly: ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`
          )
        }
      })
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (line.trim().length > 0) emitDiagnostic('info', line)
      })

      rpc = new MuseRpcClient(proc, {
        onNotification: (notification, rawFrame) => {
          captureIngest.ingestNotification(notification, rawFrame)
        },
        onRequest: (request, rawFrame) => answerServerRequest(request, rawFrame),
        onError: (error) => {
          emitDiagnostic('error', `muse-serve RPC error: ${error.message}`)
          rejectStartup?.(error)
        },
      })

      sessionId = await startMuseSession({
        rpc,
        proc,
        spec: startSpec,
        driverSpec: activeDriverSpec,
        clientVersion: MUSE_SERVE_DRIVER_VERSION,
        serve: { command, env },
        isStarting: () => starting,
        onStartupRejecter: (reject) => {
          rejectStartup = reject
        },
        onSchemaDrift: (warning) => emitDiagnostic('warn', warning),
      })

      // Driver-owned renderer: when HRC hands this invocation a
      // terminal-surface pane lease, launch the muse renderer into the pane.
      const runtimeOverlay = driverCtx.runtime
      if (
        runtimeOverlay?.terminalSurface !== undefined ||
        runtimeOverlay?.terminalSurfaceRequired === true
      ) {
        await launchMuseRendererSurface({
          driverCtx,
          spec: startSpec,
          control: rendererControl,
          sessionReadyAt: performance.now(),
          ackTimeoutMs: options.rendererStartAckTimeoutMs,
          emit: emitCaptured,
          emitDiagnostic,
          onQuit: handleRendererQuit,
        })
      }

      requireCtx().emit('invocation.started', {
        ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
        command,
        args: startSpec.process.args,
        cwd: startSpec.process.cwd,
      })
      requireCtx().emit('continuation.updated', {
        provider: 'muse',
        kind: 'session',
        key: sessionId as string,
      })
      requireCtx().emit('invocation.ready', { state: 'ready' })
      starting = false
      rejectStartup = undefined
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      if (!rpc || !spec || !driverSpec || !sessionId) {
        throw new BrokerError(BrokerCodes.InvalidInvocationState, 'Invocation is not ready')
      }
      const activeRpc = rpc
      const activeSessionId = sessionId
      const inputId = input.inputId ?? (`input_${Date.now().toString(36)}` as InputId)
      currentInputId = inputId
      requireCtx().emit(
        'user.message',
        { content: extractMuseText(input), inputId, role: 'user' as const },
        { inputId, driver: { kind: MUSE_DRIVER_KIND, rawType: 'broker.input' } }
      )

      const turnTimeoutMs = spec.process.limits?.turnTimeoutMs
      let turnTimedOut = false
      if (turnTimeoutMs !== undefined && turnTimeoutMs > 0) {
        turnTimeout = setTimeout(() => {
          if (stopping || terminalEmitted) return
          turnTimedOut = true
          if (turnActive && currentTurnId) {
            requireCtx().emit(
              'turn.failed',
              {
                turnId: currentTurnId,
                message: 'Turn timed out',
                code: 'Timeout',
              },
              { turnId: currentTurnId, inputId: currentInputId }
            )
            turnActive = false
          }
          turnTimeout = setTimeout(() => {
            if (!stopping && !terminalEmitted) {
              rpc?.close(new Error('Turn timed out'))
            }
          }, 0)
        }, turnTimeoutMs)
      }

      const commandId = newMuseCommandId()
      let deliveredTurnId: TurnId | undefined
      try {
        await activeRpc.sendRequest<{ turnId?: string; disposition?: string }>(
          'turn/start',
          await buildMuseTurnStartParams({
            commandId,
            sessionId: activeSessionId,
            input,
            ...(driverSpec.reasoningEffort ? { reasoningEffort: driverSpec.reasoningEffort } : {}),
          }),
          (response) => {
            if (typeof response.turnId !== 'string') {
              throw new BrokerError(
                BrokerCodes.HarnessError,
                'muse turn/start response did not carry turnId'
              )
            }
            deliveredTurnId = response.turnId as TurnId
            currentTurnId = deliveredTurnId
            turnActive = true
          }
        )
      } catch (error) {
        if (turnTimeout !== undefined) clearTimeout(turnTimeout)
        turnTimeout = undefined
        if (turnTimedOut) {
          if (stopping || terminalEmitted) {
            return { ...(deliveredTurnId ? { turnId: deliveredTurnId } : {}) }
          }
          throw new BrokerError(BrokerCodes.Timeout, 'Turn timed out')
        }
        if (deliveredTurnId) return { turnId: deliveredTurnId }
        if (error instanceof BrokerError) throw error
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerCodes.HarnessError,
            error instanceof Error ? error.message : 'muse turn failed to start'
          ),
          'not_written'
        )
      }
      if (turnTimeout !== undefined) clearTimeout(turnTimeout)
      turnTimeout = undefined
      if (deliveredTurnId === undefined) {
        throw new BrokerError(
          BrokerCodes.HarnessError,
          'muse turn/start response completed without a correlated turn id'
        )
      }
      return { turnId: deliveredTurnId }
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      if (!rpc || !spec || !driverSpec || !sessionId) {
        throw withDeliveryEvidence(
          new BrokerError(BrokerCodes.InvalidInvocationState, 'Invocation is not ready'),
          'not_written'
        )
      }
      if (!turnActive || currentTurnId === undefined) {
        throw withDeliveryEvidence(
          new BrokerError(BrokerCodes.InvalidInvocationState, 'muse steer requires an active turn'),
          'not_written'
        )
      }
      if (input.inputId === undefined) {
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerCodes.DispatchValidationFailed,
            'muse steer requires a broker input id'
          ),
          'not_written'
        )
      }
      await steerFence.deliver({
        rpc,
        sessionId,
        turnId: currentTurnId,
        input: { ...input, inputId: input.inputId },
        onTurnRoll: (absorbingTurnId) => {
          currentTurnId = absorbingTurnId
          turnActive = true
        },
      })
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (req.scope !== 'turn') {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: 'muse invocation-scope interrupt is unsupported',
        }
      }
      if (!rpc || !sessionId || !turnActive || currentTurnId === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      const turnId = currentTurnId
      try {
        await rpc.sendRequest('turn/interrupt', {
          commandId: newMuseCommandId(),
          sessionId,
          turnId,
          retract: false,
        })
      } catch (error) {
        throw new BrokerError(
          BrokerCodes.HarnessError,
          error instanceof Error ? error.message : 'muse turn/interrupt failed'
        )
      }
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      stopping = true
      steerFence.clear()
      // A mid-turn stop cuts the transcript: held completions did arrive, so
      // flush them as non-final rather than dropping prose silently.
      for (const held of proseSegments.takeHeldAsNonFinal()) {
        requireCtx().emit('assistant.message.completed', held.payload as never, {
          driver: { kind: MUSE_DRIVER_KIND, rawType: 'stop' },
        })
      }
      if (turnTimeout !== undefined) {
        clearTimeout(turnTimeout)
        turnTimeout = undefined
      }
      if (!proc) {
        return { accepted: false, state: 'failed' }
      }
      await terminateProcess({
        proc,
        graceMs: req.graceMs ?? spec?.process.limits?.stopGraceMs ?? 1000,
      })
      return { accepted: true, state: terminalEmitted ? 'exited' : 'failed' }
    },

    async dispose(): Promise<void> {
      rpc?.close()
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM')
      }
      await rendererControl.listener?.close().catch(() => undefined)
      rendererControl.listener = undefined
      ctx = undefined
      spec = undefined
      driverSpec = undefined
      proc = undefined
      rpc = undefined
      sessionId = undefined
      currentInputId = undefined
      currentTurnId = undefined
      turnActive = false
      terminalEmitted = false
      rendererQuitAccepted = false
      stopping = false
      starting = false
      steerFence.clear()
    },
  }
}
