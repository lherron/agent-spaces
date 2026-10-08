import type {
  EventProvenance,
  InputId,
  InvocationEvent,
  InvocationEventPayloadMap,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  emitProviderTranscriptReported,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { DriverContext } from '../driver'
import {
  CODEX_APP_SERVER_DRIVER_VERSION,
  type CodexDriverState,
  type DriverEventExtra,
  type PendingSteer,
  type TurnFailure,
} from './driver-state'
import {
  asFrameRecord,
  frameString,
  providerTranscriptPath,
  writeProviderTranscriptRows,
} from './driver-support'
import { CODEX_DRIVER_KIND } from './event-map'
import type { JsonRpcNotification } from './rpc-client'

export type CodexDriverEvents = ReturnType<typeof createCodexDriverEvents>

/**
 * The driver's emit seam: provenance, capture epoch, transcript export,
 * steer settlement, turn attribution and turn/invocation terminals.
 */
export function createCodexDriverEvents(s: CodexDriverState) {
  /**
   * Run `body` with `provenance` active on {@link emitCaptured}. A stack rather
   * than a slot for the same reason the Claude driver's is: nothing may leak
   * one record's provenance onto what a later one mints.
   */
  function withProvenance<T>(provenance: EventProvenance, body: () => T): T {
    const previousProvenance = s.activeProvenance
    const previousMinted = s.mintedForRecord
    s.activeProvenance = provenance
    s.mintedForRecord = 0
    try {
      return body()
    } finally {
      s.activeProvenance = previousProvenance
      s.mintedForRecord = previousMinted
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
      normalizer: {
        name: CODEX_DRIVER_KIND,
        version: CODEX_APP_SERVER_DRIVER_VERSION,
      },
    }
  }

  /** The driver's emit seam for facts derived from a native notification. */
  function emitCaptured<K extends InvocationEventType>(
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: Parameters<DriverContext['emit']>[2]
  ): ReturnType<DriverContext['emit']> {
    s.mintedForRecord += 1
    return requireCtx().emit(type, payload, {
      ...extra,
      provenance: s.activeProvenance ?? selfMintedProvenance(),
    })
  }

  function emitEventCaptured(
    event: InvocationEvent,
    extra?: Parameters<DriverContext['emitEvent']>[1]
  ): ReturnType<DriverContext['emitEvent']> {
    s.mintedForRecord += 1
    return requireCtx().emitEvent(event, {
      ...extra,
      provenance: s.activeProvenance ?? selfMintedProvenance(),
    })
  }

  /**
   * Bring the export at `path` up to date and return its total row count. With
   * a capture gate the rows are the COMMITTED journal — the single source §7.1
   * makes authoritative — streamed past the cursor the last export reached.
   * Without one there is no journal, so the (small, test-only) ungated frames
   * are rewritten whole.
   */
  function exportProviderTranscript(path: string): number {
    const capture = s.ctx?.capture
    if (capture === undefined) {
      if (s.ungatedFrames.length === 0) return 0
      return writeProviderTranscriptRows(path, true, (write) => {
        for (const frame of s.ungatedFrames) write(frame)
      })
    }
    const prior = s.transcriptExport?.path === path ? s.transcriptExport : undefined
    let cursor = prior?.cursor
    const written = writeProviderTranscriptRows(path, prior === undefined, (write) => {
      cursor = capture.scanRecords((record) => {
        if (record.driverKind === CODEX_DRIVER_KIND && record.sourceKind === 'provider-jsonrpc') {
          write(record.rawBytes)
        }
      }, cursor)
    })
    const rows = (prior?.rows ?? 0) + written
    s.transcriptExport = { path, cursor: cursor ?? 0, rows }
    return rows
  }

  /**
   * Emit `provider.transcript.reported` once the turn terminal has flushed,
   * after bringing the verifier-compatible JSONL export up to date from the
   * committed rows. The EVENT stays fenced to one per concrete absolute path,
   * so a multi-turn invocation keeps a current file and re-reports nothing.
   *
   * This runs inside turn-terminal handling, so it must never throw there: an
   * export failure becomes a `capture.warning` and the next terminal rebuilds
   * the file whole (T-10581).
   */
  function reportProviderTranscript(): void {
    const ctx = requireCtx()
    let path: string | undefined
    let rows: number
    try {
      path = providerTranscriptPath(ctx)
      rows = exportProviderTranscript(path)
    } catch (error) {
      s.transcriptExport = undefined
      const detail = error instanceof Error ? error.message : String(error)
      ctx.emit(
        'capture.warning',
        {
          kind: 'provider_transcript_export_failed',
          message: `Codex provider transcript export failed: ${detail}`,
          raw: { ...(path !== undefined ? { artifactPath: path } : {}), error: detail },
        },
        { driver: { kind: 'codex-app-server', rawType: 'provider-transcript.sidecar' } }
      )
      return
    }
    if (rows === 0) return
    if (s.reportedTranscriptPaths.has(path)) return
    s.reportedTranscriptPaths.add(path)
    emitProviderTranscriptReported(
      ctx,
      {
        kind: PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
        artifactPath: path,
        provider: 'codex',
      },
      {
        ...(s.currentTurnId !== undefined ? { turnId: s.currentTurnId } : {}),
        ...(s.currentInputId !== undefined ? { inputId: s.currentInputId } : {}),
        driver: {
          kind: 'codex-app-server',
          rawType: 'provider-transcript.sidecar',
        },
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
    s.notificationSequence = 0
    driverCtx.capture?.rotateEpoch(`codex-app-server-rpc:${driverCtx.invocationId}`)
  }

  function requireCtx(): DriverContext {
    if (!s.ctx) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return s.ctx
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
    if (s.terminalEmitted) return
    s.terminalEmitted = true
    settleAllPendingSteers('target-terminal')
    emitCaptured('invocation.failed', {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  function settleAllPendingSteers(result: 'native-observed' | 'target-terminal'): void {
    for (const pendingSteer of s.pendingSteers.values()) {
      if (result === 'target-terminal') retirePendingSteer(pendingSteer)
      pendingSteer.settle(result)
    }
    s.pendingSteers.clear()
  }

  function retirePendingSteer(pendingSteer: PendingSteer): void {
    const retiredTurns = s.retiredSteerTurnsByInput.get(pendingSteer.inputId) ?? new Set<TurnId>()
    retiredTurns.add(pendingSteer.turnId)
    s.retiredSteerTurnsByInput.set(pendingSteer.inputId, retiredTurns)
  }

  function isRetiredSteerTurn(inputId: InputId, turnId: TurnId): boolean {
    return s.retiredSteerTurnsByInput.get(inputId)?.has(turnId) ?? false
  }

  function settlePendingSteersForTurn(turnId: TurnId): void {
    for (const [inputId, pendingSteer] of s.pendingSteers) {
      if (pendingSteer.turnId !== turnId) continue
      retirePendingSteer(pendingSteer)
      pendingSteer.settle('target-terminal')
      s.pendingSteers.delete(inputId)
    }
  }

  function activeTurnExtra(): DriverEventExtra {
    if (s.codexTui && s.currentTurnId !== undefined) return attributionExtra(s.currentTurnId)
    return {
      ...(s.currentTurnId !== undefined ? { turnId: s.currentTurnId } : {}),
      ...(s.currentInputId !== undefined ? { inputId: s.currentInputId } : {}),
      driver: { kind: 'codex-app-server' },
    }
  }

  function failActiveTurn(failure: TurnFailure): boolean {
    if (!s.turnActive || s.currentTurnId === undefined) return false
    emitCaptured(
      'turn.failed',
      {
        turnId: s.currentTurnId,
        status: 'failed',
        message: failure.message,
        code: failure.code,
        ...(failure.data !== undefined ? { data: failure.data } : {}),
        ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
        ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
      },
      activeTurnExtra()
    )
    settlePendingSteersForTurn(s.currentTurnId)
    if (s.codexTui && s.attributionByTurn.get(s.currentTurnId)?.ownership === 'unknown') {
      rejectPendingAttributions(new BrokerError(BrokerErrorCode.HarnessError, failure.message))
    }
    s.turnActive = false
    if (s.turnTimeout !== undefined) {
      clearTimeout(s.turnTimeout)
      s.turnTimeout = undefined
    }
    reportProviderTranscript()
    return true
  }

  function attributionExtra(turn: TurnId): DriverEventExtra {
    const attribution = s.attributionByTurn.get(turn)
    return {
      turnId: turn,
      ...(attribution?.ownership === 'own' && attribution.inputId !== undefined
        ? { inputId: attribution.inputId }
        : {}),
      driver: { kind: 'codex-app-server' },
    }
  }

  function emitAttribution(
    turn: TurnId,
    attribution: {
      ownership: 'own' | 'foreign' | 'unknown'
      inputId?: InputId | undefined
      origin: 'broker' | 'human' | 'autonomous' | 'unknown'
    }
  ): void {
    if (s.attributionByTurn.has(turn)) return
    s.attributionByTurn.set(turn, attribution)
    emitCaptured(
      'turn.attributed',
      { turnId: turn, ...attribution },
      {
        turnId: turn,
        ...(attribution.ownership === 'own' && attribution.inputId !== undefined
          ? { inputId: attribution.inputId }
          : {}),
        driver: { kind: 'codex-app-server' },
      }
    )
    if (attribution.ownership === 'own' && attribution.inputId !== undefined) {
      s.currentInputId = attribution.inputId
      s.pendingBrokerInputs.delete(attribution.inputId)
      s.retiredSteerTurnsByInput.delete(attribution.inputId)
      s.attributionWaiters.get(attribution.inputId)?.resolve(turn)
      s.attributionWaiters.delete(attribution.inputId)
    }
  }

  function ensureUnknownAttribution(turn: TurnId | undefined): void {
    if (!s.codexTui || turn === undefined || s.attributionByTurn.has(turn)) return
    emitAttribution(turn, { ownership: 'unknown', origin: 'unknown' })
  }

  function rejectPendingAttributions(error: Error): void {
    for (const waiter of s.attributionWaiters.values()) waiter.reject(error)
    s.attributionWaiters.clear()
    s.pendingBrokerInputs.clear()
    s.retiredSteerTurnsByInput.clear()
    s.queuedSubmissions.clear()
  }

  function attributeFirstItem(
    notification: JsonRpcNotification,
    pendingSteer: PendingSteer | undefined
  ): boolean {
    if (!s.codexTui || notification.method !== 'item/started') return false
    const params = asFrameRecord(notification.params)
    const turn = frameString(params['turnId']) as TurnId | undefined
    if (turn === undefined || s.firstItemSeen.has(turn)) return false
    s.firstItemSeen.add(turn)
    // A context-entry item can never initiate or re-own the turn it joins.
    // Even in a provider-ordering anomaly where it is the first observed item,
    // leave attribution unresolved rather than turning a steer into execution.
    if (pendingSteer !== undefined) return true
    const item = asFrameRecord(params['item'])
    const itemType = frameString(item['type'])
    const clientId = frameString(item['clientId']) as InputId | undefined
    if (itemType === 'userMessage') {
      if (
        clientId !== undefined &&
        s.pendingBrokerInputs.has(clientId) &&
        !isRetiredSteerTurn(clientId, turn)
      ) {
        emitAttribution(turn, {
          ownership: 'own',
          inputId: clientId,
          origin: 'broker',
        })
      } else {
        emitAttribution(turn, { ownership: 'foreign', origin: 'human' })
      }
      return true
    }
    emitAttribution(turn, { ownership: 'foreign', origin: 'autonomous' })
    return true
  }

  return {
    withProvenance,
    selfMintedProvenance,
    emitCaptured,
    emitEventCaptured,
    reportProviderTranscript,
    captureSourceKey,
    rotateCaptureEpoch,
    requireCtx,
    emitDiagnostic,
    emitTerminalFailure,
    settleAllPendingSteers,
    retirePendingSteer,
    isRetiredSteerTurn,
    settlePendingSteersForTurn,
    activeTurnExtra,
    failActiveTurn,
    attributionExtra,
    emitAttribution,
    ensureUnknownAttribution,
    rejectPendingAttributions,
    attributeFirstItem,
  }
}
