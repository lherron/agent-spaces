import type {
  HarnessInvocationSpec,
  InvocationEventPayloadMap,
  InvocationEventType,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { TmuxPastedLineConfirmationError, type TmuxPastedLineDelivery } from '../../runtime/tmux'
import type { DriverContext } from '../driver'
import type { HookListenerHandle } from '../tmux-shared'
import {
  buildHookSocketPath,
  consumePaneLease,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
} from '../tmux-shared'
import { MUSE_DRIVER_KIND } from './event-map'
import { buildMuseRendererLaunchCommand, resolveMuseRendererLauncher } from './renderer'

const MUSE_RENDERER_START_ACK_TIMEOUT_MS = 5_000

/** Lifecycle envelopes the muse renderer posts to the driver control socket. */
interface MuseRendererControlEnvelope {
  type: string
  reason?: unknown
  invocationId?: unknown
  runtimeId?: unknown
  callbackSocket?: unknown
}

/** The driver-held control listener; the renderer's /quit may release it. */
export interface MuseRendererControlSlot {
  listener: HookListenerHandle | undefined
}

export interface MuseRendererSurfaceOptions {
  driverCtx: DriverContext
  spec: HarnessInvocationSpec
  control: MuseRendererControlSlot
  /** When the MSP session became ready; launch timings are reported against it. */
  sessionReadyAt: number
  ackTimeoutMs?: number | undefined
  emit: <K extends InvocationEventType>(
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: Parameters<DriverContext['emit']>[2]
  ) => void
  emitDiagnostic: (level: 'info' | 'error', message: string, extra: { data: unknown }) => void
  /** The renderer asked to end the session (`/quit`). */
  onQuit: () => Promise<void>
}

/**
 * Driver-owned renderer: when HRC hands this invocation a terminal-surface
 * pane lease, report the surface and launch the muse renderer into the pane,
 * refusing readiness until the renderer acknowledges startup on its control
 * socket. Presentation/observation only — the serve stdio child stays the
 * authoritative harness transport.
 */
export async function launchMuseRendererSurface(
  options: MuseRendererSurfaceOptions
): Promise<void> {
  const { driverCtx, control, sessionReadyAt } = options
  const observerSetupStartedAt = performance.now()
  const leased = await consumePaneLease(driverCtx, {
    driverKind: MUSE_DRIVER_KIND,
  })
  const leaseMs = elapsedMs(observerSetupStartedAt)
  options.emit(
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
      ...(leased.surface.windowName !== undefined ? { windowName: leased.surface.windowName } : {}),
    },
    { driver: { kind: MUSE_DRIVER_KIND, rawType: 'tmux.surface' } }
  )
  const expectedRuntimeId = getInvocationRuntimeId(options.spec)
  const controlSocketPath = buildHookSocketPath(
    socketDirOf(leased.surface),
    'muse-serve-renderer-control',
    { invocationId: driverCtx.invocationId, runtimeId: expectedRuntimeId }
  )
  let resolveRendererStarted: (() => void) | undefined
  let rejectRendererStarted: ((error: Error) => void) | undefined
  const rendererStarted = new Promise<void>((resolve, reject) => {
    resolveRendererStarted = resolve
    rejectRendererStarted = reject
  })
  // The promise is observed below after the command is sent. Register a
  // handler now so a fast renderer cannot race past readiness.
  rendererStarted.catch(() => undefined)
  const listenerStartedAt = performance.now()
  control.listener = await listenForHookEnvelopes<MuseRendererControlEnvelope>(
    controlSocketPath,
    async (envelope) => {
      if (envelope.invocationId !== driverCtx.invocationId) return undefined
      if (expectedRuntimeId !== undefined && envelope.runtimeId !== expectedRuntimeId) {
        return undefined
      }
      if (envelope.callbackSocket !== controlSocketPath) return undefined
      if (envelope.type === 'muse-serve-renderer.started') {
        resolveRendererStarted?.()
        return undefined
      }
      if (envelope.type === 'muse-serve-renderer.exited') {
        rejectRendererStarted?.(new Error('muse renderer exited before startup acknowledgement'))
        options.emitDiagnostic('info', 'muse renderer exited', { data: undefined })
        return undefined
      }
      if (envelope.type === 'muse-serve-renderer.quit') {
        if (envelope.reason !== 'prompt_input_exit') return undefined
        await options.onQuit()
        return undefined
      }
      return undefined
    }
  )
  const controlListenerMs = elapsedMs(listenerStartedAt)
  const rendererLauncher = resolveMuseRendererLauncher()
  let rendererDelivery: TmuxPastedLineDelivery | undefined
  let rendererAckMs: number | undefined
  try {
    const rendererLaunchStartedAt = performance.now()
    rendererDelivery = await leased.controller.sendPastedLine(
      buildMuseRendererLaunchCommand({
        invocationId: driverCtx.invocationId,
        observerSocketPath: resolveMuseRendererObserverSocket(driverCtx, leased.surface),
        controlSocketPath: control.listener.socketPath,
        ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
        ...(rendererLauncher !== undefined ? { launcher: rendererLauncher } : {}),
      }),
      {
        requireConfirmation: true,
        presentRetryPolicy: 'fresh-observer',
        submitConfirmation: 'none',
      }
    )
    await withAckTimeout(
      rendererStarted,
      options.ackTimeoutMs ?? MUSE_RENDERER_START_ACK_TIMEOUT_MS
    )
    rendererAckMs = elapsedMs(rendererLaunchStartedAt)
    options.emitDiagnostic('info', 'muse renderer launch confirmed', {
      data: {
        phase: 'muse_renderer_launch',
        postSessionMs: elapsedMs(sessionReadyAt),
        leaseMs,
        controlListenerMs,
        delivery: rendererDelivery,
        rendererAckMs,
      },
    })
  } catch (error) {
    const confirmation =
      error instanceof TmuxPastedLineConfirmationError
        ? { phase: error.phase, delivery: error.delivery }
        : undefined
    options.emitDiagnostic(
      'error',
      'muse renderer launch not confirmed; refusing invocation readiness',
      {
        data: {
          phase: 'muse_renderer_launch',
          postSessionMs: elapsedMs(sessionReadyAt),
          leaseMs,
          controlListenerMs,
          ...(rendererDelivery !== undefined ? { delivery: rendererDelivery } : {}),
          ...(rendererAckMs !== undefined ? { rendererAckMs } : {}),
          ...(confirmation !== undefined ? { confirmation } : {}),
        },
      }
    )
    await control.listener?.close().catch(() => undefined)
    control.listener = undefined
    throw error
  }
}

function withAckTimeout(started: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new BrokerError(BrokerErrorCode.Timeout, 'Muse renderer start acknowledgement timed out')
        ),
      timeoutMs
    )
    void started.then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function elapsedMs(since: number): number {
  return Math.round((performance.now() - since) * 10) / 10
}

function socketDirOf(surface: { socketPath: string }): string {
  return surface.socketPath.includes('/')
    ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
    : '.'
}

/**
 * Resolve the read-only observer/broker socket the muse renderer connects to
 * for the durable event surface. Mirrors the codex-app-server derivation:
 * HRC dispatch env first, then ambient env, then a conventional path beside
 * the leased tmux socket.
 */
function resolveMuseRendererObserverSocket(
  driverCtx: DriverContext,
  surface: { socketPath: string }
): string {
  const fromDispatch = driverCtx.dispatchEnv?.['HARNESS_BROKER_OBSERVER_SOCKET']
  if (typeof fromDispatch === 'string' && fromDispatch.length > 0) return fromDispatch
  const fromEnv = process.env['HARNESS_BROKER_OBSERVER_SOCKET']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return `${socketDirOf(surface)}/${driverCtx.invocationId}.observer.sock`
}
