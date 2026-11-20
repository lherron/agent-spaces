import type {
  InputId,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  SubmissionClass,
  SubmissionEnqueueRequest,
  SubmissionOrigin,
  SubmissionResponse,
} from 'spaces-harness-broker-protocol'
import type { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'
import { stableJsonStringify } from './event-ledger'
import { normalizeResponseFormat } from './invocation-constants'
import type {
  EmitFn,
  Invocation,
  InvocationInputWithId,
  InvocationManagerOptions,
  SubmissionRecord,
  SubmissionRequest,
} from './invocation-model'
import { steerRoutesThroughQueue } from './invocation-steer-delivery'
import type { SubmissionTerminals } from './invocation-submission-terminals'

export interface InvocationAdmissionDeps {
  emit: EmitFn
  authorizeSubmission: NonNullable<InvocationManagerOptions['authorizeSubmission']>
  terminals: Pick<SubmissionTerminals, 'rejectSubmission'>
}

export type InvocationAdmission = ReturnType<typeof createInvocationAdmission>

/**
 * Submission admission: each submission's identity, caller-id idempotency for
 * both submission doors, and the capability, state and authority decision
 * that produces the immediate admission reply.
 */
export function createInvocationAdmission(deps: InvocationAdmissionDeps) {
  const { emit, authorizeSubmission } = deps
  const { rejectSubmission } = deps.terminals

  function nextSubmissionId(inv: Invocation): string {
    inv.submissionCounter += 1
    return `submission_${inv.invocationId}_${inv.submissionCounter}`
  }

  function requestToInput(submissionId: string, req: SubmissionRequest): InvocationInputWithId {
    return {
      inputId: submissionId as InputId,
      kind: 'user',
      content: [{ type: 'text', text: req.body }],
      ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
      metadata: {
        submissionId,
        principalRef: req.origin.principalRef,
        ...(req.origin.scopeRef !== undefined ? { scopeRef: req.origin.scopeRef } : {}),
        ...(req.origin.envelopeId !== undefined ? { envelopeId: req.origin.envelopeId } : {}),
      },
    }
  }

  /** Canonical request identity for caller-minted submissionId replay (T-13689). */
  function submissionFingerprint(admissionClass: SubmissionClass, req: SubmissionRequest): string {
    const extended = req as SubmissionEnqueueRequest
    return stableJsonStringify({
      class: admissionClass,
      origin: req.origin,
      body: req.body,
      responseFormat: normalizeResponseFormat(req.responseFormat) ?? null,
      freshContext: req.freshContext ?? null,
      ttlMs: extended.ttlMs ?? null,
      turnPolicy: extended.turnPolicy ?? null,
    })
  }

  /**
   * Run one public submission's admission at most once per caller-minted id. A
   * repeat with the same id and request returns the first admission reply and
   * creates nothing; the same id with a different request is invalid params.
   */
  function admitOnce(
    inv: Invocation,
    admissionClass: SubmissionClass,
    req: SubmissionRequest,
    admit: (record: SubmissionRecord) => Promise<SubmissionResponse>
  ): Promise<SubmissionResponse> {
    const fingerprint = submissionFingerprint(admissionClass, req)
    if (req.submissionId !== undefined) {
      const existing = inv.submissions.get(req.submissionId)
      if (existing !== undefined) {
        if (existing.requestFingerprint === fingerprint && existing.admissionReply !== undefined) {
          return existing.admissionReply
        }
        return Promise.reject(
          new BrokerError(
            -32602 as BrokerErrorCode,
            `submissionId ${req.submissionId} was already used for a different request`,
            { invocationId: inv.invocationId, submissionId: req.submissionId }
          )
        )
      }
    }
    const record = registerSubmission(inv, admissionClass, req)
    record.requestFingerprint = fingerprint
    const reply = admit(record)
    record.admissionReply = reply
    return reply
  }

  function registerSubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    req: SubmissionRequest
  ): SubmissionRecord {
    const submissionId = req.submissionId ?? nextSubmissionId(inv)
    const record: SubmissionRecord = {
      submissionId,
      class: admissionClass,
      origin: req.origin,
      input: requestToInput(submissionId, req),
      turnPolicy:
        admissionClass === 'steer'
          ? 'open'
          : ((req as SubmissionEnqueueRequest).turnPolicy ?? 'open'),
      terminal: false,
    }
    inv.submissions.set(submissionId, record)
    emit(inv, 'admission.requested', {
      submissionId,
      class: admissionClass,
      origin: req.origin,
      ...(admissionClass !== 'steer' ? { turnPolicy: record.turnPolicy } : {}),
      ...(req.freshContext !== undefined ? { freshContext: req.freshContext } : {}),
    })
    return record
  }

  function registerLegacySubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    input: InvocationInputWithId
  ): SubmissionRecord {
    const origin: SubmissionOrigin = {
      principalRef: input.metadata?.['principalRef'] ?? 'legacy:invocation.input',
      ...(input.metadata?.['scopeRef'] !== undefined
        ? { scopeRef: input.metadata['scopeRef'] }
        : {}),
      ...(input.metadata?.['envelopeId'] !== undefined
        ? { envelopeId: input.metadata['envelopeId'] }
        : {}),
    }
    const record: SubmissionRecord = {
      submissionId: input.inputId,
      class: admissionClass,
      origin,
      input,
      turnPolicy: 'open',
      terminal: false,
    }
    inv.submissions.set(input.inputId, record)
    emit(inv, 'admission.requested', {
      submissionId: input.inputId,
      class: admissionClass,
      origin,
      ...(admissionClass !== 'steer' ? { turnPolicy: 'open' } : {}),
    })
    return record
  }

  async function checkAdmission(
    inv: Invocation,
    record: SubmissionRecord,
    req: SubmissionRequest
  ): Promise<SubmissionResponse | undefined> {
    // A steer to a driver without a steer door goes through its own queue
    // (T-13689), so the class that must be supported is the routed one.
    const routedClass =
      record.class === 'steer' && steerRoutesThroughQueue(inv) ? 'queue' : record.class
    if (!inv.capabilities.admission.classes.includes(routedClass)) {
      return rejectSubmission(inv, record, 'capability', `unsupported:${record.class}`)
    }
    const driverRejection = inv.driver.admissionRejectionReason?.(routedClass)
    if (driverRejection !== undefined) {
      return rejectSubmission(inv, record, 'capability', driverRejection)
    }
    if (req.freshContext === true) {
      return rejectSubmission(inv, record, 'capability', 'fresh-context-unsupported')
    }
    // A steer to a starting invocation is admitted and held until it is ready
    // (broker-steer-one-door); only a closing or closed one refuses it.
    const steerHoldable = record.class === 'steer' && inv.state === 'starting'
    if (inv.state !== 'ready' && inv.state !== 'turn_active' && !steerHoldable) {
      return rejectSubmission(inv, record, 'state', `invalid-state:${inv.state}`)
    }
    // A steer is never refused by a busy or guarded seat: the broker holds it
    // (T-08527, T-13687 C, T-13689). Exclusive is not best effort and stays busy.
    if (inv.pendingOwnTurnSubmissionId !== undefined && record.class === 'exclusive') {
      return rejectSubmission(inv, record, 'state', 'busy')
    }
    const authorized = await authorizeSubmission({
      invocationId: inv.invocationId,
      class: record.class,
      origin: record.origin,
      ...(inv.currentTurnId !== undefined ? { activeTurnId: inv.currentTurnId } : {}),
      ...(inv.state === 'turn_active' && inv.unattributedTurnId === undefined
        ? { activeTurnPolicy: inv.currentTurnPolicy }
        : {}),
    })
    if (!authorized) {
      return rejectSubmission(inv, record, 'authority', 'authority-denied')
    }
    return undefined
  }

  function admitSubmission(inv: Invocation, record: SubmissionRecord): SubmissionResponse {
    emit(inv, 'admission.admitted', {
      submissionId: record.submissionId,
      class: record.class,
    })
    return { submissionId: record.submissionId, admission: 'admitted' }
  }

  function resolveInputId(inv: Invocation, input: InvocationInput): InputId {
    if (input.inputId) return input.inputId
    inv.inputCounter += 1
    return `input_${inv.invocationId}_${inv.inputCounter}` as InputId
  }

  /**
   * Stable fingerprint of an input request's content + policy, used to detect
   * whether a duplicate inputId carries byte-identical payload (idempotent
   * replay) or differing payload (conflict). Keyed externally by inputId, so
   * the fingerprint deliberately ignores the inputId itself.
   */
  function fingerprintInput(req: InvocationInputRequest): string {
    return stableJsonStringify({
      kind: req.input.kind,
      content: req.input.content,
      policy: req.policy ?? null,
      responseFormat: normalizeResponseFormat(req.input.responseFormat),
    })
  }

  /** Persist a resolved disposition for a client-provided inputId (idempotency). */
  function recordDisposition(
    inv: Invocation,
    req: InvocationInputRequest,
    response: InvocationInputResponse
  ): void {
    if (req.input.inputId === undefined) return
    inv.inputDispositions.set(req.input.inputId, {
      fingerprint: fingerprintInput(req),
      response,
    })
  }

  return {
    admitOnce,
    registerLegacySubmission,
    checkAdmission,
    admitSubmission,
    resolveInputId,
    fingerprintInput,
    recordDisposition,
  }
}
