import type { JsonRpcError, JsonRpcErrorResponse, JsonRpcId } from './jsonrpc'

export interface ValidationIssue {
  path: string
  code: string
  message: string
}

/**
 * Shared base for every protocol error class in this package. Each subclass
 * declares its own stable `code` and passes its `name`; the base captures the
 * common `super(message)` + `this.name = name` boilerplate so the structural
 * validation errors, the JSON-RPC parse error, and the NDJSON frame error don't
 * each re-implement the same constructor shape.
 */
export abstract class ProtocolError extends Error {
  abstract readonly code: string

  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/**
 * Shared base for the protocol's structural-validation errors. Extends
 * {@link ProtocolError} with the accumulated `issues` list that every validator
 * error carries.
 */
export abstract class ProtocolValidationError extends ProtocolError {
  readonly issues: ValidationIssue[]

  constructor(name: string, message: string, issues: ValidationIssue[]) {
    super(name, message)
    this.issues = issues
  }
}

export class InvocationSpecValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_INVOCATION_SPEC'

  constructor(issues: ValidationIssue[]) {
    super('InvocationSpecValidationError', 'Invalid harness invocation spec', issues)
  }
}

export class InvocationInputValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_INVOCATION_INPUT'

  constructor(issues: ValidationIssue[]) {
    super('InvocationInputValidationError', 'Invalid invocation input', issues)
  }
}

export class InvocationStartRequestValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_INVOCATION_START_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super('InvocationStartRequestValidationError', 'Invalid invocation start request', issues)
  }
}

export class InvocationDispatchRequestValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_INVOCATION_DISPATCH_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super('InvocationDispatchRequestValidationError', 'Invalid invocation dispatch request', issues)
  }
}

export class PermissionRequestParamsValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_PERMISSION_REQUEST_PARAMS'

  constructor(issues: ValidationIssue[]) {
    super('PermissionRequestParamsValidationError', 'Invalid permission request params', issues)
  }
}

export class CommandValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_COMMAND'

  constructor(issues: ValidationIssue[]) {
    super('CommandValidationError', 'Invalid broker command', issues)
  }
}

export class EventEnvelopeValidationError extends ProtocolValidationError {
  readonly code = 'INVALID_EVENT_ENVELOPE'

  constructor(issues: ValidationIssue[]) {
    super('EventEnvelopeValidationError', 'Invalid invocation event envelope', issues)
  }
}

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
  DispatchValidationFailed = -32010,
  /**
   * Returned when an operation is rejected because the caller (driver, client,
   * or runtime) does not hold the capability needed to perform it. Phase B
   * uses this for terminal-surface lease enforcement: e.g. attempting to
   * resize a pane that did not grant `allowedOps.resize`.
   */
  CapabilityDenied = -32011,
  BrokerLifecyclePolicyUnsupported = -32012,
  EventReplayUnavailable = -32013,
  AttachRejected = -32014,
  ControllerFenced = -32015,
  DuplicateInputConflict = -32016,
  PermissionResponseConflict = -32017,
  PermissionResponseExpired = -32018,
  UnknownPermissionRequest = -32019,
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
