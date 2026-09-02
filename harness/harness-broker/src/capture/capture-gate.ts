import type {
  CaptureBlockedUnknownSummary,
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
 * The cursor NEVER STOPS. A `blocked-unknown` — in any family, load-bearing
 * included — records its disposition, emits `capture.warning{kind:
 * 'blocked_unknown'}`, writes one WARN line on the broker's own stderr, and the
 * cursor advances to the next record. Lance ruled it on 2026-09-02 (wrkq
 * T-07883), superseding the halt clause of T-07849 item 11:
 *
 *   "We should never halt when an unknown event arrives. Harnesses are upgraded
 *    all the time; we don't want to hard-fail our entire fleet when we haven't
 *    handled an upgraded new event. It should warn loudly."
 *
 * The halt was live for one night and fired three times on real seats, every
 * time on a KNOWN native type in an unhandled state (a plain Claude user row
 * arriving while a turn was active) rather than on a new type. Each seat kept
 * running while HRC saw it busy forever, and nothing reached an
 * operator-readable log. Evidence is still never dropped: the raw journal, the
 * per-record disposition and the provenance are exactly what they were. Only
 * holding-later-records is gone.
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
  /** Commit `input` verbatim and then normalize it. */
  ingest(input: RawJournalAppendInput, normalize: CaptureNormalizer): void
  /** Mint a new source epoch: file replaced/truncated, or provider reconnected. */
  rotateEpoch(sourceKey: string): void
  /** Re-drive every still-`pending` committed record (restart replay, §7.3). */
  replayPending(normalize: CaptureNormalizer): number
  /**
   * Every committed raw record for this invocation, in commit order. This is
   * the ONE source a driver may derive a provider-transcript export from: an
   * export built from anything else could carry a row the journal does not.
   */
  records(): RawProviderRecord[]
  /**
   * Retained operator surface. Since T-07883 no record ever blocks the cursor,
   * so every call throws {@link CaptureRecordNotBlockedError} — the same
   * refusal an operator naming the wrong record has always received. The RPC,
   * the `harness-broker capture release` command and the SDK types stay on the
   * wire until the whole fleet is on a broker that cannot halt.
   */
  release(input: {
    rawRecordId: string
    disposition: 'ignored-known' | 'normalized-as'
    normalizedAs?: CaptureReleaseNormalizedAs | undefined
    note?: string | undefined
  }): CaptureReleaseOutcome
  state(): CaptureStateView
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
  /**
   * Emit a committed `capture.released`; returns the committed seq. Retained
   * with the release surface (see {@link CaptureGate.release}) and unreachable
   * while no record can block.
   */
  emitReleased: (payload: CaptureReleasedPayload) => number
  /** Emit the operator-authored normalized event of a `normalized-as` release. */
  emitNormalizedAs: (spec: CaptureReleaseNormalizedAs, provenance: EventProvenance) => number
  /**
   * ONE line at WARN on the broker process's own log — the seat's
   * `bipc/<id>/broker.err`. A human tailing that file must see an unclassified
   * record without parsing ndjson, which is exactly what the halt failed to
   * give operators. Defaults to `process.stderr`.
   */
  warn?: ((line: string) => void) | undefined
}

interface UnknownTally extends CaptureBlockedUnknownSummary {
  count: number
  lastSeenIso: string
}

export function createCaptureGate(options: CaptureGateOptions): CaptureGate {
  const { invocationId, journal, index, normalizer, now } = options
  const warn = options.warn ?? ((line: string) => void process.stderr.write(`${line}\n`))
  /**
   * Rate limit, keyed by EXACT `(driver, nativeType, family)`. A harness that
   * starts emitting an unhandled type emits it many times per turn: one WARN
   * line per key per invocation is loud, one per record is a flood an operator
   * learns to ignore. The repeat count rides the snapshot instead.
   */
  const unknownByKey = new Map<string, UnknownTally>()

  // A halt written by a PRE-T-07883 broker is cleared on load rather than
  // resurrected: the ruling is that the fleet never halts, and a restart that
  // silently reinstated last night's halt would be the same outage with a new
  // start time. Records held behind it are still `pending` in the index, so the
  // ordinary `replayPending` on warm reattach normalizes them.
  const legacyHalt = index.blockedOn(invocationId)
  if (legacyHalt !== undefined) {
    index.unblock(invocationId)
    warn(
      logLine('capture halt cleared (T-07883: the cursor no longer halts)', {
        invocationId,
        driver: normalizer.name,
        family: legacyHalt.family,
        nativeType: legacyHalt.nativeType,
        rawRecordId: legacyHalt.rawRecordId,
        sinceIso: legacyHalt.sinceIso,
        message: legacyHalt.message,
      })
    )
  }

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

  /**
   * Record the unclassified type, and log it if this exact key has not already
   * been logged on this invocation.
   */
  function tallyUnknown(record: RawProviderRecord, family: EventFamily, message: string): void {
    const driver = record.driverKind
    const key = `${driver}\u0000${record.nativeType}\u0000${family}`
    const iso = now().toISOString()
    const existing = unknownByKey.get(key)
    if (existing !== undefined) {
      existing.count += 1
      existing.lastSeenIso = iso
      return
    }
    const loadBearing = isLoadBearingEventFamily(family)
    unknownByKey.set(key, {
      driver,
      nativeType: record.nativeType,
      family,
      loadBearing,
      count: 1,
      message,
      firstSeenIso: iso,
      lastSeenIso: iso,
    })
    warn(
      logLine('capture blocked_unknown', {
        invocationId,
        driver,
        family,
        nativeType: record.nativeType,
        rawRecordId: record.rawRecordId,
        loadBearing,
        message,
      })
    )
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

    index.dispose(
      invocationId,
      record.rawRecordId,
      'blocked-unknown',
      outcome.message,
      'normalizer'
    )
    tallyUnknown(record, outcome.family, outcome.message)
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
        // Retained for a consumer pinned to the pre-ruling payload; always
        // false now. `loadBearing` is the taxonomy fact that survived.
        cursorHalted: false,
        loadBearing: isLoadBearingEventFamily(outcome.family),
        native: decodeNative(record),
      },
    })
  }

  function stateView(): CaptureStateView {
    const blockedUnknown = [...unknownByKey.values()]
    return {
      state: 'open',
      deferredCount: 0,
      ...(blockedUnknown.length > 0 ? { blockedUnknown } : {}),
    }
  }

  return {
    records(): RawProviderRecord[] {
      return journal.read()
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
        replayed += 1
        normalizeNow(record, normalize)
      }
      return replayed
    },

    release(input): CaptureReleaseOutcome {
      // Nothing blocks, so nothing can be released. The refusal is the existing
      // typed one, which names the record and reports `capture: open`, so a
      // `hrc capture release` against a fleet on this broker reads as "there is
      // nothing to release" rather than as a broker fault.
      throw new CaptureRecordNotBlockedError(input.rawRecordId)
    },

    state: stateView,
  }
}

/** One line, `key=value` pairs, whitespace flattened so a tail stays greppable. */
function logLine(what: string, fields: Record<string, unknown>): string {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${flatten(String(value))}`)
  return `WARN harness-broker ${what} ${pairs.join(' ')}`
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
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
