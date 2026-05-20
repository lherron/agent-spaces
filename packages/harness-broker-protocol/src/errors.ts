import type { JsonRpcError, JsonRpcErrorResponse, JsonRpcId } from './jsonrpc'

export enum BrokerErrorCode {
  UnknownInvocation = -32001,
  InvalidInvocationState = -32002,
  UnsupportedCapability = -32003,
  InputRejected = -32004,
  HarnessError = -32005,
  Timeout = -32006,
  ResourceError = -32007,
  ShutdownInProgress = -32008,
  DriverUnavailable = -32009,
}

export function createJsonRpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return data === undefined ? { code, message } : { code, message, data }
}

export function createJsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: createJsonRpcError(code, message, data),
  }
}
