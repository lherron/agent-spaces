import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EventFamily, RawRecordDisposition } from 'spaces-harness-broker-protocol'

/**
 * Durable raw-record disposition (and the legacy capture-halt row), held in the
 * SAME
 * broker-local SQLite index Phase 1a introduced for HRC's acknowledgement and
 * the retention floor (§8.1: "a compact broker-local SQLite WAL index persists
 * source cursors, dispositions, HRC's scalar acknowledgement and the retention
 * floor").
 *
 * It is a SECOND connection to that one file rather than a restructuring of the
 * Phase 1a ledger seam: WAL plus a busy timeout makes concurrent same-process
 * writers safe, and the alternative — threading the ledger's handle through the
 * driver context — would couple capture to ledger construction order for no
 * durability gain.
 *
 * §6.1 requires EXACTLY ONE terminal disposition per committed raw record.
 * `pending` is the only non-terminal value; it means committed-but-not-yet-
 * normalized — the state a record is in between its commit and its normalizer,
 * and the state a pre-T-07883 broker's held records were left in.
 */
export interface RawDispositionRow {
  invocationId: string
  rawRecordId: string
  sourceKind: string
  sourceEpoch: string
  nativeType: string
  family?: EventFamily | undefined
  sha256: string
  disposition: RawRecordDisposition
  detail?: string | undefined
  decidedBy?: string | undefined
  decidedAt?: string | undefined
}

/**
 * The legacy halt row. Since T-07883 the broker never WRITES one: a gate that
 * finds a row a pre-ruling broker left behind clears it and logs at WARN. The
 * table, `block()` and `blockedOn()` stay so that clearing path has something
 * to read, and so a test can construct the pre-ruling state.
 */
export interface CaptureBlockRow {
  invocationId: string
  rawRecordId: string
  nativeType: string
  family: EventFamily
  message: string
  sinceIso: string
}

export interface CaptureIndex {
  record(row: RawDispositionRow): void
  dispose(
    invocationId: string,
    rawRecordId: string,
    disposition: RawRecordDisposition,
    detail?: string | undefined,
    decidedBy?: string | undefined
  ): void
  get(invocationId: string, rawRecordId: string): RawDispositionRow | undefined
  list(invocationId: string): RawDispositionRow[]
  block(row: CaptureBlockRow): void
  blockedOn(invocationId: string): CaptureBlockRow | undefined
  unblock(invocationId: string): void
  close(): void
}

/**
 * `indexPath` absent opens an in-memory index — the pathless mode the stdio /
 * in-process broker uses, mirroring `createEventLedger`'s pathless ledger.
 */
export function openCaptureIndex(
  indexPath?: string | undefined,
  now: () => Date = () => new Date()
): CaptureIndex {
  if (indexPath !== undefined) {
    mkdirSync(dirname(indexPath), { recursive: true, mode: 0o700 })
  }
  const db = new Database(indexPath ?? ':memory:', { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  // FULL for the same reason Phase 1a chose it: a `kill -9` must not forget
  // which raw records were already dispositioned.
  db.exec('PRAGMA synchronous = FULL')
  // Two same-process connections to one WAL file: give the writer room rather
  // than surfacing SQLITE_BUSY on a contended disposition write.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(
    `CREATE TABLE IF NOT EXISTS raw_record (
       invocation_id  TEXT NOT NULL,
       raw_record_id  TEXT NOT NULL,
       source_kind    TEXT NOT NULL,
       source_epoch   TEXT NOT NULL,
       native_type    TEXT NOT NULL,
       family         TEXT,
       sha256         TEXT NOT NULL,
       disposition    TEXT NOT NULL,
       detail         TEXT,
       decided_by     TEXT,
       decided_at     TEXT,
       PRIMARY KEY (invocation_id, raw_record_id)
     ) STRICT`
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS capture_block (
       invocation_id TEXT PRIMARY KEY,
       raw_record_id TEXT NOT NULL,
       native_type   TEXT NOT NULL,
       family        TEXT NOT NULL,
       message       TEXT NOT NULL,
       since_iso     TEXT NOT NULL
     ) STRICT`
  )

  const upsert = db.query(
    `INSERT INTO raw_record
       (invocation_id, raw_record_id, source_kind, source_epoch, native_type, family, sha256,
        disposition, detail, decided_by, decided_at)
     VALUES ($invocationId, $rawRecordId, $sourceKind, $sourceEpoch, $nativeType, $family, $sha256,
             $disposition, $detail, $decidedBy, $decidedAt)
     ON CONFLICT(invocation_id, raw_record_id) DO UPDATE SET
       disposition = excluded.disposition,
       detail      = excluded.detail,
       decided_by  = excluded.decided_by,
       decided_at  = excluded.decided_at`
  )
  const setDisposition = db.query(
    `UPDATE raw_record
        SET disposition = $disposition, detail = $detail, decided_by = $decidedBy, decided_at = $decidedAt
      WHERE invocation_id = $invocationId AND raw_record_id = $rawRecordId`
  )
  const selectOne = db.query<StoredRow, { $invocationId: string; $rawRecordId: string }>(
    'SELECT * FROM raw_record WHERE invocation_id = $invocationId AND raw_record_id = $rawRecordId'
  )
  const selectAll = db.query<StoredRow, { $invocationId: string }>(
    'SELECT * FROM raw_record WHERE invocation_id = $invocationId ORDER BY raw_record_id'
  )
  const upsertBlock = db.query(
    `INSERT INTO capture_block (invocation_id, raw_record_id, native_type, family, message, since_iso)
     VALUES ($invocationId, $rawRecordId, $nativeType, $family, $message, $sinceIso)
     ON CONFLICT(invocation_id) DO UPDATE SET
       raw_record_id = excluded.raw_record_id,
       native_type   = excluded.native_type,
       family        = excluded.family,
       message       = excluded.message,
       since_iso     = excluded.since_iso`
  )
  const selectBlock = db.query<StoredBlock, { $invocationId: string }>(
    'SELECT * FROM capture_block WHERE invocation_id = $invocationId'
  )
  const deleteBlock = db.query('DELETE FROM capture_block WHERE invocation_id = $invocationId')

  return {
    record(row: RawDispositionRow): void {
      upsert.run({
        $invocationId: row.invocationId,
        $rawRecordId: row.rawRecordId,
        $sourceKind: row.sourceKind,
        $sourceEpoch: row.sourceEpoch,
        $nativeType: row.nativeType,
        $family: row.family ?? null,
        $sha256: row.sha256,
        $disposition: row.disposition,
        $detail: row.detail ?? null,
        $decidedBy: row.decidedBy ?? null,
        $decidedAt: row.decidedAt ?? null,
      })
    },

    dispose(invocationId, rawRecordId, disposition, detail, decidedBy): void {
      setDisposition.run({
        $invocationId: invocationId,
        $rawRecordId: rawRecordId,
        $disposition: disposition,
        $detail: detail ?? null,
        $decidedBy: decidedBy ?? null,
        $decidedAt: now().toISOString(),
      })
    },

    get(invocationId, rawRecordId): RawDispositionRow | undefined {
      const row = selectOne.get({ $invocationId: invocationId, $rawRecordId: rawRecordId })
      return row === null || row === undefined ? undefined : toRow(row)
    },

    list(invocationId): RawDispositionRow[] {
      return selectAll.all({ $invocationId: invocationId }).map(toRow)
    },

    block(row: CaptureBlockRow): void {
      upsertBlock.run({
        $invocationId: row.invocationId,
        $rawRecordId: row.rawRecordId,
        $nativeType: row.nativeType,
        $family: row.family,
        $message: row.message,
        $sinceIso: row.sinceIso,
      })
    },

    blockedOn(invocationId): CaptureBlockRow | undefined {
      const row = selectBlock.get({ $invocationId: invocationId })
      if (row === null || row === undefined) return undefined
      return {
        invocationId: row.invocation_id,
        rawRecordId: row.raw_record_id,
        nativeType: row.native_type,
        family: row.family as EventFamily,
        message: row.message,
        sinceIso: row.since_iso,
      }
    },

    unblock(invocationId): void {
      deleteBlock.run({ $invocationId: invocationId })
    },

    close(): void {
      db.close()
    },
  }
}

interface StoredRow {
  invocation_id: string
  raw_record_id: string
  source_kind: string
  source_epoch: string
  native_type: string
  family: string | null
  sha256: string
  disposition: string
  detail: string | null
  decided_by: string | null
  decided_at: string | null
}

interface StoredBlock {
  invocation_id: string
  raw_record_id: string
  native_type: string
  family: string
  message: string
  since_iso: string
}

function toRow(row: StoredRow): RawDispositionRow {
  return {
    invocationId: row.invocation_id,
    rawRecordId: row.raw_record_id,
    sourceKind: row.source_kind,
    sourceEpoch: row.source_epoch,
    nativeType: row.native_type,
    ...(row.family !== null ? { family: row.family as EventFamily } : {}),
    sha256: row.sha256,
    disposition: row.disposition as RawRecordDisposition,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.decided_by !== null ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
  }
}
