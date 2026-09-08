import { type FSWatcher, accessSync, closeSync, openSync, readSync, watch } from 'node:fs'
import { dirname } from 'node:path'
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
import {
  asCodexRecord,
  classifyCodexRolloutLine,
  codexContentText,
  codexNativeTypeOf,
} from '../codex-rollout/native'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { withDeliveryEvidence } from '../driver'
import { CODEX_DESKTOP_AUTHORITY } from '../evidence-authority'
import { getString } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'

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
  let ctx: DriverContext | undefined
  let spec: CodexDesktopDriverSpec | undefined
  let watcher: FSWatcher | undefined
  let poller: ReturnType<typeof setInterval> | undefined
  let drain = Promise.resolve()
  let stopped = false
  let healthReason: string | undefined
  let lastNativeActivity: string | undefined
  let currentTurnId: TurnId | undefined
  let heldAssistant: HeldAssistant | undefined
  const seenItems = new Set<string>()
  const seenUsers = new Set<string>()
  const seenTurnStarts = new Set<string>()
  const seenTurnTerminals = new Set<string>()
  const attributedTurns = new Set<string>()
  const contentTurns = new Set<string>()
  // T-08295 will populate this only after its durable write-ahead queue record.
  const ownedInputIds = new Set<string>()
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
        const afterAdoption =
          typeof cursor !== 'number' || cursor >= (activeSpec().adoptionWatermark?.byteOffset ?? 0)
        const own = clientId !== undefined && afterAdoption && ownedInputIds.has(clientId)
        const inputId = own ? (clientId as InputId) : undefined
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

    capabilities(): InvocationCapabilities {
      return CODEX_DESKTOP_CAPABILITIES
    },

    captureNormalizer() {
      return (captured) => normalizeRecord(captured)
    },

    runtimeHealth() {
      return healthReason === undefined
        ? ({ state: 'healthy' } as const)
        : ({ state: 'degraded', reason: healthReason } as const)
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
      resetParserState()
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
      setupWatch(parsed.rolloutPath)
      return { ok: true }
    },

    async applyInputNow(_input: InvocationInput): Promise<ApplyInputResult> {
      throw withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          'codex-desktop queue delivery is not implemented until T-08295'
        ),
        'not_written'
      )
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
      ctx = undefined
      spec = undefined
    },
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
