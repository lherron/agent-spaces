import type { InvocationEventType } from './events'
import type { InvocationId, TurnId } from './ids'
import type { IsoTimestamp } from './primitives'

/**
 * Local-first capture contract (law `agent-spaces.harness-broker-local-commit-observation`,
 * T-07853 §§6, 6.1, 7). Types here describe HOW a normalized broker event came
 * to exist and what happened to the raw provider bytes behind it. They are
 * protocol-only: the broker owns the journal and index that produce them, and
 * HRC/renderers/parity tooling consume them.
 */

/** Where a raw provider record — and therefore a normalized event — came from. */
export type EventSourceKind = 'provider-jsonl' | 'provider-jsonrpc' | 'hook' | 'broker'

/**
 * Event families are the unit of DECLARED PROVIDER AUTHORITY (§6): authority is
 * per family, never once per provider. Every {@link InvocationEventType} maps to
 * exactly one family through {@link EVENT_FAMILY_BY_TYPE}.
 */
export type EventFamily =
  | 'invocation-lifecycle'
  | 'harness-lifecycle'
  | 'continuation'
  | 'input-admission'
  | 'submission-disposition'
  | 'turn-bracket'
  | 'turn-supervision'
  | 'conversation'
  | 'tool'
  | 'usage'
  | 'permission'
  | 'diagnostic'
  | 'terminal-surface'
  | 'provider-artifact'

/**
 * Which source owns a family's facts for a given driver. `native` = the
 * provider's own transcript/notification stream; `hook` = a synchronous harness
 * hook; `broker` = a broker decision (input disposition, lifecycle policy,
 * control disposition) that no provider can report.
 */
export type EvidenceAuthority = 'native' | 'hook' | 'broker'

/** Per-driver declared authority for every event family (§6, spec item 1). */
export type EvidenceAuthorityMatrix = Record<EventFamily, EvidenceAuthority>

/**
 * Total map from event name to family. Typed as a full `Record` so adding an
 * event to {@link InvocationEventPayloadMap} without classifying it fails the
 * build rather than silently landing outside every authority declaration.
 */
export const EVENT_FAMILY_BY_TYPE: Record<InvocationEventType, EventFamily> = {
  'invocation.started': 'invocation-lifecycle',
  'invocation.ready': 'invocation-lifecycle',
  'invocation.stopping': 'invocation-lifecycle',
  'invocation.exited': 'invocation-lifecycle',
  'invocation.failed': 'invocation-lifecycle',
  'invocation.disposed': 'invocation-lifecycle',
  'invocation.summary': 'invocation-lifecycle',
  'lifecycle.policy.accepted': 'invocation-lifecycle',
  'lifecycle.escalation': 'invocation-lifecycle',
  'harness.started': 'harness-lifecycle',
  'harness.exited': 'harness-lifecycle',
  'harness.recovery.started': 'harness-lifecycle',
  'harness.recovery.completed': 'harness-lifecycle',
  'harness.recovery.failed': 'harness-lifecycle',
  'continuation.updated': 'continuation',
  'continuation.cleared': 'continuation',
  'input.accepted': 'input-admission',
  'input.rejected': 'input-admission',
  'input.queued': 'input-admission',
  // The four-door admission API (T-07860): admission, the broker-held queue and
  // interrupt actuation are all broker DECISIONS — the broker owns which class a
  // submission entered, where it sits in its own queue, and whether it issued an
  // interrupt. No provider reports any of them.
  'admission.requested': 'input-admission',
  'admission.admitted': 'input-admission',
  'admission.rejected': 'input-admission',
  'queue.enqueued': 'input-admission',
  'queue.jumped': 'input-admission',
  'queue.cancelled': 'input-admission',
  'queue.expired': 'input-admission',
  'interrupt.requested': 'input-admission',
  'interrupt.landed': 'input-admission',
  'interrupt.failed': 'input-admission',
  'submission.absorbed': 'submission-disposition',
  'submission.executed': 'submission-disposition',
  'submission.cancelled': 'submission-disposition',
  'submission.rejected': 'submission-disposition',
  'submission.expired': 'submission-disposition',
  'turn.started': 'turn-bracket',
  'turn.completed': 'turn-bracket',
  'turn.failed': 'turn-bracket',
  'turn.interrupted': 'turn-bracket',
  'turn.stalled': 'turn-supervision',
  'turn.retry': 'turn-supervision',
  'assistant.message.started': 'conversation',
  'assistant.message.delta': 'conversation',
  'assistant.message.completed': 'conversation',
  'user.message': 'conversation',
  'tool.call.started': 'tool',
  'tool.call.delta': 'tool',
  'tool.call.completed': 'tool',
  'tool.call.failed': 'tool',
  'usage.updated': 'usage',
  'permission.requested': 'permission',
  'permission.resolved': 'permission',
  'permission.cancelled': 'permission',
  diagnostic: 'diagnostic',
  'driver.notice': 'diagnostic',
  'capture.warning': 'diagnostic',
  'capture.released': 'diagnostic',
  'terminal.surface.reported': 'terminal-surface',
  'provider.transcript.reported': 'provider-artifact',
}

/**
 * Families whose facts a consumer ACTS on: turn attribution, conversation
 * content, tool evidence, submission disposition and permission gating. An
 * unclassified native type in one of these is the LOUDEST kind of capture
 * warning — but it is still only a warning.
 *
 * This set no longer gates any halt. Lance ruled on 2026-09-02 (wrkq T-07883):
 * "We should never halt when an unknown event arrives. Harnesses are upgraded
 * all the time; we don't want to hard-fail our entire fleet when we haven't
 * handled an upgraded new event. It should warn loudly." The ruling supersedes
 * the halt clause of law 6d04d5de / T-07849 item 11. The taxonomy stays,
 * because it still says how loud a warning is and who owns the family; it is
 * carried on `capture.warning{kind:'blocked_unknown'}` as `loadBearing`.
 *
 * The families are split finer than the event-name prefixes precisely so that
 * each one has ONE truthful owner per driver: broker-decided admission
 * (`input.*`) is separated from provider-observed submission outcomes
 * (`submission.*`), and broker-decided turn supervision (`turn.stalled` /
 * `turn.retry`, which come from lifecycle policy) from the provider-observed
 * turn bracket.
 */
export const LOAD_BEARING_EVENT_FAMILIES = [
  'turn-bracket',
  'conversation',
  'tool',
  'input-admission',
  'submission-disposition',
  'permission',
] as const satisfies readonly EventFamily[]

export function isLoadBearingEventFamily(family: EventFamily): boolean {
  return (LOAD_BEARING_EVENT_FAMILIES as readonly EventFamily[]).includes(family)
}

/**
 * Provenance of one normalized broker event (§7.2). Carried on the envelope
 * alongside — never in place of — the existing identity fields.
 *
 * OPTIONAL on the wire, ALWAYS populated by a broker that has this contract:
 * the Phase 1a durable ledger already holds committed records with no
 * provenance and replays them through this same validator, so requiring the
 * field would make a pre-Phase-0 ledger unreplayable.
 */
export interface EventProvenance {
  rawRecordId?: string | undefined
  sourceKind: EventSourceKind
  sourceEpoch?: string | undefined
  sourceCursor?: Record<string, string | number> | undefined
  nativeType?: string | undefined
  nativeId?: string | undefined
  rawSha256?: string | undefined
  normalizer: { name: string; version: string }
}

/** Cursor position of a raw record within its source epoch (§7.1). */
export interface RawSourceCursor {
  byteOffset?: number | undefined
  line?: number | undefined
  nativeSequence?: string | undefined
}

/**
 * One verbatim provider input, committed BEFORE normalization (§7.1). Broker
 * metadata wraps the bytes; it never rewrites them.
 */
export interface RawProviderRecord {
  rawRecordId: string
  invocationId: InvocationId
  provider: string
  driverKind: string
  sourceKind: EventSourceKind
  /**
   * Changes on file replacement, truncation, provider-session replacement or
   * reconnect. Cursor comparison is valid ONLY within one epoch.
   */
  sourceEpoch: string
  sourceCursor: RawSourceCursor
  nativeType: string
  nativeId?: string | undefined
  observedAt: IsoTimestamp
  sha256: string
  rawBytes: Uint8Array
  correlationHints?: Record<string, string> | undefined
}

/**
 * Exactly one durable disposition per committed raw record (§6.1). `pending` is
 * the only non-terminal value: it means the record is committed but has not yet
 * been normalized (it is behind a halted cursor, or normalization is in flight).
 */
export type RawRecordDisposition =
  | 'pending'
  | 'normalized'
  | 'state-only'
  | 'duplicate'
  | 'ignored-known'
  | 'blocked-unknown'

/**
 * An invocation's normalization cursor. Since T-07883 the cursor never stops,
 * so `state` is always `open` and `deferredCount` always 0 — both are retained
 * so a controller, CLI or SDK built against the pre-ruling contract still
 * parses this view, and `blockedOn` is never populated.
 */
export interface CaptureStateView {
  state: 'open' | 'blocked'
  /** Never set since T-07883: no record blocks the cursor. */
  blockedOn?:
    | {
        rawRecordId: string
        nativeType: string
        family: EventFamily
        message: string
        sinceIso: IsoTimestamp
      }
    | undefined
  /** Always 0 since T-07883: no record is ever held unnormalized. */
  deferredCount: number
  /**
   * One entry per distinct `(driver, nativeType, family)` that reached the
   * normalizer unclassified on this invocation, with how many raw records hit
   * it. The broker logs each key ONCE at WARN on its own stderr; the count of
   * repeats lives here rather than in a per-record log flood.
   */
  blockedUnknown?: readonly CaptureBlockedUnknownSummary[] | undefined
}

/** Repeat count for one unclassified `(driver, nativeType, family)` key. */
export interface CaptureBlockedUnknownSummary {
  driver: string
  nativeType: string
  family: EventFamily
  /** Whether the family is one a consumer acts on (loudest warnings). */
  loadBearing: boolean
  /** Raw records that hit this key, including the first. */
  count: number
  /** The message the first occurrence carried. */
  message: string
  firstSeenIso: IsoTimestamp
  lastSeenIso: IsoTimestamp
}

/**
 * An operator disposition released a blocked-unknown record and the
 * normalization cursor resumed. Committed to the normalized ledger like any
 * other event, so the release is a durable fact rather than an RPC side effect.
 */
export interface CaptureReleasedPayload {
  rawRecordId: string
  disposition: 'ignored-known' | 'normalized'
  nativeType?: string | undefined
  family?: EventFamily | undefined
  note?: string | undefined
  normalizedAs?: { type: InvocationEventType } | undefined
  /** How many deferred raw records this release re-normalized. */
  resumedRecords: number
}

/** Operator-authored normalized event for a `normalized-as` release. */
export interface CaptureReleaseNormalizedAs {
  type: InvocationEventType
  payload: unknown
  turnId?: TurnId | undefined
  itemId?: string | undefined
}

/**
 * Fenced control RPC (`invocation.capture.release`). Mutating, so it lives on
 * the control connection with the other mutating RPCs and never on the
 * read-only observer surface.
 */
export interface InvocationCaptureReleaseRequest {
  invocationId: InvocationId
  rawRecordId: string
  disposition: 'ignored-known' | 'normalized-as'
  /** Required iff `disposition === 'normalized-as'`. */
  normalizedAs?: CaptureReleaseNormalizedAs | undefined
  note?: string | undefined
}

export interface InvocationCaptureReleaseResponse {
  released: true
  invocationId: InvocationId
  rawRecordId: string
  disposition: 'ignored-known' | 'normalized'
  /** Seq of the committed `capture.released` event. */
  releasedSeq: number
  /** Seq of the operator-authored normalized event, when one was minted. */
  normalizedSeq?: number | undefined
  resumedRecords: number
  capture: CaptureStateView
}

/** Stable `data.reason` when a release names a record that is not blocked. */
export const CAPTURE_RELEASE_NOT_BLOCKED = 'raw_record_not_blocked'
