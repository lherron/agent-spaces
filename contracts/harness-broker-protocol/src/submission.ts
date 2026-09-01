import type { InvocationResponseFormat } from './commands'
import type { InvocationId, TurnId } from './ids'

/** The four admission classes. The public RPC method name selects the class. */
export type SubmissionClass = 'steer' | 'queue' | 'exclusive' | 'preempt'

export type TurnPolicy = 'open' | 'guarded'

export interface SubmissionOrigin {
  principalRef: string
  scopeRef?: string | undefined
  envelopeId?: string | undefined
}

interface SubmissionRequestBase {
  invocationId: InvocationId
  origin: SubmissionOrigin
  body: string
  responseFormat?: InvocationResponseFormat | undefined
  freshContext?: boolean | undefined
}

/**
 * A steer joins the active turn and therefore cannot declare the policy of a
 * turn it does not own. It intentionally has no wait/reply/obligation fields.
 */
export interface SubmissionSteerRequest extends SubmissionRequestBase {}

export interface SubmissionEnqueueRequest extends SubmissionRequestBase {
  ttlMs?: number | undefined
  turnPolicy?: TurnPolicy | undefined
}

export interface SubmissionInvokeRequest extends SubmissionRequestBase {
  turnPolicy?: TurnPolicy | undefined
}

export interface SubmissionPreemptRequest extends SubmissionRequestBase {
  ttlMs?: number | undefined
  turnPolicy?: TurnPolicy | undefined
}

export type SubmissionAdmission = 'admitted' | 'rejected'

/** Immediate admission result. Terminal disposition is delivered by events. */
export interface SubmissionResponse {
  submissionId: string
  admission: SubmissionAdmission
  reason?: string | undefined
}

export type AdmissionLayer = 'capability' | 'policy' | 'authority' | 'state'

export interface BrokerQueueEntry {
  submissionId: string
  origin: SubmissionOrigin
  class: 'queue' | 'preempt'
  ttlMs?: number | undefined
  position: number
}

export interface QueueListRequest {
  invocationId: InvocationId
}

export interface QueueListResponse {
  entries: BrokerQueueEntry[]
}

export interface QueueJumpRequest {
  invocationId: InvocationId
  submissionId: string
  position: number
  principalRef: string
}

export interface QueueJumpResponse {
  jumped: boolean
  reason?: string | undefined
}

export interface QueueCancelRequest {
  invocationId: InvocationId
  submissionId: string
  principalRef: string
}

export interface QueueCancelResponse {
  cancelled: boolean
  reason?: string | undefined
}

export interface TurnManifestRequest {
  invocationId: InvocationId
  turnId: TurnId
}

export interface TurnManifestResponse {
  invocationId: InvocationId
  turnId: TurnId
  policy: TurnPolicy
  submissionIds: string[]
}

export interface SeatProbeRequest {
  invocationId: InvocationId
}

export type SeatState =
  | { state: 'idle' }
  | { state: 'turn-active'; turnId: TurnId; policy: TurnPolicy }
  | { state: 'starting' | 'stopping' | 'terminal' }

export interface SeatProbeResponse {
  invocationId: InvocationId
  seat: SeatState
  brokerHeldDepth: number
}
