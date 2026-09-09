import type {
  BrokerEnsureInvocationReceipt,
  BrokerEnsureInvocationRequest,
  BrokerEnsureInvocationResponse,
  BrokerInstallIdentityRequest,
  BrokerInstallIdentityResponse,
  BrokerRuntimeIdentity,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode, ensureInvocationRequestDigest } from 'spaces-harness-broker-protocol'
import type { BrokerAttachIdentity } from './broker'
import type { EnsureReceiptStore } from './ensure-receipt-store'
import { BrokerError } from './errors'

/**
 * Participant bootstrap and resident-invocation establishment
 * (T-08344 DESIGN rev6 §C.5 / §C.5.1).
 *
 * Deliberately owns NO driver execution path. `ensureInvocation` calls the same
 * `broker.start` an ordinary `invocation.start` calls, through the same
 * invocation manager, and adds only two things around it: validation against
 * the installed identity, and a durable receipt that makes a retry safe.
 */

export const BOOTSTRAP_REFUSAL_MESSAGE =
  'Broker bootstrap: only broker.installIdentity is served until an identity is installed'

/** Narrow, test-only seams. NOT a product feature flag and not reachable from
 * any CLI flag or environment variable — the only way to supply one is to build
 * a broker in-process with {@link BrokerOptions.participantFaults}, which is
 * what the prepared-before-starting crash gate does. */
export interface ParticipantEstablishmentFaults {
  /**
   * Runs AFTER the `prepared` receipt is durable and BEFORE the `starting`
   * receipt is written. Throwing here reproduces a crash in the one window the
   * contract cannot observe from outside: the attempt is recorded, but no
   * driver side effect has been initiated.
   */
  beforeStartingPersist?: (() => void | Promise<void>) | undefined
}

export interface ParticipantEstablishmentOptions {
  brokerInstanceId: string
  receiptStore: EnsureReceiptStore
  /** Launch-time identity (`--runtime-id …`), present for HRC-hosted brokers. */
  launchIdentity?: BrokerAttachIdentity | undefined
  /** Publish the installed identity to the broker's `broker.attach` gate. */
  onIdentityInstalled: (identity: BrokerRuntimeIdentity) => void
  /** Whether a resident manager invocation currently exists. */
  hasResidentInvocation: (invocationId: InvocationId) => boolean
  /** The ORDINARY start path. Must be the same one `invocation.start` uses. */
  startInvocation: (request: BrokerEnsureInvocationRequest) => Promise<unknown>
  now: () => Date
  faults?: ParticipantEstablishmentFaults | undefined
}

export interface ParticipantEstablishment {
  installIdentity(req: BrokerInstallIdentityRequest): Promise<BrokerInstallIdentityResponse>
  ensureInvocation(req: BrokerEnsureInvocationRequest): Promise<BrokerEnsureInvocationResponse>
  /** The installed identity, or undefined while still in bootstrap posture. */
  installedIdentity(): BrokerRuntimeIdentity | undefined
}

interface InFlightEnsure {
  digest: string
  promise: Promise<BrokerEnsureInvocationReceipt>
}

export function createParticipantEstablishment(
  options: ParticipantEstablishmentOptions
): ParticipantEstablishment {
  const { brokerInstanceId, receiptStore, now } = options
  let installed: BrokerRuntimeIdentity | undefined
  let installedAck: BrokerInstallIdentityResponse | undefined
  const inFlight = new Map<string, InFlightEnsure>()

  function installIdentity(
    req: BrokerInstallIdentityRequest
  ): Promise<BrokerInstallIdentityResponse> {
    // Idempotent replay for the recorded epoch returns the SAME ack, bytes
    // included. Any other identity — a different epoch above all — is refused:
    // the epoch fences live control, so accepting a second one would hand
    // control to a caller the incumbent attempt never yielded it to (§C.4).
    if (installed !== undefined && installedAck !== undefined) {
      if (!identitiesEqual(installed, req)) {
        return Promise.reject(
          new BrokerError(
            BrokerErrorCode.IdentityInstallConflict,
            `Identity install conflict: this broker already installed epoch ${installed.attachEpoch} for invocation ${installed.invocationId}`,
            { installedEpoch: installed.attachEpoch, requestedEpoch: req.attachEpoch }
          )
        )
      }
      return Promise.resolve(installedAck)
    }

    // An HRC-hosted broker was launched WITH its runtime identity. Installing a
    // different one would let a caller that reached the socket redefine the
    // runtime this process was started for, so the launch identity is the
    // authority and the install may only confirm it (and add epoch/invocation).
    const launch = options.launchIdentity
    if (
      launch !== undefined &&
      (launch.runtimeId !== req.runtimeId ||
        launch.hostSessionId !== req.hostSessionId ||
        launch.generation !== req.generation ||
        launch.attachToken !== req.attachToken)
    ) {
      return Promise.reject(
        new BrokerError(
          BrokerErrorCode.IdentityInstallConflict,
          'Identity install conflict: does not match this broker launch identity',
          { runtimeId: req.runtimeId, generation: req.generation }
        )
      )
    }

    const identity: BrokerRuntimeIdentity = {
      runtimeId: req.runtimeId,
      hostSessionId: req.hostSessionId,
      generation: req.generation,
      attachEpoch: req.attachEpoch,
      invocationId: req.invocationId,
      startRequestHash: req.startRequestHash,
      selectedProfileHash: req.selectedProfileHash,
      attachToken: req.attachToken,
    }
    installed = identity
    installedAck = {
      installed: true,
      brokerInstanceId,
      runtimeId: identity.runtimeId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      attachEpoch: identity.attachEpoch,
      invocationId: identity.invocationId,
      installedAt: now().toISOString(),
    }
    options.onIdentityInstalled(identity)
    return Promise.resolve(installedAck)
  }

  /** Every ensure is validated against the INSTALLED identity, never against
   * the request's own claims. An unrelated attempt is legitimate only in its
   * own authorized identity context, on its own broker. */
  function assertInstalledIdentity(req: BrokerEnsureInvocationRequest): BrokerRuntimeIdentity {
    if (installed === undefined) {
      throw new BrokerError(
        BrokerErrorCode.BrokerBootstrapRequired,
        'broker.ensureInvocation requires an installed identity: call broker.installIdentity first',
        { invocationId: req.invocationId }
      )
    }
    const correlation = req.startRequest.spec.correlation
    const mismatch =
      req.invocationId !== installed.invocationId ||
      req.attachEpoch !== installed.attachEpoch ||
      req.startRequest.spec.invocationId !== installed.invocationId ||
      correlation?.['runtimeId'] !== installed.runtimeId ||
      correlation?.['hostSessionId'] !== installed.hostSessionId ||
      correlation?.['startRequestHash'] !== installed.startRequestHash ||
      correlation?.['selectedProfileHash'] !== installed.selectedProfileHash
    if (mismatch) {
      throw new BrokerError(
        BrokerErrorCode.IdentityInstallConflict,
        'Identity conflict: ensureInvocation does not match the installed identity/epoch',
        { invocationId: req.invocationId, attachEpoch: req.attachEpoch }
      )
    }
    return installed
  }

  function receipt(
    req: BrokerEnsureInvocationRequest,
    digest: string,
    state: BrokerEnsureInvocationReceipt['state'],
    extra: Partial<Pick<BrokerEnsureInvocationReceipt, 'failure' | 'indeterminateReason'>> = {}
  ): BrokerEnsureInvocationReceipt {
    return {
      startAttemptId: req.startAttemptId,
      invocationId: req.invocationId,
      attachEpoch: req.attachEpoch,
      state,
      requestDigest: digest,
      brokerInstanceId,
      updatedAt: now().toISOString(),
      ...(extra.failure !== undefined ? { failure: extra.failure } : {}),
      ...(extra.indeterminateReason !== undefined
        ? { indeterminateReason: extra.indeterminateReason }
        : {}),
    }
  }

  function conflict(startAttemptId: string): BrokerError {
    return new BrokerError(
      BrokerErrorCode.StartAttemptConflict,
      `Start attempt conflict: ${startAttemptId} is bound to a different immutable request/options digest`,
      { startAttemptId }
    )
  }

  /**
   * Reconcile a receipt this broker already holds. Returns the receipt to
   * answer with, or `undefined` when the attempt may proceed to a start.
   *
   * The one thing it never does is authorize a new `driver.start` for an
   * attempt whose side effect is unknown: `starting` after a restart and
   * `started` without its resident invocation both become `indeterminate`, and
   * recovery is the caller's job with broker/adapter evidence (§C.4/§C.5.1).
   */
  function reconcile(
    stored: BrokerEnsureInvocationReceipt,
    req: BrokerEnsureInvocationRequest,
    digest: string
  ): BrokerEnsureInvocationReceipt | undefined {
    switch (stored.state) {
      case 'prepared':
        // No driver side effect was initiated, so a retry is safe.
        return undefined
      case 'starting':
        // No live operation holds this attempt (checked before reconcile), so
        // the `starting` record outlived the process that wrote it.
        return receiptStore.put(
          receipt(req, digest, 'indeterminate', {
            indeterminateReason: 'restart_while_starting',
          })
        )
      case 'started':
        return options.hasResidentInvocation(req.invocationId)
          ? stored
          : receiptStore.put(
              receipt(req, digest, 'indeterminate', {
                indeterminateReason: 'resident_invocation_absent',
              })
            )
      case 'failed':
      case 'indeterminate':
        // Absorbing. A new attempt needs a new startAttemptId; retry exhaustion
        // here must never be read as authority to start again.
        return stored
    }
  }

  async function runStart(
    req: BrokerEnsureInvocationRequest,
    digest: string
  ): Promise<BrokerEnsureInvocationReceipt> {
    receiptStore.put(receipt(req, digest, 'prepared'))
    await options.faults?.beforeStartingPersist?.()
    // Durable BEFORE the driver effect: after this point a crash is always
    // readable as "a side effect may exist".
    receiptStore.put(receipt(req, digest, 'starting'))
    try {
      await options.startInvocation(req)
    } catch (error) {
      return receiptStore.put(
        receipt(req, digest, 'failed', {
          failure: { message: error instanceof Error ? error.message : String(error) },
        })
      )
    }
    return receiptStore.put(receipt(req, digest, 'started'))
  }

  function ensureInvocation(
    req: BrokerEnsureInvocationRequest
  ): Promise<BrokerEnsureInvocationResponse> {
    let digest: string
    try {
      assertInstalledIdentity(req)
      digest = ensureInvocationRequestDigest(req)
    } catch (error) {
      return Promise.reject(error)
    }

    // Everything from here to `inFlight.set` is synchronous on purpose: two
    // concurrent duplicates must not both decide that no operation is running.
    const running = inFlight.get(req.startAttemptId)
    if (running !== undefined) {
      if (running.digest !== digest) return Promise.reject(conflict(req.startAttemptId))
      return running.promise.then((value) => ({ receipt: value }))
    }

    const stored = receiptStore.get(req.startAttemptId)
    if (stored !== undefined) {
      if (stored.requestDigest !== digest) return Promise.reject(conflict(req.startAttemptId))
      const reconciled = reconcile(stored, req, digest)
      if (reconciled !== undefined) return Promise.resolve({ receipt: reconciled })
    }

    const promise = runStart(req, digest)
    inFlight.set(req.startAttemptId, { digest, promise })
    return promise
      .finally(() => {
        inFlight.delete(req.startAttemptId)
      })
      .then((value) => ({ receipt: value }))
  }

  return {
    installIdentity,
    ensureInvocation,
    installedIdentity: () => installed,
  }
}

function identitiesEqual(left: BrokerRuntimeIdentity, right: BrokerRuntimeIdentity): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.hostSessionId === right.hostSessionId &&
    left.generation === right.generation &&
    left.attachEpoch === right.attachEpoch &&
    left.invocationId === right.invocationId &&
    left.startRequestHash === right.startRequestHash &&
    left.selectedProfileHash === right.selectedProfileHash &&
    left.attachToken === right.attachToken
  )
}
