import { createHash } from 'node:crypto'
import { canonicalizeJson } from './canonical-json.js'
import type { InvocationRuntimeContext, InvocationStartRequest } from './commands.js'
import type { InvocationId } from './ids.js'
import type { BrokerLifecyclePolicyOverlay } from './lifecycle.js'

/**
 * Participant bootstrap and resident-invocation establishment
 * (T-08344 DESIGN rev6 §C.5 / §C.5.1).
 *
 * Two operations, both served only by the durable unix broker:
 *
 * - `broker.installIdentity` is the ONLY method a participant-served broker
 *   answers before an identity exists. Without it `broker.attach` validates
 *   nothing (`harness-broker/src/broker.ts`, attach identity gate), so the
 *   bootstrap posture is what keeps an unvalidated attach off a broker whose
 *   identity has not yet been installed.
 * - `broker.ensureInvocation` wraps the ORDINARY invocation-manager start with
 *   a durable, retry-safe receipt. It does not add a second driver execution
 *   path and it does not weaken `manager.start`'s rejection of an unrelated
 *   active invocation; it gives the registration path an explicit at-most-once
 *   contract over the start it already performs.
 */

/**
 * The single identity a durable attempt installs on its broker. Extends the
 * launch-time attach identity (runtimeId/hostSessionId/generation/attachToken)
 * with the three facts a launch flag cannot carry: the attach epoch that fences
 * live control, and the invocation identity allocated ONCE per attempt together
 * with the per-invocation request/profile hashes `broker.attach` correlates on.
 */
export interface BrokerRuntimeIdentity {
  runtimeId: string
  hostSessionId: string
  generation: number
  attachEpoch: number
  invocationId: InvocationId
  startRequestHash: string
  selectedProfileHash: string
  attachToken: string
}

export type BrokerInstallIdentityRequest = BrokerRuntimeIdentity

/**
 * Acknowledgement of an installed identity. A repeat of the SAME identity for
 * the recorded epoch returns a byte-identical ack (§C.5 "a repeat for the
 * recorded epoch returns the same ack"), so `installedAt` is the time of the
 * FIRST install, never of the replay that observed it.
 */
export interface BrokerInstallIdentityResponse {
  installed: true
  brokerInstanceId: string
  runtimeId: string
  hostSessionId: string
  generation: number
  attachEpoch: number
  invocationId: InvocationId
  installedAt: string
}

/**
 * Durable receipt states (§C.5.1), in the order one attempt can traverse them.
 *
 * - `prepared`   — recorded; NO driver side effect has been initiated.
 * - `starting`   — persisted BEFORE `driver.start`, so a crash in the start
 *                  window is always visible as "a side effect may exist".
 * - `started`    — a resident manager invocation was established.
 * - `failed`     — definitive failure; the attempt did not establish.
 * - `indeterminate` — the outcome is genuinely unknown (a `starting` receipt
 *                  found after a restart, or a `started` receipt whose resident
 *                  invocation is gone). Absorbing for this operation: it never
 *                  authorizes a fresh `driver.start`, because doing so is how a
 *                  double-start happens (§C.4).
 */
export type BrokerEnsureInvocationState =
  | 'prepared'
  | 'starting'
  | 'started'
  | 'failed'
  | 'indeterminate'

export type BrokerEnsureInvocationIndeterminateReason =
  | 'restart_while_starting'
  | 'resident_invocation_absent'

export interface BrokerEnsureInvocationRequest {
  /** Idempotency key. One durable attempt, one receipt, one `driver.start`. */
  startAttemptId: string
  /** The attempt's single allocated invocation identity. */
  invocationId: InvocationId
  /** The epoch this attempt's live control is fenced to. */
  attachEpoch: number
  /** Immutable start request. Any change under the same attempt is a conflict. */
  startRequest: InvocationStartRequest
  /** Ordinary dispatch options, immutable under the same attempt. */
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export interface BrokerEnsureInvocationReceipt {
  startAttemptId: string
  invocationId: InvocationId
  attachEpoch: number
  state: BrokerEnsureInvocationState
  /** Digest of the complete immutable request + dispatch options. */
  requestDigest: string
  /** The broker incarnation that last wrote this receipt. */
  brokerInstanceId: string
  updatedAt: string
  /** Present only for `failed`; the definitive failure this attempt hit. */
  failure?: { message: string } | undefined
  /** Present only for `indeterminate`; why the outcome is unknown. */
  indeterminateReason?: BrokerEnsureInvocationIndeterminateReason | undefined
}

export interface BrokerEnsureInvocationResponse {
  receipt: BrokerEnsureInvocationReceipt
}

/**
 * Digest of the complete request/options tuple a `startAttemptId` is bound to.
 *
 * Deliberately covers the identity fields as well as the payload: an attempt
 * that presents the same start request under a different invocation id or epoch
 * is a DIFFERENT attempt, and must be refused rather than silently joined.
 */
export function ensureInvocationRequestDigest(request: BrokerEnsureInvocationRequest): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        startAttemptId: request.startAttemptId,
        invocationId: request.invocationId,
        attachEpoch: request.attachEpoch,
        startRequest: request.startRequest,
        dispatchEnv: request.dispatchEnv,
        runtime: request.runtime,
        lifecyclePolicy: request.lifecyclePolicy,
      }),
      'utf8'
    )
    .digest('hex')
}
