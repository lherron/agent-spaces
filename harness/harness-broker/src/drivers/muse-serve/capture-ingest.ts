import type {
  EventFamily,
  EventProvenance,
  RawProviderRecord,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type {
  CaptureNormalizer,
  CapturedRecord,
  NormalizeOutcome,
} from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import type { DriverContext } from '../driver'
import { MUSE_DRIVER_KIND, classifyMuseNotificationMethod } from './event-map'
import type { MuseJsonRpcNotification, MuseJsonRpcRequest } from './rpc-client'

export interface MuseCaptureIngestOptions {
  getContext: () => DriverContext | undefined
  getSessionId: () => string | undefined
  withProvenance: <T>(provenance: EventProvenance, body: () => T) => T
  /** Track and map one notification; returns how many events it minted. */
  applyNotification: (notification: MuseJsonRpcNotification) => number
  /** Note a committed server request replayed without the live answer path. */
  noteReplayedRequest: (method: string) => void
}

export interface MuseCaptureIngest {
  /** Commit one live notification through the capture gate, then normalize it. */
  ingestNotification(notification: MuseJsonRpcNotification, rawFrame: string): void
  /**
   * Commit a live approval request before answering it. Returns the raw record
   * id the permission events cite, or undefined when no capture gate is wired.
   */
  ingestApprovalRequest(
    request: MuseJsonRpcRequest,
    rawFrame: string | undefined
  ): string | undefined
  /** Normalizer for committed records, live and replayed. */
  readonly normalizeCommitted: CaptureNormalizer
  /** Restart the native sequence and rotate the capture epoch for a new start. */
  reset(driverCtx: DriverContext): void
}

/**
 * The muse-serve side of the capture gate (§7.1): every JSON-RPC frame the
 * serve child writes is committed verbatim, with a per-start native sequence
 * cursor, before it is normalized into broker events.
 */
export function createMuseCaptureIngest(options: MuseCaptureIngestOptions): MuseCaptureIngest {
  let notificationSequence = 0

  function requireCtx(): DriverContext {
    const ctx = options.getContext()
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function sourceKey(): string {
    return `muse-serve-rpc:${requireCtx().invocationId}`
  }

  function nextRecordBase(nativeType: string, rawBytes: string) {
    notificationSequence += 1
    const sessionId = options.getSessionId()
    return {
      provider: 'meta' as const,
      driverKind: MUSE_DRIVER_KIND,
      sourceKind: 'provider-jsonrpc' as const,
      sourceKey: sourceKey(),
      sourceCursor: { nativeSequence: String(notificationSequence) },
      nativeType,
      rawBytes: Buffer.from(rawBytes, 'utf8'),
      ...(sessionId !== undefined ? { correlationHints: { sessionId } } : {}),
    }
  }

  const normalizeCommitted: CaptureNormalizer = (captured: CapturedRecord) => {
    const decoded = decodeCommittedMessage(captured.record)
    if (decoded?.kind === 'request') {
      return options.withProvenance(captured.provenance(), () => {
        options.noteReplayedRequest(decoded.message.method)
        return { disposition: 'normalized', detail: decoded.message.method }
      })
    }
    if (decoded === undefined) {
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic' as EventFamily,
        message: `Committed raw record ${captured.record.rawRecordId} is not a muse-serve notification`,
      }
    }
    const notification = decoded.message
    return options.withProvenance(captured.provenance(), () =>
      museNotificationDisposition(notification.method, options.applyNotification(notification))
    )
  }

  return {
    normalizeCommitted,
    ingestNotification(notification, rawFrame) {
      const capture = options.getContext()?.capture
      if (capture === undefined) {
        const minted = options.applyNotification(notification)
        const outcome = museNotificationDisposition(notification.method, minted)
        if (outcome.disposition === 'blocked-unknown') {
          requireCtx().emit('capture.warning', {
            kind: 'blocked_unknown',
            message: outcome.message,
            raw: { native: rawFrame },
          })
        }
        return
      }
      capture.ingest(nextRecordBase(notification.method, rawFrame), normalizeCommitted)
    },
    ingestApprovalRequest(request, rawFrame) {
      const capture = options.getContext()?.capture
      if (capture === undefined) return undefined
      let requestRecordId: string | undefined
      capture.ingest(
        {
          ...nextRecordBase(request.method, rawFrame ?? JSON.stringify(request)),
          nativeId: String(request.id),
        },
        (captured) => {
          requestRecordId = captured.record.rawRecordId
          return options.withProvenance(captured.provenance(), () => ({
            disposition: 'normalized',
            detail: request.method,
          }))
        }
      )
      return requestRecordId
    },
    reset(driverCtx) {
      notificationSequence = 0
      driverCtx.capture?.rotateEpoch(`muse-serve-rpc:${driverCtx.invocationId}`)
    },
  }
}

function museNotificationDisposition(method: string, minted: number): NormalizeOutcome {
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

/** Decode a committed frame: a notification has no id, a server request has one. */
function decodeCommittedMessage(
  record: RawProviderRecord
):
  | { kind: 'notification'; message: MuseJsonRpcNotification }
  | { kind: 'request'; message: MuseJsonRpcRequest }
  | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(record.rawBytes).toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const message = parsed as Record<string, unknown>
  if (typeof message['method'] !== 'string') return undefined
  return message['id'] === undefined
    ? { kind: 'notification', message: message as unknown as MuseJsonRpcNotification }
    : { kind: 'request', message: message as unknown as MuseJsonRpcRequest }
}
