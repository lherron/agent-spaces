import type {
  EventProvenance,
  InvocationEventPayloadMap,
  InvocationEventType,
} from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import { CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS } from './native-types'

export interface ClaudeRecordProvenance {
  /**
   * Run `body` with `provenance` active on {@link ClaudeRecordProvenance.emit},
   * restoring the previous value afterwards. This is a STACK, not a slot:
   * transcript rows are normalized inside a hook record's normalization, and
   * the inner row's provenance must not leak out to what the outer hook mints
   * afterwards.
   */
  withProvenance<T>(provenance: EventProvenance, body: () => T): T
  /**
   * The driver's ONLY emit seam. Stamps the raw record's provenance and counts
   * the mint, so provenance and disposition cannot drift apart per call site.
   */
  emit<K extends InvocationEventType>(
    driverCtx: DriverContext,
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: Parameters<DriverContext['emit']>[2]
  ): ReturnType<DriverContext['emit']>
  /** Disposition for a record whose normalization minted (or did not mint). */
  mintOutcome(detail: string): NormalizeOutcome
}

export function createClaudeRecordProvenance(): ClaudeRecordProvenance {
  /**
   * Provenance of the raw record currently being normalized (§7.2). Set by the
   * capture gate's normalize callback and stamped onto every event minted while
   * it is set; broker-authored facts outside any record leave it undefined and
   * the invocation manager stamps broker provenance instead.
   */
  let activeProvenance: EventProvenance | undefined
  /**
   * Events minted while normalizing the current raw record. It is what decides
   * `normalized` vs `state-only` for that record, so it is counted at the single
   * emit seam rather than at each of the ~20 call sites.
   */
  let mintedForRecord = 0

  return {
    withProvenance(provenance, body) {
      const previousProvenance = activeProvenance
      const previousMinted = mintedForRecord
      activeProvenance = provenance
      mintedForRecord = 0
      try {
        return body()
      } finally {
        activeProvenance = previousProvenance
        mintedForRecord = previousMinted
      }
    },
    emit(driverCtx, type, payload, extra) {
      mintedForRecord += 1
      return driverCtx.emit(type, payload, {
        ...extra,
        ...(activeProvenance !== undefined ? { provenance: activeProvenance } : {}),
      })
    },
    mintOutcome(detail) {
      if (mintedForRecord > 0) return { disposition: 'normalized', detail }
      // A hook whose FACT the transcript now owns is not "state only" — it is
      // real evidence of a fact another record already carried (T-07873 scope A).
      const duplicated = CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS.get(detail)
      if (duplicated !== undefined) return { disposition: 'duplicate', detail: duplicated }
      return { disposition: 'state-only', detail }
    },
  }
}
