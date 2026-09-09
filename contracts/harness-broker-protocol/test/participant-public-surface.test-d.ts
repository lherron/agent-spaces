import type {
  BrokerEnsureInvocationIndeterminateReason,
  BrokerEnsureInvocationReceipt,
  BrokerEnsureInvocationRequest,
  BrokerEnsureInvocationResponse,
  BrokerEnsureInvocationState,
  BrokerInstallIdentityRequest,
  BrokerInstallIdentityResponse,
  BrokerMethodV4,
  BrokerRuntimeIdentity,
} from '../src/index.js'
import type { ensureInvocationRequestDigest } from '../src/index.js'

// T-08346 / DESIGN rev6 C.5–C.5.1 public contract. Behavioral coverage lives in
// `participant.test.ts`; these projections keep every exported participant
// symbol in the reviewed public corpus so an addition or a removal is visible.

declare const contract: {
  runtimeIdentity: BrokerRuntimeIdentity
  installRequest: BrokerInstallIdentityRequest
  installResponse: BrokerInstallIdentityResponse
  ensureRequest: BrokerEnsureInvocationRequest
  ensureResponse: BrokerEnsureInvocationResponse
  receipt: BrokerEnsureInvocationReceipt
  receiptState: BrokerEnsureInvocationState
  indeterminateReason: BrokerEnsureInvocationIndeterminateReason
  method: BrokerMethodV4
  digest: typeof ensureInvocationRequestDigest
}

// The receipt state machine is a CLOSED union: a new state must be declared
// here before anything can produce it.
const states: BrokerEnsureInvocationState[] = [
  'prepared',
  'starting',
  'started',
  'failed',
  'indeterminate',
]

const reasons: BrokerEnsureInvocationIndeterminateReason[] = [
  'restart_while_starting',
  'resident_invocation_absent',
]

// Both new methods are members of the negotiated broker method union.
const methods: BrokerMethodV4[] = ['broker.installIdentity', 'broker.ensureInvocation']

// An install request IS a runtime identity — the two must not drift apart, or a
// participant could install one shape and be validated against another.
const identityIsInstallRequest: BrokerInstallIdentityRequest = contract.runtimeIdentity
const installRequestIsIdentity: BrokerRuntimeIdentity = contract.installRequest

// The response carries the receipt under a named key; a bare receipt is NOT a
// response, so a consumer cannot read one as the other by accident.
const response: BrokerEnsureInvocationResponse = { receipt: contract.receipt }

// Negative assertions, expressed as types rather than as suppressions so they
// stay checkable rather than merely silenced.
type Assignable<A, B> = A extends B ? true : false
type Refused<T extends false> = T

// A state outside the closed union is refused.
const stateUnionIsClosed: Refused<Assignable<'cancelled', BrokerEnsureInvocationState>> = false

// The digest is computed from a full REQUEST. A receipt carries the digest; it
// is not material for one, so it must not be accepted where a request is asked
// for — otherwise a caller could re-digest a receipt and get a different value
// for the same attempt.
const receiptIsNotDigestMaterial: Refused<
  Assignable<BrokerEnsureInvocationReceipt, Parameters<typeof ensureInvocationRequestDigest>[0]>
> = false

export type ParticipantPublicSurface = typeof contract
export const participantPublicSurfaceProjection = {
  states,
  reasons,
  methods,
  identityIsInstallRequest,
  installRequestIsIdentity,
  response,
  stateUnionIsClosed,
  receiptIsNotDigestMaterial,
}
