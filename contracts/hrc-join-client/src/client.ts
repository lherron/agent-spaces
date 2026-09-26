import type {
  HrcSocketPath,
  JoinArgs,
  JoinAttachRefused,
  JoinAttachRequest,
  JoinAttachResult,
  JoinRegisterRefused,
  JoinRegisterRequest,
  JoinRegisterResult,
  JoinResult,
} from './types'

async function postJoin(
  hrcSocketPath: HrcSocketPath,
  path: '/v1/participants/register' | '/v1/participants/attach',
  body: unknown
): Promise<{ httpStatus: number; body: unknown }> {
  const response = await fetch(`http://localhost${path}`, {
    method: 'POST',
    unix: hrcSocketPath,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } as never)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { httpStatus: response.status, body: parsed }
}

function toHrcError(
  body: unknown
): { reason: string; detail: string; refusalReason?: string } | undefined {
  if (!isRecord(body) || !isRecord(body['error'])) return undefined
  const code =
    typeof body['error']['code'] === 'string' ? (body['error']['code'] as string) : 'unknown'
  const message =
    typeof body['error']['message'] === 'string' ? (body['error']['message'] as string) : ''
  // The summon gate's refusal reason (`scope-retired`, `pin-mismatch`, ...)
  // rides in the error detail; `hrc_stale_context` alone cannot tell them apart.
  const refusalReason = isRecord(body['error']['detail'])
    ? body['error']['detail']['reason']
    : undefined
  return {
    reason: `hrc_${code}`,
    detail: message,
    ...(typeof refusalReason === 'string' ? { refusalReason } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function registerParticipant(
  hrcSocketPath: HrcSocketPath,
  request: JoinRegisterRequest
): Promise<JoinRegisterResult> {
  const { httpStatus, body } = await postJoin(hrcSocketPath, '/v1/participants/register', request)
  if (!isRecord(body) || typeof body['status'] !== 'string') {
    const envelope = toHrcError(body)
    if (envelope !== undefined) return { outcome: 'rejected', httpStatus, ...envelope }
    return {
      outcome: 'rejected',
      httpStatus,
      reason: 'hrc_join_malformed',
      detail: 'unparseable register response',
    }
  }
  if (body['status'] === 'registered') {
    const identity = body['identity']
    if (!isRecord(identity)) {
      return {
        outcome: 'rejected',
        httpStatus,
        reason: 'hrc_join_malformed',
        detail: 'registered response without identity',
      }
    }
    return {
      outcome: 'registered',
      httpStatus,
      scopeRef: String(body['scopeRef'] ?? request.requestedSessionRef),
      hostSessionId: String(body['hostSessionId'] ?? ''),
      generation: Number(body['generation'] ?? 1),
      created: body['created'] === true,
      resumed: body['resumed'] === true,
      observation: isRecord(body['observation'])
        ? {
            state:
              (body['observation']['state'] as 'prepared' | 'attachment_pending' | 'attached') ??
              'attachment_pending',
            detail: String(body['observation']['detail'] ?? ''),
          }
        : { state: 'attachment_pending', detail: '' },
      identity: {
        registrationId: String(identity['registrationId'] ?? ''),
        laneRef: String(identity['laneRef'] ?? 'main'),
        runtimeId: String(identity['runtimeId'] ?? ''),
        attemptId: String(identity['attemptId'] ?? ''),
        invocationId: String(identity['invocationId'] ?? ''),
        attachEpoch: Number(identity['attachEpoch'] ?? 1),
        requestId: String(identity['requestId'] ?? ''),
        operationId: String(identity['operationId'] ?? ''),
      },
      ...(isRecord(body['continuation'])
        ? {
            continuation: {
              carried: body['continuation']['carried'] === true,
              reason: String(body['continuation']['reason'] ?? ''),
              selected: body['continuation']['selected'],
              resumeState: String(body['continuation']['resumeState'] ?? ''),
            },
          }
        : {}),
    }
  }
  const refused: JoinRegisterRefused = {
    outcome: body['status'] === 'pending' ? 'pending' : 'rejected',
    httpStatus,
    reason: String(body['reason'] ?? 'hrc_join_unknown'),
    detail: String(body['detail'] ?? ''),
    ...(isRecord(body['observed'])
      ? {
          observed: {
            ...(typeof body['observed']['homeNodeId'] === 'string'
              ? { homeNodeId: body['observed']['homeNodeId'] as string }
              : {}),
          },
        }
      : {}),
  }
  return refused
}

export async function attachParticipant(
  hrcSocketPath: HrcSocketPath,
  request: JoinAttachRequest
): Promise<JoinAttachResult> {
  const { httpStatus, body } = await postJoin(hrcSocketPath, '/v1/participants/attach', request)
  if (!isRecord(body) || typeof body['status'] !== 'string') {
    const envelope = toHrcError(body)
    if (envelope !== undefined) return { outcome: 'rejected', httpStatus, ...envelope }
    return {
      outcome: 'rejected',
      httpStatus,
      reason: 'hrc_join_malformed',
      detail: 'unparseable attach response',
    }
  }
  if (body['status'] === 'attached') {
    return {
      outcome: 'attached',
      httpStatus,
      registrationId: String(body['registrationId'] ?? request.registrationId),
      attemptId: String(body['attemptId'] ?? request.attemptId),
      attachEpoch: Number(body['attachEpoch'] ?? request.attachEpoch),
      prepared: body['prepared'] === true,
      observation: isRecord(body['observation'])
        ? { state: 'attached', detail: String(body['observation']['detail'] ?? '') }
        : { state: 'attached', detail: '' },
    }
  }
  const refused: JoinAttachRefused = {
    outcome: body['status'] === 'pending' ? 'pending' : 'rejected',
    httpStatus,
    reason: String(body['reason'] ?? 'hrc_join_unknown'),
    detail: String(body['detail'] ?? ''),
  }
  return refused
}

const REDIRECT_REASONS = new Set([
  'participant_scope_bound_elsewhere',
  'participant_scope_birth_designated_elsewhere',
])

export function isRedirect(result: JoinRegisterResult): boolean {
  return result.outcome !== 'registered' && REDIRECT_REASONS.has(result.reason)
}

export function isScopeOccupied(result: JoinRegisterResult): boolean {
  return result.outcome !== 'registered' && result.reason === 'participant_scope_occupied'
}

export function isHostBindingConflict(result: JoinRegisterResult): boolean {
  return result.outcome !== 'registered' && result.reason === 'host_binding_conflict'
}

/** This node permanently retired the requested address; a fresh slot is needed. */
export function isScopeRetired(result: JoinRegisterResult): boolean {
  return (
    result.outcome !== 'registered' &&
    result.reason === 'hrc_stale_context' &&
    result.refusalReason === 'scope-retired'
  )
}

export function isIncarnationBoundElsewhere(result: JoinRegisterResult): boolean {
  return (
    result.outcome !== 'registered' &&
    result.reason === 'participant_host_incarnation_bound_elsewhere'
  )
}

export function isAttachEpochStale(result: JoinAttachResult): boolean {
  return result.outcome !== 'attached' && result.reason === 'participant_attach_epoch_stale'
}

export function isAttachConflict(result: JoinAttachResult): boolean {
  return result.outcome !== 'attached' && result.reason === 'participant_attach_conflict'
}

export async function joinAsParticipant(args: JoinArgs): Promise<JoinResult> {
  const register = await registerParticipant(args.hrcSocketPath, args.register)
  if (register.outcome !== 'registered') {
    return { outcome: 'register-refused', register }
  }
  const prepared = await args.adapter.prepare({
    classId: args.prepare.classId,
    join: 'participant-served',
    participantKey: args.prepare.participantKey,
    workspaceCwd: args.prepare.workspaceCwd,
    preparation: args.prepare.preparation as never,
    identity: {
      requestId: register.identity.requestId as never,
      operationId: register.identity.operationId as never,
      hostSessionId: register.hostSessionId as never,
      generation: register.generation,
      runtimeId: register.identity.runtimeId as never,
      invocationId: register.identity.invocationId as never,
    },
    scopeRef: register.scopeRef,
    laneRef: register.identity.laneRef,
    attachEpoch: register.identity.attachEpoch,
  })
  if (prepared.status !== 'prepared') {
    return { outcome: 'not-prepared', register, reason: prepared.reason }
  }
  const attach = await attachParticipant(args.hrcSocketPath, {
    registrationId: register.identity.registrationId,
    attemptId: register.identity.attemptId,
    attachEpoch: register.identity.attachEpoch,
    ...(args.register.socketPath === undefined ? {} : { socketPath: args.register.socketPath }),
    descriptor: prepared.descriptor,
  })
  if (attach.outcome !== 'attached') {
    return { outcome: 'attach-refused', register, attach }
  }
  return { outcome: 'attached', register, attach }
}
