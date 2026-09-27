import type { InputId, TurnId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { CaptureNormalizer, NormalizeOutcome } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import type { CodexDriverControl } from './driver-control'
import type { CodexDriverEvents } from './driver-events'
import type { CodexDriverState } from './driver-state'
import {
  asFrameRecord,
  canonicalFrame,
  canonicalRequestFrame,
  classifyRpcFailure,
  decodeCommittedNotification,
  frameString,
  nativeIdOf,
  normalizeUserMessageText,
  turnCompletedNotificationId,
  turnStartedNotificationId,
} from './driver-support'
import {
  CODEX_DRIVER_KIND,
  classifyCodexNotificationMethod,
  codexUnknownMethodFamily,
  type createCodexNotificationMapper,
  parseCodexError,
} from './event-map'
import {
  type OpenedPermissionRequest,
  type PermissionHandlerContext,
  openPermissionRequest,
  permissionRequestedPayload,
  resolvePermissionRequest,
} from './permissions'
import type { JsonRpcNotification, JsonRpcRequest } from './rpc-client'

export type CodexDriverNormalizer = ReturnType<typeof createCodexDriverNormalizer>

/**
 * Native frame ingest and normalization: commit-then-normalize for
 * notifications and server requests, dispositions, exit and RPC failure.
 */
export function createCodexDriverNormalizer(
  s: CodexDriverState,
  events: CodexDriverEvents,
  control: CodexDriverControl,
  mapCodexNotification: ReturnType<typeof createCodexNotificationMapper>
) {
  const {
    withProvenance,
    selfMintedProvenance,
    emitCaptured,
    emitEventCaptured,
    reportProviderTranscript,
    captureSourceKey,
    requireCtx,
    emitDiagnostic,
    emitTerminalFailure,
    settleAllPendingSteers,
    settlePendingSteersForTurn,
    activeTurnExtra,
    failActiveTurn,
    attributionExtra,
    ensureUnknownAttribution,
    rejectPendingAttributions,
    attributeFirstItem,
  } = events
  const { observeModelReroute, startNextQueuedSubmission } = control

  function normalizeCodexPrelude(notification: JsonRpcNotification): void {
    if (notification.method === 'item/started') {
      const params = asFrameRecord(notification.params)
      const observedThreadId = frameString(params['threadId'])
      const observedTurnId = frameString(params['turnId']) as TurnId | undefined
      const item = asFrameRecord(params['item'])
      const itemId = frameString(item['id'])
      const clientId = frameString(item['clientId']) as InputId | undefined
      const pendingSteer = clientId === undefined ? undefined : s.pendingSteers.get(clientId)
      const exactPendingSteer =
        pendingSteer !== undefined &&
        observedThreadId === pendingSteer.threadId &&
        observedTurnId === pendingSteer.turnId
          ? pendingSteer
          : undefined
      const wasFirst = attributeFirstItem(notification, exactPendingSteer)

      if (frameString(item['type']) !== 'userMessage') return
      if (observedThreadId === undefined || observedTurnId === undefined || itemId === undefined) {
        emitDiagnostic('warn', 'Codex user-message item lacks correlation identity', {
          threadId: observedThreadId ?? null,
          turnId: observedTurnId ?? null,
          itemId: itemId ?? null,
          clientId: clientId ?? null,
        })
        return
      }

      const observedKey = `${observedThreadId}\u0000${observedTurnId}\u0000${itemId}`
      if (s.observedUserItems.has(observedKey)) return
      s.observedUserItems.add(observedKey)

      if (pendingSteer !== undefined && exactPendingSteer === undefined) {
        emitDiagnostic(
          'warn',
          'Codex steered user-message arrived on an unexpected thread or turn',
          {
            inputId: pendingSteer.inputId,
            expectedThreadId: pendingSteer.threadId,
            observedThreadId,
            expectedTurnId: pendingSteer.turnId,
            observedTurnId,
            itemId,
          },
          { turnId: observedTurnId, driver: { kind: 'codex-app-server' } }
        )
      }

      const content = normalizeUserMessageText(item)
      if (exactPendingSteer !== undefined) {
        exactPendingSteer.nativeObserved = true
        exactPendingSteer.settle('native-observed')
        emitCaptured(
          'user.message',
          { content, inputId: exactPendingSteer.inputId, role: 'user' },
          {
            turnId: observedTurnId,
            inputId: exactPendingSteer.inputId,
            driver: { kind: 'codex-app-server', rawType: 'item/started' },
          }
        )
        emitCaptured(
          'submission.absorbed',
          { submissionId: exactPendingSteer.inputId, turnId: observedTurnId },
          {
            turnId: observedTurnId,
            inputId: exactPendingSteer.inputId,
            driver: { kind: 'codex-app-server', rawType: 'item/started' },
          }
        )
        s.pendingSteers.delete(exactPendingSteer.inputId)
        return
      }

      // Headless turns already mint their initiating user.message at delivery.
      // Only native steer confirmations add a later headless user row. TUI
      // turns, by contrast, are observed and expose every native user item.
      if (s.codexTui) {
        const attribution = wasFirst ? s.attributionByTurn.get(observedTurnId) : undefined
        const inputId = attribution?.ownership === 'own' ? attribution.inputId : undefined
        emitCaptured(
          'user.message',
          {
            content,
            ...(inputId !== undefined ? { inputId } : {}),
            role: 'user',
          },
          {
            turnId: observedTurnId,
            ...(inputId !== undefined ? { inputId } : {}),
            driver: { kind: 'codex-app-server', rawType: 'item/started' },
          }
        )
      }
    }
    if (s.codexTui && notification.method === 'turn/completed') {
      ensureUnknownAttribution(turnCompletedNotificationId(notification) ?? s.currentTurnId)
    }
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
    const capture = s.ctx?.capture
    if (capture === undefined) {
      // No capture gate (isolated driver unit harness): identical
      // classification, no journal — so nothing else would report a
      // blocked-unknown, and the frame is retained here for the export.
      s.ungatedFrames.push(frame)
      const outcome = normalizeNotification(notification)
      if (outcome.disposition === 'blocked-unknown') {
        requireCtx().emit(
          'capture.warning',
          {
            kind: 'blocked_unknown',
            message: outcome.message,
            raw: { native: frame },
          },
          {
            driver: { kind: 'codex-app-server', rawType: notification.method },
          }
        )
      }
      return
    }

    s.notificationSequence += 1
    const nativeId = nativeIdOf(notification)
    capture.ingest(
      {
        provider: 'openai',
        driverKind: CODEX_DRIVER_KIND,
        sourceKind: 'provider-jsonrpc',
        sourceKey: captureSourceKey(),
        sourceCursor: { nativeSequence: String(s.notificationSequence) },
        nativeType: notification.method,
        ...(nativeId !== undefined ? { nativeId } : {}),
        rawBytes: Buffer.from(frame, 'utf8'),
        ...(s.threadId !== undefined ? { correlationHints: { threadId: s.threadId } } : {}),
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
    const extra = {
      turnId: permCtx.currentTurnId,
      inputId: permCtx.currentInputId,
    }
    const frame = rawFrame ?? JSON.stringify(canonicalRequestFrame(request))
    const capture = s.ctx?.capture
    let requestRecordId: string | undefined

    if (capture === undefined) {
      // No capture gate (isolated driver unit harness): no journal exists, so
      // the ask has no record to name and says `broker` like every other
      // self-minted event here.
      s.ungatedFrames.push(frame)
      requireCtx().emit('permission.requested', permissionRequestedPayload(opened), {
        ...extra,
        provenance: selfMintedProvenance(),
      })
    } else {
      s.notificationSequence += 1
      capture.ingest(
        {
          provider: 'openai',
          driverKind: CODEX_DRIVER_KIND,
          sourceKind: 'provider-jsonrpc',
          sourceKey: captureSourceKey(),
          sourceCursor: { nativeSequence: String(s.notificationSequence) },
          nativeType: request.method,
          nativeId: String(request.id),
          rawBytes: Buffer.from(frame, 'utf8'),
          ...(s.threadId !== undefined ? { correlationHints: { threadId: s.threadId } } : {}),
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
        return s.mintedForRecord > 0
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

  function normalizeErrorNotification(params: unknown): NormalizeOutcome {
    ensureUnknownAttribution(s.currentTurnId)
    const error = parseCodexError(params)
    emitDiagnostic('error', error.message, error.data, activeTurnExtra())
    // willRetry:true is codex reporting an attempt on a turn it is still
    // running (e.g. "Reconnecting... 2/5"); it sends a final willRetry:false
    // error or turn/completed once it gives up. Failing here ended the turn
    // and then the invocation mid-retry, and the terminal latch swallowed
    // the real final error (T-09238). Startup stays terminal because no
    // thread has become usable yet (T-08557).
    if (error.retryable === true && !s.starting) {
      return { disposition: 'normalized', detail: 'error-will-retry' }
    }
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

    if (s.starting) {
      s.rejectStartup?.(
        new BrokerError(BrokerErrorCode.HarnessError, error.message, {
          code: error.code,
          data: error.data,
        })
      )
    }
    // A non-retry error always mints (a diagnostic, plus a turn or invocation
    // terminal). It is a §6.1 disposition, not a special case outside the
    // classification.
    return { disposition: 'normalized', detail: 'error' }
  }

  function normalizeNotification(notification: JsonRpcNotification): NormalizeOutcome {
    if (notification.method === 'error') return normalizeErrorNotification(notification.params)

    // After any invocation-terminal event, drop further native events so a late
    // turn/completed (or any other notification) can never follow a terminal.
    // The drop keeps its semantics but is now a RECORDED disposition rather
    // than a silent skip: the bytes are committed and accounted for.
    if (s.terminalEmitted) {
      return {
        disposition: 'ignored-known',
        detail: `after-invocation-terminal:${notification.method}`,
      }
    }

    if (notification.method === 'turn/started' && !s.codexTui) {
      const observedTurnId = turnStartedNotificationId(notification)
      if (s.acknowledgedTurnId === undefined || observedTurnId !== s.acknowledgedTurnId) {
        return {
          disposition: 'blocked-unknown',
          family: 'turn-bracket',
          message:
            s.acknowledgedTurnId === undefined
              ? `Codex turn/started arrived without a turn/start response id (observed ${observedTurnId ?? 'missing'})`
              : `Codex turn/start response id ${s.acknowledgedTurnId} does not match turn/started id ${observedTurnId ?? 'missing'}`,
        }
      }
    }

    normalizeCodexPrelude(notification)
    observeModelReroute(notification)

    for (const mapped of mapCodexNotification(notification)) {
      const isTurnTerminal =
        mapped.type === 'turn.completed' ||
        mapped.type === 'turn.failed' ||
        mapped.type === 'turn.interrupted'
      // Suppress a turn terminal for a turn that already reached a terminal
      // state (e.g. a turn-timeout turn.failed followed by a late turn/completed).
      if (isTurnTerminal && !s.turnActive) continue
      const mappedTurnId = mapped.extra?.turnId ?? s.currentTurnId
      const extra = s.codexTui
        ? mappedTurnId !== undefined
          ? { ...mapped.extra, ...attributionExtra(mappedTurnId) }
          : mapped.extra
        : mapped.type === 'turn.started' || isTurnTerminal
          ? { ...mapped.extra, inputId: s.currentInputId }
          : mapped.extra
      const effectiveMapped =
        s.codexTui && mapped.type === 'turn.started'
          ? {
              ...mapped,
              payload: { ...mapped.payload, source: 'observed' as const },
            }
          : mapped
      const event = emitEventCaptured(effectiveMapped, extra)
      if (event.type === 'turn.started') {
        s.currentTurnId = event.turnId
        s.turnActive = true
        if (s.codexTui) s.queuedStartRequired = false
      }
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
      ) {
        settlePendingSteersForTurn(event.payload.turnId)
        if (s.codexTui && event.type === 'turn.interrupted') {
          s.queuedStartRequired = true
          const attribution = s.attributionByTurn.get(event.payload.turnId)
          if (attribution?.ownership !== 'own') void startNextQueuedSubmission()
        }
        s.turnActive = false
        if (s.codexTui && s.attributionByTurn.get(event.payload.turnId)?.ownership === 'unknown') {
          rejectPendingAttributions(
            new BrokerError(BrokerErrorCode.HarnessError, 'Turn attribution was lost')
          )
        }
        // Clear turn timeout on any turn termination
        if (s.turnTimeout !== undefined) {
          clearTimeout(s.turnTimeout)
          s.turnTimeout = undefined
        }
        // Turn terminal flushed: report the provider transcript provenance once
        // the raw rows (including this terminal notification) are durable.
        reportProviderTranscript()
      }
    }

    return dispositionForMethod(notification.method)
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!s.startedEmitted || s.terminalEmitted) {
      if (s.starting) {
        s.rejectStartup?.(
          new BrokerError(BrokerErrorCode.HarnessError, 'Harness process exited during startup', {
            exitCode: code,
            signal,
          })
        )
      }
      return
    }

    if (s.turnActive && s.currentTurnId !== undefined) {
      ensureUnknownAttribution(s.currentTurnId)
      if (s.stopping) {
        requireCtx().emit(
          'turn.interrupted',
          {
            turnId: s.currentTurnId,
            status: 'interrupted',
          },
          { turnId: s.currentTurnId, inputId: s.currentInputId }
        )
        s.turnActive = false
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

    settleAllPendingSteers('target-terminal')
    s.terminalEmitted = true
    requireCtx().emit('invocation.exited', { exitCode: code, signal })
  }

  function handleRpcError(error: Error): void {
    if (s.starting) {
      s.rejectStartup?.(error)
      return
    }
    if (s.terminalEmitted) return
    settleAllPendingSteers('target-terminal')
    ensureUnknownAttribution(s.currentTurnId)
    if (s.codexTui) {
      if (s.turnActive && s.currentTurnId !== undefined) {
        if (s.stopping) {
          emitCaptured(
            'turn.interrupted',
            { turnId: s.currentTurnId, status: 'interrupted' },
            activeTurnExtra()
          )
          s.turnActive = false
        } else {
          const failure = classifyRpcFailure(error)
          emitDiagnostic('error', failure.message, failure.data, activeTurnExtra())
          failActiveTurn(failure)
        }
      }
      s.terminalEmitted = true
      requireCtx().emit('invocation.exited', { exitCode: null, signal: null })
      return
    }
    if (s.stopping) return
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
    if (s.proc !== undefined && s.proc.exitCode === null) s.proc.kill('SIGTERM')
  }

  return {
    normalizeCodexPrelude,
    onNotification,
    handleServerRequest,
    normalizeCommittedRecord,
    dispositionForMethod,
    normalizeErrorNotification,
    normalizeNotification,
    onExit,
    handleRpcError,
  }
}
