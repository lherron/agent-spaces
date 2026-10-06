import type { ArrisControlReceipt } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { withDeliveryEvidence } from '../driver'

export class ArrisNotWrittenError extends BrokerError {
  readonly receipt: ArrisControlReceipt

  constructor(receipt: ArrisControlReceipt) {
    const outcome = receipt.outcome
    super(
      BrokerErrorCode.HarnessError,
      outcome.outcome === 'not_written' ? outcome.message : 'Arris input was not written',
      { receipt }
    )
    this.name = 'ArrisNotWrittenError'
    this.receipt = receipt
    withDeliveryEvidence(this, 'not_written')
  }
}

export class ArrisRetryableNotWrittenError extends ArrisNotWrittenError {
  readonly retryableNotWritten = true

  constructor(receipt: ArrisControlReceipt) {
    super(receipt)
    this.name = 'ArrisRetryableNotWrittenError'
  }
}

export class ArrisIndeterminateDeliveryError extends BrokerError {
  readonly receipt: ArrisControlReceipt

  constructor(receipt: ArrisControlReceipt) {
    const outcome = receipt.outcome
    super(
      BrokerErrorCode.HarnessError,
      outcome.outcome === 'indeterminate' ? outcome.message : 'Arris delivery is indeterminate',
      { receipt }
    )
    this.name = 'ArrisIndeterminateDeliveryError'
    this.receipt = receipt
    withDeliveryEvidence(this, 'possibly_written')
  }
}
