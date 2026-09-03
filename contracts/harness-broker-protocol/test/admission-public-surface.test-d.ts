import type {
  AdmissionAdmittedPayload,
  AdmissionLayer,
  AdmissionRejectedPayload,
  AdmissionRequestedPayload,
  BrokerMethodV3,
  BrokerQueueEntry,
  EventProvenance,
  InterruptDecisionPayload,
  InterruptFailedPayload,
  QueueCancelRequest,
  QueueCancelResponse,
  QueueCancelledPayload,
  QueueEnqueuedPayload,
  QueueExpiredPayload,
  QueueJumpRequest,
  QueueJumpResponse,
  QueueJumpedPayload,
  QueueListRequest,
  QueueListResponse,
  QueueWithdrawnPayload,
  SeatProbeRequest,
  SeatProbeResponse,
  SeatState,
  SubmissionAdmission,
  SubmissionClass,
  SubmissionEnqueueRequest,
  SubmissionExpiredPayload,
  SubmissionInvokeRequest,
  SubmissionLostPayload,
  SubmissionPreemptRequest,
  SubmissionRejectedPayload,
  SubmissionResponse,
  SubmissionSteerRequest,
  SubmissionWithdrawRequest,
  SubmissionWithdrawResponse,
  SubmissionWithdrawnPayload,
  TurnManifestRequest,
  TurnManifestResponse,
  TurnPolicy,
} from '../src/index.js'

// T-07859 frozen v0.3 admission ABI. Behavioral schema coverage lives in
// admission.test.ts; these projections keep every exported type in the public
// contract corpus so additions or removals remain review-visible.

declare const contract: {
  admissionAdmitted: AdmissionAdmittedPayload
  admissionLayer: AdmissionLayer
  admissionRejected: AdmissionRejectedPayload
  admissionRequested: AdmissionRequestedPayload
  brokerMethod: BrokerMethodV3
  brokerQueueEntry: BrokerQueueEntry
  eventProvenance: EventProvenance
  interruptDecision: InterruptDecisionPayload
  interruptFailed: InterruptFailedPayload
  queueCancelRequest: QueueCancelRequest
  queueCancelResponse: QueueCancelResponse
  queueCancelled: QueueCancelledPayload
  queueEnqueued: QueueEnqueuedPayload
  queueExpired: QueueExpiredPayload
  queueWithdrawn: QueueWithdrawnPayload
  queueJumpRequest: QueueJumpRequest
  queueJumpResponse: QueueJumpResponse
  queueJumped: QueueJumpedPayload
  queueListRequest: QueueListRequest
  queueListResponse: QueueListResponse
  seatProbeRequest: SeatProbeRequest
  seatProbeResponse: SeatProbeResponse
  seatState: SeatState
  submissionAdmission: SubmissionAdmission
  submissionClass: SubmissionClass
  submissionEnqueue: SubmissionEnqueueRequest
  submissionExpired: SubmissionExpiredPayload
  submissionInvoke: SubmissionInvokeRequest
  submissionLost: SubmissionLostPayload
  submissionPreempt: SubmissionPreemptRequest
  submissionRejected: SubmissionRejectedPayload
  submissionResponse: SubmissionResponse
  submissionSteer: SubmissionSteerRequest
  submissionWithdrawRequest: SubmissionWithdrawRequest
  submissionWithdrawResponse: SubmissionWithdrawResponse
  submissionWithdrawn: SubmissionWithdrawnPayload
  turnManifestRequest: TurnManifestRequest
  turnManifestResponse: TurnManifestResponse
  turnPolicy: TurnPolicy
}

void contract
