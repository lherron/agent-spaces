import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrokerEnsureInvocationReceipt } from 'spaces-harness-broker-protocol'

/**
 * Durable start-attempt receipts (DESIGN rev6 §C.5.1).
 *
 * An append-only NDJSON journal, last-record-wins per `startAttemptId`. Every
 * write is `write + fsync` before the call returns, because the ONE ordering
 * this contract rests on is that `starting` is on disk BEFORE `driver.start`
 * runs: a crash in the start window must always be readable afterwards as "a
 * side effect may exist", never as "nothing happened".
 *
 * The journal's OWNER opens it, so opening REPAIRS a torn tail rather than
 * merely skipping it in memory. This is broker-owned maintenance, not the
 * read-only historical recovery the event ledger's `eventsSince` performs: a
 * skipped-but-retained fragment would have the next append concatenated onto
 * it, producing a complete-looking line that no later open can parse — which
 * bricks the very restart path the receipt exists to serve. Truncation is safe
 * precisely because an incomplete record is by construction one whose `fsync`
 * had not returned, so no caller was ever told it was durable.
 *
 * Interior corruption is a different fact and is NOT repaired: a complete,
 * newline-terminated record that will not parse means bytes were damaged
 * behind our back, and silently dropping it could resurrect a superseded state
 * for an attempt. That throws.
 */
export interface EnsureReceiptStore {
  get(startAttemptId: string): BrokerEnsureInvocationReceipt | undefined
  /** Persist (write + fsync) and return the stored receipt. */
  put(receipt: BrokerEnsureInvocationReceipt): BrokerEnsureInvocationReceipt
  /** All receipts, in journal order. */
  list(): BrokerEnsureInvocationReceipt[]
  /** What this open repaired, if anything. Absent when the tail was intact. */
  tailRepair(): EnsureReceiptTailRepair | undefined
}

/** Bytes discarded from an incomplete trailing record when the journal opened. */
export interface EnsureReceiptTailRepair {
  truncatedAtOffset: number
  truncatedBytes: number
}

export interface EnsureReceiptStoreOptions {
  /**
   * Directory the journal lives in — the durable broker's ledger directory.
   * ABSENT keeps receipts in memory, exactly as a pathless event ledger keeps
   * events in memory: an in-memory receipt has no restart contract, so a broker
   * without durable storage simply has no durable attempt to reconcile.
   */
  dir?: string | undefined
  /** One operator-facing line per tail repair. Defaults to this process's stderr. */
  logWarn?: ((line: string) => void) | undefined
}

export const ENSURE_RECEIPT_JOURNAL_FILENAME = 'ensure-receipts.ndjson'

const NEWLINE = 0x0a

export function createEnsureReceiptStore(
  options: EnsureReceiptStoreOptions = {}
): EnsureReceiptStore {
  const path =
    options.dir === undefined ? undefined : join(options.dir, ENSURE_RECEIPT_JOURNAL_FILENAME)
  const logWarn = options.logWarn ?? ((line: string) => process.stderr.write(`${line}\n`))
  const receipts = new Map<string, BrokerEnsureInvocationReceipt>()
  let repair: EnsureReceiptTailRepair | undefined

  if (path !== undefined) {
    const opened = openJournal(path)
    repair = opened.repair
    for (const receipt of opened.records) {
      receipts.set(receipt.startAttemptId, receipt)
    }
    if (repair !== undefined) {
      logWarn(
        `WARN harness-broker ensure-receipt journal tail repaired: discarded ${repair.truncatedBytes} torn trailing byte(s) at offset ${repair.truncatedAtOffset} in ${path}`
      )
    }
  }

  return {
    get(startAttemptId: string): BrokerEnsureInvocationReceipt | undefined {
      return receipts.get(startAttemptId)
    },

    put(receipt: BrokerEnsureInvocationReceipt): BrokerEnsureInvocationReceipt {
      if (path !== undefined) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        appendLineSync(path, `${JSON.stringify(receipt)}\n`)
      }
      receipts.set(receipt.startAttemptId, receipt)
      return receipt
    },

    list(): BrokerEnsureInvocationReceipt[] {
      return [...receipts.values()]
    },

    tailRepair(): EnsureReceiptTailRepair | undefined {
      return repair
    },
  }
}

function openJournal(path: string): {
  records: BrokerEnsureInvocationReceipt[]
  repair: EnsureReceiptTailRepair | undefined
} {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { records: [], repair: undefined }
    throw error
  }

  // Byte offsets, not string indices: a receipt's failure message can carry
  // multi-byte characters, and a truncation computed in UTF-16 units would cut
  // the file in the wrong place.
  const completeBytes = buffer.lastIndexOf(NEWLINE) + 1
  const truncatedBytes = buffer.length - completeBytes
  let repair: EnsureReceiptTailRepair | undefined
  if (truncatedBytes > 0) {
    truncateFile(path, completeBytes)
    repair = { truncatedAtOffset: completeBytes, truncatedBytes }
  }

  const records: BrokerEnsureInvocationReceipt[] = []
  const text = buffer.subarray(0, completeBytes).toString('utf8')
  const lines = text.split('\n')
  // The final element is the empty string after the last newline.
  lines.pop()
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line) as BrokerEnsureInvocationReceipt)
    } catch (error) {
      throw new Error(
        `Corrupt ensure-receipt journal ${path}: complete record ${index + 1} does not parse (${
          error instanceof Error ? error.message : String(error)
        })`
      )
    }
  }
  return { records, repair }
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

function appendLineSync(path: string, line: string): void {
  const fd = openSync(path, 'a')
  try {
    writeFileSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
