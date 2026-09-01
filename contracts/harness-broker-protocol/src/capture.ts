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
  'submission.absorbed': 'submission-disposition',
  'submission.executed': 'submission-disposition',
  'submission.cancelled': 'submission-disposition',
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
 * Families for which an unclassified native type HALTS the normalization cursor
 * (law 6d04d5de: "An unclassified load-bearing type, including a queue
 * operation used for turn attribution, warns and stops its normalization cursor
 * until an operator disposition releases it").
 *
 * Turn attribution, conversation content, tool evidence, submission disposition
 * and permission gating are all facts a consumer ACTS on, so guessing past an
 * unknown type in them is not recoverable. Everything else (diagnostics, usage,
 * turn supervision, terminal-surface reports, artifact pointers) still records a
 * `blocked-unknown` disposition and emits `capture.warning`, but does not halt.
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

/** Whether an invocation's normalization cursor is running or halted. */
export interface CaptureStateView {
  state: 'open' | 'blocked'
  blockedOn?:
    | {
        rawRecordId: string
        nativeType: string
        family: EventFamily
        message: string
        sinceIso: IsoTimestamp
      }
    | undefined
  /** Raw records committed but held unnormalized behind the halt. */
  deferredCount: number
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
