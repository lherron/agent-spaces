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
import { ASPC_PROTOCOL_VERSION } from './types.js'

type SchemaRecord = Record<string, unknown>

export class AspcHelloRequestValidationError extends Error {
  readonly code = 'INVALID_ASPC_HELLO_REQUEST'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid ASPC hello request')
    this.name = 'AspcHelloRequestValidationError'
    this.issues = issues
  }
}

export class AspcCompileRuntimePlanRequestValidationError extends Error {
  readonly code = 'INVALID_ASPC_COMPILE_RUNTIME_PLAN_REQUEST'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid ASPC compileRuntimePlan request')
    this.name = 'AspcCompileRuntimePlanRequestValidationError'
    this.issues = issues
  }
}

export class AspcCompileHarnessInvocationRequestValidationError extends Error {
  readonly code = 'INVALID_ASPC_COMPILE_HARNESS_INVOCATION_REQUEST'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid ASPC compileHarnessInvocation request')
    this.name = 'AspcCompileHarnessInvocationRequestValidationError'
    this.issues = issues
  }
}

export class AspcCommandValidationError extends Error {
  readonly code = 'INVALID_ASPC_COMMAND'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid ASPC command')
    this.name = 'AspcCommandValidationError'
    this.issues = issues
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

export function validateAspcCommand(value: unknown): AspcCommand {
  const issues: ValidationIssue[] = []
  if (!isJsonRpcRequest(value)) {
    issues.push(issue('', 'invalid_type', 'ASPC command must be a JSON-RPC request'))
  } else if (!isAspcMethod(value.method)) {
    issues.push(issue('method', 'invalid_literal', `Unsupported ASPC method: ${value.method}`))
  } else {
    validateJsonRpcId(value.id, 'id', issues)
    switch (value.method) {
      case 'aspc.hello':
        validateHello(value.params, 'params', issues)
        break
      case 'aspc.compileRuntimePlan':
        validateCompileRuntimePlan(value.params, 'params', issues)
        break
      case 'aspc.compileHarnessInvocation':
      case 'aspc.compileAndStart':
        validateCompileHarnessInvocation(value.params, 'params', issues)
        break
    }
  }
  if (issues.length > 0) {
    throw new AspcCommandValidationError(issues)
  }
  return value as AspcCommand
}

function isAspcMethod(value: string): value is AspcMethod {
  return (
    value === 'aspc.hello' ||
    value === 'aspc.compileRuntimePlan' ||
    value === 'aspc.compileHarnessInvocation' ||
    value === 'aspc.compileAndStart'
  )
}

function validateJsonRpcId(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string, number, or null`))
  }
}

function validateHello(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const request = record(value, basePath, issues)
  if (request === undefined) return
  const clientInfo = record(request['clientInfo'], path(basePath, 'clientInfo'), issues)
  if (clientInfo !== undefined) {
    requireString(clientInfo['name'], path(basePath, 'clientInfo.name'), issues)
    optionalString(clientInfo['version'], path(basePath, 'clientInfo.version'), issues)
  }
  requireStringArray(request['protocolVersions'], path(basePath, 'protocolVersions'), issues)
  if (
    Array.isArray(request['protocolVersions']) &&
    !request['protocolVersions'].includes(ASPC_PROTOCOL_VERSION)
  ) {
    issues.push(
      issue(
        path(basePath, 'protocolVersions'),
        'unsupported_protocol',
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
): void {
  const request = record(value, basePath, issues)
  if (request === undefined) return
  validateRuntimeCompileRequest(request['compileRequest'], path(basePath, 'compileRequest'), issues)
  optionalString(request['aspHome'], path(basePath, 'aspHome'), issues)
}

function validateCompileHarnessInvocation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateCompileRuntimePlan(value, basePath, issues)
  const request = asRecord(value)
  if (request === undefined) return
  validateProfileSelector(request['profileSelector'], path(basePath, 'profileSelector'), issues)
  validateStringRecord(request['dispatchEnv'], path(basePath, 'dispatchEnv'), issues)
  validateOptionalRecord(request['runtime'], path(basePath, 'runtime'), issues)
}

function validateRuntimeCompileRequest(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = record(value, basePath, issues)
  if (request === undefined) return
  requireLiteral(
    request['schemaVersion'],
    'agent-runtime-compile-request/v1',
    path(basePath, 'schemaVersion'),
    issues
  )
  validateRequiredRecord(request['identity'], path(basePath, 'identity'), issues)
  validateRequiredRecord(request['placement'], path(basePath, 'placement'), issues)
  validateRequiredRecord(request['requested'], path(basePath, 'requested'), issues)
  validateRequiredRecord(request['materialization'], path(basePath, 'materialization'), issues)
  validateRequiredRecord(request['hrcPolicy'], path(basePath, 'hrcPolicy'), issues)
  validateRequiredRecord(request['correlation'], path(basePath, 'correlation'), issues)
}

function validateProfileSelector(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) return
  const selector = record(value, basePath, issues)
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
  const object = record(value, basePath, issues)
  if (object === undefined) return
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'boolean') {
      issues.push(
        issue(path(basePath, key), 'invalid_type', `${path(basePath, key)} must be a boolean`)
      )
    }
  }
}

function validateStringRecord(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) return
  const object = record(value, basePath, issues)
  if (object === undefined) return
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'string') {
      issues.push(
        issue(path(basePath, key), 'invalid_type', `${path(basePath, key)} must be a string`)
      )
    }
  }
}

function validateOptionalRecord(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined) {
    record(value, basePath, issues)
  }
}

function validateRequiredRecord(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  record(value, basePath, issues)
}

function record(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const object = asRecord(value)
  if (object === undefined) {
    issues.push(
      issue(
        basePath,
        value === undefined ? 'required' : 'invalid_type',
        `${basePath} must be an object`
      )
    )
    return undefined
  }
  return object
}

function asRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

function requireString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'string') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

function optionalString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

function requireStringArray(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(
      issue(
        basePath,
        value === undefined ? 'required' : 'invalid_type',
        `${basePath} must be an array`
      )
    )
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push(
        issue(path(basePath, String(index)), 'invalid_type', 'array item must be a string')
      )
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
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (value !== expected) {
    issues.push(issue(basePath, 'invalid_literal', `${basePath} must be ${expected}`))
  }
}

function path(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : `${prefix}.${suffix}`
}

function issue(pathValue: string, code: string, message: string): ValidationIssue {
  return { path: pathValue, code, message }
}
