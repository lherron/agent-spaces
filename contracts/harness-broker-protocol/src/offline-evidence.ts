import type { AspReleaseIdentity } from './commands'
import type { InvocationEventEnvelope, InvocationEventType } from './events'
import type { InvocationId } from './ids'
import type { InvocationEventsSinceResponse } from './invocation'

export const OFFLINE_EVIDENCE_SCHEMA = 'harness-broker.offline-evidence/v1' as const
export const OFFLINE_EVIDENCE_CAPABILITY = OFFLINE_EVIDENCE_SCHEMA
export const PROVIDER_OBSERVATION_SCHEMA = 'harness-broker.provider-observation/v1' as const

export interface OfflineFileIdentity {
  ino: number
  size: number
  mtimeMs: number
}

export interface OfflineLedgerSnapshot {
  ledger: OfflineFileIdentity
  index: {
    db: OfflineFileIdentity
    wal?: OfflineFileIdentity | undefined
  }
}

export type OfflineArtifactSnapshot = OfflineFileIdentity

export type OfflineEvidenceRequest =
  | {
      schema: typeof OFFLINE_EVIDENCE_SCHEMA
      operation: 'eventsSince'
      invocationId: InvocationId
      afterSeq: number
      types?: InvocationEventType[] | undefined
      limit?: number | undefined
      maxBytes?: number | undefined
    }
  | {
      schema: typeof OFFLINE_EVIDENCE_SCHEMA
      operation: 'providerObservations'
      artifactPath: string
      providerHint?: 'codex' | 'claude-code' | undefined
      afterLine: number
      limit?: number | undefined
      maxBytes?: number | undefined
      brokerEvents: InvocationEventEnvelope[]
      snapshot?: OfflineArtifactSnapshot | undefined
    }

export type ProviderObservationType =
  | 'user.message'
  | 'assistant.message.completed'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'

export type Sha256Hex = string

interface ProviderObservationBase {
  schema: typeof PROVIDER_OBSERVATION_SCHEMA
  line: number
  provider: 'codex' | 'claude-code'
  correlationKey?: string | undefined
  payloadHash: Sha256Hex
}

export type ComparisonPayload =
  | { content: string }
  | { toolCallId?: string | undefined; name: string; input: unknown }
  | {
      toolCallId?: string | undefined
      result:
        | { output?: string | undefined; exitCode?: number | undefined }
        | { content: unknown[] }
      isError?: boolean | undefined
    }

export type ProviderObservation =
  | (ProviderObservationBase & {
      type: 'user.message' | 'assistant.message.completed'
      normalizedPayload: { content: string }
      text: string
    })
  | (ProviderObservationBase & {
      type: 'tool.call.started'
      normalizedPayload: { toolCallId?: string | undefined; name: string; input: unknown }
    })
  | (ProviderObservationBase & {
      type: 'tool.call.completed'
      normalizedPayload: {
        toolCallId?: string | undefined
        result:
          | { output?: string | undefined; exitCode?: number | undefined }
          | { content: unknown[] }
        isError?: boolean | undefined
      }
    })

export interface BrokerComparisonForm {
  seq: number
  type: ProviderObservationType
  correlationKey?: string | undefined
  normalizedPayload: ComparisonPayload
  payloadHash: Sha256Hex
}

export type OfflineEvidenceErrorCode =
  | 'invalid_request'
  | 'offline_schema_unsupported'
  | 'ledger_unavailable'
  | 'ledger_index_unavailable'
  | 'ledger_corrupt'
  | 'ledger_conflicting_duplicate'
  | 'ledger_snapshot_unstable'
  | 'offline_record_too_large'
  | 'replay_below_floor'
  | 'provider_artifact_not_found'
  | 'provider_artifact_unreadable'
  | 'provider_artifact_snapshot_unstable'
  | 'provider_artifact_format_unsupported'

export type OfflineEvidenceResponse =
  | {
      schema: typeof OFFLINE_EVIDENCE_SCHEMA
      ok: true
      operation: 'eventsSince'
      release: AspReleaseIdentity
      result: InvocationEventsSinceResponse
      hasMore: boolean
      nextAfterSeq: number
      snapshot: OfflineLedgerSnapshot
      integrity:
        | { status: 'intact'; byteLength: number }
        | {
            status: 'torn_tail'
            byteLength: number
            lastIntactByteOffset: number
            trailingBytes: number
            lastIntact?: { invocationId: InvocationId; seq: number } | undefined
          }
    }
  | {
      schema: typeof OFFLINE_EVIDENCE_SCHEMA
      ok: true
      operation: 'providerObservations'
      release: AspReleaseIdentity
      snapshot: OfflineArtifactSnapshot
      provider: 'codex' | 'claude-code' | 'unknown'
      observations: ProviderObservation[]
      brokerComparisons: BrokerComparisonForm[]
      warnings: string[]
      page: { scannedThroughLine: number; hasMore: boolean }
      counts: {
        lines: number
        parsedRecords: number
        invalidJsonRecords: number
        applicableObservations: number
        ignoredRecords: number
        unsupportedRecords: number
        unknownRecords: number
        observationsByType: Record<ProviderObservationType, number>
      }
    }
  | {
      schema: typeof OFFLINE_EVIDENCE_SCHEMA
      ok: false
      operation?: 'eventsSince' | 'providerObservations' | undefined
      release?: AspReleaseIdentity | undefined
      error: {
        code: OfflineEvidenceErrorCode
        message: string
        data?: Record<string, unknown> | undefined
      }
    }
