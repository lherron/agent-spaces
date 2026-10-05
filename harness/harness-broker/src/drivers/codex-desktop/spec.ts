import { isAbsolute } from 'node:path'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { asCodexRecord } from '../codex-rollout/native'

export const CODEX_DESKTOP_DRIVER_KIND = 'codex-desktop'
export const CODEX_DESKTOP_DRIVER_VERSION = '0.1.0'

export interface CodexDesktopDriverSpec {
  kind: typeof CODEX_DESKTOP_DRIVER_KIND
  bundleExecutable: string
  codexHome: string
  sqliteHome: string
  threadId: string
  rolloutPath: string
  recoveryBoundary?: CodexDesktopRecoveryBoundary | undefined
  nativeAttemptStorePath?: string | undefined
  /** Legacy producer-EOF hint. Unsafe for recovery and deliberately ignored. */
  adoptionWatermark?: { byteOffset: number } | undefined
}

export interface CodexDesktopRecoveryBoundary {
  sourceKind?: string | undefined
  sourceEpoch?: string | undefined
  furthestCommittedRecord?:
    | {
        rawRecordId: string
        byteOffset: number
        line?: number | undefined
        rawSha256?: string | undefined
        nativeType?: string | undefined
      }
    | undefined
  earliestPendingRecord?:
    | {
        rawRecordId: string
        byteOffset: number
      }
    | undefined
  committedProjections: readonly {
    seq: number
    type: string
    turnId?: string | undefined
    itemId?: string | undefined
    nativeId?: string | undefined
    rawRecordId?: string | undefined
  }[]
  appliedThroughSeq: number
  empty: boolean
}

export function parseDesktopSpec(spec: HarnessInvocationSpec): CodexDesktopDriverSpec {
  if (spec.driver.kind !== CODEX_DESKTOP_DRIVER_KIND) {
    throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid codex-desktop driver spec')
  }
  const value = spec.driver as Record<string, unknown>
  const required = [
    'bundleExecutable',
    'codexHome',
    'sqliteHome',
    'threadId',
    'rolloutPath',
  ] as const
  for (const field of required) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `codex-desktop driver.${field} must be a non-empty string`
      )
    }
  }
  const watermark = asCodexRecord(value['adoptionWatermark'])
  if (
    watermark !== undefined &&
    (typeof watermark['byteOffset'] !== 'number' || watermark['byteOffset'] < 0)
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'codex-desktop driver.adoptionWatermark.byteOffset must be a non-negative number'
    )
  }
  const attemptStorePath = value['nativeAttemptStorePath']
  if (
    attemptStorePath !== undefined &&
    (typeof attemptStorePath !== 'string' ||
      attemptStorePath.length === 0 ||
      !isAbsolute(attemptStorePath))
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'codex-desktop driver.nativeAttemptStorePath must be an absolute non-empty path'
    )
  }
  const boundary = asCodexRecord(value['recoveryBoundary'])
  if (value['recoveryBoundary'] !== undefined && boundary === undefined) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'codex-desktop driver.recoveryBoundary must be an object'
    )
  }
  if (boundary !== undefined) validateRecoveryBoundary(boundary)
  return value as unknown as CodexDesktopDriverSpec
}

function validateRecoveryBoundary(boundary: Record<string, unknown>): void {
  const projections = boundary['committedProjections']
  const appliedThroughSeq = boundary['appliedThroughSeq']
  if (
    typeof boundary['empty'] !== 'boolean' ||
    !Array.isArray(projections) ||
    typeof appliedThroughSeq !== 'number' ||
    !Number.isSafeInteger(appliedThroughSeq) ||
    appliedThroughSeq < 0
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'codex-desktop driver.recoveryBoundary has invalid summary fields'
    )
  }
  for (const projection of projections) {
    const value = asCodexRecord(projection)
    if (
      value === undefined ||
      typeof value['seq'] !== 'number' ||
      !Number.isSafeInteger(value['seq']) ||
      typeof value['type'] !== 'string'
    ) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        'codex-desktop driver.recoveryBoundary has an invalid committed projection'
      )
    }
  }
  for (const name of ['furthestCommittedRecord', 'earliestPendingRecord']) {
    const record = asCodexRecord(boundary[name])
    if (
      boundary[name] !== undefined &&
      (record === undefined ||
        typeof record['rawRecordId'] !== 'string' ||
        typeof record['byteOffset'] !== 'number' ||
        !Number.isSafeInteger(record['byteOffset']) ||
        record['byteOffset'] < 0)
    ) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `codex-desktop driver.recoveryBoundary has an invalid ${name}`
      )
    }
  }
}

/** Capture source identity of one desktop rollout. */
export function sourceKey(spec: CodexDesktopDriverSpec): string {
  return `provider-jsonl:${spec.threadId}:${spec.rolloutPath}`
}

/** Native-attempt store partition: one desktop installation's thread. */
export function desktopInstallationKey(spec: CodexDesktopDriverSpec): string {
  return `${spec.codexHome}\u0000${spec.sqliteHome}\u0000${spec.threadId}`
}
