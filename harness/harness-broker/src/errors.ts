import { BrokerErrorCode, createJsonRpcError } from 'spaces-harness-broker-protocol'
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
  if (isProtocolValidationError(err)) {
    return createJsonRpcError(-32602, 'Invalid params', { issues: err.issues })
  }
  if (err instanceof Error) {
    return createJsonRpcError(-32603, err.message)
  }
  return createJsonRpcError(-32603, 'Internal error')
}

export function fromJsonRpcError(error: JsonRpcError): BrokerError {
  return new BrokerError(error.code as BrokerErrorCode, error.message, error.data)
}

export function toInvalidParamsBrokerError(err: unknown): BrokerError | undefined {
  if (!isProtocolValidationError(err)) {
    return undefined
  }
  return new BrokerError(-32602 as BrokerErrorCode, 'Invalid params', { issues: err.issues })
}

export function timeoutError(message: string): BrokerError {
  return new BrokerError(BrokerErrorCode.Timeout, message)
}

export function shutdownError(message: string): BrokerError {
  return new BrokerError(BrokerErrorCode.ShutdownInProgress, message)
}

function isProtocolValidationError(err: unknown): err is { issues: unknown[] } {
  if (!(err instanceof Error) || typeof err !== 'object' || err === null) {
    return false
  }

  const maybeValidationError = err as { issues?: unknown; code?: unknown }
  return (
    typeof maybeValidationError.code === 'string' &&
    maybeValidationError.code.startsWith('INVALID_') &&
    Array.isArray(maybeValidationError.issues) &&
    maybeValidationError.issues.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as { path?: unknown }).path === 'string' &&
        typeof (issue as { code?: unknown }).code === 'string' &&
        typeof (issue as { message?: unknown }).message === 'string'
    )
  )
}
