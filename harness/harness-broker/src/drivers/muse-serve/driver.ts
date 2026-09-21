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
 * buildProcessEnv composition plus the HOME override) → initialize
 * (fingerprint-checked) → initialized → session/start|resume → turn/start per
 * input (broker owns queueing; never ifBusy) → turn/steer with the
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
  EventFamily,
  EventProvenance,
  RawProviderRecord,
} from 'spaces-harness-broker-protocol'
import type {
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
  MessageId,
  MuseServeDriverSpec,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode as BrokerCodes } from 'spaces-harness-broker-protocol'
import { museHomeEnv, prepareMuseHome } from 'spaces-harness-muse'
import type { PreparedMuseHome } from 'spaces-harness-muse'
import type { CaptureNormalizer, NormalizeOutcome } from '../../capture/capture-gate'
import type { CapturedRecord } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import { buildProcessEnv } from '../../runtime/env'
import { terminateProcess } from '../../runtime/signals'
import { TmuxPastedLineConfirmationError, type TmuxPastedLineDelivery } from '../../runtime/tmux'
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
import type { HookListenerHandle } from '../tmux-shared'
import {
  buildHookSocketPath,
  consumePaneLease,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
} from '../tmux-shared'
import { MUSE_CAPABILITIES } from './capabilities'
import { newMuseCommandId } from './command-id'
import { MUSE_DRIVER_KIND, classifyMuseNotificationMethod, mapMuseNotification } from './event-map'
import type { MappedEvent } from './event-map'
import { buildMuseTurnStartParams, extractMuseText } from './input'
import { createPermissionRequestIdAllocator, handleMuseApprovalRequest } from './permissions'
import type { PermissionRequestIdAllocator } from './permissions'
import { buildMuseRendererLaunchCommand, resolveMuseRendererLauncher } from './renderer'
import { MuseRpcClient } from './rpc-client'
import type { MuseJsonRpcNotification, MuseJsonRpcRequest, MuseRpcPeer } from './rpc-client'

export const MUSE_SERVE_DRIVER_VERSION = '0.1.0'

/**
 * Stable-surface fingerprint from the committed schema export
 * (`muse schema generate-json-schema`, muse 1.3.0 R3401.1). initialize results
 * carrying any other fingerprint fail startup — the SDK
 * checkServedFingerprint precedent. R3401.1 is additive over R3233.1 (goal,
 * subagent, task, view, workflow methods; session/listChanged); everything
 * the driver uses is unchanged.
 */
export const MSP_SCHEMA_FINGERPRINT =
  'sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81'

export interface MuseServeDriverOptions {
  /** Base dir for per-invocation isolated HOMEs. */
  homeBaseDir?: string | undefined
  /** Test-only override for the bounded renderer startup acknowledgement wait. */
  rendererStartAckTimeoutMs?: number | undefined
}

/** Lifecycle envelopes the muse renderer posts to the driver control socket. */
interface MuseRendererControlEnvelope {
  type: string
  reason?: unknown
  invocationId?: unknown
  runtimeId?: unknown
  callbackSocket?: unknown
}

const MUSE_RENDERER_START_ACK_TIMEOUT_MS = 5_000

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
  const dir = surface.socketPath.includes('/')
    ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
    : '.'
  return `${dir}/${driverCtx.invocationId}.observer.sock`
}

function buildMuseRendererControlSocketPath(
  driverCtx: DriverContext,
  surface: { socketPath: string },
  runtimeId: string | undefined
): string {
  const dir = surface.socketPath.includes('/')
    ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
    : '.'
  return buildHookSocketPath(dir, 'muse-serve-renderer-control', {
    invocationId: driverCtx.invocationId,
    runtimeId,
  })
}

interface PendingSteer {
  inputId: InputId
  sessionId: string
  turnId: TurnId
  nativeObserved: boolean
}

export function createMuseServeDriver(options: MuseServeDriverOptions = {}): Driver {
  let ctx: DriverContext | undefined
  let spec: HarnessInvocationSpec | undefined
  let driverSpec: MuseServeDriverSpec | undefined
  let proc: ChildProcessWithoutNullStreams | undefined
  let rpc: MuseRpcPeer | undefined
  let home: PreparedMuseHome | undefined
  let sessionId: string | undefined
  let currentInputId: InputId | undefined
  let currentTurnId: TurnId | undefined
  let turnActive = false
  let turnTimeout: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let starting = false
  let terminalEmitted = false
  let rendererQuitAccepted = false
  let rendererControlListener: HookListenerHandle | undefined
  let notificationSequence = 0
  let mintedForRecord = 0
  let activeProvenance: EventProvenance | undefined
  const pendingSteers = new Map<InputId, PendingSteer>()
  /**
   * Per-turn held assistant completion (codex-app-server precedent): an
   * agentMessage item/completed cannot know whether the turn holds more
   * prose, so the newest completion is held back while the previously held
   * one flushes as final:false; the turn terminal flushes the last held one
   * as final:true ahead of itself. Without the hold every message would
   * claim final:true and the intermediate/final split would be unobservable.
   */
  const heldAssistant = new Map<string, MappedEvent>()
  /**
   * Per-turn streamed prose runs. MSP streams assistant text as item/delta
   * fragments and finalizes at most one agentMessage item per turn, so
   * without segmentation a narrating turn would surface zero intermediate
   * completions. Each text-delta run accumulates here; the run flushes as
   * assistant.message.completed{final:false} at the next segment boundary
   * (tool start, next message start, or message completion) — verbatim
   * provider text, never synthesized prose.
   */
  const deltaRuns = new Map<string, string>()
  let deltaRunSeq = 0
  const ungatedFrames: string[] = []
  const permissionRequestIds: PermissionRequestIdAllocator = createPermissionRequestIdAllocator()
  let rejectStartup: ((error: Error) => void) | undefined

  function requireCtx(): DriverContext {
    if (!ctx) throw new BrokerError(BrokerCodes.InvalidInvocationState, 'Driver has not started')
    return ctx
  }

  function captureSourceKey(): string {
    return `muse-serve-rpc:${requireCtx().invocationId}`
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
    const listener = rendererControlListener
    rendererControlListener = undefined
    setTimeout(() => {
      void listener?.close().catch(() => undefined)
    }, 0)
  }

  function markSteerObserved(turnId: string, text: string): void {
    if (!text) return
    for (const pending of pendingSteers.values()) {
      if (pending.turnId === (turnId as TurnId)) pending.nativeObserved = true
    }
  }

  function turnKeyOf(event: MappedEvent): string {
    const extra = event.extra as { turnId?: unknown } | undefined
    if (typeof extra?.turnId === 'string') return extra.turnId
    return (currentTurnId ?? '') as string
  }

  function withFinal(event: MappedEvent, final: boolean): MappedEvent {
    if (event.type !== 'assistant.message.completed') return event
    return { ...event, payload: { ...event.payload, final } }
  }

  function flushDeltaRun(key: string, notification: MuseJsonRpcNotification): void {
    const run = deltaRuns.get(key) ?? ''
    deltaRuns.delete(key)
    if (run.trim().length === 0) return
    deltaRunSeq += 1
    emitOne(
      {
        type: 'assistant.message.completed',
        payload: {
          messageId: `${key}:run-${deltaRunSeq}` as MessageId,
          content: [{ type: 'text', text: run }],
          final: false,
        },
        extra: { turnId: key as TurnId },
      },
      notification
    )
  }

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

  function emitMapped(
    notification: MuseJsonRpcNotification,
    observer: { onAgentText?: ((turnId: string, text: string) => void) | undefined } = {}
  ): number {
    const mapped = mapMuseNotification(notification, {
      onAgentText: (turnId, text) => {
        markSteerObserved(turnId, text)
        observer.onAgentText?.(turnId, text)
      },
    })
    for (const event of mapped) {
      if (event.type === 'assistant.message.delta') {
        const key = turnKeyOf(event)
        const text = (event.payload as { text?: unknown }).text
        if (typeof text === 'string' && text.length > 0) {
          deltaRuns.set(key, (deltaRuns.get(key) ?? '') + text)
        }
        emitOne(event, notification)
        continue
      }
      if (event.type === 'assistant.message.started') {
        flushDeltaRun(turnKeyOf(event), notification)
        emitOne(event, notification)
        continue
      }
      if (event.type === 'assistant.message.completed') {
        const key = turnKeyOf(event)
        flushDeltaRun(key, notification)
        const previous = heldAssistant.get(key)
        if (previous !== undefined) emitOne(withFinal(previous, false), notification)
        heldAssistant.set(key, event)
        continue
      }
      if (
        event.type === 'tool.call.started' ||
        event.type === 'tool.call.completed' ||
        event.type === 'tool.call.failed'
      ) {
        const key = turnKeyOf(event)
        const previous = heldAssistant.get(key)
        if (previous !== undefined) {
          heldAssistant.delete(key)
          emitOne(withFinal(previous, false), notification)
        }
      }
      if (event.type === 'tool.call.started') {
        // Prose run before the tool call ends here; what streams after
        // belongs to the next segment.
        flushDeltaRun(turnKeyOf(event), notification)
      }
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
      ) {
        const key = turnKeyOf(event)
        deltaRuns.delete(key)
        const previous = heldAssistant.get(key)
        if (previous !== undefined) {
          heldAssistant.delete(key)
          emitOne(withFinal(previous, true), notification)
        }
      }
      emitOne(event, notification)
    }
    return mapped.length
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
      const retracted = params['turnId'] as TurnId | undefined
      for (const [inputId, pending] of pendingSteers) {
        if (pending.turnId === retracted) pendingSteers.delete(inputId)
      }
    }
  }

  function dispositionForMethod(method: string, minted: number): NormalizeOutcome {
    switch (classifyMuseNotificationMethod(method)) {
      case 'ignored-known':
        return { disposition: 'ignored-known', detail: method }
      case 'mapped':
        return minted > 0
          ? { disposition: 'normalized', detail: method }
          : { disposition: 'state-only', detail: method }
      default:
        return {
          disposition: 'blocked-unknown',
          family: 'diagnostic' as EventFamily,
          message: `Unknown muse-serve notification: ${method}`,
        }
    }
  }

  function decodeCommittedNotification(
    record: RawProviderRecord
  ): MuseJsonRpcNotification | undefined {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(record.rawBytes).toString('utf8'))
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const message = parsed as Record<string, unknown>
    if (typeof message['method'] !== 'string' || message['id'] !== undefined) return undefined
    return message as unknown as MuseJsonRpcNotification
  }

  const normalizeCommittedRecord: CaptureNormalizer = (captured: CapturedRecord) => {
    const decoded = decodeCommittedNotification(captured.record)
    if (decoded === undefined) {
      const asRequest = decodeCommittedRequest(captured.record)
      if (asRequest !== undefined) {
        return withProvenance(captured.provenance(), () => {
          emitCaptured('diagnostic', {
            level: 'debug',
            message: `muse-serve server request replayed without answer: ${asRequest.method}`,
            source: 'driver',
            kind: MUSE_DRIVER_KIND,
          })
          return { disposition: 'normalized', detail: asRequest.method }
        })
      }
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic' as EventFamily,
        message: `Committed raw record ${captured.record.rawRecordId} is not a muse-serve notification`,
      }
    }
    return withProvenance(captured.provenance(), () => {
      trackTurnLifecycle(decoded)
      const before = mintedForRecord
      emitMapped(decoded)
      return dispositionForMethod(decoded.method, mintedForRecord - before)
    })
  }

  function decodeCommittedRequest(record: RawProviderRecord): MuseJsonRpcRequest | undefined {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(record.rawBytes).toString('utf8'))
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const message = parsed as Record<string, unknown>
    if (typeof message['method'] !== 'string' || message['id'] === undefined) return undefined
    return message as unknown as MuseJsonRpcRequest
  }

  function ingestNotification(notification: MuseJsonRpcNotification, rawFrame: string): void {
    const capture = ctx?.capture
    if (capture === undefined) {
      ungatedFrames.push(rawFrame)
      trackTurnLifecycle(notification)
      const before = mintedForRecord
      emitMapped(notification)
      const outcome = dispositionForMethod(notification.method, mintedForRecord - before)
      if (outcome.disposition === 'blocked-unknown') {
        requireCtx().emit('capture.warning', {
          kind: 'blocked_unknown',
          message: outcome.message,
          raw: { native: rawFrame },
        })
      }
      return
    }
    notificationSequence += 1
    capture.ingest(
      {
        provider: 'meta',
        driverKind: MUSE_DRIVER_KIND,
        sourceKind: 'provider-jsonrpc',
        sourceKey: captureSourceKey(),
        sourceCursor: { nativeSequence: String(notificationSequence) },
        nativeType: notification.method,
        rawBytes: Buffer.from(rawFrame, 'utf8'),
        ...(sessionId !== undefined ? { correlationHints: { sessionId } } : {}),
      },
      normalizeCommittedRecord
    )
  }

  async function answerServerRequest(
    request: MuseJsonRpcRequest,
    rawFrame: string | undefined
  ): Promise<unknown> {
    const capture = ctx?.capture
    if (request.method === 'approval/request') {
      let requestRecordId: string | undefined
      if (capture !== undefined) {
        notificationSequence += 1
        let emitted = false
        capture.ingest(
          {
            provider: 'meta',
            driverKind: MUSE_DRIVER_KIND,
            sourceKind: 'provider-jsonrpc',
            sourceKey: captureSourceKey(),
            sourceCursor: { nativeSequence: String(notificationSequence) },
            nativeType: request.method,
            nativeId: String(request.id),
            rawBytes: Buffer.from(rawFrame ?? JSON.stringify(request), 'utf8'),
            ...(sessionId !== undefined ? { correlationHints: { sessionId } } : {}),
          },
          (captured) => {
            requestRecordId = captured.record.rawRecordId
            return withProvenance(captured.provenance(), () => {
              emitted = true
              return { disposition: 'normalized', detail: request.method }
            })
          }
        )
        void emitted
      }
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

  async function readSessionMcpConfig(
    workspace: string | undefined
  ): Promise<Record<string, unknown> | undefined> {
    if (!workspace) return undefined
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    for (const candidate of [
      join(workspace, 'muse.workspace', 'settings.json'),
      join(workspace, 'settings.json'),
    ]) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf-8')) as Record<string, unknown>
        const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers
        if (servers && typeof servers === 'object') return servers
      } catch {
        // Try the next candidate path.
      }
    }
    return undefined
  }

  function validateInitializeHandshake(result: unknown): void {
    const record = (result ?? {}) as Record<string, unknown>
    const schema = record['schema'] as Record<string, unknown> | undefined
    const fingerprint =
      typeof schema?.['fingerprint'] === 'string' ? schema['fingerprint'] : undefined
    if (fingerprint !== MSP_SCHEMA_FINGERPRINT) {
      throw new BrokerError(
        BrokerCodes.HarnessError,
        `muse-serve schema fingerprint mismatch: expected ${MSP_SCHEMA_FINGERPRINT}, got ${fingerprint ?? 'absent'}`
      )
    }
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
      return normalizeCommittedRecord
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
      await rendererControlListener?.close().catch(() => undefined)
      rendererControlListener = undefined
      sessionId = undefined
      currentInputId = undefined
      currentTurnId = undefined
      turnActive = false
      notificationSequence = 0
      pendingSteers.clear()
      heldAssistant.clear()
      deltaRuns.clear()
      deltaRunSeq = 0
      ungatedFrames.length = 0
      driverCtx.capture?.rotateEpoch(`muse-serve-rpc:${driverCtx.invocationId}`)

      try {
        await stat(startSpec.process.cwd)
      } catch (error) {
        throw new BrokerError(BrokerCodes.ResourceError, `Invalid cwd: ${startSpec.process.cwd}`, {
          cause: error instanceof Error ? error.message : String(error),
        })
      }

      const workspaceSkills = activeDriverSpec.workspace
        ? await (async () => {
            const { join } = await import('node:path')
            const { stat: statPath } = await import('node:fs/promises')
            for (const candidate of [
              join(activeDriverSpec.workspace as string, 'muse.workspace', 'skills'),
              join(activeDriverSpec.workspace as string, 'skills'),
            ]) {
              try {
                if ((await statPath(candidate)).isDirectory()) return candidate
              } catch {
                // Try the next candidate path.
              }
            }
            return undefined
          })()
        : undefined

      home = await prepareMuseHome(driverCtx.invocationId, {
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
          ingestNotification(notification, rawFrame)
        },
        onRequest: (request, rawFrame) => answerServerRequest(request, rawFrame),
        onError: (error) => {
          emitDiagnostic('error', `muse-serve RPC error: ${error.message}`)
          rejectStartup?.(error)
        },
      })

      const startupTimeoutMs = startSpec.process.limits?.startupTimeoutMs
      let startupTimer: ReturnType<typeof setTimeout> | undefined
      let startupTimedOut = false
      const startupFailure = new Promise<never>((_resolve, reject) => {
        rejectStartup = reject
      })
      startupFailure.catch(() => undefined)
      const armStartupTimer = (): void => {
        if (startupTimer !== undefined) clearTimeout(startupTimer)
        if (startupTimeoutMs === undefined || startupTimeoutMs <= 0) return
        startupTimer = setTimeout(() => {
          if (!starting) return
          startupTimedOut = true
          rpc?.close(new Error('Startup timed out'))
          if (proc && proc.exitCode === null) proc.kill('SIGTERM')
          rejectStartup?.(new BrokerError(BrokerCodes.Timeout, 'Startup timed out'))
        }, startupTimeoutMs)
      }
      const withStartupRace = <T>(work: Promise<T>): Promise<T> =>
        Promise.race([work, startupFailure]) as Promise<T>

      try {
        armStartupTimer()
        const initializeResult = await withStartupRace(
          (rpc as MuseRpcPeer).sendRequest('initialize', {
            // MSP ClientInfo.name is [a-z0-9_]+ (SS1.4.1) — hyphens are rejected.
            clientInfo: { name: 'harness_broker', version: MUSE_SERVE_DRIVER_VERSION },
          })
        )
        validateInitializeHandshake(initializeResult)
        armStartupTimer()
        await withStartupRace((rpc as MuseRpcPeer).sendNotification('initialized', {}))

        const mcpServers = await readSessionMcpConfig(activeDriverSpec.workspace)
        const resumeKey =
          activeDriverSpec.resumeSessionId ??
          (spec.continuation?.kind === 'session' ? spec.continuation.key : undefined)
        let startedSessionId: string | undefined
        if (resumeKey) {
          try {
            armStartupTimer()
            const resumed = (await withStartupRace(
              (rpc as MuseRpcPeer).sendRequest('session/resume', {
                commandId: newMuseCommandId(),
                sessionId: resumeKey,
              })
            )) as { session?: { sessionId?: string } }
            startedSessionId = resumed.session?.sessionId
          } catch (error) {
            if ((activeDriverSpec.resumeFallback ?? 'fail') === 'fail') throw error
            startedSessionId = undefined
          }
        }
        if (!startedSessionId) {
          armStartupTimer()
          const started = (await withStartupRace(
            (rpc as MuseRpcPeer).sendRequest('session/start', {
              commandId: newMuseCommandId(),
              workspaceRoot: startSpec.process.cwd,
              ...(activeDriverSpec.approvalMode
                ? { approvalMode: activeDriverSpec.approvalMode }
                : {}),
              ...(activeDriverSpec.model ? { modelId: activeDriverSpec.model } : {}),
              ...(mcpServers ? { config: { mcpServers } } : {}),
            })
          )) as { session?: { sessionId?: string } }
          startedSessionId = started.session?.sessionId
          if (!startedSessionId) {
            throw new BrokerError(
              BrokerCodes.HarnessError,
              'muse session/start returned no session id'
            )
          }
        }
        sessionId = startedSessionId
      } catch (startupError) {
        if (startupTimer !== undefined) clearTimeout(startupTimer)
        if (startupTimedOut) throw new BrokerError(BrokerCodes.Timeout, 'Startup timed out')
        throw startupError
      }
      if (startupTimer !== undefined) clearTimeout(startupTimer)

      const sessionReadyAt = performance.now()
      // Driver-owned renderer: when HRC hands this invocation a
      // terminal-surface pane lease, report the surface and launch the muse
      // renderer into the pane. Presentation/observation only — the serve
      // stdio child stays the authoritative harness transport.
      const runtimeOverlay = driverCtx.runtime
      if (
        runtimeOverlay?.terminalSurface !== undefined ||
        runtimeOverlay?.terminalSurfaceRequired === true
      ) {
        const observerSetupStartedAt = performance.now()
        const leased = await consumePaneLease(driverCtx, {
          driverKind: MUSE_DRIVER_KIND,
        })
        const leaseMs = Math.round((performance.now() - observerSetupStartedAt) * 10) / 10
        emitCaptured(
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
          { driver: { kind: MUSE_DRIVER_KIND, rawType: 'tmux.surface' } }
        )
        const expectedRuntimeId = getInvocationRuntimeId(startSpec)
        const controlSocketPath = buildMuseRendererControlSocketPath(
          driverCtx,
          leased.surface,
          expectedRuntimeId
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
        rendererControlListener = await listenForHookEnvelopes<MuseRendererControlEnvelope>(
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
              rejectRendererStarted?.(
                new Error('muse renderer exited before startup acknowledgement')
              )
              emitDiagnostic('info', 'muse renderer exited')
              return undefined
            }
            if (envelope.type === 'muse-serve-renderer.quit') {
              if (envelope.reason !== 'prompt_input_exit') return undefined
              await handleRendererQuit()
              return undefined
            }
            return undefined
          }
        )
        const controlListenerMs = Math.round((performance.now() - listenerStartedAt) * 10) / 10
        const observerSocketPath = resolveMuseRendererObserverSocket(driverCtx, leased.surface)
        const rendererLauncher = resolveMuseRendererLauncher()
        let rendererDelivery: TmuxPastedLineDelivery | undefined
        let rendererAckMs: number | undefined
        try {
          const rendererLaunchStartedAt = performance.now()
          rendererDelivery = await leased.controller.sendPastedLine(
            buildMuseRendererLaunchCommand({
              invocationId: driverCtx.invocationId,
              observerSocketPath,
              controlSocketPath: rendererControlListener.socketPath,
              ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
              ...(rendererLauncher !== undefined ? { launcher: rendererLauncher } : {}),
            }),
            {
              requireConfirmation: true,
              presentRetryPolicy: 'fresh-observer',
              submitConfirmation: 'none',
            }
          )
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () =>
                reject(
                  new BrokerError(
                    BrokerCodes.Timeout,
                    'Muse renderer start acknowledgement timed out'
                  )
                ),
              options.rendererStartAckTimeoutMs ?? MUSE_RENDERER_START_ACK_TIMEOUT_MS
            )
            void rendererStarted.then(
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
          rendererAckMs = Math.round((performance.now() - rendererLaunchStartedAt) * 10) / 10
          emitDiagnostic('info', 'muse renderer launch confirmed', {
            data: {
              phase: 'muse_renderer_launch',
              postSessionMs: Math.round((performance.now() - sessionReadyAt) * 10) / 10,
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
          emitDiagnostic(
            'error',
            'muse renderer launch not confirmed; refusing invocation readiness',
            {
              data: {
                phase: 'muse_renderer_launch',
                postSessionMs: Math.round((performance.now() - sessionReadyAt) * 10) / 10,
                leaseMs,
                controlListenerMs,
                ...(rendererDelivery !== undefined ? { delivery: rendererDelivery } : {}),
                ...(rendererAckMs !== undefined ? { rendererAckMs } : {}),
                ...(confirmation !== undefined ? { confirmation } : {}),
              },
            }
          )
          await rendererControlListener?.close().catch(() => undefined)
          rendererControlListener = undefined
          throw error
        }
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
      const activeRpc = rpc
      const activeSessionId = sessionId
      const steerInputId = input.inputId
      const steerTurnId = currentTurnId
      const pendingSteer: PendingSteer = {
        inputId: steerInputId,
        sessionId: activeSessionId,
        turnId: steerTurnId,
        nativeObserved: false,
      }
      pendingSteers.set(steerInputId, pendingSteer)
      try {
        const response = await activeRpc.sendRequest<{ turnId?: string }>('turn/steer', {
          commandId: newMuseCommandId(),
          sessionId: activeSessionId,
          expectedTurnId: steerTurnId,
          input: await buildMuseTurnStartParams({
            commandId: newMuseCommandId(),
            sessionId: activeSessionId,
            input,
          }).then((params) => params['input']),
        })
        const absorbedTurnId =
          typeof response?.turnId === 'string' && response.turnId.length > 0
            ? (response.turnId as TurnId)
            : undefined
        if (absorbedTurnId === undefined) {
          emitDiagnostic(
            'error',
            'muse turn/steer response conflicts with the armed turn identity',
            {
              turnId: steerTurnId,
              inputId: steerInputId,
              driver: { kind: MUSE_DRIVER_KIND, rawType: 'turn/steer' },
            }
          )
          throw withDeliveryEvidence(
            new BrokerError(
              BrokerCodes.HarnessError,
              'muse turn/steer response did not match the armed turn'
            ),
            'possibly_written'
          )
        }
        if (absorbedTurnId !== steerTurnId) {
          // Native turn roll: the armed turn ended server-side between the
          // admission check and the steer landing, and muse absorbed the
          // input into the now-running turn (TurnSteerResult.turnId is "the
          // running turn that absorbed the input"). The text did not leak —
          // it landed in a known turn — so re-arm to the absorbing turn and
          // report delivery instead of failing the input.
          currentTurnId = absorbedTurnId
          turnActive = true
          emitDiagnostic('info', 'muse turn/steer absorbed after native turn roll', {
            turnId: absorbedTurnId,
            inputId: steerInputId,
            driver: { kind: MUSE_DRIVER_KIND, rawType: 'turn/steer' },
          })
        }
      } catch (error) {
        if (pendingSteer.nativeObserved) {
          emitDiagnostic('error', 'muse turn/steer RPC failed after native transcript entry', {
            turnId: steerTurnId,
            inputId: steerInputId,
            driver: { kind: MUSE_DRIVER_KIND, rawType: 'turn/steer' },
          })
        }
        if (error !== null && typeof error === 'object' && 'deliveryEvidence' in error) {
          throw error
        }
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerCodes.HarnessError,
            error instanceof Error ? error.message : 'muse turn/steer failed'
          ),
          'possibly_written'
        )
      }
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
      pendingSteers.clear()
      // A mid-turn stop cuts the transcript: held completions did arrive, so
      // flush them as non-final rather than dropping prose silently.
      for (const held of heldAssistant.values()) {
        requireCtx().emit('assistant.message.completed', withFinal(held, false).payload as never, {
          driver: { kind: MUSE_DRIVER_KIND, rawType: 'stop' },
        })
      }
      heldAssistant.clear()
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
      await rendererControlListener?.close().catch(() => undefined)
      rendererControlListener = undefined
      ctx = undefined
      spec = undefined
      driverSpec = undefined
      proc = undefined
      rpc = undefined
      home = undefined
      sessionId = undefined
      currentInputId = undefined
      currentTurnId = undefined
      turnActive = false
      terminalEmitted = false
      rendererQuitAccepted = false
      stopping = false
      starting = false
      pendingSteers.clear()
      ungatedFrames.length = 0
    },
  }
}
