import type { InvocationDispatchRequest, InvocationId } from 'spaces-harness-broker-protocol'
import { createCanonicalHasher, neutralSpecHash, neutralStartRequestHash } from './hash'
import type { RuntimeIdentityAllocation } from './ids'
import {
  type ParticipantBrokerDescriptor,
  neutralParticipantBrokerDescriptorHash,
  validateParticipantBrokerDescriptor,
} from './participant-broker-descriptor'
import type { JsonValue } from './primitives'

/** The join direction controls broker-process ownership; it never grants lifecycle authority. */
export type ParticipantAdapterJoin = 'hrc-hosted' | 'participant-served'

export type ParticipantAdapterAdmissionRequest = {
  classId: string
  join: ParticipantAdapterJoin
  participantKey?: string | undefined
  evidence?: JsonValue | undefined
}

export type ParticipantAdapterAdmissionResult =
  | { status: 'pending' | 'rejected'; reason: string }
  | {
      status: 'admitted'
      participantKey: string
      workspaceCwd: string
      preparation: JsonValue
      continuityEvidence?: JsonValue | undefined
    }

export type ParticipantAdapterPreparationRequest = {
  classId: string
  join: ParticipantAdapterJoin
  participantKey: string
  workspaceCwd: string
  preparation: JsonValue
  identity: RuntimeIdentityAllocation & { invocationId: InvocationId }
  scopeRef: string
  laneRef: string
  attachEpoch: number
}

/**
 * The only dispatch material an adapter may return. HRC supplies its own
 * runtime leases and lifecycle policy after resource realization.
 */
export type ParticipantAdapterPreparationResult =
  | { status: 'pending' | 'rejected'; reason: string }
  | {
      status: 'prepared'
      descriptor: ParticipantBrokerDescriptor
      dispatchEnv?: InvocationDispatchRequest['dispatchEnv']
    }

/** The writer kind whose native write path is being inspected or retired. */
export type WriterSubject = 'host' | 'bridge'

/** Product-neutral identity of the exact writer an evidence receipt describes. */
export type WriterRef = {
  subject: WriterSubject
  classId: string
  participantKey: string
  attemptId: string
  invocationId: InvocationId
  attachEpoch: number
  brokerInstanceId?: string | undefined
  hostIncarnationId?: string | undefined
}

export type WriterPathState = 'retired' | 'writable' | 'unknown'
export type WriterLiveness = 'dead' | 'live' | 'unknown'
export type PriorRecovery = 'recovered' | 'outstanding' | 'unknown'

/** Independent point-in-time observations made by the writer's owner. */
export type WriterEvidence = {
  schemaVersion: 'writer-evidence/v1'
  writerRef: WriterRef
  observedAt: string
  writePath: {
    state: WriterPathState
    reason: string
    detail?: JsonValue | undefined
  }
  liveness: {
    state: WriterLiveness
    reason: string
    detail?: JsonValue | undefined
  }
  priorRecovery: {
    state: PriorRecovery
    reason: string
    detail?: JsonValue | undefined
  }
}

export type WriterRetirementRequest = { writerRef: WriterRef; reason: string }
export type WriterInspectionRequest = { writerRef: WriterRef }

/** A trusted, locally composed adapter; it has no dynamic loading contract. */
export interface ParticipantAdapter {
  readonly adapterId: string
  admit(
    request: ParticipantAdapterAdmissionRequest
  ): Promise<ParticipantAdapterAdmissionResult> | ParticipantAdapterAdmissionResult
  prepare(
    request: ParticipantAdapterPreparationRequest
  ): Promise<ParticipantAdapterPreparationResult> | ParticipantAdapterPreparationResult
  /** Idempotently close native write paths owned by this adapter, then report state. */
  retireWriter?(request: WriterRetirementRequest): Promise<WriterEvidence> | WriterEvidence
  /** Inspect the exact writer without changing it. */
  inspectWriter?(request: WriterInspectionRequest): Promise<WriterEvidence> | WriterEvidence
}

export type ParticipantAdapterValidationIssue = {
  path: string
  message: string
}

export type ParticipantAdapterValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ParticipantAdapterValidationIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(value).every(isJsonValue)
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function pushIssue(
  issues: ParticipantAdapterValidationIssue[],
  path: string,
  message: string
): void {
  issues.push({ path, message })
}

const writerRefKeys = [
  'subject',
  'classId',
  'participantKey',
  'attemptId',
  'invocationId',
  'attachEpoch',
  'brokerInstanceId',
  'hostIncarnationId',
] as const

function validateWriterRef(value: unknown, issues: ParticipantAdapterValidationIssue[]): void {
  if (!isRecord(value)) {
    pushIssue(issues, 'writerRef', 'Writer evidence requires a writerRef object.')
    return
  }
  if (!hasOnlyKeys(value, writerRefKeys)) {
    pushIssue(issues, 'writerRef', 'Writer reference has extra fields.')
  }
  if (value['subject'] !== 'host' && value['subject'] !== 'bridge') {
    pushIssue(issues, 'writerRef.subject', 'Writer subject must be host or bridge.')
  }
  for (const key of ['classId', 'participantKey', 'attemptId', 'invocationId'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      pushIssue(issues, `writerRef.${key}`, `Writer reference requires a non-empty ${key}.`)
    }
  }
  if (!Number.isInteger(value['attachEpoch']) || (value['attachEpoch'] as number) < 0) {
    pushIssue(issues, 'writerRef.attachEpoch', 'Writer reference attachEpoch must be non-negative.')
  }
  for (const key of ['brokerInstanceId', 'hostIncarnationId'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0)) {
      pushIssue(issues, `writerRef.${key}`, `${key} must be non-empty when present.`)
    }
  }
  if (value['subject'] === 'bridge' && typeof value['brokerInstanceId'] !== 'string') {
    pushIssue(issues, 'writerRef.brokerInstanceId', 'Bridge writers require brokerInstanceId.')
  }
}

function writerRefsMatch(expected: WriterRef, actual: Record<string, unknown>): boolean {
  return writerRefKeys.every((key) => expected[key] === actual[key])
}

function validateWriterAxis(
  value: unknown,
  path: 'writePath' | 'liveness' | 'priorRecovery',
  states: readonly string[],
  issues: ParticipantAdapterValidationIssue[]
): void {
  if (!isRecord(value)) {
    pushIssue(issues, path, `${path} must be an object.`)
    return
  }
  if (!hasOnlyKeys(value, ['state', 'reason', 'detail'])) {
    pushIssue(issues, path, `${path} has extra fields.`)
  }
  if (typeof value['state'] !== 'string' || !states.includes(value['state'])) {
    pushIssue(issues, `${path}.state`, `${path} has an invalid state.`)
  }
  if (typeof value['reason'] !== 'string' || value['reason'].length === 0) {
    pushIssue(issues, `${path}.reason`, `${path} requires a non-empty reason.`)
  }
  if (value['detail'] !== undefined && !isJsonValue(value['detail'])) {
    pushIssue(issues, `${path}.detail`, `${path} detail must be JSON-serializable.`)
  }
}

/** Validate a writer receipt and bind it to the exact requested writer identity. */
export function validateWriterEvidence(
  request: WriterRetirementRequest | WriterInspectionRequest,
  value: unknown
): ParticipantAdapterValidationResult<WriterEvidence> {
  const issues: ParticipantAdapterValidationIssue[] = []
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ path: '', message: 'Writer evidence must be an object.' }],
    }
  }
  if (
    !hasOnlyKeys(value, [
      'schemaVersion',
      'writerRef',
      'observedAt',
      'writePath',
      'liveness',
      'priorRecovery',
    ])
  ) {
    pushIssue(issues, '', 'Writer evidence has extra fields.')
  }
  if (value['schemaVersion'] !== 'writer-evidence/v1') {
    pushIssue(issues, 'schemaVersion', 'Writer evidence schemaVersion must be writer-evidence/v1.')
  }
  validateWriterRef(value['writerRef'], issues)
  if (isRecord(value['writerRef']) && !writerRefsMatch(request.writerRef, value['writerRef'])) {
    pushIssue(issues, 'writerRef', 'Writer evidence must match the requested writerRef exactly.')
  }
  if (
    typeof value['observedAt'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value['observedAt']
    ) ||
    Number.isNaN(Date.parse(value['observedAt']))
  ) {
    pushIssue(issues, 'observedAt', 'Writer evidence observedAt must be an ISO-8601 timestamp.')
  }
  validateWriterAxis(value['writePath'], 'writePath', ['retired', 'writable', 'unknown'], issues)
  validateWriterAxis(value['liveness'], 'liveness', ['dead', 'live', 'unknown'], issues)
  validateWriterAxis(
    value['priorRecovery'],
    'priorRecovery',
    ['recovered', 'outstanding', 'unknown'],
    issues
  )
  return issues.length === 0 ? { ok: true, value: value as WriterEvidence } : { ok: false, issues }
}

/**
 * Validates an adapter admission boundary without interpreting its opaque
 * preparation/evidence payloads. HRC can persist a successful value as JSON.
 */
export function validateParticipantAdapterAdmission(
  value: unknown
): ParticipantAdapterValidationResult<ParticipantAdapterAdmissionResult> {
  const issues: ParticipantAdapterValidationIssue[] = []
  if (!isRecord(value) || typeof value['status'] !== 'string') {
    return {
      ok: false,
      issues: [{ path: '', message: 'Admission result must be an object.' }],
    }
  }

  if (value['status'] === 'pending' || value['status'] === 'rejected') {
    if (!hasOnlyKeys(value, ['status', 'reason']))
      pushIssue(issues, '', 'Admission result has extra fields.')
    if (typeof value['reason'] !== 'string' || value['reason'].length === 0) {
      pushIssue(issues, 'reason', 'Pending/rejected admission requires a non-empty reason.')
    }
  } else if (value['status'] === 'admitted') {
    if (
      !hasOnlyKeys(value, [
        'status',
        'participantKey',
        'workspaceCwd',
        'preparation',
        'continuityEvidence',
      ])
    ) {
      pushIssue(issues, '', 'Admitted result has extra fields.')
    }
    for (const key of ['participantKey', 'workspaceCwd'] as const) {
      if (typeof value[key] !== 'string' || value[key].length === 0) {
        pushIssue(issues, key, `Admitted result requires a non-empty ${key}.`)
      }
    }
    if (!isJsonValue(value['preparation'])) {
      pushIssue(issues, 'preparation', 'Preparation must be JSON-serializable.')
    }
    if (value['continuityEvidence'] !== undefined && !isJsonValue(value['continuityEvidence'])) {
      pushIssue(issues, 'continuityEvidence', 'Continuity evidence must be JSON-serializable.')
    }
  } else {
    pushIssue(issues, 'status', 'Admission status must be pending, rejected, or admitted.')
  }

  return issues.length === 0
    ? { ok: true, value: value as ParticipantAdapterAdmissionResult }
    : { ok: false, issues }
}

/**
 * Driver-agnostic validation for a prepared adapter result. This deliberately
 * does not call the compiler's harness-name selector: it verifies only the
 * transportable descriptor structure, ownership, HRC identity binding, and the
 * established neutral hashes.
 */
export function validateParticipantAdapterPreparation(
  request: ParticipantAdapterPreparationRequest,
  value: unknown
): ParticipantAdapterValidationResult<ParticipantAdapterPreparationResult> {
  const issues: ParticipantAdapterValidationIssue[] = []
  if (!isRecord(value) || typeof value['status'] !== 'string') {
    return {
      ok: false,
      issues: [{ path: '', message: 'Preparation result must be an object.' }],
    }
  }

  if (value['status'] === 'pending' || value['status'] === 'rejected') {
    if (!hasOnlyKeys(value, ['status', 'reason'])) {
      pushIssue(issues, '', 'Pending/rejected preparation has extra fields.')
    }
    if (typeof value['reason'] !== 'string' || value['reason'].length === 0) {
      pushIssue(issues, 'reason', 'Pending/rejected preparation requires a non-empty reason.')
    }
    return issues.length === 0
      ? { ok: true, value: value as ParticipantAdapterPreparationResult }
      : { ok: false, issues }
  }

  if (value['status'] !== 'prepared') {
    return {
      ok: false,
      issues: [
        {
          path: 'status',
          message: 'Preparation status must be pending, rejected, or prepared.',
        },
      ],
    }
  }

  if (!hasOnlyKeys(value, ['status', 'descriptor', 'dispatchEnv'])) {
    pushIssue(
      issues,
      '',
      'Prepared result may contain only status, descriptor, and dispatchEnv; runtime and lifecyclePolicy are HRC-owned.'
    )
  }
  if (!isStringRecord(value['dispatchEnv']) && value['dispatchEnv'] !== undefined) {
    pushIssue(issues, 'dispatchEnv', 'dispatchEnv must be a record of strings.')
  }
  const descriptorValidation = validateParticipantBrokerDescriptor(value['descriptor'])
  if (!descriptorValidation.ok) {
    for (const issue of descriptorValidation.issues) {
      pushIssue(
        issues,
        issue.path === '' ? 'descriptor' : `descriptor.${issue.path}`,
        issue.message
      )
    }
    return { ok: false, issues }
  }

  const descriptor = descriptorValidation.value
  const requiredOwnership =
    request.join === 'hrc-hosted' ? 'hrc-owned-process' : 'participant-owned-process'
  if (descriptor.brokerOwnership !== requiredOwnership) {
    pushIssue(
      issues,
      'descriptor.brokerOwnership',
      `Prepared descriptor must use ${requiredOwnership} for ${request.join}.`
    )
  }

  const invocation = descriptor.harnessInvocation
  if (
    !isRecord(invocation) ||
    !isRecord(invocation.startRequest) ||
    !isRecord(invocation.startRequest.spec)
  ) {
    pushIssue(
      issues,
      'descriptor.harnessInvocation',
      'Prepared descriptor lacks a valid start request.'
    )
    return { ok: false, issues }
  }
  const startRequest = invocation.startRequest
  if (startRequest.spec.invocationId !== request.identity.invocationId) {
    pushIssue(
      issues,
      'descriptor.harnessInvocation.startRequest.spec.invocationId',
      'Start request invocationId must match the HRC allocation.'
    )
  }
  const correlation = startRequest.spec.correlation
  for (const [key, expected] of [
    ['runtimeId', request.identity.runtimeId],
    ['hostSessionId', request.identity.hostSessionId],
    ['generation', String(request.identity.generation)],
    ['invocationId', request.identity.invocationId],
  ] as const) {
    if (correlation?.[key] !== String(expected)) {
      pushIssue(
        issues,
        `descriptor.harnessInvocation.startRequest.spec.correlation.${key}`,
        `Start request correlation ${key} must match the HRC allocation.`
      )
    }
  }
  for (const [key, expected] of [
    ['startRequestHash', invocation.startRequestHash],
    ['selectedProfileHash', descriptor.descriptorHash],
  ] as const) {
    if (correlation?.[key] !== expected) {
      pushIssue(
        issues,
        `descriptor.harnessInvocation.startRequest.spec.correlation.${key}`,
        `Start request correlation ${key} must match the prepared descriptor.`
      )
    }
  }
  if (
    request.identity.initialInputId !== undefined &&
    startRequest.initialInput !== undefined &&
    startRequest.initialInput.inputId !== request.identity.initialInputId
  ) {
    pushIssue(
      issues,
      'descriptor.harnessInvocation.startRequest.initialInput.inputId',
      'Initial input id must match the HRC allocation.'
    )
  }
  if (descriptor.observability?.correlation?.invocationId !== request.identity.invocationId) {
    pushIssue(
      issues,
      'descriptor.observability.correlation.invocationId',
      'Observability invocationId must match the HRC allocation.'
    )
  }
  if (descriptor.observability?.correlation?.requestId !== request.identity.requestId) {
    pushIssue(
      issues,
      'descriptor.observability.correlation.requestId',
      'Observability requestId must match the HRC allocation.'
    )
  }
  if (descriptor.observability?.correlation?.operationId !== request.identity.operationId) {
    pushIssue(
      issues,
      'descriptor.observability.correlation.operationId',
      'Observability operationId must match the HRC allocation.'
    )
  }
  if (descriptor.observability?.correlation?.runtimeId !== request.identity.runtimeId) {
    pushIssue(
      issues,
      'descriptor.observability.correlation.runtimeId',
      'Observability runtimeId must match the HRC allocation.'
    )
  }
  if (descriptor.observability?.correlation?.hostSessionId !== request.identity.hostSessionId) {
    pushIssue(
      issues,
      'descriptor.observability.correlation.hostSessionId',
      'Observability hostSessionId must match the HRC allocation.'
    )
  }
  if (descriptor.observability?.correlation?.generation !== request.identity.generation) {
    pushIssue(
      issues,
      'descriptor.observability.correlation.generation',
      'Observability generation must match the HRC allocation.'
    )
  }

  if (invocation.specHash !== neutralSpecHash(startRequest.spec)) {
    pushIssue(
      issues,
      'descriptor.harnessInvocation.specHash',
      'Descriptor specHash does not match neutral spec hash.'
    )
  }
  if (invocation.startRequestHash !== neutralStartRequestHash(startRequest)) {
    pushIssue(
      issues,
      'descriptor.harnessInvocation.startRequestHash',
      'Descriptor startRequestHash does not match neutral start request hash.'
    )
  }
  const actualInitialInputHash =
    startRequest.initialInput === undefined
      ? undefined
      : createCanonicalHasher().hash(startRequest.initialInput, {
          timestampMode: 'omit-ephemeral',
        }).value
  if (invocation.initialInputHash !== actualInitialInputHash) {
    pushIssue(
      issues,
      'descriptor.harnessInvocation.initialInputHash',
      'Descriptor initialInputHash does not match the initial input payload.'
    )
  }
  if (descriptor.descriptorHash !== neutralParticipantBrokerDescriptorHash(descriptor)) {
    pushIssue(
      issues,
      'descriptor.descriptorHash',
      'Descriptor hash does not match neutral participant descriptor semantics.'
    )
  }

  return issues.length === 0
    ? { ok: true, value: value as ParticipantAdapterPreparationResult }
    : { ok: false, issues }
}
