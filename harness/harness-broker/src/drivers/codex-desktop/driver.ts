import { type FSWatcher, accessSync, watch } from 'node:fs'
import { dirname } from 'node:path'
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
import { BrokerError, errorMessage } from '../../errors'
import {
  classifyCodexRolloutLine,
  codexNativeTypeOf,
  codexResponseItemOf,
} from '../codex-rollout/native'
import type {
  ApplyInputResult,
  CancelInputResult,
  Driver,
  DriverContext,
  DriverStartResult,
} from '../driver'
import { CODEX_DESKTOP_AUTHORITY } from '../evidence-authority'
import { getString } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { createNativeDelivery } from './native-delivery'
import { type CodexDesktopQueueHelper, openBundledQueueHelper } from './queue-helper'
import { createRolloutNormalizer } from './rollout-normalizer'
import { capturedRecord, rolloutResumeOffset } from './rollout-resume'
import {
  CODEX_DESKTOP_DRIVER_KIND,
  CODEX_DESKTOP_DRIVER_VERSION,
  type CodexDesktopDriverSpec,
  parseDesktopSpec,
  sourceKey,
} from './spec'

export interface CodexDesktopDriverOptions {
  pollIntervalMs?: number | undefined
  watchFile?: boolean | undefined
  openQueueHelper?: ((spec: CodexDesktopDriverSpec) => Promise<CodexDesktopQueueHelper>) | undefined
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
  let tailer = createTailer()

  const delivery = createNativeDelivery({
    ctx: requireCtx,
    spec: activeSpec,
    openQueueHelper: options.openQueueHelper ?? openBundledQueueHelper,
    readRows,
  })
  const normalizer = createRolloutNormalizer({
    emit: (type, payload, extra) => requireCtx().emit(type, payload, extra),
    threadId: () => activeSpec().threadId,
    claimOwnUserMessage: (message) => delivery.claimOwnUserMessage(message),
  })

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

  function emitHealth(nextReason: string | undefined): void {
    if (healthReason === nextReason) return
    healthReason = nextReason
    if (ctx === undefined) return
    const lastNativeActivity = normalizer.lastNativeActivity()
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

  function readRows(): void {
    const active = activeSpec()
    try {
      accessSync(active.rolloutPath)
      emitHealth(undefined)
    } catch (error) {
      emitHealth(`rollout unreadable or not materialized: ${errorMessage(error)}`)
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
        (captured) => normalizer.normalize(captured)
      )
    })
  }

  function scheduleRead(): void {
    if (stopped) return
    drain = drain
      .then(() => readRows())
      .catch((error) => emitHealth(`observer read failed: ${errorMessage(error)}`))
  }

  function setupWatch(path: string): void {
    if (options.watchFile !== false) {
      try {
        watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
          if (filename === null || path.endsWith(String(filename))) scheduleRead()
        })
        watcher.on('error', (error) => emitHealth(`rollout watch failed: ${errorMessage(error)}`))
      } catch (error) {
        emitHealth(`rollout watch unavailable: ${errorMessage(error)}`)
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
      return (captured) => normalizer.normalize(captured)
    },

    runtimeHealth() {
      const reason = healthReason ?? delivery.deliveryReason()
      return reason === undefined
        ? ({ state: 'healthy' } as const)
        : ({ state: 'degraded', reason } as const)
    },

    admissionRejectionReason(admissionClass) {
      return admissionClass === 'queue' ? delivery.deliveryReason() : undefined
    },

    probeAdmissionState() {
      return { harnessLocalQueueDepth: delivery.harnessLocalQueueDepth() }
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
      normalizer.reset()
      delivery.open(parsed, driverCtx.durableStateDir)
      tailer = createTailer()

      // Rebuild dedupe state from records this capture already settled...
      const records = driverCtx.capture?.records() ?? []
      for (const record of records) {
        if (
          record.driverKind === CODEX_DESKTOP_DRIVER_KIND &&
          driverCtx.capture?.disposition(record.rawRecordId) !== 'pending'
        ) {
          normalizer.normalize(capturedRecord(record), false)
        }
      }
      // ...and re-drive the crash window before moving the physical file cursor.
      driverCtx.capture?.replayPending((captured) => normalizer.normalize(captured))
      tailer.retarget(parsed.rolloutPath, {
        startAtOffset: rolloutResumeOffset(driverCtx, parsed, records),
      })
      readRows()
      await delivery.reconcileUnresolved()
      setupWatch(parsed.rolloutPath)
      return { ok: true }
    },

    applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      return delivery.applyInput(input)
    },

    cancelInput(inputId): Promise<CancelInputResult> {
      return delivery.cancel(inputId)
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
      delivery.close()
      ctx = undefined
      spec = undefined
    },
  }
}

function nativeIdOf(line: string): string | undefined {
  const responseItem = codexResponseItemOf(line)
  if (responseItem !== undefined) {
    return getString(responseItem.payload, 'call_id') ?? getString(responseItem.payload, 'id')
  }
  const classified = classifyCodexRolloutLine(line)
  if ('outcome' in classified) return undefined
  const turnId = getString(classified.payload, 'turn_id')
  const itemId = classified.item === undefined ? undefined : getString(classified.item, 'id')
  return itemId ?? turnId
}
