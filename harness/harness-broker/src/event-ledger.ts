import { Database } from 'bun:sqlite'
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'

export interface EventLedgerAppendResult {
  appended: boolean
  /**
   * The stable sequence this call committed (or, for an idempotent no-op, the
   * sequence already committed for these exact bytes). Appends are serialized
   * per invocation, so this is also the record's position in file order.
   */
  seq: number
}

export interface EventLedgerAckResult {
  ackedThroughSeq: number
}

export interface EventLedgerPruneOptions {
  activeInvocationIds: string[]
}

/**
 * What a startup trailing-segment scan repaired, if anything. A torn final
 * record (a partial write interrupted by `kill -9` or a full disk) is truncated
 * and reported here exactly once — the truncation itself makes the repair
 * idempotent, because a subsequent open no longer sees a torn tail.
 */
export interface LedgerTailRepair {
  /** Byte offset the file was truncated to (end of the last intact record). */
  truncatedAtOffset: number
  /** How many trailing bytes were discarded. */
  truncatedBytes: number
  /** Identity of the last intact record, absent when the file held none. */
  lastIntact?: { invocationId: InvocationId; seq: number } | undefined
}

export interface EventLedger {
  /**
   * Commit one event durably (write + `fsync`) and return its stable seq.
   * SYNCHRONOUS by contract: the broker's publish path calls this inline so an
   * event cannot reach a controller or observer before it is on disk. Throws on
   * any storage failure — never swallows.
   */
  appendSync(event: InvocationEventEnvelope): EventLedgerAppendResult
  append(event: InvocationEventEnvelope): Promise<EventLedgerAppendResult>
  eventsSince(invocationId: InvocationId, afterSeq: number): Promise<InvocationEventEnvelope[]>
  ackEvents(invocationId: InvocationId, throughSeq: number): Promise<EventLedgerAckResult>
  retentionFloorSeq(invocationId: InvocationId): Promise<number>
  currentSeq(invocationId: InvocationId): number
  prune(options: EventLedgerPruneOptions): Promise<void>
  /** What the startup scan repaired, if anything. */
  tailRepair(): LedgerTailRepair | undefined
  /** Release the durable consumer-state index handle. */
  close(): void
}

export interface EventLedgerOptions {
  path?: string | undefined
  /**
   * Durable consumer-state index. Defaults to `ledger-index.db` beside the
   * NDJSON ledger (the invocation's bipc dir). Ignored when `path` is absent —
   * a pathless ledger is an in-memory inspection ledger with no durability
   * contract to keep.
   */
  indexPath?: string | undefined
  /** Clock for the index's `updated_at` column. */
  now?: (() => Date) | undefined
}

interface StoredEvent {
  event: InvocationEventEnvelope
  bytes: string
}

interface ConsumerState {
  ackedThroughSeq: number
  retentionFloorSeq: number
}

const DEFAULT_RETENTION_FLOOR = 0

/**
 * Typed below-floor replay rejection, shared by `invocation.eventsSince` and
 * `broker.attach`. The numeric code stays `EventReplayUnavailable` so callers
 * with a numeric precheck keep working; `data.reason` is the stable
 * discriminator and `data.currentSeq` tells the caller where the live stream is.
 */
export function replayBelowFloorError(details: {
  invocationId: string
  afterSeq: number
  retentionFloorSeq: number
  currentSeq: number
}): BrokerError {
  return new BrokerError(
    BrokerErrorCode.EventReplayUnavailable,
    `Event replay unavailable before retention floor ${details.retentionFloorSeq}`,
    { reason: 'replay_below_floor', ...details }
  )
}

export function createEventLedger(options: EventLedgerOptions = {}): EventLedger {
  const path = options.path
  const now = options.now ?? (() => new Date())
  const eventsByInvocation = new Map<string, Map<number, StoredEvent>>()
  const consumerState = new Map<string, ConsumerState>()

  let index: ConsumerStateIndex | undefined
  let repair: LedgerTailRepair | undefined

  if (path !== undefined) {
    mkdirSync(dirname(path), { recursive: true })
    // The durable index opens FIRST: HRC's acknowledged-through seq and the
    // retention floor are independently durable state (§8.1), so they must be
    // in hand before the NDJSON scan decides what `currentSeq` is.
    index = openConsumerStateIndex(options.indexPath ?? join(dirname(path), 'ledger-index.db'))
    for (const [invocationId, state] of index.readAll()) {
      consumerState.set(invocationId, state)
    }
    repair = loadExisting(path, eventsByInvocation)
  }

  function stateFor(invocationId: string): ConsumerState {
    return (
      consumerState.get(invocationId) ?? {
        ackedThroughSeq: DEFAULT_RETENTION_FLOOR,
        retentionFloorSeq: DEFAULT_RETENTION_FLOOR,
      }
    )
  }

  function writeState(invocationId: string, next: ConsumerState): void {
    consumerState.set(invocationId, next)
    index?.write(invocationId, next, now().toISOString())
  }

  function highestSeq(invocationId: string): number {
    const bySeq = eventsByInvocation.get(invocationId)
    const inFile = bySeq === undefined || bySeq.size === 0 ? 0 : Math.max(...bySeq.keys())
    // Pruning DELETES records at or below the floor, so the file alone under-
    // reports the stream position. The persisted floor is the lower bound that
    // survives that deletion, which is what keeps seq monotonic across restart.
    return Math.max(inFile, stateFor(invocationId).retentionFloorSeq)
  }

  function appendSync(event: InvocationEventEnvelope): EventLedgerAppendResult {
    const invocationId = event.invocationId
    const seq = event.seq
    const bytes = stableJsonStringify(event)
    const bySeq = eventsByInvocation.get(invocationId) ?? new Map<number, StoredEvent>()
    const existing = bySeq.get(seq)
    if (existing !== undefined) {
      if (existing.bytes !== bytes) {
        throw new BrokerError(
          BrokerErrorCode.ResourceError,
          `Conflicting duplicate event for ${invocationId} seq ${seq}`,
          { invocationId, seq }
        )
      }
      return { appended: false, seq }
    }

    // Disk first, memory second. If the write or its fsync fails, the caller
    // sees the throw and NOTHING is published; an in-memory record here would
    // make the broker believe it committed an event no restart can replay.
    if (path !== undefined) {
      appendLine(path, `${bytes}\n`)
    }
    bySeq.set(seq, { event: structuredClone(event), bytes })
    eventsByInvocation.set(invocationId, bySeq)
    return { appended: true, seq }
  }

  const ledger: EventLedger = {
    appendSync,

    append(event: InvocationEventEnvelope): Promise<EventLedgerAppendResult> {
      try {
        return Promise.resolve(appendSync(event))
      } catch (error) {
        return Promise.reject(error)
      }
    },

    eventsSince(invocationId: InvocationId, afterSeq: number): Promise<InvocationEventEnvelope[]> {
      const floor = stateFor(invocationId).retentionFloorSeq
      if (afterSeq < floor) {
        return Promise.reject(
          replayBelowFloorError({
            invocationId,
            afterSeq,
            retentionFloorSeq: floor,
            currentSeq: highestSeq(invocationId),
          })
        )
      }
      const bySeq = eventsByInvocation.get(invocationId) ?? new Map<number, StoredEvent>()
      const events = [...bySeq.entries()]
        .filter(([seq]) => seq > afterSeq)
        .sort(([left], [right]) => left - right)
        .map(([, stored]) => structuredClone(stored.event))
      return Promise.resolve(events)
    },

    ackEvents(invocationId: InvocationId, throughSeq: number): Promise<EventLedgerAckResult> {
      const state = stateFor(invocationId)
      if (throughSeq < state.ackedThroughSeq) {
        return Promise.reject(
          new BrokerError(
            BrokerErrorCode.EventReplayUnavailable,
            `Event ack cannot move backwards from ${state.ackedThroughSeq} to ${throughSeq}`,
            {
              invocationId,
              previousAckedThroughSeq: state.ackedThroughSeq,
              throughSeq,
            }
          )
        )
      }
      try {
        writeState(invocationId, { ...state, ackedThroughSeq: throughSeq })
      } catch (error) {
        // The ack is HRC's durable retention promise. If it cannot be made
        // durable, refuse it rather than acknowledging in memory only.
        return Promise.reject(
          new BrokerError(
            BrokerErrorCode.ResourceError,
            `Event ack could not be persisted: ${describeError(error)}`,
            { invocationId, throughSeq }
          )
        )
      }
      return Promise.resolve({ ackedThroughSeq: throughSeq })
    },

    retentionFloorSeq(invocationId: InvocationId): Promise<number> {
      return Promise.resolve(stateFor(invocationId).retentionFloorSeq)
    },

    currentSeq(invocationId: InvocationId): number {
      return highestSeq(invocationId)
    },

    prune(options: EventLedgerPruneOptions): Promise<void> {
      const active = new Set(options.activeInvocationIds)
      for (const [invocationId, state] of [...consumerState.entries()]) {
        if (active.has(invocationId)) {
          continue
        }
        // Monotonic: the persisted floor is the promise a restart inherits, so
        // pruning may only ever advance it, never move it backwards.
        if (state.ackedThroughSeq <= state.retentionFloorSeq) {
          continue
        }
        writeState(invocationId, { ...state, retentionFloorSeq: state.ackedThroughSeq })
        const bySeq = eventsByInvocation.get(invocationId)
        if (bySeq !== undefined) {
          for (const seq of bySeq.keys()) {
            if (seq <= state.ackedThroughSeq) {
              bySeq.delete(seq)
            }
          }
        }
      }
      if (path !== undefined) {
        rewriteLedger(path, eventsByInvocation)
      }
      return Promise.resolve()
    },

    tailRepair(): LedgerTailRepair | undefined {
      return repair
    },

    close(): void {
      index?.close()
      index = undefined
    },
  }

  return ledger
}

// ---------------------------------------------------------------------------
// Durable consumer-state index (bun:sqlite, WAL)
// ---------------------------------------------------------------------------

interface ConsumerStateIndex {
  readAll(): Map<string, ConsumerState>
  write(invocationId: string, state: ConsumerState, updatedAt: string): void
  close(): void
}

function openConsumerStateIndex(indexPath: string): ConsumerStateIndex {
  mkdirSync(dirname(indexPath), { recursive: true })
  const db = new Database(indexPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  // FULL, not NORMAL: this index exists so a `kill -9` cannot forget HRC's
  // acknowledged-through seq or the retention floor. Writes are rare (one per
  // ack, one per prune), so the fsync cost is not on the event path.
  db.exec('PRAGMA synchronous = FULL')
  db.exec(
    `CREATE TABLE IF NOT EXISTS consumer_state (
       invocation_id       TEXT PRIMARY KEY,
       acked_through_seq   INTEGER NOT NULL,
       retention_floor_seq INTEGER NOT NULL,
       updated_at          TEXT NOT NULL
     ) STRICT`
  )
  const selectAll = db.query<
    { invocation_id: string; acked_through_seq: number; retention_floor_seq: number },
    []
  >('SELECT invocation_id, acked_through_seq, retention_floor_seq FROM consumer_state')
  const upsert = db.query(
    `INSERT INTO consumer_state (invocation_id, acked_through_seq, retention_floor_seq, updated_at)
     VALUES ($invocationId, $acked, $floor, $updatedAt)
     ON CONFLICT(invocation_id) DO UPDATE SET
       acked_through_seq   = excluded.acked_through_seq,
       retention_floor_seq = excluded.retention_floor_seq,
       updated_at          = excluded.updated_at`
  )

  return {
    readAll(): Map<string, ConsumerState> {
      const out = new Map<string, ConsumerState>()
      for (const row of selectAll.all()) {
        out.set(row.invocation_id, {
          ackedThroughSeq: row.acked_through_seq,
          retentionFloorSeq: row.retention_floor_seq,
        })
      }
      return out
    },
    write(invocationId: string, state: ConsumerState, updatedAt: string): void {
      upsert.run({
        $invocationId: invocationId,
        $acked: state.ackedThroughSeq,
        $floor: state.retentionFloorSeq,
        $updatedAt: updatedAt,
      })
    },
    close(): void {
      db.close()
    },
  }
}

// ---------------------------------------------------------------------------
// NDJSON load + trailing-segment validation
// ---------------------------------------------------------------------------

const NEWLINE = 0x0a

/**
 * Scan the ledger, indexing every intact record. A torn or partial FINAL record
 * (the signature of a crash mid-append) is truncated away and reported; an
 * unreadable INTERIOR record is corruption we must never silently skip, so it
 * raises a typed storage error instead.
 */
function loadExisting(
  path: string,
  eventsByInvocation: Map<string, Map<number, StoredEvent>>
): LedgerTailRepair | undefined {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return undefined
  }

  let offset = 0
  let lastIntactEnd = 0
  let lastIntact: { invocationId: InvocationId; seq: number } | undefined
  let torn = false

  while (offset < buf.length) {
    const newlineAt = buf.indexOf(NEWLINE, offset)
    const terminated = newlineAt !== -1
    const end = terminated ? newlineAt : buf.length
    const line = buf.toString('utf8', offset, end)
    const next = terminated ? end + 1 : buf.length

    if (line.trim() === '') {
      if (!terminated) {
        // Trailing whitespace with no record behind it: drop it as tail damage
        // only if it is not simply the empty remainder of a clean file.
        torn = line.length > 0
        break
      }
      offset = next
      lastIntactEnd = next
      continue
    }

    const record = parseRecord(line)
    if (record === undefined) {
      // Unterminated, or terminated but unreadable while sitting at the end of
      // the file: either way this is the crash-torn tail.
      if (!terminated || next >= buf.length) {
        torn = true
        break
      }
      throw new BrokerError(
        BrokerErrorCode.ResourceError,
        `Event ledger corrupt at byte offset ${offset}: unreadable interior record`,
        { path, offset }
      )
    }

    const bySeq = eventsByInvocation.get(record.invocationId) ?? new Map<number, StoredEvent>()
    bySeq.set(record.seq, { event: record.event, bytes: stableJsonStringify(record.event) })
    eventsByInvocation.set(record.invocationId, bySeq)
    lastIntact = { invocationId: record.event.invocationId, seq: record.seq }
    offset = next
    lastIntactEnd = next
  }

  if (!torn) {
    return undefined
  }

  const truncatedBytes = buf.length - lastIntactEnd
  truncateFile(path, lastIntactEnd)
  return {
    truncatedAtOffset: lastIntactEnd,
    truncatedBytes,
    ...(lastIntact !== undefined ? { lastIntact } : {}),
  }
}

function parseRecord(
  line: string
): { event: InvocationEventEnvelope; invocationId: string; seq: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const candidate = parsed as { invocationId?: unknown; seq?: unknown; type?: unknown }
  if (
    typeof candidate.invocationId !== 'string' ||
    candidate.invocationId === '' ||
    typeof candidate.type !== 'string' ||
    typeof candidate.seq !== 'number' ||
    !Number.isInteger(candidate.seq) ||
    candidate.seq < 1
  ) {
    return undefined
  }
  return {
    event: parsed as InvocationEventEnvelope,
    invocationId: candidate.invocationId,
    seq: candidate.seq,
  }
}

function truncateFile(path: string, length: number): void {
  const fd = openSync(path, 'r+')
  try {
    ftruncateSync(fd, length)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, 'a')
  try {
    writeFileSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function rewriteLedger(
  path: string,
  eventsByInvocation: Map<string, Map<number, StoredEvent>>
): void {
  const tmp = `${path}.tmp`
  const rows = [...eventsByInvocation.values()]
    .flatMap((bySeq) => [...bySeq.values()])
    .sort((left, right) => {
      const invocationOrder = left.event.invocationId.localeCompare(right.event.invocationId)
      return invocationOrder === 0 ? left.event.seq - right.event.seq : invocationOrder
    })
    .map((stored) => stored.bytes)
  writeFileSync(tmp, rows.length === 0 ? '' : `${rows.join('\n')}\n`)
  const fd = openSync(tmp, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item !== undefined) {
        sorted[key] = sortJson(item)
      }
    }
    return sorted
  }
  return value
}
