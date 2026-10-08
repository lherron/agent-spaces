import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  EventSourceKind,
  InvocationId,
  RawProviderRecord,
  RawSourceCursor,
} from 'spaces-harness-broker-protocol'

/**
 * Per-invocation verbatim raw ingress journal (T-07853 §7.1).
 *
 * A provider row becomes a broker fact only after its bytes are on disk. This
 * journal is therefore append-only and `fsync`s every record BEFORE the
 * normalizer is allowed to look at it: a crash between the two leaves a
 * committed raw row that restart re-normalizes to the same identity, whereas a
 * crash the other way round would lose evidence the broker had already acted on.
 *
 * Bytes are stored base64 so a row survives NDJSON framing without being
 * rewritten — §15 forbids mutating raw authority, including "helpful"
 * re-encoding. Directories are `0700` and files `0600` because raw provider
 * evidence carries prompts, tool arguments and potentially secrets.
 */
export interface RawJournalAppendInput {
  provider: string
  driverKind: string
  sourceKind: EventSourceKind
  /** Stable key for the physical source (a transcript path, a hook channel). */
  sourceKey: string
  sourceCursor?: RawSourceCursor | undefined
  nativeType: string
  nativeId?: string | undefined
  rawBytes: Uint8Array
  correlationHints?: Record<string, string> | undefined
}

export interface RawJournal {
  /** Commit one raw record durably and return it with its minted identity. */
  append(input: RawJournalAppendInput): RawProviderRecord
  /**
   * Mint a NEW source epoch for `sourceKey`. Called on file replacement,
   * truncation, provider-session replacement or reconnect (§7.1). Cursor
   * comparison is only valid within one epoch, so every cursor recorded after
   * this call belongs to a different comparison space than those before it.
   */
  rotateEpoch(sourceKey: string): string
  /** The current epoch for a source, minting one on first use. */
  epochFor(sourceKey: string): string
  /**
   * Visit every committed record after `fromCursor` (from the start when
   * absent), in commit order, and return the cursor just past the last one.
   * Streams from disk in bounded chunks: a journal can hold gigabytes of
   * evidence, and nothing may hold it all in memory at once (T-10581).
   */
  scan(visit: (record: RawProviderRecord) => void, fromCursor?: RawJournalCursor): RawJournalCursor
  /** Every committed record, in commit order. Materializes them all; prefer `scan`. */
  read(): RawProviderRecord[]
  /** Absolute path of this invocation's journal file; absent when in-memory. */
  readonly path: string | undefined
}

export interface RawJournalOptions {
  invocationId: InvocationId
  /**
   * Directory the normalized ledger lives in; the raw journal goes in `raw/`.
   * ABSENT means an in-memory journal with no durability contract — exactly the
   * pathless mode `createEventLedger` already has for the stdio/in-process
   * broker, so capture semantics stay uniform across transports while
   * durability differs exactly where the ledger's does.
   */
  dir?: string | undefined
  now?: (() => Date) | undefined
  /** Epoch id minting, injectable so tests get deterministic ids. */
  newEpochId?: (() => string) | undefined
  /** Bytes per disk read while scanning; injectable so tests cross chunk edges. */
  readChunkBytes?: number | undefined
}

/**
 * Opaque resume point for `scan`: a byte offset just past a newline-terminated
 * row for a file-backed journal, a row count for an in-memory one.
 */
export type RawJournalCursor = number

const DEFAULT_READ_CHUNK_BYTES = 1024 * 1024

interface StoredRow {
  rawRecordId: string
  invocationId: string
  provider: string
  driverKind: string
  sourceKind: EventSourceKind
  sourceEpoch: string
  sourceCursor: RawSourceCursor
  nativeType: string
  nativeId?: string
  observedAt: string
  sha256: string
  rawBase64: string
  correlationHints?: Record<string, string>
}

export function createRawJournal(options: RawJournalOptions): RawJournal {
  const now = options.now ?? (() => new Date())
  const newEpochId = options.newEpochId ?? (() => `ep_${randomUUID()}`)
  let path: string | undefined
  if (options.dir !== undefined) {
    const dir = join(options.dir, 'raw')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    path = join(dir, `${options.invocationId}.ndjson`)
  }

  const readChunkBytes = options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES
  // Only a pathless journal keeps rows in memory: it has nowhere else to keep
  // them. A file-backed journal is read back from disk on demand, so its
  // resident size does not grow with the evidence it holds (T-10581).
  const memory: StoredRow[] = []
  let ordinal = 0
  const epochs = new Map<string, string>()
  if (path !== undefined) {
    terminateTornTail(path)
    // A restart inherits the epoch of every source it had already seen, so a
    // resumed tail keeps comparing cursors inside the epoch it recorded them in.
    scanFile(path, 0, readChunkBytes, (row) => {
      ordinal += 1
      epochs.set(sourceKeyOf(row), row.sourceEpoch)
    })
  }

  function scan(
    visit: (record: RawProviderRecord) => void,
    fromCursor: RawJournalCursor = 0
  ): RawJournalCursor {
    if (path !== undefined) {
      return scanFile(path, fromCursor, readChunkBytes, (row) => visit(toRecord(row)))
    }
    for (const row of memory.slice(fromCursor)) visit(toRecord(row))
    return Math.max(fromCursor, memory.length)
  }

  function nextRawRecordId(): string {
    ordinal += 1
    return `raw_${String(ordinal).padStart(6, '0')}`
  }

  function epochFor(sourceKey: string): string {
    const known = epochs.get(sourceKey)
    if (known !== undefined) return known
    const minted = newEpochId()
    epochs.set(sourceKey, minted)
    return minted
  }

  return {
    path,

    append(input: RawJournalAppendInput): RawProviderRecord {
      const rawBytes = Uint8Array.from(input.rawBytes)
      const sha256 = createHash('sha256').update(rawBytes).digest('hex')
      const record: RawProviderRecord = {
        rawRecordId: nextRawRecordId(),
        invocationId: options.invocationId,
        provider: input.provider,
        driverKind: input.driverKind,
        sourceKind: input.sourceKind,
        sourceEpoch: epochFor(input.sourceKey),
        sourceCursor: input.sourceCursor ?? {},
        nativeType: input.nativeType,
        ...(input.nativeId !== undefined ? { nativeId: input.nativeId } : {}),
        observedAt: now().toISOString(),
        sha256,
        rawBytes,
        ...(input.correlationHints !== undefined
          ? { correlationHints: input.correlationHints }
          : {}),
      }
      const row: StoredRow = {
        rawRecordId: record.rawRecordId,
        invocationId: record.invocationId,
        provider: record.provider,
        driverKind: record.driverKind,
        sourceKind: record.sourceKind,
        sourceEpoch: record.sourceEpoch,
        sourceCursor: record.sourceCursor,
        nativeType: record.nativeType,
        ...(record.nativeId !== undefined ? { nativeId: record.nativeId } : {}),
        observedAt: record.observedAt,
        sha256: record.sha256,
        rawBase64: Buffer.from(rawBytes).toString('base64'),
        ...(record.correlationHints !== undefined
          ? { correlationHints: record.correlationHints }
          : {}),
        // `sourceKey` is journal bookkeeping, not part of the §7.1 envelope; it
        // is written so a restart can rebuild the epoch registry per source.
        ...({ sourceKey: input.sourceKey } as Record<string, string>),
      }
      // Throws on any storage failure. The caller MUST NOT normalize when this
      // throws — that is the whole point of committing first.
      if (path !== undefined) {
        appendLine(path, `${JSON.stringify(row)}\n`)
      } else {
        memory.push(row)
      }
      return record
    },

    rotateEpoch(sourceKey: string): string {
      const minted = newEpochId()
      epochs.set(sourceKey, minted)
      return minted
    },

    epochFor,

    scan,

    read(): RawProviderRecord[] {
      const records: RawProviderRecord[] = []
      scan((record) => void records.push(record))
      return records
    },
  }
}

function sourceKeyOf(row: StoredRow): string {
  const key = (row as unknown as Record<string, unknown>)['sourceKey']
  return typeof key === 'string' ? key : `${row.sourceKind}:${row.provider}`
}

function toRecord(row: StoredRow): RawProviderRecord {
  return {
    rawRecordId: row.rawRecordId,
    invocationId: row.invocationId as InvocationId,
    provider: row.provider,
    driverKind: row.driverKind,
    sourceKind: row.sourceKind,
    sourceEpoch: row.sourceEpoch,
    sourceCursor: row.sourceCursor,
    nativeType: row.nativeType,
    ...(row.nativeId !== undefined ? { nativeId: row.nativeId } : {}),
    observedAt: row.observedAt,
    sha256: row.sha256,
    rawBytes: new Uint8Array(Buffer.from(row.rawBase64, 'base64')),
    ...(row.correlationHints !== undefined ? { correlationHints: row.correlationHints } : {}),
  }
}

/**
 * Stream every intact row from `fromOffset`, returning the offset just past the
 * last newline-terminated line. Unreadable lines are skipped rather than
 * throwing: unlike the normalized ledger, the raw journal is evidence, and a
 * single damaged evidence row must not make the rest unreadable. An
 * unterminated final line is never visited and never consumed, so a resumed
 * scan re-reads it once it is complete.
 *
 * A missing file reads as empty. Any OTHER read failure throws: treating an
 * unreadable journal as empty would restart the ordinal at zero and mint
 * duplicate raw record ids over the evidence already on disk.
 */
function scanFile(
  path: string,
  fromOffset: number,
  chunkBytes: number,
  visit: (row: StoredRow) => void
): number {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fromOffset
    throw error
  }
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes)
    let position = fromOffset
    let consumed = fromOffset
    let pending: Buffer[] = []
    for (;;) {
      const read = readSync(fd, chunk, 0, chunkBytes, position)
      if (read === 0) break
      position += read
      const view = chunk.subarray(0, read)
      let start = 0
      for (;;) {
        const newline = view.indexOf(0x0a, start)
        if (newline === -1) break
        const piece = view.subarray(start, newline)
        const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece])
        pending = []
        consumed += line.length + 1
        start = newline + 1
        const row = parseRow(line)
        if (row !== undefined) visit(row)
      }
      if (start < read) pending.push(Buffer.from(view.subarray(start)))
    }
    return consumed
  } finally {
    closeSync(fd)
  }
}

function parseRow(line: Buffer): StoredRow | undefined {
  if (line.length === 0) return undefined
  try {
    const parsed = JSON.parse(line.toString('utf8')) as StoredRow
    if (typeof parsed?.rawRecordId === 'string' && typeof parsed?.rawBase64 === 'string') {
      return parsed
    }
  } catch {
    // Torn or damaged row: skip it, keep the rest.
  }
  return undefined
}

/**
 * A crash mid-append leaves a final line with no newline. Terminate it so the
 * next append starts a fresh line instead of fusing onto the torn one and
 * becoming unreadable with it; the torn bytes themselves stay as residue.
 */
function terminateTornTail(path: string): void {
  let fd: number
  try {
    fd = openSync(path, 'r+')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    if (last[0] === 0x0a) return
    writeSync(fd, '\n', size)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, 'a', 0o600)
  try {
    writeFileSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
