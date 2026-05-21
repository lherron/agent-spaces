import { type BrokerErrorCode, createJsonRpcError } from 'spaces-harness-broker-protocol'
import type { JsonRpcError } from 'spaces-harness-broker-protocol'

export class BrokerError extends Error {
  readonly code: BrokerErrorCode
  readonly data?: unknown

  constructor(code: BrokerErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'BrokerError'
    this.code = code
    this.data = data
  }
}

export function toJsonRpcError(err: unknown): JsonRpcError {
  if (err instanceof BrokerError) {
    return createJsonRpcError(err.code, err.message, err.data)
  }
  if (err instanceof Error) {
    return createJsonRpcError(-32603, err.message)
  }
  return createJsonRpcError(-32603, 'Internal error')
}
