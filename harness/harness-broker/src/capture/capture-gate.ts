import type {
  CaptureReleaseNormalizedAs,
  CaptureReleasedPayload,
  CaptureStateView,
  CaptureWarningPayload,
  EventFamily,
  EventProvenance,
  InvocationId,
  RawProviderRecord,
} from 'spaces-harness-broker-protocol'
import { isLoadBearingEventFamily } from 'spaces-harness-broker-protocol'
import type { CaptureIndex } from './capture-index'
import type { RawJournal, RawJournalAppendInput } from './raw-journal'

/**
 * The normalization cursor for one invocation (T-07853 §6.1, §7; law
 * `agent-spaces.harness-broker-local-commit-observation`).
 *
 * Every provider input passes through here and the order is fixed:
 *
 *   1. commit the bytes verbatim (`fsync`) — a crash after this re-normalizes;
 *   2. record the raw row as `pending` in the durable index;
 *   3. run the driver's normalizer, WHICH MUST RETURN A DISPOSITION;
 *   4. record that disposition durably.
 *
 * If step 3 reports `blocked-unknown` in a load-bearing family the cursor STOPS:
 * later records are still committed (evidence is never dropped) but are held
 * unnormalized until an operator `invocation.capture.release` disposes the
 * blocking record. The seat keeps running; only capture halts, and it halts
 * visibly through `snapshot.capture.state`.
 */
export type NormalizeOutcome =
  | { disposition: 'normalized' | 'state-only' | 'duplicate' | 'ignored-known'; detail?: string }
  | { disposition: 'blocked-unknown'; family: EventFamily; message: string }

export interface CapturedRecord {
  readonly record: RawProviderRecord
  /**
   * Provenance to stamp on every normalized event this raw record produces
   * (§7.2). Existing envelope identity is untouched; this is added alongside.
   */
  provenance(): EventProvenance
}

export type CaptureNormalizer = (captured: CapturedRecord) => NormalizeOutcome

export interface CaptureGate {
  /**
   * Commit `input` verbatim and then normalize it — unless the cursor is
   * halted, in which case the committed record is HELD and `normalize` runs
   * when the block is released, in cursor order.
   */
  ingest(input: RawJournalAppendInput, normalize: CaptureNormalizer): void
  /** Mint a new source epoch: file replaced/truncated, or provider reconnected. */
  rotateEpoch(sourceKey: string): void
  /** Re-drive every still-`pending` committed record (restart replay, §7.3). */
  replayPending(normalize: CaptureNormalizer): number
  release(input: {
    rawRecordId: string
    disposition: 'ignored-known' | 'normalized-as'
    normalizedAs?: CaptureReleaseNormalizedAs | undefined
    note?: string | undefined
  }): CaptureReleaseOutcome
  state(): CaptureStateView
  readonly blocked: boolean
}

export interface CaptureReleaseOutcome {
  disposition: 'ignored-known' | 'normalized'
  releasedSeq: number
  normalizedSeq?: number | undefined
  resumedRecords: number
  capture: CaptureStateView
}

export class CaptureRecordNotBlockedError extends Error {
  constructor(readonly rawRecordId: string) {
    super(`Raw record ${rawRecordId} is not the blocked-unknown record`)
    this.name = 'CaptureRecordNotBlockedError'
  }
}

export interface CaptureGateOptions {
  invocationId: InvocationId
  journal: RawJournal
  index: CaptureIndex
  normalizer: { name: string; version: string }
  now: () => Date
  /** Emit a committed `capture.warning`; returns the committed seq. */
  emitWarning: (payload: CaptureWarningPayload) => number
  /** Emit a committed `capture.released`; returns the committed seq. */
  emitReleased: (payload: CaptureReleasedPayload) => number
  /** Emit the operator-authored normalized event of a `normalized-as` release. */
  emitNormalizedAs: (spec: CaptureReleaseNormalizedAs, provenance: EventProvenance) => number
}

interface Deferred {
  record: RawProviderRecord
  normalize: CaptureNormalizer
}

export function createCaptureGate(options: CaptureGateOptions): CaptureGate {
  const { invocationId, journal, index, normalizer, now } = options
  const deferred: Deferred[] = []
  // Rehydrated from the durable index, so a broker that reopens an invocation's
  // capture state finds the halt still in force rather than quietly resuming.
  let blocked = index.blockedOn(invocationId)

  function capturedFor(record: RawProviderRecord): CapturedRecord {
    return {
      record,
      provenance(): EventProvenance {
        return {
          rawRecordId: record.rawRecordId,
          sourceKind: record.sourceKind,
          sourceEpoch: record.sourceEpoch,
          ...(Object.keys(record.sourceCursor).length > 0
            ? { sourceCursor: record.sourceCursor as Record<string, string | number> }
            : {}),
          nativeType: record.nativeType,
          ...(record.nativeId !== undefined ? { nativeId: record.nativeId } : {}),
          rawSha256: record.sha256,
          normalizer: { ...normalizer },
        }
      },
    }
  }

  function brokerProvenance(rawRecordId?: string): EventProvenance {
    return {
      ...(rawRecordId !== undefined ? { rawRecordId } : {}),
      sourceKind: 'broker',
      normalizer: { ...normalizer },
    }
  }

  /** Run the normalizer and persist whatever disposition it reports. */
  function normalizeNow(record: RawProviderRecord, normalize: CaptureNormalizer): void {
    let outcome: NormalizeOutcome
    try {
      outcome = normalize(capturedFor(record))
    } catch (error) {
      // A normalizer that throws has classified nothing. That is exactly the
      // "provider method silently disappeared" case §6.1 forbids, so it becomes
      // a blocked-unknown rather than a swallowed exception.
      // Carry the detail, not just the class. A validation failure's `issues`
      // are the whole diagnosis, and "Normalizer threw: Invalid invocation
      // event envelope" on its own sends the reader back to a debugger.
      outcome = {
        disposition: 'blocked-unknown',
        family: 'diagnostic',
        message: `Normalizer threw: ${describeThrown(error)}`,
      }
    }

    if (outcome.disposition !== 'blocked-unknown') {
      index.dispose(
        invocationId,
        record.rawRecordId,
        outcome.disposition,
        outcome.detail,
        'normalizer'
      )
      return
    }

    const halt = isLoadBearingEventFamily(outcome.family)
    index.dispose(
      invocationId,
      record.rawRecordId,
      'blocked-unknown',
      outcome.message,
      'normalizer'
    )
    if (halt) {
      const row = {
        invocationId,
        rawRecordId: record.rawRecordId,
        nativeType: record.nativeType,
        family: outcome.family,
        message: outcome.message,
        sinceIso: now().toISOString(),
      }
      index.block(row)
      blocked = row
    }
    options.emitWarning({
      kind: 'blocked_unknown',
      message: outcome.message,
      raw: {
        rawRecordId: record.rawRecordId,
        nativeType: record.nativeType,
        family: outcome.family,
        sourceKind: record.sourceKind,
        sourceEpoch: record.sourceEpoch,
        sourceCursor: record.sourceCursor,
        cursorHalted: halt,
        native: decodeNative(record),
      },
    })
  }

  function stateView(): CaptureStateView {
    return {
      state: blocked === undefined ? 'open' : 'blocked',
      ...(blocked !== undefined
        ? {
            blockedOn: {
              rawRecordId: blocked.rawRecordId,
              nativeType: blocked.nativeType,
              family: blocked.family,
              message: blocked.message,
              sinceIso: blocked.sinceIso,
            },
          }
        : {}),
      deferredCount: deferred.length,
    }
  }

  function drainDeferred(): number {
    let resumed = 0
    while (blocked === undefined && deferred.length > 0) {
      const next = deferred.shift()
      if (next === undefined) break
      resumed += 1
      normalizeNow(next.record, next.normalize)
    }
    return resumed
  }

  return {
    get blocked(): boolean {
      return blocked !== undefined
    },

    ingest(input, normalize): void {
      // Commit FIRST. A throw here means the bytes are not durable, so nothing
      // downstream may treat them as observed — the caller sees the throw.
      const record = journal.append(input)
      index.record({
        invocationId,
        rawRecordId: record.rawRecordId,
        sourceKind: record.sourceKind,
        sourceEpoch: record.sourceEpoch,
        nativeType: record.nativeType,
        sha256: record.sha256,
        disposition: 'pending',
      })
      if (blocked !== undefined) {
        // Cursor halted: evidence is captured, normalization is not.
        deferred.push({ record, normalize })
        return
      }
      normalizeNow(record, normalize)
    },

    rotateEpoch(sourceKey): void {
      journal.rotateEpoch(sourceKey)
    },

    replayPending(normalize): number {
      const pendingIds = new Set(
        index
          .list(invocationId)
          .filter((row) => row.disposition === 'pending')
          .map((row) => row.rawRecordId)
      )
      if (pendingIds.size === 0) return 0
      let replayed = 0
      for (const record of journal.read()) {
        if (!pendingIds.has(record.rawRecordId)) continue
        if (blocked !== undefined) {
          deferred.push({ record, normalize })
          continue
        }
        replayed += 1
        normalizeNow(record, normalize)
      }
      return replayed
    },

    release(input): CaptureReleaseOutcome {
      const current = blocked
      if (current === undefined || current.rawRecordId !== input.rawRecordId) {
        throw new CaptureRecordNotBlockedError(input.rawRecordId)
      }

      let normalizedSeq: number | undefined
      const disposition: 'ignored-known' | 'normalized' =
        input.disposition === 'ignored-known' ? 'ignored-known' : 'normalized'

      if (input.disposition === 'normalized-as') {
        const spec = input.normalizedAs
        if (spec === undefined) {
          throw new CaptureRecordNotBlockedError(input.rawRecordId)
        }
        // The operator authors the normalized fact the broker could not derive.
        // It carries the blocked record's provenance so the ledger still shows
        // which raw bytes it came from, with sourceKind 'broker' because the
        // classification decision was a broker/operator one, not the provider's.
        normalizedSeq = options.emitNormalizedAs(spec, brokerProvenance(input.rawRecordId))
      }

      index.dispose(invocationId, input.rawRecordId, disposition, input.note, 'operator')
      index.unblock(invocationId)
      blocked = undefined

      // Resume BEFORE committing capture.released so the released event's
      // resumedRecords is a fact, not a prediction. Any resumed record may
      // block again; the drain stops there and the next release resumes it.
      const resumedRecords = drainDeferred()

      const releasedSeq = options.emitReleased({
        rawRecordId: input.rawRecordId,
        disposition,
        nativeType: current.nativeType,
        family: current.family,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(normalizedSeq !== undefined && input.normalizedAs !== undefined
          ? { normalizedAs: { type: input.normalizedAs.type } }
          : {}),
        resumedRecords,
      })

      return {
        disposition,
        releasedSeq,
        ...(normalizedSeq !== undefined ? { normalizedSeq } : {}),
        resumedRecords,
        capture: stateView(),
      }
    },

    state: stateView,
  }
}

/** Message plus any structured `issues`/`data` the thrown error carries. */
function describeThrown(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const detail =
    (error as { issues?: unknown; data?: unknown } | null)?.issues ??
    (error as { data?: unknown } | null)?.data
  if (detail === undefined) return message
  try {
    return `${message}: ${JSON.stringify(detail)}`
  } catch {
    return message
  }
}

/**
 * Best-effort readable form of the verbatim bytes for the warning payload. The
 * journal keeps the authoritative bytes; this is a rendering, and a
 * non-JSON/non-UTF8 row degrades to a base64 string rather than being dropped.
 */
function decodeNative(record: RawProviderRecord): unknown {
  const text = Buffer.from(record.rawBytes).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text.length > 0 && !text.includes('�')
      ? text
      : Buffer.from(record.rawBytes).toString('base64')
  }
}
