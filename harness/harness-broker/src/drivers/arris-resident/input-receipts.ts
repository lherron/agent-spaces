import type {
  ArrisControlReceipt,
  ArrisHostDescriptor,
  ArrisInputIdentity,
  InvocationInput,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { ApplyInputResult, DriverContext } from '../driver'
import { withDeliveryEvidence } from '../driver'
import type { ArrisControlClient } from './control-client'
import {
  ArrisIndeterminateDeliveryError,
  ArrisNotWrittenError,
  ArrisRetryableNotWrittenError,
} from './delivery-errors'
import { ARRIS_RESIDENT_DRIVER_KIND } from './driver-spec'
import type { ArrisResidentState } from './resident-state'

export interface InputReceiptDeps {
  ctx(): DriverContext
  descriptor(): ArrisHostDescriptor
  control(): ArrisControlClient
}

/**
 * The broker's side of the Arris control ledger: which durable identity and
 * attempt an input is written under, what the host's receipt for it says, and
 * how a receipt the broker already holds is reconciled before writing again.
 */
export interface InputReceiptLedger {
  identityFor(input: InvocationInput): ArrisInputIdentity
  /** Records a receipt and maps its outcome onto a queue write's result. */
  queueResult(receipt: ArrisControlReceipt): ApplyInputResult
  /** Records a receipt and maps its outcome onto a steer's success or failure. */
  settleSteer(receipt: ArrisControlReceipt): void
  /** A held receipt's settled result, or undefined when the input should be written. */
  reconcileBeforeWrite(identity: ArrisInputIdentity): Promise<ApplyInputResult | undefined>
  reconcileUnresolved(control: ArrisControlClient): Promise<void>
  reset(): void
}

export function createInputReceiptLedger(
  state: ArrisResidentState,
  deps: InputReceiptDeps
): InputReceiptLedger {
  const nextAttempts = new Map<string, number>()
  const receiptByInput = new Map<string, ArrisControlReceipt>()

  function identityFor(input: InvocationInput): ArrisInputIdentity {
    if (input.inputId === undefined) {
      throw withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.DispatchValidationFailed,
          'Arris input requires a broker input id'
        ),
        'not_written'
      )
    }
    const brokerInputId = input.inputId
    const inputId = input.metadata?.['envelopeId'] ?? brokerInputId
    state.brokerInputByHostInput.set(inputId, brokerInputId)
    return {
      platform: 'hrc',
      input_id: inputId,
      envelope_id: input.metadata?.['envelopeId'] ?? inputId,
      attempt: nextAttempts.get(inputId) ?? 1,
    }
  }

  function remember(receipt: ArrisControlReceipt): void {
    assertReceiptTarget(receipt)
    receiptByInput.set(receipt.identity.input_id, receipt)
    const maximumAttempt = receipt.attempts_seen.reduce(
      (maximum, value) => Math.max(maximum, value),
      0
    )
    nextAttempts.set(receipt.identity.input_id, maximumAttempt + 1)
    const brokerInputId = state.brokerInputByHostInput.get(receipt.identity.input_id)
    if (receipt.outcome.outcome === 'written') {
      state.currentNeutralTurnId = receipt.outcome.neutral_turn_id
      if (brokerInputId !== undefined) {
        state.inputByNeutralTurn.set(receipt.outcome.neutral_turn_id, brokerInputId)
      }
      if (receipt.outcome.codex_turn_id !== null) {
        state.neutralByCodexTurn.set(receipt.outcome.codex_turn_id, receipt.outcome.neutral_turn_id)
      }
    }
    deps.ctx().emit(
      'driver.notice',
      {
        code: 'ARRIS_CONTROL_RECEIPT',
        message: `Arris ${receipt.kind} receipt ${receipt.outcome.outcome}`,
        data: receipt,
      },
      {
        ...(brokerInputId !== undefined ? { inputId: brokerInputId } : {}),
        driver: { kind: ARRIS_RESIDENT_DRIVER_KIND, rawType: 'control.receipt' },
      }
    )
  }

  function assertReceiptTarget(receipt: ArrisControlReceipt): void {
    const expected = deps.descriptor().host_incarnation.host_incarnation_id
    if (receipt.host_incarnation_id !== expected) {
      throw new BrokerError(
        BrokerErrorCode.IdentityInstallConflict,
        `Arris receipt belongs to foreign host ${receipt.host_incarnation_id}`,
        { expectedHostIncarnationId: expected, receipt }
      )
    }
  }

  /** A retry-eligible refusal also holds admission until the journal says the host can take input. */
  function throwIfNotWritten(receipt: ArrisControlReceipt): void {
    if (receipt.outcome.outcome !== 'not_written') return
    if (receipt.outcome.eligible_for_retry) {
      state.retryHold = true
      throw new ArrisRetryableNotWrittenError(receipt)
    }
    throw new ArrisNotWrittenError(receipt)
  }

  function queueResult(receipt: ArrisControlReceipt): ApplyInputResult {
    remember(receipt)
    throwIfNotWritten(receipt)
    if (receipt.outcome.outcome === 'written' && receipt.presentation !== null) {
      return { turnId: receipt.outcome.neutral_turn_id as TurnId }
    }
    // in_flight, indeterminate and written-before-presentation all keep the
    // broker's pending-own-turn fence. Journal evidence settles the attempt.
    return {}
  }

  function settleSteer(receipt: ArrisControlReceipt): void {
    remember(receipt)
    throwIfNotWritten(receipt)
    if (receipt.outcome.outcome === 'indeterminate' || receipt.outcome.outcome === 'in_flight') {
      throw new ArrisIndeterminateDeliveryError(receipt)
    }
  }

  async function reconcileBeforeWrite(
    identity: ArrisInputIdentity
  ): Promise<ApplyInputResult | undefined> {
    const prior = receiptByInput.get(identity.input_id)
    if (
      prior === undefined ||
      (prior.outcome.outcome === 'not_written' && prior.outcome.eligible_for_retry)
    ) {
      return undefined
    }
    const reconciled = await deps.control().lookup(prior.identity)
    if (reconciled === null) {
      if (prior.outcome.outcome === 'indeterminate' || prior.outcome.outcome === 'in_flight') {
        remember(prior)
        return {}
      }
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        `Arris lost the durable receipt for ${identity.input_id}`,
        { receipt: prior }
      )
    }
    if (reconciled.outcome.outcome === 'not_written' && reconciled.outcome.eligible_for_retry) {
      remember(reconciled)
      return undefined
    }
    return queueResult(reconciled)
  }

  async function reconcileUnresolved(control: ArrisControlClient): Promise<void> {
    for (const receipt of await control.unresolved()) remember(receipt)
  }

  function reset(): void {
    receiptByInput.clear()
    nextAttempts.clear()
  }

  return { identityFor, queueResult, settleSteer, reconcileBeforeWrite, reconcileUnresolved, reset }
}
