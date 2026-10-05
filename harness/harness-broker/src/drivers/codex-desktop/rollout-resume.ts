import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import type { RawProviderRecord } from 'spaces-harness-broker-protocol'
import type { CapturedRecord } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import {
  CODEX_DESKTOP_DRIVER_KIND,
  CODEX_DESKTOP_DRIVER_VERSION,
  type CodexDesktopDriverSpec,
} from './spec'

/** Rebuild a capture-gate record from a journaled raw record for state reconstruction. */
export function capturedRecord(record: RawProviderRecord): CapturedRecord {
  return {
    record,
    provenance: () => ({
      rawRecordId: record.rawRecordId,
      sourceKind: record.sourceKind,
      sourceEpoch: record.sourceEpoch,
      ...(Object.keys(record.sourceCursor).length > 0
        ? { sourceCursor: record.sourceCursor as Record<string, string | number> }
        : {}),
      nativeType: record.nativeType,
      ...(record.nativeId !== undefined ? { nativeId: record.nativeId } : {}),
      rawSha256: record.sha256,
      normalizer: { name: CODEX_DESKTOP_DRIVER_KIND, version: CODEX_DESKTOP_DRIVER_VERSION },
    }),
  }
}

/**
 * Byte offset to resume tailing the rollout from: just past the last journaled
 * record when this capture already has one, else zero after announcing a
 * fresh recovery replay.
 */
export function rolloutResumeOffset(
  ctx: DriverContext,
  spec: CodexDesktopDriverSpec,
  records: RawProviderRecord[]
): number {
  const journaled = records.filter(
    (record) =>
      record.driverKind === CODEX_DESKTOP_DRIVER_KIND &&
      typeof record.sourceCursor['byteOffset'] === 'number'
  )
  if (journaled.length > 0) return durableResumeOffset(spec.rolloutPath, journaled)
  announceFreshRecovery(ctx, spec)
  return 0
}

/** Resume after the last journaled record, only if the file still holds its exact bytes there. */
function durableResumeOffset(path: string, journaled: RawProviderRecord[]): number {
  const last = journaled
    .sort(
      (left, right) =>
        Number(left.sourceCursor['byteOffset']) - Number(right.sourceCursor['byteOffset'])
    )
    .at(-1)
  if (last === undefined) return 0
  const offset = Number(last.sourceCursor['byteOffset'])
  const fd = safeOpen(path)
  if (fd === undefined) return 0
  try {
    const probe = Buffer.alloc(last.rawBytes.length)
    const read = readSync(fd, probe, 0, probe.length, offset)
    if (read !== probe.length || !probe.equals(Buffer.from(last.rawBytes))) return 0
    return offset + last.rawBytes.length + 1
  } catch {
    return 0
  } finally {
    closeSync(fd)
  }
}

function safeOpen(path: string): number | undefined {
  try {
    return openSync(path, 'r')
  } catch {
    return undefined
  }
}

function announceFreshRecovery(ctx: DriverContext, spec: CodexDesktopDriverSpec): void {
  const boundary = spec.recoveryBoundary
  if (boundary === undefined) return
  // HRC can prove which projections it committed, but no nonzero cursor can
  // prove that every earlier projection reached it. The former broker may
  // have died with an immediate projection in flight or normalization still
  // buffered locally. Replay the complete source; HRC suppresses only the
  // projection identities it durably committed.
  let replaySnapshot: Record<string, number> = {}
  try {
    const bytes = readFileSync(spec.rolloutPath)
    let completeRecordCount = 0
    let lastCompleteByte = 0
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue
      completeRecordCount += 1
      lastCompleteByte = index + 1
    }
    replaySnapshot = {
      replaySnapshotBytes: bytes.length,
      replaySnapshotCompleteRecords: completeRecordCount,
      replaySnapshotTrailingPartialBytes: bytes.length - lastCompleteByte,
    }
  } catch {
    // readRows owns the visible observer-health error. Recovery still starts
    // losslessly at zero if the rollout materializes after this snapshot.
  }
  ctx.emit('driver.notice', {
    code: 'CODEX_DESKTOP_RECOVERY_BOUNDARY_APPLIED',
    message:
      'Codex desktop recovery is replaying from byte zero against durable committed projections',
    data: {
      replayByteOffset: 0,
      ...replaySnapshot,
      appliedThroughSeq: boundary.appliedThroughSeq,
      committedProjectionCount: boundary.committedProjections.length,
      empty: boundary.empty,
      ...(boundary.furthestCommittedRecord === undefined
        ? {}
        : { furthestCommittedByteOffset: boundary.furthestCommittedRecord.byteOffset }),
      ...(boundary.earliestPendingRecord === undefined
        ? {}
        : { earliestPendingByteOffset: boundary.earliestPendingRecord.byteOffset }),
    },
  })
}
