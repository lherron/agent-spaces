export type JsonRpcId = string | number | null

export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: TMethod
  params?: TParams | undefined
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown> {
  jsonrpc: '2.0'
  method: TMethod
  params?: TParams | undefined
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResultResponse<TResult = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: TResult
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: JsonRpcError
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcResultResponse<TResult>
  | JsonRpcErrorResponse

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

type JsonRpcRecord = Record<string, unknown> & {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
  code?: unknown
  message?: unknown
}

export class JsonRpcParseError extends Error {
  readonly code = 'INVALID_JSON_RPC'
  readonly issues: string[]

  constructor(message: string, issues: string[] = [message]) {
    super(message)
    this.name = 'JsonRpcParseError'
    this.issues = issues
  }
}

export function parseJsonRpcMessage(line: string): JsonRpcMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new JsonRpcParseError(error instanceof Error ? error.message : 'Invalid JSON')
  }

  if (!isRecord(parsed)) {
    throw new JsonRpcParseError('JSON-RPC message must be an object')
  }

  if (parsed.jsonrpc !== '2.0') {
    throw new JsonRpcParseError('JSON-RPC message must use version 2.0')
  }

  if (isJsonRpcRequest(parsed) || isJsonRpcNotification(parsed) || isJsonRpcResponse(parsed)) {
    return parsed
  }

  throw new JsonRpcParseError('Malformed JSON-RPC message')
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    return false
  }
  return (
    typeof value.method === 'string' &&
    Object.hasOwn(value, 'id') &&
    isJsonRpcId(value.id) &&
    !Object.hasOwn(value, 'result') &&
    !Object.hasOwn(value, 'error')
  )
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    return false
  }
  return (
    typeof value.method === 'string' &&
    !Object.hasOwn(value, 'id') &&
    !Object.hasOwn(value, 'result') &&
    !Object.hasOwn(value, 'error')
  )
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    return false
  }
  if (!Object.hasOwn(value, 'id') || !isJsonRpcId(value.id) || Object.hasOwn(value, 'method')) {
    return false
  }

  const hasResult = Object.hasOwn(value, 'result')
  const hasError = Object.hasOwn(value, 'error')
  if (hasResult === hasError) {
    return false
  }

  return hasResult || isJsonRpcError(value.error)
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return (
    isRecord(value) &&
    typeof value.code === 'number' &&
    Number.isInteger(value.code) &&
    typeof value.message === 'string'
  )
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function isRecord(value: unknown): value is JsonRpcRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
