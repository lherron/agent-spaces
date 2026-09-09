import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
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
 * Append-only rather than rewrite-in-place for the same reason the event ledger
 * is: a torn rewrite could lose a receipt that a driver side effect already
 * corresponds to. A torn trailing record is dropped at open — the record it
 * replaces is still there, and a receipt that was never fully written is by
 * construction one whose `fsync` had not returned, so no caller had been told
 * it was durable.
 */
export interface EnsureReceiptStore {
  get(startAttemptId: string): BrokerEnsureInvocationReceipt | undefined
  /** Persist (write + fsync) and return the stored receipt. */
  put(receipt: BrokerEnsureInvocationReceipt): BrokerEnsureInvocationReceipt
  /** All receipts, in journal order. */
  list(): BrokerEnsureInvocationReceipt[]
}

export interface EnsureReceiptStoreOptions {
  /**
   * Directory the journal lives in — the durable broker's ledger directory.
   * ABSENT keeps receipts in memory, exactly as a pathless event ledger keeps
   * events in memory: an in-memory receipt has no restart contract, so a broker
   * without durable storage simply has no durable attempt to reconcile.
   */
  dir?: string | undefined
}

export const ENSURE_RECEIPT_JOURNAL_FILENAME = 'ensure-receipts.ndjson'

export function createEnsureReceiptStore(
  options: EnsureReceiptStoreOptions = {}
): EnsureReceiptStore {
  const path =
    options.dir === undefined ? undefined : join(options.dir, ENSURE_RECEIPT_JOURNAL_FILENAME)
  const receipts = new Map<string, BrokerEnsureInvocationReceipt>()

  if (path !== undefined) {
    for (const receipt of readJournal(path)) {
      receipts.set(receipt.startAttemptId, receipt)
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
  }
}

function readJournal(path: string): BrokerEnsureInvocationReceipt[] {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return []
    throw error
  }

  const records: BrokerEnsureInvocationReceipt[] = []
  const lines = contents.split('\n')
  // A trailing '' from the final newline, or a torn final record from a crash
  // mid-append. Both are dropped: only complete, newline-terminated records are
  // ones whose fsync returned.
  lines.pop()
  for (const line of lines) {
    if (line.length === 0) continue
    records.push(JSON.parse(line) as BrokerEnsureInvocationReceipt)
  }
  return records
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
