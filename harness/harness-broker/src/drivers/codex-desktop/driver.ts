import { spawn } from 'node:child_process'
import { type FSWatcher, accessSync, closeSync, openSync, readSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  EventProvenance,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  MessageId,
  RawProviderRecord,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord, NormalizeOutcome } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import { buildCodexInput } from '../codex-app-server/input'
import { CodexRpcClient, CodexRpcError, type CodexRpcPeer } from '../codex-app-server/rpc-client'
import {
  asCodexRecord,
  classifyCodexRolloutLine,
  codexContentText,
  codexNativeTypeOf,
} from '../codex-rollout/native'
import type {
  ApplyInputResult,
  CancelInputResult,
  Driver,
  DriverContext,
  DriverStartResult,
} from '../driver'
import { withDeliveryEvidence } from '../driver'
import { CODEX_DESKTOP_AUTHORITY } from '../evidence-authority'
import { getString } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import {
  type CodexDesktopNativeAttempt,
  type CodexDesktopNativeAttemptStore,
  isUnresolvedCodexDesktopAttempt,
  openCodexDesktopNativeAttemptStore,
} from './native-attempt-store'

export const CODEX_DESKTOP_DRIVER_KIND = 'codex-desktop'
const CODEX_DESKTOP_DRIVER_VERSION = '0.1.0'

export interface CodexDesktopDriverSpec {
  kind: typeof CODEX_DESKTOP_DRIVER_KIND
  bundleExecutable: string
  codexHome: string
  sqliteHome: string
  threadId: string
  rolloutPath: string
  adoptionWatermark?: { byteOffset: number } | undefined
}

export interface CodexDesktopDriverOptions {
  pollIntervalMs?: number | undefined
  watchFile?: boolean | undefined
  openQueueHelper?: ((spec: CodexDesktopDriverSpec) => Promise<CodexDesktopQueueHelper>) | undefined
}

export interface CodexDesktopQueueHelper {
  list(threadId: string, cursor?: string): Promise<unknown>
  add(threadId: string, input: InvocationInput, clientUserMessageId: string): Promise<unknown>
  delete(threadId: string, queuedSubmissionId: string): Promise<unknown>
  close(): void
}

const CODEX_DESKTOP_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['queue'] },
  bracketMintingMode: 'observed',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: null },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
  },
  turns: { concurrency: 'single', interrupt: 'unsupported' },
  continuation: { supported: true, provider: 'openai', keyKind: 'thread' },
  events: {
    assistantDeltas: false,
    toolCalls: true,
    usage: true,
    diagnostics: true,
    replay: true,
    ack: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    status: true,
    snapshot: true,
    eventsSince: true,
    eventTypeFilter: true,
    liveness: 'cached',
    driverAttachExistingSurface: true,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

type HeldAssistant = {
  messageId: MessageId
  content: string
  turnId: TurnId
  provenance?: EventProvenance | undefined
}

/** Observe one desktop-owned rollout. This driver never starts or signals Codex. */
export function createCodexDesktopDriver(options: CodexDesktopDriverOptions = {}): Driver {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const openQueueHelper = options.openQueueHelper ?? openBundledQueueHelper
  let ctx: DriverContext | undefined
  let spec: CodexDesktopDriverSpec | undefined
  let watcher: FSWatcher | undefined
  let poller: ReturnType<typeof setInterval> | undefined
  let drain = Promise.resolve()
  let stopped = false
  let healthReason: string | undefined
  let deliveryReason: string | undefined
  let lastNativeActivity: string | undefined
  let currentTurnId: TurnId | undefined
  let heldAssistant: HeldAssistant | undefined
  const seenItems = new Set<string>()
  const seenUsers = new Set<string>()
  const seenTurnStarts = new Set<string>()
  const seenTurnTerminals = new Set<string>()
  const attributedTurns = new Set<string>()
  const contentTurns = new Set<string>()
  const ownedInputIds = new Set<string>()
  let attemptStore: CodexDesktopNativeAttemptStore | undefined
  let installationKey = ''
  let normalizedEventCount = 0
  let tailer = createTailer()

  function createTailer() {
    return createJsonlByteOffsetTailer({
      onEpochChange: () => {
        const active = spec
        if (active !== undefined) ctx?.capture?.rotateEpoch(sourceKey(active))
      },
    })
  }

  function requireCtx(): DriverContext {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'codex-desktop has not started')
    }
    return ctx
  }

  function activeSpec(): CodexDesktopDriverSpec {
    if (spec === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'codex-desktop has no spec')
    }
    return spec
  }

  function emit(
    type: Parameters<DriverContext['emit']>[0],
    payload: Parameters<DriverContext['emit']>[1],
    extra: Parameters<DriverContext['emit']>[2]
  ): void {
    normalizedEventCount += 1
    requireCtx().emit(type as never, payload as never, extra)
  }

  function emitHealth(nextReason: string | undefined): void {
    if (healthReason === nextReason) return
    healthReason = nextReason
    if (ctx === undefined) return
    ctx.emit('driver.notice', {
      message:
        nextReason === undefined
          ? 'Codex desktop rollout observation is healthy'
          : `Codex desktop rollout observation degraded: ${nextReason}`,
      code:
        nextReason === undefined
          ? 'CODEX_DESKTOP_OBSERVER_HEALTHY'
          : 'CODEX_DESKTOP_OBSERVER_DEGRADED',
      data: {
        observer: nextReason === undefined ? 'healthy' : 'degraded',
        desktopAvailability: 'unknown',
        ...(lastNativeActivity !== undefined ? { lastNativeActivity } : {}),
      },
    })
  }

  function resetParserState(): void {
    currentTurnId = undefined
    heldAssistant = undefined
    seenItems.clear()
    seenUsers.clear()
    seenTurnStarts.clear()
    seenTurnTerminals.clear()
    attributedTurns.clear()
    contentTurns.clear()
    ownedInputIds.clear()
  }

  function requireAttemptStore(): CodexDesktopNativeAttemptStore {
    if (attemptStore === undefined) {
      throw new BrokerError(BrokerErrorCode.ResourceError, 'Codex desktop attempt store is closed')
    }
    return attemptStore
  }

  function attemptData(row: CodexDesktopNativeAttempt): Record<string, unknown> {
    return {
      attemptState: row.state,
      inputId: row.inputId,
      clientUserMessageId: row.clientUserMessageId,
      nativeThreadId: row.threadId,
      observationWatermark: row.observationWatermark,
      ...(row.principalRef !== undefined ? { principalRef: row.principalRef } : {}),
      ...(row.scopeRef !== undefined ? { scopeRef: row.scopeRef } : {}),
      ...(row.envelopeId !== undefined ? { envelopeId: row.envelopeId } : {}),
      ...(row.queuedSubmissionId !== undefined
        ? { queuedSubmissionId: row.queuedSubmissionId }
        : {}),
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
      ...(row.detail !== undefined ? { detail: row.detail } : {}),
    }
  }

  function emitAttempt(row: CodexDesktopNativeAttempt, code: string, message: string): void {
    requireCtx().emit(
      'driver.notice',
      { message, code, data: attemptData(row) },
      {
        inputId: row.inputId as InputId,
        ...(row.turnId !== undefined ? { turnId: row.turnId as TurnId } : {}),
        driver: { kind: CODEX_DESKTOP_DRIVER_KIND, rawType: 'broker.native-attempt' },
      }
    )
  }

  function updateAttempt(
    inputId: string,
    patch: Parameters<CodexDesktopNativeAttemptStore['update']>[2],
    code?: string,
    message?: string
  ): CodexDesktopNativeAttempt {
    const row = requireAttemptStore().update(installationKey, inputId, patch)
    if (code !== undefined && message !== undefined) emitAttempt(row, code, message)
    return row
  }

  function stampExtra(
    captured: CapturedRecord,
    turnId?: TurnId,
    inputId?: InputId,
    itemId?: string
  ) {
    return {
      ...(turnId !== undefined ? { turnId } : {}),
      ...(inputId !== undefined ? { inputId } : {}),
      ...(itemId !== undefined ? { itemId } : {}),
      driver: { kind: CODEX_DESKTOP_DRIVER_KIND, rawType: captured.record.nativeType },
      provenance: captured.provenance(),
    }
  }

  function flushAssistant(captured: CapturedRecord, final: boolean, publish: boolean): void {
    const held = heldAssistant
    if (held === undefined) return
    heldAssistant = undefined
    contentTurns.add(held.turnId)
    if (!publish) return
    emit(
      'assistant.message.completed',
      { messageId: held.messageId, content: [{ type: 'text', text: held.content }], final },
      {
        turnId: held.turnId,
        itemId: held.messageId,
        driver: { kind: CODEX_DESKTOP_DRIVER_KIND, rawType: captured.record.nativeType },
        provenance: held.provenance ?? captured.provenance(),
      }
    )
  }

  function turnIdOf(payload: Record<string, unknown>): TurnId | undefined {
    return getString(payload, 'turn_id') as TurnId | undefined
  }

  function itemBelongsToThread(payload: Record<string, unknown>): boolean {
    const threadId = getString(payload, 'thread_id')
    return threadId === undefined || threadId === activeSpec().threadId
  }

  // The branches deliberately mirror Codex's persisted EventMsg vocabulary so
  // every native family remains auditable in one normalization switch.
  // EXCEPTION(T-08293): keeping the closed native vocabulary in one mapper makes drift fail visibly.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: native vocabulary mapper
  function normalizeRecord(captured: CapturedRecord, publish = true): NormalizeOutcome {
    const line = Buffer.from(captured.record.rawBytes).toString('utf8')
    const classified = classifyCodexRolloutLine(line)
    if ('outcome' in classified) return classified.outcome
    const { payload, payloadType, item } = classified
    if (!itemBelongsToThread(payload)) {
      return { disposition: 'ignored-known', detail: 'different desktop thread' }
    }
    lastNativeActivity = captured.record.observedAt
    const turnId = turnIdOf(payload) ?? currentTurnId
    const before = eventCount()

    if (payloadType === 'task_started') {
      const startedTurn = turnIdOf(payload)
      if (startedTurn !== undefined) {
        currentTurnId = startedTurn
        if (!seenTurnStarts.has(startedTurn)) {
          seenTurnStarts.add(startedTurn)
          if (publish) {
            emit(
              'turn.started',
              { turnId: startedTurn, source: 'observed', sessionId: activeSpec().threadId },
              stampExtra(captured, startedTurn)
            )
          }
        }
      }
    } else if (payloadType === 'item_completed' && item !== undefined && turnId !== undefined) {
      const itemType = getString(item, 'type')
      const itemId = (getString(item, 'id') ??
        `${itemType ?? 'item'}:${captured.record.rawRecordId}`) as string
      if (itemType === 'UserMessage' && !seenUsers.has(itemId)) {
        seenUsers.add(itemId)
        const content = codexContentText(item['content'])
        const clientId = getString(item, 'client_id')
        const cursor = captured.record.sourceCursor['byteOffset']
        const attempt =
          clientId === undefined ? undefined : requireAttemptStore().get(installationKey, clientId)
        const attemptWatermark =
          attempt?.observationWatermark ?? activeSpec().adoptionWatermark?.byteOffset ?? 0
        const afterAdoption = typeof cursor !== 'number' || cursor >= attemptWatermark
        const own =
          clientId !== undefined &&
          afterAdoption &&
          seenTurnStarts.has(turnId) &&
          ownedInputIds.has(clientId)
        const inputId = own ? (clientId as InputId) : undefined
        if (own && attempt !== undefined && attempt.state !== 'executed') {
          updateAttempt(
            attempt.inputId,
            { state: 'executed', turnId },
            publish ? 'CODEX_DESKTOP_NATIVE_ATTEMPT_EXECUTED' : undefined,
            publish ? 'Codex desktop native input execution observed' : undefined
          )
          requireCtx().admissionStateChanged?.()
        }
        if (publish) {
          emit(
            'user.message',
            { content, role: 'user', turnId, ...(inputId !== undefined ? { inputId } : {}) },
            stampExtra(captured, turnId, inputId, itemId)
          )
          emit(
            'turn.attributed',
            {
              turnId,
              ownership: own ? 'own' : 'foreign',
              origin: own ? 'broker' : 'human',
              ...(inputId !== undefined ? { inputId } : {}),
            },
            stampExtra(captured, turnId, inputId)
          )
        }
        attributedTurns.add(turnId)
      } else if (itemType === 'AgentMessage' && !seenItems.has(itemId)) {
        seenItems.add(itemId)
        const content = codexContentText(item['content'])
        if (content.length > 0) {
          const phase = getString(item, 'phase')
          if (phase === 'commentary') {
            flushAssistant(captured, false, publish)
            contentTurns.add(turnId)
            if (publish) {
              emit(
                'assistant.message.completed',
                {
                  messageId: itemId as MessageId,
                  content: [{ type: 'text', text: content }],
                  final: false,
                },
                stampExtra(captured, turnId, undefined, itemId)
              )
            }
          } else {
            flushAssistant(captured, false, publish)
            heldAssistant = {
              messageId: itemId as MessageId,
              content,
              turnId,
              provenance: captured.provenance(),
            }
          }
        }
      } else if (isRecordedTool(itemType) && !seenItems.has(itemId)) {
        seenItems.add(itemId)
        contentTurns.add(turnId)
        if (publish) {
          emit(
            'tool.call.completed',
            {
              toolCallId: itemId as ToolCallId,
              name: toolName(itemType, item),
              result: recordedToolResult(itemType, item),
              ...(item['is_error'] === true ? { isError: true } : {}),
            },
            stampExtra(captured, turnId, undefined, itemId)
          )
        }
      }
    } else if (payloadType === 'agent_message' && turnId !== undefined) {
      const content = getString(payload, 'message')
      const itemId = getString(payload, 'id') ?? `agent:${turnId}:${captured.record.rawRecordId}`
      if (content !== undefined && !seenItems.has(itemId)) {
        seenItems.add(itemId)
        flushAssistant(captured, false, publish)
        heldAssistant = {
          messageId: itemId as MessageId,
          content,
          turnId,
          provenance: captured.provenance(),
        }
      }
    } else if (payloadType === 'token_count') {
      const usage = payload['info']
      if (usage !== undefined && publish) {
        emit('usage.updated', { usage }, stampExtra(captured, turnId))
      }
    } else if (payloadType === 'task_complete') {
      const completedTurn = turnIdOf(payload) ?? currentTurnId
      if (completedTurn !== undefined && !seenTurnTerminals.has(completedTurn)) {
        if (heldAssistant === undefined) {
          const fallback = getString(payload, 'last_agent_message')
          if (fallback !== undefined && fallback.length > 0) {
            heldAssistant = {
              messageId: `agent:${completedTurn}:terminal` as MessageId,
              content: fallback,
              turnId: completedTurn,
              provenance: captured.provenance(),
            }
          }
        }
        flushAssistant(captured, true, publish)
        if (!attributedTurns.has(completedTurn) && publish) {
          emit(
            'turn.attributed',
            { turnId: completedTurn, ownership: 'unknown', origin: 'unknown' },
            stampExtra(captured, completedTurn)
          )
        }
        attributedTurns.add(completedTurn)
        seenTurnTerminals.add(completedTurn)
        if (publish) {
          emit(
            'turn.completed',
            {
              turnId: completedTurn,
              status: 'completed',
              ...(getString(payload, 'last_agent_message') !== undefined
                ? { finalOutput: getString(payload, 'last_agent_message') }
                : {}),
              producedContent: contentTurns.has(completedTurn),
            },
            stampExtra(captured, completedTurn)
          )
        }
        if (currentTurnId === completedTurn) currentTurnId = undefined
      }
    } else if (payloadType === 'turn_aborted') {
      const abortedTurn = turnIdOf(payload) ?? currentTurnId
      if (abortedTurn !== undefined && !seenTurnTerminals.has(abortedTurn)) {
        flushAssistant(captured, false, publish)
        seenTurnTerminals.add(abortedTurn)
        if (publish) {
          emit(
            'turn.interrupted',
            { turnId: abortedTurn, status: 'interrupted', reason: getString(payload, 'reason') },
            stampExtra(captured, abortedTurn)
          )
        }
        if (currentTurnId === abortedTurn) currentTurnId = undefined
      }
    }

    return eventCount() > before
      ? { disposition: 'normalized', detail: `event_msg:${payloadType}` }
      : { disposition: 'state-only', detail: `event_msg:${payloadType}` }
  }

  // State changes count as normalization even during reconstruction; this is
  // deliberately a cheap monotonic proxy, not a public event counter.
  function eventCount(): number {
    return normalizedEventCount
  }

  function readRows(): void {
    const active = activeSpec()
    try {
      accessSync(active.rolloutPath)
      emitHealth(undefined)
    } catch (error) {
      emitHealth(`rollout unreadable or not materialized: ${describe(error)}`)
      return
    }
    tailer.readNewLines((line, cursor) => {
      const capture = requireCtx().capture
      if (capture === undefined) return
      capture.ingest(
        {
          provider: 'openai',
          driverKind: CODEX_DESKTOP_DRIVER_KIND,
          sourceKind: 'provider-jsonl',
          sourceKey: sourceKey(active),
          sourceCursor: cursor,
          nativeType: codexNativeTypeOf(line),
          nativeId: nativeIdOf(line),
          rawBytes: Buffer.from(line, 'utf8'),
          correlationHints: { threadId: active.threadId },
        },
        (captured) => normalizeRecord(captured)
      )
    })
  }

  function scheduleRead(): void {
    if (stopped) return
    drain = drain
      .then(() => readRows())
      .catch((error) => emitHealth(`observer read failed: ${describe(error)}`))
  }

  function setupWatch(path: string): void {
    if (options.watchFile !== false) {
      try {
        watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
          if (filename === null || path.endsWith(String(filename))) scheduleRead()
        })
        watcher.on('error', (error) => emitHealth(`rollout watch failed: ${describe(error)}`))
      } catch (error) {
        emitHealth(`rollout watch unavailable: ${describe(error)}`)
      }
    }
    poller = setInterval(scheduleRead, pollIntervalMs)
    poller.unref?.()
  }

  function cleanup(): void {
    stopped = true
    watcher?.close()
    watcher = undefined
    if (poller !== undefined) clearInterval(poller)
    poller = undefined
  }

  return {
    kind: CODEX_DESKTOP_DRIVER_KIND,
    version: CODEX_DESKTOP_DRIVER_VERSION,
    bracketMintingMode: 'observed',
    evidenceAuthority: CODEX_DESKTOP_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: null,
    steerLandingEvidence: null,
    interruptLandingEvidence: null,
    blocksAdmissionWhileHarnessLocalQueued: true,
    confirmsSubmissionExecutionOnOwnAttribution: true,

    capabilities(): InvocationCapabilities {
      return CODEX_DESKTOP_CAPABILITIES
    },

    captureNormalizer() {
      return (captured) => normalizeRecord(captured)
    },

    runtimeHealth() {
      const reason = healthReason ?? deliveryReason
      return reason === undefined
        ? ({ state: 'healthy' } as const)
        : ({ state: 'degraded', reason } as const)
    },

    admissionRejectionReason(admissionClass) {
      return admissionClass === 'queue' ? deliveryReason : undefined
    },

    probeAdmissionState() {
      return {
        harnessLocalQueueDepth: attemptStore?.unresolved(installationKey) === undefined ? 0 : 1,
      }
    },

    async start(
      startSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      const parsed = parseDesktopSpec(startSpec)
      cleanup()
      stopped = false
      ctx = driverCtx
      spec = parsed
      deliveryReason = undefined
      resetParserState()
      attemptStore?.close()
      attemptStore = openCodexDesktopNativeAttemptStore(
        driverCtx.durableStateDir === undefined
          ? undefined
          : join(driverCtx.durableStateDir, 'codex-desktop-native-attempts.db')
      )
      installationKey = desktopInstallationKey(parsed)
      for (const attempt of attemptStore.list(installationKey)) {
        ownedInputIds.add(attempt.clientUserMessageId)
      }
      normalizedEventCount = 0
      tailer = createTailer()

      const records = driverCtx.capture?.records() ?? []
      for (const record of records) {
        if (
          record.driverKind === CODEX_DESKTOP_DRIVER_KIND &&
          driverCtx.capture?.disposition(record.rawRecordId) !== 'pending'
        ) {
          normalizeRecord(capturedRecord(record), false)
        }
      }
      // Re-drive the crash window before moving the physical file cursor.
      driverCtx.capture?.replayPending((captured) => normalizeRecord(captured))
      const resumeOffset = durableResumeOffset(parsed.rolloutPath, records)
      tailer.retarget(parsed.rolloutPath, { startAtOffset: resumeOffset })
      readRows()
      const unresolved = attemptStore.unresolved(installationKey)
      if (unresolved !== undefined) await reconcileAttempt(unresolved)
      setupWatch(parsed.rolloutPath)
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      const inputId = input.inputId
      if (inputId === undefined) {
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerErrorCode.DispatchValidationFailed,
            'Desktop queue inputId is required'
          ),
          'not_written'
        )
      }
      const store = requireAttemptStore()
      const unresolved = store.unresolved(installationKey)
      if (unresolved !== undefined) {
        if (unresolved.inputId !== inputId) {
          throw withDeliveryEvidence(
            new BrokerError(
              BrokerErrorCode.InvalidInvocationState,
              `Desktop native write remains unresolved for ${unresolved.inputId}`
            ),
            'not_written'
          )
        }
        await reconcileAttempt(unresolved)
        if (isUnresolvedCodexDesktopAttempt(store.get(installationKey, inputId) ?? unresolved)) {
          return {}
        }
      }

      const existing = store.get(installationKey, inputId)
      if (existing?.state === 'executed' || existing?.state === 'cancelled') return {}
      const observationWatermark = currentObservationWatermark()
      const prepared =
        existing?.state === 'rejected'
          ? updateAttempt(inputId, {
              state: 'prepared',
              detail: 'retry after definitive rejection',
            })
          : store.prepare({
              installationKey,
              invocationId: requireCtx().invocationId,
              inputId,
              clientUserMessageId: inputId,
              threadId: activeSpec().threadId,
              principalRef: input.metadata?.['principalRef'],
              scopeRef: input.metadata?.['scopeRef'],
              envelopeId: input.metadata?.['envelopeId'],
              observationWatermark,
            })
      ownedInputIds.add(inputId)
      emitAttempt(
        prepared,
        'CODEX_DESKTOP_NATIVE_ATTEMPT_PREPARED',
        'Codex desktop native input persisted before queue write'
      )

      const beforeAdd = await reconcileAttempt(prepared)
      if (beforeAdd.state !== 'prepared') return {}
      if (deliveryReason !== undefined) {
        updateAttempt(inputId, {
          state: 'rejected',
          detail: `definitive pre-write helper failure: ${deliveryReason}`,
        })
        throw withDeliveryEvidence(
          new BrokerError(BrokerErrorCode.DriverUnavailable, deliveryReason),
          'not_written'
        )
      }
      let helper: CodexDesktopQueueHelper | undefined
      try {
        helper = await openQueueHelper(activeSpec())
        updateAttempt(inputId, { state: 'writing', detail: 'thread/queue/add request begun' })
        const response = await helper.add(activeSpec().threadId, input, inputId)
        const queuedSubmissionId = queueSubmissionId(response)
        if (queuedSubmissionId === undefined) {
          throw new Error('Codex thread/queue/add response did not carry queuedSubmission.id')
        }
        deliveryReason = undefined
        updateAttempt(
          inputId,
          { state: 'queued', queuedSubmissionId, detail: 'native queue add acknowledged' },
          'CODEX_DESKTOP_NATIVE_ATTEMPT_QUEUED',
          'Codex desktop queued input accepted'
        )
        return {}
      } catch (error) {
        if (error instanceof CodexRpcError) {
          updateAttempt(
            inputId,
            { state: 'rejected', detail: describe(error) },
            'CODEX_DESKTOP_NATIVE_ATTEMPT_REJECTED',
            'Codex desktop native queue rejected the input'
          )
          throw withDeliveryEvidence(error, 'not_written')
        }
        updateAttempt(inputId, { state: 'indeterminate', detail: describe(error) })
        const reconciled = await reconcileAttempt(
          store.get(installationKey, inputId) as CodexDesktopNativeAttempt
        )
        if (reconciled.state === 'indeterminate') {
          emitAttempt(
            reconciled,
            'CODEX_DESKTOP_NATIVE_ATTEMPT_INDETERMINATE',
            'Codex desktop queue write outcome is indeterminate; automatic resend is fenced'
          )
        }
        return {}
      } finally {
        helper?.close()
      }
    },

    async cancelInput(inputId): Promise<CancelInputResult> {
      const row = requireAttemptStore().get(installationKey, inputId)
      if (row === undefined) return { outcome: 'not_owned' }
      readRows()
      const refreshed = requireAttemptStore().get(
        installationKey,
        inputId
      ) as CodexDesktopNativeAttempt
      if (refreshed.state === 'executed')
        return { outcome: 'executed', turnId: refreshed.turnId as TurnId }
      if (refreshed.queuedSubmissionId === undefined) {
        return { outcome: 'indeterminate', reason: 'native queue id was not acknowledged' }
      }
      let helper: CodexDesktopQueueHelper | undefined
      try {
        helper = await openQueueHelper(activeSpec())
        const queued = await listAllQueued(helper, activeSpec().threadId)
        const owned = queued.find(
          (entry) =>
            queueEntryId(entry) === refreshed.queuedSubmissionId &&
            queueEntryClientId(entry) === refreshed.clientUserMessageId
        )
        if (owned === undefined) {
          updateAttempt(inputId, {
            state: 'indeterminate',
            detail: 'owned queue row disappeared before delete',
          })
          return { outcome: 'indeterminate', reason: 'owned native queue row disappeared' }
        }
        await helper.delete(activeSpec().threadId, refreshed.queuedSubmissionId)
        readRows()
        const afterDelete = requireAttemptStore().get(
          installationKey,
          inputId
        ) as CodexDesktopNativeAttempt
        if (afterDelete.state === 'executed') {
          return { outcome: 'executed', turnId: afterDelete.turnId as TurnId }
        }
        const remaining = await listAllQueued(helper, activeSpec().threadId)
        if (remaining.some((entry) => queueEntryId(entry) === refreshed.queuedSubmissionId)) {
          updateAttempt(inputId, {
            state: 'indeterminate',
            detail: 'native delete did not remove owned row',
          })
          return { outcome: 'indeterminate', reason: 'native delete outcome is indeterminate' }
        }
        const cancelled = updateAttempt(
          inputId,
          { state: 'cancelled', detail: 'owned native queue row delete acknowledged' },
          'CODEX_DESKTOP_NATIVE_ATTEMPT_CANCELLED',
          'Codex desktop owned queued input cancelled'
        )
        requireCtx().admissionStateChanged?.()
        return cancelled.state === 'cancelled'
          ? { outcome: 'cancelled' }
          : { outcome: 'indeterminate', reason: cancelled.detail ?? 'cancel state changed' }
      } catch (error) {
        updateAttempt(inputId, { state: 'indeterminate', detail: describe(error) })
        return { outcome: 'indeterminate', reason: describe(error) }
      } finally {
        helper?.close()
      }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      return {
        accepted: false,
        effect: 'unsupported',
        reason: 'desktop lifecycle is externally owned',
      }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      cleanup()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      cleanup()
      attemptStore?.close()
      attemptStore = undefined
      ctx = undefined
      spec = undefined
    },
  }

  async function reconcileAttempt(
    attempt: CodexDesktopNativeAttempt
  ): Promise<CodexDesktopNativeAttempt> {
    readRows()
    const committedTurnId = findCommittedExecution(attempt)
    if (committedTurnId !== undefined) {
      const executed = updateAttempt(attempt.inputId, {
        state: 'executed',
        turnId: committedTurnId,
        detail: 'reconciled from committed rollout evidence',
      })
      requireCtx().admissionStateChanged?.()
      return executed
    }
    const afterRollout = requireAttemptStore().get(installationKey, attempt.inputId) ?? attempt
    if (afterRollout.state === 'executed') return afterRollout
    let helper: CodexDesktopQueueHelper | undefined
    try {
      helper = await openQueueHelper(activeSpec())
      const entries = await listAllQueued(helper, activeSpec().threadId)
      deliveryReason = undefined
      const queued = entries.find(
        (entry) => queueEntryClientId(entry) === attempt.clientUserMessageId
      )
      if (queued !== undefined) {
        const queuedSubmissionId = queueEntryId(queued)
        if (queuedSubmissionId === undefined) {
          throw new Error('Matching native queue row did not carry queuedSubmission.id')
        }
        deliveryReason = undefined
        return updateAttempt(
          attempt.inputId,
          { state: 'queued', queuedSubmissionId, detail: 'reconciled from native queue/list' },
          'CODEX_DESKTOP_NATIVE_ATTEMPT_RECONCILED_QUEUED',
          'Codex desktop native queued input recovered without a second add'
        )
      }
      if (attempt.state === 'writing' || attempt.state === 'indeterminate') {
        return updateAttempt(attempt.inputId, {
          state: 'indeterminate',
          detail: 'possibly-written attempt absent from queue and committed rollout',
        })
      }
      return requireAttemptStore().get(installationKey, attempt.inputId) ?? attempt
    } catch (error) {
      deliveryReason = `desktop queue helper unavailable: ${describe(error)}`
      requireCtx().emit('driver.notice', {
        message: `Codex desktop delivery degraded: ${deliveryReason}`,
        code: 'CODEX_DESKTOP_DELIVERY_DEGRADED',
        data: { desktopAvailability: 'unknown', delivery: 'disabled' },
      })
      return requireAttemptStore().get(installationKey, attempt.inputId) ?? attempt
    } finally {
      helper?.close()
    }
  }

  function currentObservationWatermark(): number {
    return (ctx?.capture?.records() ?? [])
      .filter(
        (record) =>
          record.driverKind === CODEX_DESKTOP_DRIVER_KIND &&
          typeof record.sourceCursor['byteOffset'] === 'number'
      )
      .reduce((maximum, record) => Math.max(maximum, Number(record.sourceCursor['byteOffset'])), 0)
  }

  function findCommittedExecution(attempt: CodexDesktopNativeAttempt): TurnId | undefined {
    const records = ctx?.capture?.records() ?? []
    const startedTurns = new Set<string>()
    for (const record of records) {
      if (record.driverKind !== CODEX_DESKTOP_DRIVER_KIND) continue
      const classified = classifyCodexRolloutLine(Buffer.from(record.rawBytes).toString('utf8'))
      if ('outcome' in classified) continue
      if (classified.payloadType === 'task_started') {
        const turnId = turnIdOf(classified.payload)
        if (turnId !== undefined) startedTurns.add(turnId)
        continue
      }
      if (classified.payloadType !== 'item_completed' || classified.item === undefined) continue
      if (getString(classified.item, 'type') !== 'UserMessage') continue
      if (getString(classified.item, 'client_id') !== attempt.clientUserMessageId) continue
      const cursor = record.sourceCursor['byteOffset']
      if (typeof cursor === 'number' && cursor < attempt.observationWatermark) continue
      const turnId = turnIdOf(classified.payload)
      if (turnId !== undefined && startedTurns.has(turnId)) return turnId
    }
    return undefined
  }
}

function parseDesktopSpec(spec: HarnessInvocationSpec): CodexDesktopDriverSpec {
  if (spec.driver.kind !== CODEX_DESKTOP_DRIVER_KIND) {
    throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid codex-desktop driver spec')
  }
  const value = spec.driver as Record<string, unknown>
  const required = [
    'bundleExecutable',
    'codexHome',
    'sqliteHome',
    'threadId',
    'rolloutPath',
  ] as const
  for (const field of required) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `codex-desktop driver.${field} must be a non-empty string`
      )
    }
  }
  const watermark = asCodexRecord(value['adoptionWatermark'])
  if (
    watermark !== undefined &&
    (typeof watermark['byteOffset'] !== 'number' || watermark['byteOffset'] < 0)
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'codex-desktop driver.adoptionWatermark.byteOffset must be a non-negative number'
    )
  }
  return value as unknown as CodexDesktopDriverSpec
}

function sourceKey(spec: CodexDesktopDriverSpec): string {
  return `provider-jsonl:${spec.threadId}:${spec.rolloutPath}`
}

function nativeIdOf(line: string): string | undefined {
  const classified = classifyCodexRolloutLine(line)
  if ('outcome' in classified) return undefined
  const turnId = getString(classified.payload, 'turn_id')
  const itemId = classified.item === undefined ? undefined : getString(classified.item, 'id')
  return itemId ?? turnId
}

function capturedRecord(record: RawProviderRecord): CapturedRecord {
  return {
    record,
    provenance: () => ({
      rawRecordId: record.rawRecordId,
      sourceKind: record.sourceKind,
      sourceEpoch: record.sourceEpoch,
      ...(Object.keys(record.sourceCursor).length > 0
        ? { sourceCursor: record.sourceCursor as Record<string, string | number> }
        : {}),
      nativeType: record.nativeType,
      ...(record.nativeId !== undefined ? { nativeId: record.nativeId } : {}),
      rawSha256: record.sha256,
      normalizer: { name: CODEX_DESKTOP_DRIVER_KIND, version: CODEX_DESKTOP_DRIVER_VERSION },
    }),
  }
}

function durableResumeOffset(path: string, records: RawProviderRecord[]): number {
  const relevant = records
    .filter(
      (record) =>
        record.driverKind === CODEX_DESKTOP_DRIVER_KIND &&
        typeof record.sourceCursor['byteOffset'] === 'number'
    )
    .sort(
      (left, right) =>
        Number(left.sourceCursor['byteOffset']) - Number(right.sourceCursor['byteOffset'])
    )
  const last = relevant.at(-1)
  if (last === undefined) return 0
  const offset = Number(last.sourceCursor['byteOffset'])
  const fd = safeOpen(path)
  if (fd === undefined) return 0
  try {
    const probe = Buffer.alloc(last.rawBytes.length)
    const read = readSync(fd, probe, 0, probe.length, offset)
    if (read !== probe.length || !probe.equals(Buffer.from(last.rawBytes))) return 0
    return offset + last.rawBytes.length + 1
  } catch {
    return 0
  } finally {
    closeSync(fd)
  }
}

function safeOpen(path: string): number | undefined {
  try {
    return openSync(path, 'r')
  } catch {
    return undefined
  }
}

function isRecordedTool(itemType: string | undefined): boolean {
  return new Set([
    'CommandExecution',
    'DynamicToolCall',
    'CollabAgentToolCall',
    'WebSearch',
    'ImageView',
    'Extension',
    'ImageGeneration',
    'FileChange',
    'McpToolCall',
    'FunctionCallOutput',
  ]).has(itemType ?? '')
}

function toolName(itemType: string | undefined, item: Record<string, unknown>): string {
  return (
    getString(item, 'tool') ??
    getString(item, 'name') ??
    (itemType === 'CommandExecution' ? 'command' : (itemType ?? 'recorded-tool'))
  )
}

function recordedToolResult(itemType: string | undefined, item: Record<string, unknown>): unknown {
  if (itemType === 'CommandExecution') {
    return {
      status: item['status'],
      stdout: item['stdout'],
      stderr: item['stderr'],
      output: item['aggregated_output'],
      exitCode: item['exit_code'],
      duration: item['duration'],
    }
  }
  return item
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function desktopInstallationKey(spec: CodexDesktopDriverSpec): string {
  return `${spec.codexHome}\u0000${spec.sqliteHome}\u0000${spec.threadId}`
}

function queueSubmissionId(value: unknown): string | undefined {
  const record = asCodexRecord(value) ?? {}
  return (
    getString(record, 'queuedSubmissionId') ??
    getString(record, 'id') ??
    getString(asCodexRecord(record['queuedSubmission']) ?? {}, 'id') ??
    getString(asCodexRecord(record['submission']) ?? {}, 'id')
  )
}

function queueEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map((entry) => asCodexRecord(entry) ?? {})
  const record = asCodexRecord(value) ?? {}
  for (const key of ['data', 'items', 'queue', 'submissions']) {
    const entries = record[key]
    if (Array.isArray(entries)) return entries.map((entry) => asCodexRecord(entry) ?? {})
  }
  return []
}

function queueEntryId(entry: Record<string, unknown>): string | undefined {
  return (
    getString(entry, 'queuedSubmissionId') ??
    getString(entry, 'id') ??
    getString(asCodexRecord(entry['queuedSubmission']) ?? {}, 'id')
  )
}

function queueEntryClientId(entry: Record<string, unknown>): string | undefined {
  return (
    getString(entry, 'clientUserMessageId') ??
    getString(entry, 'client_id') ??
    getString(asCodexRecord(entry['queuedSubmission']) ?? {}, 'clientUserMessageId')
  )
}

async function listAllQueued(
  helper: CodexDesktopQueueHelper,
  threadId: string
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await helper.list(threadId, cursor)
    entries.push(...queueEntries(page))
    const nextCursor = getString(asCodexRecord(page) ?? {}, 'nextCursor')
    if (nextCursor === undefined || nextCursor.length === 0) return entries
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Codex thread/queue/list repeated cursor ${nextCursor}`)
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

async function openBundledQueueHelper(
  spec: CodexDesktopDriverSpec
): Promise<CodexDesktopQueueHelper> {
  const proc = spawn(spec.bundleExecutable, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: spec.codexHome,
      CODEX_SQLITE_HOME: spec.sqliteHome,
    },
  })
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })
  const rpc: CodexRpcPeer = new CodexRpcClient(proc)
  try {
    await rpc.sendRequest('initialize', {
      clientInfo: { name: 'harness-broker-codex-desktop', version: CODEX_DESKTOP_DRIVER_VERSION },
      capabilities: { experimentalApi: true },
    })
    await rpc.sendNotification('initialized', {})
  } catch (error) {
    rpc.close()
    if (proc.exitCode === null) proc.kill('SIGTERM')
    throw new Error(
      `Desktop-bundled Codex app-server initialization failed: ${describe(error)}${
        stderr.trim().length > 0 ? `; stderr: ${stderr.trim()}` : ''
      }`
    )
  }
  return {
    list(threadId, cursor) {
      return rpc.sendRequest('thread/queue/list', {
        threadId,
        ...(cursor !== undefined ? { cursor } : {}),
      })
    },
    add(threadId, input, clientUserMessageId) {
      return rpc.sendRequest('thread/queue/add', {
        threadId,
        input: buildCodexInput(input, undefined),
        clientUserMessageId,
      })
    },
    delete(threadId, queuedSubmissionId) {
      return rpc.sendRequest('thread/queue/delete', { threadId, queuedSubmissionId })
    },
    close() {
      rpc.close()
      if (proc.exitCode === null) proc.kill('SIGTERM')
    },
  }
}
