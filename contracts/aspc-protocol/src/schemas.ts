import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import { isJsonRpcRequest } from 'spaces-harness-broker-protocol'
import { validateCompileHarnessInvocation } from './compile-params.js'
import {
  validateCatalogAgentInspection,
  validateCatalogAgents,
  validateInspectAgent,
  validateInspectAgentSelection,
} from './inspection-params.js'
import {
  validateInspectRuntimePlacementParams,
  validateObserveContinuationArtifactParams,
  validateObserveRuntimeCapabilityParams,
  validatePrepareProcessParams,
  validateResolveRuntimeDeclarationParams,
} from './runtime-observation-params.js'
import type {
  AspcCatalogAgentInspectionRequest,
  AspcCatalogAgentsRequest,
  AspcCommand,
  AspcCompileHarnessInvocationRequest,
  AspcHelloRequest,
  AspcInspectAgentRequest,
  AspcInspectAgentSelectionRequest,
  AspcInspectRuntimePlacementRequest,
  AspcMethod,
  AspcObserveContinuationArtifactRequest,
  AspcObserveRuntimeCapabilityRequest,
  AspcPrepareProcessInvocationRequest,
  AspcResolveRuntimeDeclarationRequest,
} from './types.js'
import { ASPC_METHODS, ASPC_PROTOCOL_VERSION } from './types.js'
import type { ParamsValidator } from './validation-primitives.js'
import {
  path,
  ISSUE_CODE,
  issue,
  optionalString,
  requireRecord,
  requireString,
  requireStringArray,
  validateOptionalBooleanRecord,
} from './validation-primitives.js'

/**
 * Base for the package's request/command validation errors. Subclasses supply
 * their own `code`/`name`/message via the constructor; the shared body carries
 * the `issues` payload. The exported subclasses below keep their concrete names
 * and `code` literals intact so consumers can still `instanceof`/branch on them.
 */
export abstract class AspcValidationError extends Error {
  abstract readonly code: string
  readonly issues: ValidationIssue[]

  constructor(name: string, message: string, issues: ValidationIssue[]) {
    super(message)
    this.name = name
    this.issues = issues
  }
}

export class AspcHelloRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_HELLO_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super('AspcHelloRequestValidationError', 'Invalid ASPC hello request', issues)
  }
}

export class AspcCatalogAgentsRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_CATALOG_AGENTS_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super('AspcCatalogAgentsRequestValidationError', 'Invalid ASPC catalogAgents request', issues)
  }
}

export class AspcInspectAgentRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_INSPECT_AGENT_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super('AspcInspectAgentRequestValidationError', 'Invalid ASPC inspectAgent request', issues)
  }
}

export class AspcCatalogAgentInspectionRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_CATALOG_AGENT_INSPECTION_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super(
      'AspcCatalogAgentInspectionRequestValidationError',
      'Invalid ASPC catalogAgentInspection request',
      issues
    )
  }
}

export class AspcInspectAgentSelectionRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_INSPECT_AGENT_SELECTION_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super(
      'AspcInspectAgentSelectionRequestValidationError',
      'Invalid ASPC inspectAgentSelection request',
      issues
    )
  }
}

export class AspcCompileHarnessInvocationRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_COMPILE_HARNESS_INVOCATION_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super(
      'AspcCompileHarnessInvocationRequestValidationError',
      'Invalid ASPC compileHarnessInvocation request',
      issues
    )
  }
}

export class AspcCommandValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_COMMAND'

  constructor(issues: ValidationIssue[]) {
    super('AspcCommandValidationError', 'Invalid ASPC command', issues)
  }
}

export class AspcRuntimeObservationRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_RUNTIME_OBSERVATION_REQUEST'

  constructor(method: string, issues: ValidationIssue[]) {
    super('AspcRuntimeObservationRequestValidationError', `Invalid ${method} request`, issues)
  }
}

export function validateAspcHelloRequest(value: unknown): AspcHelloRequest {
  const issues: ValidationIssue[] = []
  validateHello(value, 'params', issues)
  if (issues.length > 0) {
    throw new AspcHelloRequestValidationError(issues)
  }
  return value as AspcHelloRequest
}

export function validateAspcCompileHarnessInvocationRequest(
  value: unknown
): AspcCompileHarnessInvocationRequest {
  const issues: ValidationIssue[] = []
  validateCompileHarnessInvocation(value, 'params', issues)
  if (issues.length > 0) {
    throw new AspcCompileHarnessInvocationRequestValidationError(issues)
  }
  return value as AspcCompileHarnessInvocationRequest
}

export function validateAspcCatalogAgentsRequest(value: unknown): AspcCatalogAgentsRequest {
  const issues: ValidationIssue[] = []
  validateCatalogAgents(value, 'params', issues)
  if (issues.length > 0) throw new AspcCatalogAgentsRequestValidationError(issues)
  return value as AspcCatalogAgentsRequest
}

export function validateAspcInspectAgentRequest(value: unknown): AspcInspectAgentRequest {
  const issues: ValidationIssue[] = []
  validateInspectAgent(value, 'params', issues)
  if (issues.length > 0) throw new AspcInspectAgentRequestValidationError(issues)
  return value as AspcInspectAgentRequest
}

export function validateAspcCatalogAgentInspectionRequest(
  value: unknown
): AspcCatalogAgentInspectionRequest {
  const issues: ValidationIssue[] = []
  validateCatalogAgentInspection(value, 'params', issues)
  if (issues.length > 0) throw new AspcCatalogAgentInspectionRequestValidationError(issues)
  return value as AspcCatalogAgentInspectionRequest
}

export function validateAspcInspectAgentSelectionRequest(
  value: unknown
): AspcInspectAgentSelectionRequest {
  const issues: ValidationIssue[] = []
  validateInspectAgentSelection(value, 'params', issues)
  if (issues.length > 0) throw new AspcInspectAgentSelectionRequestValidationError(issues)
  return value as AspcInspectAgentSelectionRequest
}

function validateObservationRequest<T>(
  value: unknown,
  method: string,
  validate: ParamsValidator
): T {
  const issues: ValidationIssue[] = []
  validate(value, 'params', issues)
  if (issues.length > 0) throw new AspcRuntimeObservationRequestValidationError(method, issues)
  return value as T
}

export function validateAspcResolveRuntimeDeclarationRequest(
  value: unknown
): AspcResolveRuntimeDeclarationRequest {
  return validateObservationRequest(
    value,
    'aspc.resolveRuntimeDeclaration',
    validateResolveRuntimeDeclarationParams
  )
}

export function validateAspcInspectRuntimePlacementRequest(
  value: unknown
): AspcInspectRuntimePlacementRequest {
  return validateObservationRequest(
    value,
    'aspc.inspectRuntimePlacement',
    validateInspectRuntimePlacementParams
  )
}

export function validateAspcObserveRuntimeCapabilityRequest(
  value: unknown
): AspcObserveRuntimeCapabilityRequest {
  return validateObservationRequest(
    value,
    'aspc.observeRuntimeCapability',
    validateObserveRuntimeCapabilityParams
  )
}

export function validateAspcObserveContinuationArtifactRequest(
  value: unknown
): AspcObserveContinuationArtifactRequest {
  return validateObservationRequest(
    value,
    'aspc.observeContinuationArtifact',
    validateObserveContinuationArtifactParams
  )
}

export const validateAspcPrepareProcessInvocationRequest = (value: unknown) =>
  validateObservationRequest<AspcPrepareProcessInvocationRequest>(
    value,
    'aspc.prepareProcessInvocation',
    validatePrepareProcessParams
  )

/**
 * Dispatch table mapping each `aspc.*` method to its params validator. Typing it
 * as `Record<AspcMethod, ...>` makes the compiler fail if a method is added to
 * `ASPC_METHODS` without a corresponding validator entry here.
 */
const ASPC_PARAMS_VALIDATORS: Record<AspcMethod, ParamsValidator> = {
  'aspc.hello': validateHello,
  'aspc.catalogAgents': validateCatalogAgents,
  'aspc.inspectAgent': validateInspectAgent,
  'aspc.catalogAgentInspection': validateCatalogAgentInspection,
  'aspc.inspectAgentSelection': validateInspectAgentSelection,
  'aspc.compileHarnessInvocation': validateCompileHarnessInvocation,
  'aspc.resolveRuntimeDeclaration': validateResolveRuntimeDeclarationParams,
  'aspc.inspectRuntimePlacement': validateInspectRuntimePlacementParams,
  'aspc.observeRuntimeCapability': validateObserveRuntimeCapabilityParams,
  'aspc.observeContinuationArtifact': validateObserveContinuationArtifactParams,
  'aspc.prepareProcessInvocation': validatePrepareProcessParams,
}

export function validateAspcCommand(value: unknown): AspcCommand {
  const issues: ValidationIssue[] = []
  if (!isJsonRpcRequest(value)) {
    issues.push(issue('', ISSUE_CODE.invalidType, 'ASPC command must be a JSON-RPC request'))
  } else if (!isAspcMethod(value.method)) {
    issues.push(
      issue(
        'method',
        ISSUE_CODE.invalidLiteral,
        `Unsupported ASPC method: ${value.method}. Expected one of: ${ASPC_METHODS.join(', ')}`
      )
    )
  } else {
    // `isJsonRpcRequest` already guarantees `value.id` is a valid JSON-RPC id
    // (string | number | null), so no separate id validation is needed here.
    ASPC_PARAMS_VALIDATORS[value.method](value.params, 'params', issues)
  }
  if (issues.length > 0) {
    throw new AspcCommandValidationError(issues)
  }
  return value as AspcCommand
}

function isAspcMethod(value: string): value is AspcMethod {
  return (ASPC_METHODS as readonly string[]).includes(value)
}

function validateHello(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return
  const clientInfo = requireRecord(request['clientInfo'], path(basePath, 'clientInfo'), issues)
  if (clientInfo !== undefined) {
    requireString(clientInfo['name'], path(basePath, 'clientInfo.name'), issues)
    optionalString(clientInfo['version'], path(basePath, 'clientInfo.version'), issues)
  }
  const versions = request['protocolVersions']
  const versionsIssueCount = issues.length
  requireStringArray(versions, path(basePath, 'protocolVersions'), issues)
  // Only check protocol support once the array itself is well-formed, so the
  // "unsupported protocol" issue isn't emitted alongside item-type issues for
  // the same field.
  if (
    issues.length === versionsIssueCount &&
    Array.isArray(versions) &&
    !versions.includes(ASPC_PROTOCOL_VERSION)
  ) {
    issues.push(
      issue(
        path(basePath, 'protocolVersions'),
        ISSUE_CODE.unsupportedProtocol,
        `protocolVersions must include ${ASPC_PROTOCOL_VERSION}`
      )
    )
  }
  validateOptionalBooleanRecord(request['capabilities'], path(basePath, 'capabilities'), issues)
}
