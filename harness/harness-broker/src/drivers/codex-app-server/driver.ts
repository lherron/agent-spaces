import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  CodexAppServerDriverSpec,
  EventProvenance,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationEvent,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  RawProviderRecord,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  emitProviderTranscriptReported,
} from 'spaces-harness-broker-protocol'
import type { CaptureNormalizer, NormalizeOutcome } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import { spawnHarnessProcess } from '../../runtime/process-runner'
import { terminateProcess } from '../../runtime/signals'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { CODEX_APP_SERVER_AUTHORITY } from '../evidence-authority'
import {
  type HookListenerHandle,
  buildHookSocketPath,
  consumePaneLease,
  extractText,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
} from '../tmux-shared'
import { CODEX_CAPABILITIES } from './capabilities'
import {
  CODEX_DRIVER_KIND,
  classifyCodexNotificationMethod,
  codexUnknownMethodFamily,
  createCodexNotificationMapper,
  parseCodexError,
} from './event-map'
import { buildCodexInput, buildTurnStartParams } from './input'
import {
  type OpenedPermissionRequest,
  type PermissionHandlerContext,
  createPermissionRequestIdAllocator,
  openPermissionRequest,
  permissionRequestedPayload,
  resolvePermissionRequest,
} from './permissions'
import { buildRendererLaunchCommand } from './renderer'
import {
  CodexRpcClient,
  CodexRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './rpc-client'

const CODEX_APP_SERVER_DRIVER_VERSION = '0.1.0'

const bunRuntime =
  typeof Bun !== 'undefined' ? (Bun as unknown as { execPath?: string }) : undefined
if (bunRuntime !== undefined && bunRuntime.execPath === undefined) {
  Object.defineProperty(Bun, 'execPath', {
    value: process.execPath,
    configurable: true,
  })
}

interface ThreadResponse {
  threadId?: string | undefined
  thread?: { id?: string | undefined } | undefined
}

interface TurnStartResponse {
  turn?: { id?: string | undefined } | undefined
}

type ChildProcess = Awaited<ReturnType<typeof spawnHarnessProcess>>
type DriverEventExtra = NonNullable<Parameters<DriverContext['emit']>[2]>

interface TurnFailure {
  message: string
  code: string
  data?: unknown
  retryable?: boolean | undefined
  reason?: string | undefined
}

type RendererControlEnvelope =
  | {
      type: 'app-server-renderer.quit'
      invocationId?: string | undefined
      runtimeId?: string | undefined
      callbackSocket?: string | undefined
      reason?: string | undefined
    }
  | {
      type: 'app-server-renderer.exited'
      invocationId?: string | undefined
      runtimeId?: string | undefined
      callbackSocket?: string | undefined
      exitCode?: number | null | undefined
      signal?: NodeJS.Signals | string | null | undefined
    }

export function createCodexAppServerDriver(): Driver {
  let ctx: DriverContext | undefined
  let spec: HarnessInvocationSpec | undefined
  let driverSpec: CodexAppServerDriverSpec | undefined
  let proc: ChildProcess | undefined
  let rpc: CodexRpcClient | undefined
  let threadId: string | undefined
  let currentInputId: InputId | undefined
  let currentTurnId: TurnId | undefined
  // The provider's `turn/start` response is the delivery acknowledgement. Its
  // id is therefore the ONLY id applyInputNow may return and the native
  // `turn/started` record may open a bracket under.
  let acknowledgedTurnId: TurnId | undefined
  let turnActive = false
  let startedEmitted = false
  let terminalEmitted = false
  let stopping = false
  let starting = false
  let rejectStartup: ((error: Error) => void) | undefined
  let startupFailure: Promise<never> | undefined
  let turnTimeout: ReturnType<typeof setTimeout> | undefined
  let rendererControlListener: HookListenerHandle | undefined
  let rendererQuitAccepted = false
  // Provider-transcript provenance state (T-05374, T-07868). The exported
  // sidecar is now a PROJECTION of the committed raw journal rather than a
  // parallel write, so there is no path on which it can hold a row the journal
  // does not. `reportedTranscriptPaths` still fences provenance emission to
  // at-most-once per concrete absolute path per invocation.
  const reportedTranscriptPaths = new Set<string>()
  /**
   * Verbatim frames observed while NO capture gate is wired — the isolated
   * driver unit harness. That mode has no journal at all, so this is the only
   * copy of the evidence rather than a second one; a gated invocation never
   * appends here (asserted by the driver tests).
   */
  const ungatedFrames: string[] = []
  const mapCodexNotification = createCodexNotificationMapper()
  const permissionRequestIds = createPermissionRequestIdAllocator()
  /**
   * Provenance of the committed raw record currently being normalized, stamped
   * onto every event that record produces (§7.2), plus the count of what it
   * minted — which is what decides `normalized` vs `state-only` for it (§6.1).
   * Both live at the single emit seam below so provenance and disposition
   * cannot drift apart per call site.
   */
  let activeProvenance: EventProvenance | undefined
  let mintedForRecord = 0
  /** Monotonic per-connection notification counter; the §7.1 source cursor. */
  let notificationSequence = 0

  /**
   * Run `body` with `provenance` active on {@link emitCaptured}. A stack rather
   * than a slot for the same reason the Claude driver's is: nothing may leak
   * one record's provenance onto what a later one mints.
   */
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

  /**
   * Provenance for a fact this driver MINTED rather than read off a committed
   * provider record: the stderr/lifecycle diagnostics and the thread-id
   * continuation. Under T-07870 a `provider-*` claim must name a record, and
   * these have none to name — the broker-side path is what produced them, so
   * that is what they say. `rawRecordId` is carried when the mint is
   * nevertheless traceable to a committed record (the permission resolution).
   */
  function selfMintedProvenance(rawRecordId?: string): EventProvenance {
    return {
      ...(rawRecordId !== undefined ? { rawRecordId } : {}),
      sourceKind: 'broker',
      normalizer: { name: CODEX_DRIVER_KIND, version: CODEX_APP_SERVER_DRIVER_VERSION },
    }
  }

  /** The driver's emit seam for facts derived from a native notification. */
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

  function emitEventCaptured(
    event: InvocationEvent,
    extra?: Parameters<DriverContext['emitEvent']>[1]
  ): ReturnType<DriverContext['emitEvent']> {
    mintedForRecord += 1
    return requireCtx().emitEvent(event, {
      ...extra,
      provenance: activeProvenance ?? selfMintedProvenance(),
    })
  }

  /**
   * The rows the exported provider transcript is projected from. With a capture
   * gate that is the COMMITTED journal — the single source §7.1 makes
   * authoritative. Without one there is no journal, so the ungated frames are.
   */
  function transcriptRows(): string[] {
    const capture = ctx?.capture
    if (capture === undefined) return ungatedFrames
    return capture
      .records()
      .filter(
        (record) =>
          record.driverKind === CODEX_DRIVER_KIND && record.sourceKind === 'provider-jsonrpc'
      )
      .map((record) => Buffer.from(record.rawBytes).toString('utf8'))
  }

  /**
   * Emit `provider.transcript.reported` once the turn terminal has flushed,
   * after materializing the verifier-compatible JSONL export from the committed
   * rows. The file is rewritten in full on every turn terminal (it is derived,
   * not accumulated) while the EVENT stays fenced to one per concrete absolute
   * path, so a multi-turn invocation keeps a current file and re-reports
   * nothing.
   */
  function reportProviderTranscript(): void {
    const rows = transcriptRows()
    if (rows.length === 0) return
    const path = providerTranscriptPath(requireCtx())
    writeProviderTranscriptExport(path, rows)
    if (reportedTranscriptPaths.has(path)) return
    reportedTranscriptPaths.add(path)
    emitProviderTranscriptReported(
      requireCtx(),
      {
        kind: PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
        artifactPath: path,
        provider: 'codex',
      },
      {
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(currentInputId !== undefined ? { inputId: currentInputId } : {}),
        driver: { kind: 'codex-app-server', rawType: 'provider-transcript.sidecar' },
      }
    )
  }

  /**
   * Stable key for the physical source: the app-server JSON-RPC connection.
   * The THREAD id rides on `correlationHints` instead of keying the source,
   * because a thread replacement mid-connection is an epoch rotation on the
   * same stream — not a different stream — and §7.1 makes cursor comparison
   * valid only within an epoch either way.
   */
  function captureSourceKey(): string {
    return `codex-app-server-rpc:${requireCtx().invocationId}`
  }

  /**
   * Mint a new source epoch and restart the per-connection cursor (§7.1).
   *
   * Called from `start()`, which is the ONLY place this driver acquires a
   * JSON-RPC connection or a thread. Thread replacement therefore cannot happen
   * without passing through here: a resumed or fresh thread arrives with a new
   * app-server process, and a resume-fallback `thread/start` happens before the
   * first notification is ever committed. There is no second rotation site to
   * add — adding one would be unreachable code claiming to guard a case that
   * cannot occur.
   */
  function rotateCaptureEpoch(driverCtx: DriverContext): void {
    notificationSequence = 0
    driverCtx.capture?.rotateEpoch(`codex-app-server-rpc:${driverCtx.invocationId}`)
  }

  function requireCtx(): DriverContext {
    if (!ctx) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function emitDiagnostic(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown,
    extra?: DriverEventExtra
  ): void {
    emitCaptured(
      'diagnostic',
      {
        level,
        message,
        source: 'harness',
        ...(data !== undefined ? { data } : {}),
      },
      extra
    )
  }

  function emitTerminalFailure(
    message: string,
    code?: string,
    data?: unknown,
    retryable?: boolean,
    reason?: string
  ): void {
    if (terminalEmitted) return
    terminalEmitted = true
    emitCaptured('invocation.failed', {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  function activeTurnExtra(): DriverEventExtra {
    return {
      ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
      ...(currentInputId !== undefined ? { inputId: currentInputId } : {}),
      driver: { kind: 'codex-app-server' },
    }
  }

  function failActiveTurn(failure: TurnFailure): boolean {
    if (!turnActive || currentTurnId === undefined) return false
    emitCaptured(
      'turn.failed',
      {
        turnId: currentTurnId,
        status: 'failed',
        message: failure.message,
        code: failure.code,
        ...(failure.data !== undefined ? { data: failure.data } : {}),
        ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
        ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
      },
      activeTurnExtra()
    )
    turnActive = false
    if (turnTimeout !== undefined) {
      clearTimeout(turnTimeout)
      turnTimeout = undefined
    }
    reportProviderTranscript()
    return true
  }

  /**
   * Commit the verbatim JSON-RPC frame, then normalize it FROM THE COMMITTED
   * RECORD (T-07853 §5.2, §7.3 — the whole point of Phase 2: the live mapper no
   * longer consumes the parallel in-memory notification object). A crash
   * between the two leaves a `pending` raw row that `replayPending` re-drives
   * to exactly one normalized result.
   */
  function onNotification(notification: JsonRpcNotification, rawFrame?: string): void {
    const frame = rawFrame ?? JSON.stringify(canonicalFrame(notification))
    const capture = ctx?.capture
    if (capture === undefined) {
      // No capture gate (isolated driver unit harness): identical
      // classification, no journal — so nothing else would report a
      // blocked-unknown, and the frame is retained here for the export.
      ungatedFrames.push(frame)
      const outcome = normalizeNotification(notification)
      if (outcome.disposition === 'blocked-unknown') {
        requireCtx().emit(
          'capture.warning',
          { kind: 'blocked_unknown', message: outcome.message, raw: { native: frame } },
          { driver: { kind: 'codex-app-server', rawType: notification.method } }
        )
      }
      return
    }

    notificationSequence += 1
    const nativeId = nativeIdOf(notification)
    capture.ingest(
      {
        provider: 'openai',
        driverKind: CODEX_DRIVER_KIND,
        sourceKind: 'provider-jsonrpc',
        sourceKey: captureSourceKey(),
        sourceCursor: { nativeSequence: String(notificationSequence) },
        nativeType: notification.method,
        ...(nativeId !== undefined ? { nativeId } : {}),
        rawBytes: Buffer.from(frame, 'utf8'),
        ...(threadId !== undefined ? { correlationHints: { threadId } } : {}),
      },
      normalizeCommittedRecord
    )
  }

  /**
   * A server->client JSON-RPC REQUEST (T-07870 §4).
   *
   * These are permission asks, and until now they were the only provider input
   * this driver answered without committing: `permission.requested` claimed a
   * `provider-jsonrpc` source while naming no record, which is a claim nothing
   * on disk could confirm or refute. The frame is now committed exactly like a
   * notification, and the ask is minted from INSIDE that record's
   * normalization, so it names the bytes it came from.
   *
   * The ANSWER is not provider evidence — the broker (or its client) decides it,
   * asynchronously, after the record is dispositioned. It therefore carries
   * `sourceKind: 'broker'` while still naming the request record it answers, so
   * the audit pair stays followable in both directions.
   *
   * Note this driver answers EVERY server->client request through the permission
   * path (pre-existing behaviour: `permissionKind` falls back to `tool`), so the
   * record is always normalized rather than classified against a method table.
   */
  async function handleServerRequest(
    request: JsonRpcRequest,
    rawFrame: string | undefined,
    permCtx: PermissionHandlerContext
  ): Promise<unknown> {
    const opened: OpenedPermissionRequest = openPermissionRequest(request, permCtx)
    const extra = { turnId: permCtx.currentTurnId, inputId: permCtx.currentInputId }
    const frame = rawFrame ?? JSON.stringify(canonicalRequestFrame(request))
    const capture = ctx?.capture
    let requestRecordId: string | undefined

    if (capture === undefined) {
      // No capture gate (isolated driver unit harness): no journal exists, so
      // the ask has no record to name and says `broker` like every other
      // self-minted event here.
      ungatedFrames.push(frame)
      requireCtx().emit('permission.requested', permissionRequestedPayload(opened), {
        ...extra,
        provenance: selfMintedProvenance(),
      })
    } else {
      notificationSequence += 1
      capture.ingest(
        {
          provider: 'openai',
          driverKind: CODEX_DRIVER_KIND,
          sourceKind: 'provider-jsonrpc',
          sourceKey: captureSourceKey(),
          sourceCursor: { nativeSequence: String(notificationSequence) },
          nativeType: request.method,
          nativeId: String(request.id),
          rawBytes: Buffer.from(frame, 'utf8'),
          ...(threadId !== undefined ? { correlationHints: { threadId } } : {}),
        },
        (captured) => {
          requestRecordId = captured.record.rawRecordId
          return withProvenance(captured.provenance(), () => {
            emitCaptured('permission.requested', permissionRequestedPayload(opened), extra)
            return { disposition: 'normalized', detail: request.method }
          })
        }
      )
    }

    return resolvePermissionRequest(opened, permCtx, {
      resolved: (payload) => {
        requireCtx().emit('permission.resolved', payload, {
          ...extra,
          provenance: selfMintedProvenance(requestRecordId),
        })
      },
      diagnostic: (payload) => {
        requireCtx().emit('diagnostic', payload, {
          ...extra,
          provenance: selfMintedProvenance(requestRecordId),
        })
      },
    })
  }

  /**
   * The production normalizer. Live ingest and restart replay call THIS, so a
   * replayed record cannot take a different code path than a live one (§7.3).
   */
  const normalizeCommittedRecord: CaptureNormalizer = (captured) => {
    const decoded = decodeCommittedNotification(captured.record)
    if (decoded === undefined) {
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic',
        message: `Committed raw record ${captured.record.rawRecordId} is not a JSON-RPC notification`,
      }
    }
    return withProvenance(captured.provenance(), () => normalizeNotification(decoded))
  }

  /**
   * Disposition for the record whose normalization just ran (§6.1). Emission
   * alone cannot decide it — an unknown method also emits (a debug diagnostic)
   * — so the native method's classification is what separates a mapped record
   * from a reviewed-but-ignored one from a genuinely novel one.
   */
  function dispositionForMethod(method: string): NormalizeOutcome {
    switch (classifyCodexNotificationMethod(method)) {
      case 'ignored-known':
        return { disposition: 'ignored-known', detail: method }
      case 'mapped':
        return mintedForRecord > 0
          ? { disposition: 'normalized', detail: method }
          : { disposition: 'state-only', detail: method }
      default:
        return {
          disposition: 'blocked-unknown',
          family: codexUnknownMethodFamily(method),
          message: `Unknown Codex app-server notification: ${method}`,
        }
    }
  }

  function normalizeNotification(notification: JsonRpcNotification): NormalizeOutcome {
    if (notification.method === 'error') {
      const error = parseCodexError(notification.params)
      emitDiagnostic('error', error.message, error.data, activeTurnExtra())
      if (
        !failActiveTurn({
          message: error.message,
          code: error.code,
          data: error.data,
          ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
          ...(error.reason !== undefined ? { reason: error.reason } : {}),
        })
      ) {
        emitTerminalFailure(error.message, error.code, error.data, error.retryable, error.reason)
      }

      if (starting) {
        rejectStartup?.(
          new BrokerError(BrokerErrorCode.HarnessError, error.message, {
            code: error.code,
            data: error.data,
          })
        )
      }
      // The error path always mints (a diagnostic, plus a turn or invocation
      // terminal). It is a §6.1 disposition, not a special case outside the
      // classification.
      return { disposition: 'normalized', detail: 'error' }
    }

    // After any invocation-terminal event, drop further native events so a late
    // turn/completed (or any other notification) can never follow a terminal.
    // The drop keeps its semantics but is now a RECORDED disposition rather
    // than a silent skip: the bytes are committed and accounted for.
    if (terminalEmitted) {
      return {
        disposition: 'ignored-known',
        detail: `after-invocation-terminal:${notification.method}`,
      }
    }

    if (notification.method === 'turn/started') {
      const observedTurnId = turnStartedNotificationId(notification)
      if (acknowledgedTurnId === undefined || observedTurnId !== acknowledgedTurnId) {
        return {
          disposition: 'blocked-unknown',
          family: 'turn-bracket',
          message:
            acknowledgedTurnId === undefined
              ? `Codex turn/started arrived without a turn/start response id (observed ${observedTurnId ?? 'missing'})`
              : `Codex turn/start response id ${acknowledgedTurnId} does not match turn/started id ${observedTurnId ?? 'missing'}`,
        }
      }
    }

    for (const mapped of mapCodexNotification(notification)) {
      const isTurnTerminal =
        mapped.type === 'turn.completed' ||
        mapped.type === 'turn.failed' ||
        mapped.type === 'turn.interrupted'
      // Suppress a turn terminal for a turn that already reached a terminal
      // state (e.g. a turn-timeout turn.failed followed by a late turn/completed).
      if (isTurnTerminal && !turnActive) continue
      const extra =
        mapped.type === 'turn.started' || isTurnTerminal
          ? { ...mapped.extra, inputId: currentInputId }
          : mapped.extra
      const event = emitEventCaptured(mapped, extra)
      if (event.type === 'turn.started') {
        currentTurnId = event.turnId
        turnActive = true
      }
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
      ) {
        turnActive = false
        // Clear turn timeout on any turn termination
        if (turnTimeout !== undefined) {
          clearTimeout(turnTimeout)
          turnTimeout = undefined
        }
        // Turn terminal flushed: report the provider transcript provenance once
        // the raw rows (including this terminal notification) are durable.
        reportProviderTranscript()
      }
    }

    return dispositionForMethod(notification.method)
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!startedEmitted || terminalEmitted) {
      if (starting) {
        rejectStartup?.(
          new BrokerError(BrokerErrorCode.HarnessError, 'Harness process exited during startup', {
            exitCode: code,
            signal,
          })
        )
      }
      return
    }

    if (turnActive && currentTurnId !== undefined) {
      if (stopping) {
        requireCtx().emit(
          'turn.interrupted',
          {
            turnId: currentTurnId,
            status: 'interrupted',
          },
          { turnId: currentTurnId, inputId: currentInputId }
        )
        turnActive = false
      } else {
        const data = { exitCode: code, signal }
        emitDiagnostic(
          'error',
          'Codex app-server process exited during active turn',
          { code: 'codex_process_exit', ...data },
          activeTurnExtra()
        )
        failActiveTurn({
          message: 'Harness process exited during active turn',
          code: 'codex_process_exit',
          data,
          retryable: false,
          reason: 'process-exit',
        })
      }
    }

    terminalEmitted = true
    requireCtx().emit('invocation.exited', { exitCode: code, signal })
  }

  function closeRendererControlListener(): void {
    const listener = rendererControlListener
    rendererControlListener = undefined
    if (listener !== undefined) {
      void listener.close()
    }
  }

  function rendererEnvelopeMatchesFence(
    envelope: RendererControlEnvelope,
    expectedRuntimeId: string | undefined
  ): boolean {
    if (envelope.invocationId !== requireCtx().invocationId) return false
    if (expectedRuntimeId !== undefined && envelope.runtimeId !== expectedRuntimeId) return false
    if (
      rendererControlListener === undefined ||
      envelope.callbackSocket !== rendererControlListener.socketPath
    ) {
      return false
    }
    return true
  }

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
      { driver: { kind: 'codex-app-server', rawType: 'app-server-renderer.quit' } }
    )
    if (proc !== undefined) {
      await terminateProcess({
        proc,
        graceMs: spec?.process.limits?.stopGraceMs ?? 1000,
      })
    }
    setTimeout(closeRendererControlListener, 0)
  }

  function handleRendererExited(
    envelope: Extract<RendererControlEnvelope, { type: 'app-server-renderer.exited' }>
  ): void {
    if (rendererQuitAccepted || terminalEmitted) return
    emitDiagnostic('error', 'Codex app-server renderer exited unexpectedly', {
      exitCode: envelope.exitCode ?? null,
      signal: envelope.signal ?? null,
    })
  }

  async function startThread(): Promise<string> {
    if (!rpc || !spec || !driverSpec) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver is not initialized')
    }

    const resumeThreadId =
      driverSpec.resumeThreadId ??
      (spec.continuation?.provider === 'codex' ? spec.continuation.key : undefined)

    const startParams = buildThreadStartParams(spec, driverSpec)
    if (!resumeThreadId) {
      return extractThreadId(await rpc.sendRequest<ThreadResponse>('thread/start', startParams))
    }

    try {
      return extractThreadId(
        await rpc.sendRequest<ThreadResponse>('thread/resume', {
          ...startParams,
          threadId: resumeThreadId,
          history: null,
          path: null,
        })
      )
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error
      }

      if ((driverSpec.resumeFallback ?? 'start-fresh') === 'fail') {
        const message = error instanceof Error ? error.message : 'Thread not found'
        const code = error instanceof CodexRpcError ? extractErrorCode(error) : undefined
        emitDiagnostic('error', message, code !== undefined ? { code } : undefined)
        emitTerminalFailure(message, code)
        throw new BrokerError(BrokerErrorCode.HarnessError, message, { code })
      }

      requireCtx().emit('driver.notice', {
        message: `Codex thread ${resumeThreadId} was not found; starting a fresh thread`,
        code: 'resume_fallback_start_fresh',
        data: { missingThreadId: resumeThreadId },
      })
      return extractThreadId(await rpc.sendRequest<ThreadResponse>('thread/start', startParams))
    }
  }

  return {
    kind: 'codex-app-server',
    version: CODEX_APP_SERVER_DRIVER_VERSION,
    bracketMintingMode: 'delivery-acknowledged',
    evidenceAuthority: CODEX_APP_SERVER_AUTHORITY,
    nativeSourceKind: 'provider-jsonrpc',
    preemptMode: 'atomic',
    steerLandingEvidence: 'ack',
    interruptLandingEvidence: 'ack',

    capabilities(): InvocationCapabilities {
      return CODEX_CAPABILITIES
    },

    captureNormalizer(): CaptureNormalizer {
      return normalizeCommittedRecord
    },

    async start(
      startSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      if (startSpec.driver.kind !== 'codex-app-server') {
        throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Codex driver spec')
      }

      ctx = driverCtx
      spec = startSpec
      driverSpec = startSpec.driver as CodexAppServerDriverSpec
      const activeDriverSpec = driverSpec
      const expectedRuntimeId = getInvocationRuntimeId(startSpec)
      terminalEmitted = false
      startedEmitted = false
      stopping = false
      starting = true
      rendererQuitAccepted = false
      reportedTranscriptPaths.clear()
      ungatedFrames.length = 0
      // A fresh app-server process is a fresh JSON-RPC stream, so its cursors
      // belong to a new epoch — never to the one a previous connection wrote.
      rotateCaptureEpoch(driverCtx)

      if (
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
        rendererControlListener = await listenForHookEnvelopes<RendererControlEnvelope>(
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
            controlSocketPath: rendererControlListener.socketPath,
            ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
          })
        )
      }

      startupFailure = new Promise<never>((_resolve, reject) => {
        rejectStartup = reject
      })
      // Prevent unhandled rejection when startupFailure outlives the race
      startupFailure.catch(() => {})

      // Codex credentials live on disk (auth.json via CODEX_HOME, a lockedEnv
      // path) — the credentials channel is empty. Only the per-invocation
      // dispatchEnv rides alongside the lockedEnv from the spec.
      proc = await spawnHarnessProcess(startSpec.process, {
        credentials: {},
        ...(driverCtx.dispatchEnv !== undefined ? { dispatchEnv: driverCtx.dispatchEnv } : {}),
      })
      proc.on('exit', onExit)
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (line.trim().length > 0) {
          emitDiagnostic('info', line)
        }
      })

      const rpcClient = new CodexRpcClient(proc, {
        onNotification,
        onRequest: async (request, rawFrame) => {
          const permCtx: PermissionHandlerContext = {
            ctx: requireCtx(),
            driver: activeDriverSpec,
            currentTurnId,
            currentInputId,
            permissionRequestIds,
          }
          return handleServerRequest(request, rawFrame, permCtx)
        },
        onError: (error) => {
          if (starting) {
            rejectStartup?.(error)
            return
          }
          if (terminalEmitted || stopping) return
          const failure = classifyRpcFailure(error)
          emitDiagnostic('error', failure.message, failure.data, activeTurnExtra())
          failActiveTurn(failure)
          emitTerminalFailure(
            failure.message,
            failure.code,
            failure.data,
            failure.retryable,
            failure.reason
          )
          if (proc !== undefined && proc.exitCode === null) {
            proc.kill('SIGTERM')
          }
        },
      })
      rpc = rpcClient

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
          if (!starting) return
          startupTimedOut = true
          emitTerminalFailure('Startup timed out', 'Timeout')
          rpc?.close(new Error('Startup timed out'))
          if (proc && proc.exitCode === null) proc.kill('SIGTERM')
          rejectStartup?.(new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out'))
        }, startupTimeoutMs)
      }

      try {
        armStartupTimer()
        const initializeResult = await withStartupRace(
          rpcClient.sendRequest('initialize', {
            clientInfo: { name: 'harness-broker', version: '0.1.0' },
          })
        )
        validateInitializeHandshake(initializeResult, emitDiagnostic)
        armStartupTimer() // re-arm after successful initialize
        await withStartupRace(rpcClient.sendNotification('initialized', {}))
        armStartupTimer() // re-arm after initialized notification
        startedThreadId = await withStartupRace(startThread())
        threadId = startedThreadId
      } catch (startupErr) {
        if (startupTimer !== undefined) clearTimeout(startupTimer)
        if (startupTimedOut) {
          throw new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out')
        }
        throw startupErr
      }
      if (startupTimer !== undefined) clearTimeout(startupTimer)

      requireCtx().emit('invocation.started', {
        pid: proc.pid,
        command: startSpec.process.command ?? process.execPath,
        args: startSpec.process.args,
        cwd: startSpec.process.cwd,
      })
      startedEmitted = true
      requireCtx().emit('continuation.updated', {
        provider: 'codex',
        kind: 'thread',
        key: startedThreadId,
      })
      requireCtx().emit('invocation.ready', { state: 'ready' })
      starting = false
      rejectStartup = undefined
      startupFailure = undefined

      return { ok: true }
    },

    // Driver applies the input immediately — broker manager owns all policy,
    // disposition, and queue semantics. No policy or busy checks here.
    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      if (!rpc || !spec || !driverSpec || !threadId) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
      }

      const inputId = input.inputId ?? (`input_${Date.now().toString(36)}` as InputId)
      currentInputId = inputId
      requireCtx().emit(
        'user.message',
        {
          content: extractText(input),
          inputId,
          role: 'user' as const,
        },
        { inputId, driver: { kind: 'codex-app-server', rawType: 'broker.input' } }
      )

      // Wire turn timeout
      const turnTimeoutMs = spec.process.limits?.turnTimeoutMs
      let turnTimedOut = false

      if (turnTimeoutMs !== undefined && turnTimeoutMs > 0) {
        turnTimeout = setTimeout(() => {
          // Skip timeout if stopping/exited — the stop path handles turn teardown
          if (stopping || terminalEmitted) return
          turnTimedOut = true
          if (turnActive && currentTurnId) {
            requireCtx().emit(
              'turn.failed',
              {
                turnId: currentTurnId,
                status: 'failed',
                message: 'Turn timed out',
                code: 'Timeout',
              },
              { turnId: currentTurnId, inputId: currentInputId }
            )
            turnActive = false
          }
          // Defer the RPC close to the next event-loop turn so a concurrent
          // stop() (arriving from a same-tick timer) can pre-empt it.
          // stop() clears turnTimeout, cancelling this deferred close.
          turnTimeout = setTimeout(() => {
            if (!stopping && !terminalEmitted) {
              rpc?.close(new Error('Turn timed out'))
            }
          }, 0)
        }, turnTimeoutMs)
      }

      let deliveredTurnId: TurnId | undefined
      try {
        acknowledgedTurnId = undefined
        await rpc.sendRequest<TurnStartResponse>(
          'turn/start',
          buildTurnStartParams({
            threadId,
            cwd: spec.process.cwd,
            input,
            driver: driverSpec,
          }),
          (response, rawFrame) => {
            const responseTurnId = turnStartResponseId(response)
            if (responseTurnId === undefined) {
              throw new BrokerError(
                BrokerErrorCode.HarnessError,
                'Codex turn/start response did not carry turn.id',
                { rawFrame }
              )
            }
            // This callback runs synchronously in the JSON-RPC response
            // handler, before a following turn/started frame can normalize.
            acknowledgedTurnId = responseTurnId
            deliveredTurnId = responseTurnId
            currentTurnId = responseTurnId
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
          throw new BrokerError(BrokerErrorCode.Timeout, 'Turn timed out')
        }
        if (terminalEmitted || turnActive || stopping) {
          return { ...(deliveredTurnId ? { turnId: deliveredTurnId } : {}) }
        }
        if (error instanceof BrokerError) throw error
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'Codex turn failed to start'
        )
      }
      if (turnTimeout !== undefined) clearTimeout(turnTimeout)
      turnTimeout = undefined

      if (deliveredTurnId === undefined) {
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          'Codex turn/start response completed without a correlated turn id'
        )
      }
      return { turnId: deliveredTurnId }
    },

    /**
     * T-07155 — mid-turn steer via the app-server `turn/steer` RPC.
     *
     * The broker manager calls this only under `whenBusy: 'steer'` while a turn
     * is active; it owns all policy and disposition. This method's contract is
     * narrow: apply the text to the ACTIVE turn or throw. It never starts a
     * turn, never queues, and never resolves without having applied — a silent
     * resolve would report an order as delivered when it was not.
     *
     * `expectedTurnId` is the app-server's own active-turn precondition, so a
     * turn that ended in the race window fails the RPC instead of leaking the
     * text into an unrelated turn. It is a staleness fence only: duplicate
     * suppression is the caller's job (HRC's contribution ledger), because the
     * same turn stays active across a retry.
     */
    async applySteerNow(input: InvocationInput): Promise<void> {
      if (!rpc || !spec || !driverSpec || !threadId) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
      }
      if (!turnActive || currentTurnId === undefined) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'Codex steer requires an active turn'
        )
      }
      const steerTurnId = currentTurnId
      try {
        await rpc.sendRequest('turn/steer', {
          threadId,
          expectedTurnId: steerTurnId,
          input: buildCodexInput(input, driverSpec.defaultImageAttachments),
        })
      } catch (error) {
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'Codex turn/steer failed'
        )
      }
      // Mirror applyInputNow's user.message emission so the steered text is in
      // the transcript on the turn it actually joined, not a turn of its own.
      requireCtx().emit(
        'user.message',
        {
          content: extractText(input),
          inputId: input.inputId,
          role: 'user' as const,
        },
        {
          turnId: steerTurnId,
          ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
          driver: { kind: 'codex-app-server', rawType: 'broker.steer' },
        }
      )
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (req.scope !== 'turn') {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: 'Codex invocation-scope interrupt is unsupported',
        }
      }
      if (!rpc || !threadId || !turnActive || currentTurnId === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      const turnId = currentTurnId
      try {
        await rpc.sendRequest('turn/interrupt', { threadId, turnId })
      } catch (error) {
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'Codex turn/interrupt failed'
        )
      }
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      stopping = true
      closeRendererControlListener()
      // Clear any pending turn timeout; the stop takes precedence.
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
      closeRendererControlListener()
      reportedTranscriptPaths.clear()
      ungatedFrames.length = 0
      rpc?.close()
      ctx = undefined
      spec = undefined
      driverSpec = undefined
      proc = undefined
      rpc = undefined
      threadId = undefined
      currentInputId = undefined
      currentTurnId = undefined
      turnActive = false
      startedEmitted = false
      terminalEmitted = false
      stopping = false
      starting = false
      rendererQuitAccepted = false
    },
  }

  async function withStartupRace<T>(work: Promise<T>): Promise<T> {
    if (!startupFailure) return work
    // Attach no-op catch to both sides so the loser doesn't trigger unhandled rejection
    work.catch(() => {})
    return Promise.race([work, startupFailure])
  }
}

/**
 * Resolve the read-only observer/broker socket the renderer connects to for the
 * durable event surface. HRC supplies it via the
 * `HARNESS_BROKER_OBSERVER_SOCKET` dispatch/process env (the concrete read
 * endpoint seam); absent that, derive a conventional path beside the leased
 * tmux socket so the launch command always carries a concrete endpoint.
 */
function resolveRendererObserverSocket(
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

function classifyRpcFailure(error: Error): TurnFailure {
  const protocolFailure =
    error.message.startsWith('Failed to parse JSON-RPC message:') ||
    error.message.startsWith('Unexpected JSON-RPC response id:')
  const code = protocolFailure ? 'codex_rpc_protocol_error' : 'codex_rpc_transport_error'
  const causeCode = (error as Error & { code?: unknown }).code
  return {
    message: error.message.trim().length > 0 ? error.message : 'Codex app-server RPC failed',
    code,
    data: {
      code,
      fatal: true,
      errorName: error.name,
      ...(typeof causeCode === 'string' || typeof causeCode === 'number' ? { causeCode } : {}),
    },
    retryable: false,
    reason: 'transport-error',
  }
}

/**
 * Absolute path of the broker-owned provider-transcript export.
 *
 * The directory is taken from a broker-owned artifact root on `dispatchEnv`
 * (`HARNESS_BROKER_ARTIFACT_DIR`, supplied by HRC in production) when present;
 * otherwise it falls back to a deterministic, per-user broker-owned subtree
 * under the system temp root. The user fence matters on same-host multi-user
 * estates: one account must never inherit another account's unwritable temp
 * directory. The path is always ABSOLUTE and per-invocation.
 */
function providerTranscriptPath(ctx: DriverContext): string {
  const fromDispatch = ctx.dispatchEnv?.['HARNESS_BROKER_ARTIFACT_DIR']
  const dir =
    typeof fromDispatch === 'string' && fromDispatch.length > 0
      ? fromDispatch
      : DEFAULT_PROVIDER_TRANSCRIPT_DIR
  mkdirSync(dir, { recursive: true })
  return join(dir, `${ctx.invocationId}.provider-transcript.jsonl`)
}

/**
 * Materialize the verifier-compatible JSONL export from committed rows.
 *
 * Opened `'w'` and written whole: the export is DERIVED, so rewriting it from
 * the journal is what keeps the §7.1 invariant true by construction — it can
 * never hold a row the journal does not. Durability of the evidence itself is
 * the journal's job (it fsyncs every record before the normalizer sees it);
 * this fsync only makes the export readable to whoever follows the
 * `provider.transcript.reported` pointer.
 */
function writeProviderTranscriptExport(path: string, rows: string[]): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, rows.map((row) => `${row}\n`).join(''))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Re-encoded frame for a notification that arrived without its verbatim line
 * (only the in-process test harness, which calls `onNotification` directly).
 * The wire path always carries the provider's own bytes.
 */
function canonicalFrame(notification: JsonRpcNotification): Record<string, unknown> {
  return notification.params !== undefined
    ? { jsonrpc: '2.0', method: notification.method, params: notification.params }
    : { jsonrpc: '2.0', method: notification.method }
}

/** The same re-encode for a server->client REQUEST, which also carries an id. */
function canonicalRequestFrame(request: JsonRpcRequest): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: request.id,
    method: request.method,
    ...(request.params !== undefined ? { params: request.params } : {}),
  }
}

/**
 * Decode the COMMITTED record's bytes back into a notification. This is the
 * copy the normalizer reads — never the in-memory object the transport parsed —
 * so live normalization and replay are the same computation over the same
 * bytes. Returns undefined for a record that is not a JSON-RPC notification,
 * which the caller turns into a blocked-unknown rather than a silent drop.
 */
function decodeCommittedNotification(record: RawProviderRecord): JsonRpcNotification | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(record.rawBytes).toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const frame = parsed as Record<string, unknown>
  if (typeof frame['method'] !== 'string') return undefined
  return {
    jsonrpc: '2.0',
    method: frame['method'],
    ...(frame['params'] !== undefined ? { params: frame['params'] } : {}),
  }
}

/**
 * The notification's OWN id, when it carries one (§7.1 `nativeId`). The item id
 * wins over the turn id where both are present: it is the finer identity, and
 * the turn is already reachable through the event envelope's `turnId`.
 */
function nativeIdOf(notification: JsonRpcNotification): string | undefined {
  const params = asFrameRecord(notification.params)
  const item = asFrameRecord(params['item'])
  return (
    frameString(item['id']) ??
    frameString(params['itemId']) ??
    frameString(params['id']) ??
    frameString(params['turnId']) ??
    frameString(asFrameRecord(params['turn'])['id'])
  )
}

function asFrameRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function frameString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Deterministic broker-owned fallback root for provider transcripts. The root
 * is stable per OS user (vs `mkdtemp`) so artifacts remain discoverable while
 * sibling accounts cannot collide on ownership/permissions. HRC normally
 * overrides it with a runtime-owned artifact root via
 * `HARNESS_BROKER_ARTIFACT_DIR`.
 */
export function defaultProviderTranscriptDir(
  tempRoot = tmpdir(),
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
): string {
  return join(
    tempRoot,
    `spaces-harness-broker-provider-transcripts-${uid === null ? 'current-user' : `uid-${uid}`}`
  )
}

const DEFAULT_PROVIDER_TRANSCRIPT_DIR = defaultProviderTranscriptDir()

function buildRendererControlSocketPath(
  driverCtx: DriverContext,
  surface: { socketPath: string },
  runtimeId: string | undefined
): string {
  const dir = surface.socketPath.includes('/')
    ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
    : '.'
  return buildHookSocketPath(dir, 'codex-app-server-renderer-control', {
    invocationId: driverCtx.invocationId,
    runtimeId,
  })
}

type DiagnosticEmitter = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown
) => void

/**
 * Tolerantly validate the Codex `initialize` handshake response.
 *
 * - A clearly-unsupported `protocolVersion` (a string that does not carry the
 *   `codex-app-server/` namespace) is a hard failure: throw HarnessError so the
 *   broker fails the invocation predictably rather than driving an incompatible
 *   server.
 * - A present-but-non-string `protocolVersion`, or a non-object response, is
 *   suspicious but non-critical — emit a `warn` diagnostic and continue.
 * - A missing `protocolVersion` is loose-but-common (do not overfit to the fake
 *   server) — emit a `debug` diagnostic and continue.
 */
export function validateInitializeHandshake(
  result: unknown,
  emitDiagnostic: DiagnosticEmitter
): void {
  if (result === null || typeof result !== 'object') {
    emitDiagnostic('warn', 'Codex initialize response was not an object', {
      received: typeof result,
    })
    return
  }

  const protocolVersion = (result as Record<string, unknown>)['protocolVersion']
  if (typeof protocolVersion === 'string') {
    if (!protocolVersion.startsWith('codex-app-server/')) {
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        `Unsupported Codex app-server protocol version: ${protocolVersion}`,
        { protocolVersion }
      )
    }
    return
  }

  if (protocolVersion !== undefined) {
    emitDiagnostic('warn', 'Codex initialize protocolVersion was not a string', {
      received: typeof protocolVersion,
    })
    return
  }

  emitDiagnostic('debug', 'Codex initialize response omitted protocolVersion')
}

/**
 * Build `thread/start` params from the driver spec. Every driver-spec field is
 * either forwarded to the native call or deliberately handled elsewhere:
 *  - model / approvalPolicy / sandboxMode: forwarded here.
 *  - profile: forwarded here (Codex app-server selects a config profile).
 *  - modelReasoningEffort: forwarded as a thread-scope `config` override here
 *    AND applied per-turn in buildTurnStartParams(effort).
 *  - defaultImageAttachments: applied per-turn in buildTurnStartParams.
 *  - resumeThreadId / resumeFallback / permissionPolicy: consumed by the driver
 *    resume + permission paths, not by thread/start.
 */
export function buildThreadStartParams(
  spec: HarnessInvocationSpec,
  driver: CodexAppServerDriverSpec
): Record<string, unknown> {
  return {
    model: driver.model ?? null,
    modelProvider: null,
    profile: driver.profile ?? null,
    cwd: spec.process.cwd,
    approvalPolicy: driver.approvalPolicy ?? 'never',
    sandbox: driver.sandboxMode ?? null,
    config:
      driver.modelReasoningEffort !== undefined
        ? { model_reasoning_effort: driver.modelReasoningEffort }
        : null,
    baseInstructions: null,
    developerInstructions: null,
    experimentalRawEvents: false,
  }
}

function extractThreadId(response: ThreadResponse | undefined): string {
  const threadId = response?.threadId ?? response?.thread?.id
  if (!threadId) {
    throw new BrokerError(
      BrokerErrorCode.HarnessError,
      'Codex thread id missing after app-server thread start'
    )
  }
  return threadId
}

function turnStartResponseId(response: TurnStartResponse | undefined): TurnId | undefined {
  const turnId = response?.turn?.id
  return typeof turnId === 'string' && turnId.length > 0 ? (turnId as TurnId) : undefined
}

function turnStartedNotificationId(notification: JsonRpcNotification): TurnId | undefined {
  if (notification.params === null || typeof notification.params !== 'object') return undefined
  const params = notification.params as Record<string, unknown>
  const direct = params['turnId']
  if (typeof direct === 'string' && direct.length > 0) return direct as TurnId
  const turn = params['turn']
  if (turn === null || typeof turn !== 'object') return undefined
  const nested = (turn as Record<string, unknown>)['id']
  return typeof nested === 'string' && nested.length > 0 ? (nested as TurnId) : undefined
}

function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) {
    return false
  }
  const code = extractErrorCode(error)
  return code === 'thread_missing' || /not found|no rollout found/i.test(error.message)
}

function extractErrorCode(error: CodexRpcError): string | undefined {
  if (typeof error.data === 'string') return error.data
  if (error.data !== null && typeof error.data === 'object') {
    const data = error.data as Record<string, unknown>
    return typeof data['code'] === 'string' ? data['code'] : undefined
  }
  return undefined
}
