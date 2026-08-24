import type { JsonRpcError } from 'spaces-harness-broker-protocol'

export class BrokerRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(error: JsonRpcError) {
    super(error.message)
    this.name = 'BrokerRpcError'
    this.code = error.code
    if (error.data !== undefined) {
      this.data = error.data
    }
  }
}

export class BrokerTransportError extends Error {
  readonly causeError?: unknown

  constructor(message: string, causeError?: unknown) {
    super(message)
    this.name = 'BrokerTransportError'
    this.causeError = causeError
  }
}
