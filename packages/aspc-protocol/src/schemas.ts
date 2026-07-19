import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import { isJsonRpcRequest } from 'spaces-harness-broker-protocol'
import {
  AgentInspectionValidationError,
  validateAgentInspectionEvaluationContext,
  validateAgentInspectionRequest,
} from 'spaces-runtime-contracts'
import type {
  AspcCatalogAgentsRequest,
  AspcCommand,
  AspcCompileAndStartRequest,
  AspcCompileHarnessInvocationRequest,
  AspcCompileRuntimePlanRequest,
  AspcHelloRequest,
  AspcInspectAgentRequest,
  AspcMethod,
} from './types.js'
import { ASPC_METHODS, ASPC_PROTOCOL_VERSION } from './types.js'
import type { SchemaRecord } from './validation-primitives.js'
import {
  path,
  ISSUE_CODE,
  issue,
  optionalString,
  requireLiteral,
  requireRecord,
  requireRecordFields,
  requireString,
  requireStringArray,
} from './validation-primitives.js'

/**
 * Canonical `schemaVersion` literal of the runtime compile request. Authoritative
 * home is `spaces-runtime-contracts`; mirrored here as a single point of reference
 * for the validator so the literal isn't repeated inline.
 */
const RUNTIME_COMPILE_REQUEST_SCHEMA_VERSION = 'agent-runtime-compile-request/v1'

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
  'aspc.catalogAgents': validateCatalogAgents,
  'aspc.inspectAgent': validateInspectAgent,
  'aspc.compileHarnessInvocation': validateCompileHarnessInvocation,
  'aspc.compileAndStart': validateCompileHarnessInvocation,
}

function validateCatalogAgents(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  appendInspectionIssues(
    () => validateAgentInspectionEvaluationContext(params['evaluationContext']),
    path(basePath, 'evaluationContext'),
    issues
  )
  rejectUnknownParams(params, new Set(['evaluationContext']), basePath, issues)
}

function validateInspectAgent(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  appendInspectionIssues(
    () => validateAgentInspectionRequest(params['request']),
    path(basePath, 'request'),
    issues
  )
  appendInspectionIssues(
    () => validateAgentInspectionEvaluationContext(params['evaluationContext']),
    path(basePath, 'evaluationContext'),
    issues
  )
  rejectUnknownParams(params, new Set(['request', 'evaluationContext']), basePath, issues)
}

function appendInspectionIssues(
  validate: () => unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  try {
    validate()
  } catch (error) {
    if (!(error instanceof AgentInspectionValidationError)) throw error
    issues.push(
      ...error.issues.map((item) => ({
        ...item,
        path: item.path.length === 0 ? basePath : `${basePath}.${item.path}`,
      }))
    )
  }
}

function rejectUnknownParams(
  params: SchemaRecord,
  allowed: ReadonlySet<string>,
  basePath: string,
  issues: ValidationIssue[]
): void {
  for (const key of Object.keys(params)) {
    if (allowed.has(key)) continue
    issues.push(
      issue(path(basePath, key), 'forbidden_input', `${path(basePath, key)} is not accepted`)
    )
  }
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
  validateCompileContext(request['compileContext'], path(basePath, 'compileContext'), issues)
  return request
}

/**
 * Validate the optional serializable compile context (T-04133). All fields are
 * optional; an absent context is accepted. `nowIso` / `idSalt` must be strings;
 * `toolchainManifest`, when present, must be a record.
 */
function validateCompileContext(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) return
  const context = requireRecord(value, basePath, issues)
  if (context === undefined) return
  optionalString(context['nowIso'], path(basePath, 'nowIso'), issues)
  optionalString(context['idSalt'], path(basePath, 'idSalt'), issues)
  if (context['toolchainManifest'] !== undefined) {
    requireRecord(context['toolchainManifest'], path(basePath, 'toolchainManifest'), issues)
  }
}

function validateCompileHarnessInvocation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = validateCompileRuntimePlan(value, basePath, issues)
  if (request === undefined) return
  validateProfileSelector(request['profileSelector'], path(basePath, 'profileSelector'), issues)
  validateOptionalStringRecord(request['dispatchEnv'], path(basePath, 'dispatchEnv'), issues)
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
    RUNTIME_COMPILE_REQUEST_SCHEMA_VERSION,
    path(basePath, 'schemaVersion'),
    issues
  )
  requireRecordFields(
    request,
    basePath,
    ['identity', 'placement', 'requested', 'materialization', 'hrcPolicy', 'correlation'],
    issues
  )
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

/**
 * Validates that an optional `value` is a record whose entries all match the
 * given primitive `typeof`. Absent values are accepted; a non-record records a
 * single issue and skips entry checks; each off-type entry records its own
 * indexed issue. Shared by the boolean- and string-valued record validators.
 */
function validateOptionalPrimitiveRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  itemType: 'boolean' | 'string'
): void {
  if (value === undefined) return
  const object = requireRecord(value, basePath, issues)
  if (object === undefined) return
  for (const [key, item] of Object.entries(object)) {
    // biome-ignore lint/suspicious/useValidTypeof: itemType is constrained to the typeof-string union 'boolean' | 'string'
    if (typeof item !== itemType) {
      const itemPath = path(basePath, key)
      issues.push(issue(itemPath, ISSUE_CODE.invalidType, `${itemPath} must be a ${itemType}`))
    }
  }
}

function validateOptionalBooleanRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateOptionalPrimitiveRecord(value, basePath, issues, 'boolean')
}

function validateOptionalStringRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateOptionalPrimitiveRecord(value, basePath, issues, 'string')
}

function optionalRecord(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined) {
    requireRecord(value, basePath, issues)
  }
}
