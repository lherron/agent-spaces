import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import { isJsonRpcRequest } from 'spaces-harness-broker-protocol'
import type {
  AspcCommand,
  AspcCompileAndStartRequest,
  AspcCompileHarnessInvocationRequest,
  AspcCompileRuntimePlanRequest,
  AspcHelloRequest,
  AspcMethod,
} from './types.js'
import { ASPC_METHODS, ASPC_PROTOCOL_VERSION } from './types.js'

type SchemaRecord = Record<string, unknown>

/**
 * Shared issue `code` literals so producers reference one canonical set instead
 * of repeating bare strings throughout the validators.
 */
const ISSUE_CODE = {
  required: 'required',
  invalidType: 'invalid_type',
  invalidLiteral: 'invalid_literal',
  unsupportedProtocol: 'unsupported_protocol',
} as const

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

export class AspcCompileRuntimePlanRequestValidationError extends AspcValidationError {
  readonly code = 'INVALID_ASPC_COMPILE_RUNTIME_PLAN_REQUEST'

  constructor(issues: ValidationIssue[]) {
    super(
      'AspcCompileRuntimePlanRequestValidationError',
      'Invalid ASPC compileRuntimePlan request',
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

export function validateAspcHelloRequest(value: unknown): AspcHelloRequest {
  const issues: ValidationIssue[] = []
  validateHello(value, 'params', issues)
  if (issues.length > 0) {
    throw new AspcHelloRequestValidationError(issues)
  }
  return value as AspcHelloRequest
}

export function validateAspcCompileRuntimePlanRequest(
  value: unknown
): AspcCompileRuntimePlanRequest {
  const issues: ValidationIssue[] = []
  validateCompileRuntimePlan(value, 'params', issues)
  if (issues.length > 0) {
    throw new AspcCompileRuntimePlanRequestValidationError(issues)
  }
  return value as AspcCompileRuntimePlanRequest
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

export function validateAspcCompileAndStartRequest(value: unknown): AspcCompileAndStartRequest {
  return validateAspcCompileHarnessInvocationRequest(value)
}

type ParamsValidator = (value: unknown, basePath: string, issues: ValidationIssue[]) => void

/**
 * Dispatch table mapping each `aspc.*` method to its params validator. Typing it
 * as `Record<AspcMethod, ...>` makes the compiler fail if a method is added to
 * `ASPC_METHODS` without a corresponding validator entry here.
 */
const ASPC_PARAMS_VALIDATORS: Record<AspcMethod, ParamsValidator> = {
  'aspc.hello': validateHello,
  'aspc.compileRuntimePlan': validateCompileRuntimePlan,
  'aspc.compileHarnessInvocation': validateCompileHarnessInvocation,
  'aspc.compileAndStart': validateCompileHarnessInvocation,
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

function validateCompileRuntimePlan(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return undefined
  validateRuntimeCompileRequest(request['compileRequest'], path(basePath, 'compileRequest'), issues)
  optionalString(request['aspHome'], path(basePath, 'aspHome'), issues)
  return request
}

function validateCompileHarnessInvocation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = validateCompileRuntimePlan(value, basePath, issues)
  if (request === undefined) return
  validateProfileSelector(request['profileSelector'], path(basePath, 'profileSelector'), issues)
  validateStringRecord(request['dispatchEnv'], path(basePath, 'dispatchEnv'), issues)
  optionalRecord(request['runtime'], path(basePath, 'runtime'), issues)
  optionalRecord(request['lifecyclePolicy'], path(basePath, 'lifecyclePolicy'), issues)
}

function validateRuntimeCompileRequest(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return
  requireLiteral(
    request['schemaVersion'],
    'agent-runtime-compile-request/v1',
    path(basePath, 'schemaVersion'),
    issues
  )
  requireRecord(request['identity'], path(basePath, 'identity'), issues)
  requireRecord(request['placement'], path(basePath, 'placement'), issues)
  requireRecord(request['requested'], path(basePath, 'requested'), issues)
  requireRecord(request['materialization'], path(basePath, 'materialization'), issues)
  requireRecord(request['hrcPolicy'], path(basePath, 'hrcPolicy'), issues)
  requireRecord(request['correlation'], path(basePath, 'correlation'), issues)
}

function validateProfileSelector(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) return
  const selector = requireRecord(value, basePath, issues)
  if (selector === undefined) return
  optionalString(selector['profileId'], path(basePath, 'profileId'), issues)
  optionalString(selector['profileHash'], path(basePath, 'profileHash'), issues)
  optionalString(selector['brokerDriver'], path(basePath, 'brokerDriver'), issues)
}

function validateOptionalBooleanRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) return
  const object = requireRecord(value, basePath, issues)
  if (object === undefined) return
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'boolean') {
      issues.push(
        issue(
          path(basePath, key),
          ISSUE_CODE.invalidType,
          `${path(basePath, key)} must be a boolean`
        )
      )
    }
  }
}

function validateStringRecord(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) return
  const object = requireRecord(value, basePath, issues)
  if (object === undefined) return
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'string') {
      issues.push(
        issue(
          path(basePath, key),
          ISSUE_CODE.invalidType,
          `${path(basePath, key)} must be a string`
        )
      )
    }
  }
}

function optionalRecord(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined) {
    requireRecord(value, basePath, issues)
  }
}

/**
 * Coerces `value` to a record, *pushing a validation issue* when it is not an
 * object. Contrast with {@link coerceRecord}, which is silent. Returns the
 * record on success, `undefined` (with an issue recorded) otherwise.
 */
function requireRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const object = coerceRecord(value)
  if (object === undefined) {
    issues.push(
      issue(
        basePath,
        value === undefined ? ISSUE_CODE.required : ISSUE_CODE.invalidType,
        `${basePath} must be an object`
      )
    )
    return undefined
  }
  return object
}

/**
 * Silently coerces `value` to a record, returning `undefined` when it is not a
 * plain object. Contrast with {@link requireRecord}, which records an issue.
 */
function coerceRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

function requireString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, ISSUE_CODE.required, `${basePath} is required`))
  } else if (typeof value !== 'string') {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a string`))
  }
}

function optionalString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a string`))
  }
}

function requireStringArray(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(
      issue(
        basePath,
        value === undefined ? ISSUE_CODE.required : ISSUE_CODE.invalidType,
        `${basePath} must be an array`
      )
    )
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      const itemPath = path(basePath, String(index))
      issues.push(issue(itemPath, ISSUE_CODE.invalidType, `${itemPath} must be a string`))
    }
  })
}

function requireLiteral(
  value: unknown,
  expected: string,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    issues.push(issue(basePath, ISSUE_CODE.required, `${basePath} is required`))
  } else if (value !== expected) {
    issues.push(issue(basePath, ISSUE_CODE.invalidLiteral, `${basePath} must be ${expected}`))
  }
}

function path(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : `${prefix}.${suffix}`
}

function issue(pathValue: string, code: string, message: string): ValidationIssue {
  return { path: pathValue, code, message }
}
