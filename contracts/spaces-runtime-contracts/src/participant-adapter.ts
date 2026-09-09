import type { InvocationDispatchRequest, InvocationId } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from './execution-profile'
import {
  createCanonicalHasher,
  hashNeutralStartRequest,
  neutralSpecHash,
  neutralStartRequestHash,
  project,
} from './hash'
import type { RuntimeIdentityAllocation } from './ids'
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
      profile: BrokerExecutionProfile
      dispatchEnv?: InvocationDispatchRequest['dispatchEnv']
    }

/** A trusted, locally composed adapter; it has no dynamic loading contract. */
export interface ParticipantAdapter {
  readonly adapterId: string
  admit(
    request: ParticipantAdapterAdmissionRequest
  ): Promise<ParticipantAdapterAdmissionResult> | ParticipantAdapterAdmissionResult
  prepare(
    request: ParticipantAdapterPreparationRequest
  ): Promise<ParticipantAdapterPreparationResult> | ParticipantAdapterPreparationResult
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

/**
 * Reproduces the existing compiler's profile projection material. It keeps the
 * neutral start request and generation-only observability correlation used by
 * compiler-produced broker profiles; no new hash semantics are introduced.
 */
export function neutralBrokerExecutionProfileHash(profile: BrokerExecutionProfile): string {
  const { profileHash: _profileHash, harnessInvocation, observability, ...material } = profile
  return (
    project(
      {
        ...material,
        harnessInvocation: {
          ...harnessInvocation,
          startRequest: hashNeutralStartRequest(harnessInvocation.startRequest),
        },
        observability: { correlation: { generation: observability.correlation.generation } },
      },
      'profile'
    ) as { profileHash: string }
  ).profileHash
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
    return { ok: false, issues: [{ path: '', message: 'Admission result must be an object.' }] }
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
 * transportable profile structure, ownership, HRC identity binding, and the
 * established neutral hashes.
 */
export function validateParticipantAdapterPreparation(
  request: ParticipantAdapterPreparationRequest,
  value: unknown
): ParticipantAdapterValidationResult<ParticipantAdapterPreparationResult> {
  const issues: ParticipantAdapterValidationIssue[] = []
  if (!isRecord(value) || typeof value['status'] !== 'string') {
    return { ok: false, issues: [{ path: '', message: 'Preparation result must be an object.' }] }
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
        { path: 'status', message: 'Preparation status must be pending, rejected, or prepared.' },
      ],
    }
  }

  if (!hasOnlyKeys(value, ['status', 'profile', 'dispatchEnv'])) {
    pushIssue(
      issues,
      '',
      'Prepared result may contain only status, profile, and dispatchEnv; runtime and lifecyclePolicy are HRC-owned.'
    )
  }
  if (!isStringRecord(value['dispatchEnv']) && value['dispatchEnv'] !== undefined) {
    pushIssue(issues, 'dispatchEnv', 'dispatchEnv must be a record of strings.')
  }
  if (!isRecord(value['profile'])) {
    pushIssue(issues, 'profile', 'Prepared result requires a broker execution profile.')
    return { ok: false, issues }
  }

  const profile = value['profile'] as BrokerExecutionProfile
  if (profile.kind !== 'harness-broker') {
    pushIssue(issues, 'profile.kind', 'Prepared profile must be a harness-broker profile.')
  }
  const requiredOwnership =
    request.join === 'hrc-hosted' ? 'hrc-owned-process' : 'participant-owned-process'
  if (profile.brokerOwnership !== requiredOwnership) {
    pushIssue(
      issues,
      'profile.brokerOwnership',
      `Prepared profile must use ${requiredOwnership} for ${request.join}.`
    )
  }

  const invocation = profile.harnessInvocation
  if (
    !isRecord(invocation) ||
    !isRecord(invocation.startRequest) ||
    !isRecord(invocation.startRequest.spec)
  ) {
    pushIssue(issues, 'profile.harnessInvocation', 'Prepared profile lacks a valid start request.')
    return { ok: false, issues }
  }
  const startRequest = invocation.startRequest
  if (startRequest.spec.invocationId !== request.identity.invocationId) {
    pushIssue(
      issues,
      'profile.harnessInvocation.startRequest.spec.invocationId',
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
        `profile.harnessInvocation.startRequest.spec.correlation.${key}`,
        `Start request correlation ${key} must match the HRC allocation.`
      )
    }
  }
  for (const [key, expected] of [
    ['startRequestHash', invocation.startRequestHash],
    ['selectedProfileHash', profile.profileHash],
  ] as const) {
    if (correlation?.[key] !== expected) {
      pushIssue(
        issues,
        `profile.harnessInvocation.startRequest.spec.correlation.${key}`,
        `Start request correlation ${key} must match the prepared profile.`
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
      'profile.harnessInvocation.startRequest.initialInput.inputId',
      'Initial input id must match the HRC allocation.'
    )
  }
  if (profile.observability?.correlation?.invocationId !== request.identity.invocationId) {
    pushIssue(
      issues,
      'profile.observability.correlation.invocationId',
      'Observability invocationId must match the HRC allocation.'
    )
  }
  if (profile.observability?.correlation?.requestId !== request.identity.requestId) {
    pushIssue(
      issues,
      'profile.observability.correlation.requestId',
      'Observability requestId must match the HRC allocation.'
    )
  }
  if (profile.observability?.correlation?.operationId !== request.identity.operationId) {
    pushIssue(
      issues,
      'profile.observability.correlation.operationId',
      'Observability operationId must match the HRC allocation.'
    )
  }
  if (profile.observability?.correlation?.runtimeId !== request.identity.runtimeId) {
    pushIssue(
      issues,
      'profile.observability.correlation.runtimeId',
      'Observability runtimeId must match the HRC allocation.'
    )
  }
  if (profile.observability?.correlation?.hostSessionId !== request.identity.hostSessionId) {
    pushIssue(
      issues,
      'profile.observability.correlation.hostSessionId',
      'Observability hostSessionId must match the HRC allocation.'
    )
  }
  if (profile.observability?.correlation?.generation !== request.identity.generation) {
    pushIssue(
      issues,
      'profile.observability.correlation.generation',
      'Observability generation must match the HRC allocation.'
    )
  }

  if (invocation.specHash !== neutralSpecHash(startRequest.spec)) {
    pushIssue(
      issues,
      'profile.harnessInvocation.specHash',
      'Profile specHash does not match neutral spec hash.'
    )
  }
  if (invocation.startRequestHash !== neutralStartRequestHash(startRequest)) {
    pushIssue(
      issues,
      'profile.harnessInvocation.startRequestHash',
      'Profile startRequestHash does not match neutral start request hash.'
    )
  }
  const actualInitialInputHash =
    startRequest.initialInput === undefined
      ? undefined
      : createCanonicalHasher().hash(startRequest.initialInput, { timestampMode: 'omit-ephemeral' })
          .value
  if (invocation.initialInputHash !== actualInitialInputHash) {
    pushIssue(
      issues,
      'profile.harnessInvocation.initialInputHash',
      'Profile initialInputHash does not match the initial input payload.'
    )
  }
  if (profile.profileHash !== neutralBrokerExecutionProfileHash(profile)) {
    pushIssue(
      issues,
      'profile.profileHash',
      'Profile hash does not match existing neutral profile hash semantics.'
    )
  }

  return issues.length === 0
    ? { ok: true, value: value as ParticipantAdapterPreparationResult }
    : { ok: false, issues }
}
