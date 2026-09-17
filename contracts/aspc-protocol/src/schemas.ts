import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import { isJsonRpcRequest } from 'spaces-harness-broker-protocol'
import {
  AgentInspectionValidationError,
  validateAgentInspectionEvaluationContext,
  validateAgentInspectionRequest,
} from 'spaces-runtime-contracts'
import type {
  AspcAdmitDesktopRegistrationRequest,
  AspcCatalogAgentInspectionRequest,
  AspcCatalogAgentsRequest,
  AspcCommand,
  AspcCompileAndStartRequest,
  AspcCompileHarnessInvocationRequest,
  AspcCompileRuntimePlanRequest,
  AspcHelloRequest,
  AspcInspectAgentRequest,
  AspcInspectAgentSelectionRequest,
  AspcInspectRuntimePlacementRequest,
  AspcMethod,
  AspcObserveContinuationArtifactRequest,
  AspcObserveRuntimeCapabilityRequest,
  AspcPrepareDesktopObserverRequest,
  AspcPrepareProcessInvocationRequest,
  AspcResolveDesktopIdentityRequest,
  AspcResolveRuntimeDeclarationRequest,
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

export function validateAspcCompileAndStartRequest(value: unknown): AspcCompileAndStartRequest {
  return validateAspcCompileHarnessInvocationRequest(value)
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
    (item, base, issues) => {
      const request = validateRuntimeObservation(
        item,
        base,
        issues,
        'aspc-resolve-runtime-declaration-request/v1'
      )
      if (request) rejectUnknownParams(request, new Set(['schemaVersion', 'context']), base, issues)
    }
  )
}

export function validateAspcInspectRuntimePlacementRequest(
  value: unknown
): AspcInspectRuntimePlacementRequest {
  return validateObservationRequest(value, 'aspc.inspectRuntimePlacement', (item, base, issues) => {
    const request = validateRuntimeObservation(
      item,
      base,
      issues,
      'aspc-inspect-runtime-placement-request/v1'
    )
    if (request) {
      validateOptionalStringRecord(request['dispatchEnv'], path(base, 'dispatchEnv'), issues)
      validatePreparationCorrelation(request['preparationCorrelation'], base, issues, false)
      rejectUnknownParams(
        request,
        new Set(['schemaVersion', 'context', 'dispatchEnv', 'preparationCorrelation']),
        base,
        issues
      )
    }
  })
}

export function validateAspcObserveRuntimeCapabilityRequest(
  value: unknown
): AspcObserveRuntimeCapabilityRequest {
  return validateObservationRequest(
    value,
    'aspc.observeRuntimeCapability',
    (item, base, issues) => {
      const request = validateRuntimeObservation(
        item,
        base,
        issues,
        'aspc-observe-runtime-capability-request/v1'
      )
      if (request) {
        requireString(request['harness'], path(base, 'harness'), issues)
        rejectUnknownParams(request, new Set(['schemaVersion', 'context', 'harness']), base, issues)
      }
    }
  )
}

export function validateAspcObserveContinuationArtifactRequest(
  value: unknown
): AspcObserveContinuationArtifactRequest {
  return validateObservationRequest(
    value,
    'aspc.observeContinuationArtifact',
    validateContinuationObservation
  )
}

function validatePreparationEnvelope(
  value: unknown,
  base: string,
  issues: ValidationIssue[],
  schemaVersion: string,
  allowed: readonly string[],
  required: readonly string[]
): SchemaRecord | undefined {
  const request = requireRecord(value, base, issues)
  if (!request) return undefined
  requireLiteral(request['schemaVersion'], schemaVersion, path(base, 'schemaVersion'), issues)
  for (const field of required) {
    if (request[field] === undefined)
      issues.push(issue(path(base, field), ISSUE_CODE.required, `${field} is required`))
  }
  rejectUnknownParams(request, new Set(allowed), base, issues)
  return request
}

function validatePreparationCorrelation(
  value: unknown,
  base: string,
  issues: ValidationIssue[],
  required: boolean
): void {
  if (!required && value === undefined) return
  const correlation = requireRecord(value, path(base, 'preparationCorrelation'), issues)
  if (correlation) {
    optionalString(
      correlation['hostSessionId'],
      path(base, 'preparationCorrelation.hostSessionId'),
      issues
    )
    optionalString(correlation['runId'], path(base, 'preparationCorrelation.runId'), issues)
    optionalNumber(
      correlation['generation'],
      path(base, 'preparationCorrelation.generation'),
      issues
    )
    const sessionRef = optionalRecordValue(
      correlation['sessionRef'],
      path(base, 'preparationCorrelation.sessionRef'),
      issues
    )
    if (sessionRef) {
      requireString(
        sessionRef['scopeRef'],
        path(base, 'preparationCorrelation.sessionRef.scopeRef'),
        issues
      )
      requireString(
        sessionRef['laneRef'],
        path(base, 'preparationCorrelation.sessionRef.laneRef'),
        issues
      )
      rejectUnknownParams(
        sessionRef,
        new Set(['scopeRef', 'laneRef']),
        path(base, 'preparationCorrelation.sessionRef'),
        issues
      )
    }
    rejectUnknownParams(
      correlation,
      new Set(['hostSessionId', 'runId', 'generation', 'sessionRef']),
      path(base, 'preparationCorrelation'),
      issues
    )
  }
}

const validatePrepareProcessParams: ParamsValidator = (value, base, issues) => {
  const request = validatePreparationEnvelope(
    value,
    base,
    issues,
    'aspc-prepare-process-invocation-request/v1',
    [
      'schemaVersion',
      'context',
      'preparationCorrelation',
      'expected',
      'launch',
      'dispatchEnv',
      'lockedEnv',
      'artifactDir',
    ],
    ['context', 'preparationCorrelation', 'expected', 'launch']
  )
  if (!request) return
  validateRuntimeObservation(value, base, issues, 'aspc-prepare-process-invocation-request/v1')
  validatePreparationCorrelation(request['preparationCorrelation'], base, issues, true)
  const expected = requireRecord(request['expected'], path(base, 'expected'), issues)
  if (expected) {
    requireEnum(
      expected['provider'],
      ['anthropic', 'openai'],
      path(base, 'expected.provider'),
      issues
    )
    requireString(expected['frontend'], path(base, 'expected.frontend'), issues)
    rejectUnknownParams(expected, new Set(['provider', 'frontend']), path(base, 'expected'), issues)
  }
  const launch = requireRecord(request['launch'], path(base, 'launch'), issues)
  if (launch) {
    requireEnum(
      launch['interactionMode'],
      ['interactive', 'headless'],
      path(base, 'launch.interactionMode'),
      issues
    )
    requireEnum(launch['ioMode'], ['pty', 'inherit', 'pipes'], path(base, 'launch.ioMode'), issues)
    rejectUnknownParams(
      launch,
      new Set([
        'interactionMode',
        'ioMode',
        'model',
        'modelReasoningEffort',
        'continuation',
        'prompt',
        'omitPriming',
        'attachments',
        'yolo',
      ]),
      path(base, 'launch'),
      issues
    )
  }
}

const validateResolveDesktopIdentityParams: ParamsValidator = (value, base, issues) => {
  const request = validatePreparationEnvelope(
    value,
    base,
    issues,
    'aspc-resolve-desktop-identity-request/v1',
    ['schemaVersion', 'nativeThreadId', 'reported', 'fallbackHomeDir'],
    ['nativeThreadId', 'reported', 'fallbackHomeDir']
  )
  if (request) {
    requireString(request['nativeThreadId'], path(base, 'nativeThreadId'), issues)
    requireString(request['fallbackHomeDir'], path(base, 'fallbackHomeDir'), issues)
    const reported = requireRecord(request['reported'], path(base, 'reported'), issues)
    if (reported) {
      optionalString(reported['codexHome'], path(base, 'reported.codexHome'), issues)
      optionalString(reported['sqliteHome'], path(base, 'reported.sqliteHome'), issues)
      optionalString(reported['rolloutPath'], path(base, 'reported.rolloutPath'), issues)
      rejectUnknownParams(
        reported,
        new Set(['codexHome', 'sqliteHome', 'rolloutPath']),
        path(base, 'reported'),
        issues
      )
    }
  }
}

const validateAdmitDesktopRegistrationParams: ParamsValidator = (value, base, issues) => {
  const request = validatePreparationEnvelope(
    value,
    base,
    issues,
    'aspc-admit-desktop-registration-request/v1',
    ['schemaVersion', 'identity', 'rolloutPath', 'reportedWorkspaceCwd'],
    ['identity']
  )
  if (request) {
    const identity = requireRecord(request['identity'], path(base, 'identity'), issues)
    if (identity) {
      for (const field of [
        'nativeThreadId',
        'homeIdentity',
        'sqliteHome',
        'registrationKey',
        'homeBasis',
      ]) {
        requireString(identity[field], path(base, `identity.${field}`), issues)
      }
      rejectUnknownParams(
        identity,
        new Set(['nativeThreadId', 'homeIdentity', 'sqliteHome', 'registrationKey', 'homeBasis']),
        path(base, 'identity'),
        issues
      )
    }
    optionalString(request['rolloutPath'], path(base, 'rolloutPath'), issues)
    optionalString(request['reportedWorkspaceCwd'], path(base, 'reportedWorkspaceCwd'), issues)
  }
}

const validatePrepareDesktopObserverParams: ParamsValidator = (value, base, issues) => {
  const request = validatePreparationEnvelope(
    value,
    base,
    issues,
    'aspc-prepare-desktop-observer-request/v1',
    [
      'schemaVersion',
      'registration',
      'operatorBundleExecutable',
      'hostingIdentity',
      'recoveryBoundary',
      'nativeAttemptStorePath',
    ],
    ['registration', 'hostingIdentity', 'nativeAttemptStorePath']
  )
  if (!request) return
  const registration = requireRecord(request['registration'], path(base, 'registration'), issues)
  if (registration) {
    for (const field of [
      'registrationKey',
      'agentId',
      'projectId',
      'projectRoot',
      'scopeRef',
      'laneRef',
      'hostSessionId',
      'nativeThreadId',
      'homeIdentity',
      'sqliteHome',
    ]) {
      requireString(registration[field], path(base, `registration.${field}`), issues)
    }
    optionalString(registration['rolloutPath'], path(base, 'registration.rolloutPath'), issues)
    optionalString(
      registration['reportedBundleExecutable'],
      path(base, 'registration.reportedBundleExecutable'),
      issues
    )
    requireNumber(registration['generation'], path(base, 'registration.generation'), issues)
    rejectUnknownParams(
      registration,
      new Set([
        'registrationKey',
        'agentId',
        'projectId',
        'projectRoot',
        'scopeRef',
        'laneRef',
        'hostSessionId',
        'generation',
        'nativeThreadId',
        'homeIdentity',
        'sqliteHome',
        'rolloutPath',
        'reportedBundleExecutable',
      ]),
      path(base, 'registration'),
      issues
    )
  }
  optionalString(
    request['operatorBundleExecutable'],
    path(base, 'operatorBundleExecutable'),
    issues
  )
  const hostingIdentity = requireRecord(
    request['hostingIdentity'],
    path(base, 'hostingIdentity'),
    issues
  )
  if (hostingIdentity) {
    for (const field of ['runtimeId', 'runId', 'hostSessionId']) {
      requireString(hostingIdentity[field], path(base, `hostingIdentity.${field}`), issues)
    }
    requireNumber(hostingIdentity['generation'], path(base, 'hostingIdentity.generation'), issues)
    rejectUnknownParams(
      hostingIdentity,
      new Set(['runtimeId', 'runId', 'hostSessionId', 'generation']),
      path(base, 'hostingIdentity'),
      issues
    )
  }
  if (request['recoveryBoundary'] !== undefined) {
    requireRecord(request['recoveryBoundary'], path(base, 'recoveryBoundary'), issues)
  }
  requireString(request['nativeAttemptStorePath'], path(base, 'nativeAttemptStorePath'), issues)
}

function requireNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, ISSUE_CODE.required, `${basePath} is required`))
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a finite number`))
  }
}

function optionalNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a finite number`))
  }
}

function validatePreparationRequest<T>(
  value: unknown,
  method: string,
  validator: ParamsValidator
): T {
  return validateObservationRequest<T>(value, method, validator)
}

export const validateAspcPrepareProcessInvocationRequest = (value: unknown) =>
  validatePreparationRequest<AspcPrepareProcessInvocationRequest>(
    value,
    'aspc.prepareProcessInvocation',
    validatePrepareProcessParams
  )
export const validateAspcResolveDesktopIdentityRequest = (value: unknown) =>
  validatePreparationRequest<AspcResolveDesktopIdentityRequest>(
    value,
    'aspc.resolveDesktopIdentity',
    validateResolveDesktopIdentityParams
  )
export const validateAspcAdmitDesktopRegistrationRequest = (value: unknown) =>
  validatePreparationRequest<AspcAdmitDesktopRegistrationRequest>(
    value,
    'aspc.admitDesktopRegistration',
    validateAdmitDesktopRegistrationParams
  )
export const validateAspcPrepareDesktopObserverRequest = (value: unknown) =>
  validatePreparationRequest<AspcPrepareDesktopObserverRequest>(
    value,
    'aspc.prepareDesktopObserver',
    validatePrepareDesktopObserverParams
  )

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
  'aspc.catalogAgentInspection': validateCatalogAgentInspection,
  'aspc.inspectAgentSelection': validateInspectAgentSelection,
  'aspc.compileHarnessInvocation': validateCompileHarnessInvocation,
  'aspc.resolveRuntimeDeclaration': (value, base, issues) => {
    const request = validateRuntimeObservation(
      value,
      base,
      issues,
      'aspc-resolve-runtime-declaration-request/v1'
    )
    if (request) rejectUnknownParams(request, new Set(['schemaVersion', 'context']), base, issues)
  },
  'aspc.inspectRuntimePlacement': (value, base, issues) => {
    const request = validateRuntimeObservation(
      value,
      base,
      issues,
      'aspc-inspect-runtime-placement-request/v1'
    )
    if (request) {
      validateOptionalStringRecord(request['dispatchEnv'], path(base, 'dispatchEnv'), issues)
      validatePreparationCorrelation(request['preparationCorrelation'], base, issues, false)
      rejectUnknownParams(
        request,
        new Set(['schemaVersion', 'context', 'dispatchEnv', 'preparationCorrelation']),
        base,
        issues
      )
    }
  },
  'aspc.observeRuntimeCapability': (value, base, issues) => {
    const request = validateRuntimeObservation(
      value,
      base,
      issues,
      'aspc-observe-runtime-capability-request/v1'
    )
    if (request) {
      requireString(request['harness'], path(base, 'harness'), issues)
      rejectUnknownParams(request, new Set(['schemaVersion', 'context', 'harness']), base, issues)
    }
  },
  'aspc.observeContinuationArtifact': validateContinuationObservation,
  'aspc.prepareProcessInvocation': validatePrepareProcessParams,
  'aspc.resolveDesktopIdentity': validateResolveDesktopIdentityParams,
  'aspc.admitDesktopRegistration': validateAdmitDesktopRegistrationParams,
  'aspc.prepareDesktopObserver': validatePrepareDesktopObserverParams,
  'aspc.compileAndStart': validateCompileHarnessInvocation,
}

function validateRuntimeObservation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  version: string
): SchemaRecord | undefined {
  const request = requireRecord(value, basePath, issues)
  if (!request) return undefined
  requireLiteral(request['schemaVersion'], version, path(basePath, 'schemaVersion'), issues)
  const context = requireRecord(request['context'], path(basePath, 'context'), issues)
  if (context) {
    requireString(context['agentId'], path(basePath, 'context.agentId'), issues)
    optionalString(context['agentRoot'], path(basePath, 'context.agentRoot'), issues)
    requireString(context['cwd'], path(basePath, 'context.cwd'), issues)
    requireEnum(
      context['runMode'],
      ['query', 'heartbeat', 'task', 'maintenance'],
      path(basePath, 'context.runMode'),
      issues
    )
    optionalString(context['taskId'], path(basePath, 'context.taskId'), issues)
    const project = requireRecord(context['project'], path(basePath, 'context.project'), issues)
    if (project) {
      requireEnum(
        project['mode'],
        ['root', 'infer-from-cwd', 'none'],
        path(basePath, 'context.project.mode'),
        issues
      )
      if (project['mode'] === 'root') {
        requireString(project['projectRoot'], path(basePath, 'context.project.projectRoot'), issues)
        optionalString(project['projectId'], path(basePath, 'context.project.projectId'), issues)
        rejectUnknownParams(
          project,
          new Set(['mode', 'projectRoot', 'projectId']),
          path(basePath, 'context.project'),
          issues
        )
      } else {
        rejectUnknownParams(project, new Set(['mode']), path(basePath, 'context.project'), issues)
      }
    }
    const agentSources = optionalRecordValue(
      context['agentSources'],
      path(basePath, 'context.agentSources'),
      issues
    )
    if (agentSources) {
      optionalString(
        agentSources['aspHome'],
        path(basePath, 'context.agentSources.aspHome'),
        issues
      )
      optionalString(
        agentSources['agentsRoot'],
        path(basePath, 'context.agentSources.agentsRoot'),
        issues
      )
      rejectUnknownParams(
        agentSources,
        new Set(['aspHome', 'agentsRoot']),
        path(basePath, 'context.agentSources'),
        issues
      )
    }
    validateOptionalProvisionDirectives(
      context['provisionDirectives'],
      path(basePath, 'context.provisionDirectives'),
      issues
    )
    rejectUnknownParams(
      context,
      new Set([
        'agentId',
        'agentRoot',
        'project',
        'cwd',
        'runMode',
        'taskId',
        'agentSources',
        'provisionDirectives',
      ]),
      path(basePath, 'context'),
      issues
    )
  }
  return request
}

function validateContinuationObservation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = requireRecord(value, basePath, issues)
  if (!request) return
  requireLiteral(
    request['schemaVersion'],
    'aspc-observe-continuation-artifact-request/v1',
    path(basePath, 'schemaVersion'),
    issues
  )
  const continuation = requireRecord(
    request['continuation'],
    path(basePath, 'continuation'),
    issues
  )
  if (continuation) {
    requireString(continuation['provider'], path(basePath, 'continuation.provider'), issues)
    requireString(continuation['key'], path(basePath, 'continuation.key'), issues)
    if (continuation['artifactFormat'] !== undefined) {
      requireEnum(
        continuation['artifactFormat'],
        ['claude', 'codex', 'pi'],
        path(basePath, 'continuation.artifactFormat'),
        issues
      )
    }
    rejectUnknownParams(
      continuation,
      new Set(['provider', 'key', 'artifactFormat']),
      path(basePath, 'continuation'),
      issues
    )
  }
  const historical = optionalRecordValue(
    request['historicalExecution'],
    path(basePath, 'historicalExecution'),
    issues
  )
  if (historical) {
    const frozen = optionalRecordValue(
      historical['frozenStartRequest'],
      path(basePath, 'historicalExecution.frozenStartRequest'),
      issues
    )
    if (frozen) {
      requireLiteral(
        frozen['keyBinding'],
        'runtime-continuation',
        path(basePath, 'historicalExecution.frozenStartRequest.keyBinding'),
        issues
      )
      requireRecord(
        frozen['placement'],
        path(basePath, 'historicalExecution.frozenStartRequest.placement'),
        issues
      )
      requireRecord(
        frozen['startRequest'],
        path(basePath, 'historicalExecution.frozenStartRequest.startRequest'),
        issues
      )
      if (frozen['brokerDriver'] !== undefined) {
        requireEnum(
          frozen['brokerDriver'],
          ['codex-app-server', 'claude-code-tmux', 'codex-cli-tmux', 'pi-tui-tmux', 'pi-sdk'],
          path(basePath, 'historicalExecution.frozenStartRequest.brokerDriver'),
          issues
        )
      }
      for (const field of ['compileId', 'planHash', 'selectedProfileHash', 'startRequestHash']) {
        optionalString(
          frozen[field],
          path(basePath, `historicalExecution.frozenStartRequest.${field}`),
          issues
        )
      }
      optionalRecord(
        frozen['executionRelease'],
        path(basePath, 'historicalExecution.frozenStartRequest.executionRelease'),
        issues
      )
    }
    const recorded = optionalRecordValue(
      historical['recordedPlacement'],
      path(basePath, 'historicalExecution.recordedPlacement'),
      issues
    )
    if (recorded) {
      requireRecord(
        recorded['placement'],
        path(basePath, 'historicalExecution.recordedPlacement.placement'),
        issues
      )
      requireRecord(
        recorded['bundle'],
        path(basePath, 'historicalExecution.recordedPlacement.bundle'),
        issues
      )
      optionalString(
        recorded['aspHome'],
        path(basePath, 'historicalExecution.recordedPlacement.aspHome'),
        issues
      )
      for (const field of ['compileId', 'planHash', 'selectedProfileHash']) {
        optionalString(
          recorded[field],
          path(basePath, `historicalExecution.recordedPlacement.${field}`),
          issues
        )
      }
    }
    rejectUnknownParams(
      historical,
      new Set(['frozenStartRequest', 'recordedPlacement']),
      path(basePath, 'historicalExecution'),
      issues
    )
  }
  rejectUnknownParams(
    request,
    new Set(['schemaVersion', 'continuation', 'historicalExecution']),
    basePath,
    issues
  )
}

function requireEnum(
  value: unknown,
  allowed: readonly string[],
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(
      issue(
        basePath,
        ISSUE_CODE.invalidLiteral,
        `${basePath} must be one of: ${allowed.join(', ')}`
      )
    )
  }
}

function optionalRecordValue(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  return value === undefined ? undefined : requireRecord(value, basePath, issues)
}

function validateOptionalProvisionDirectives(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const directives = optionalRecordValue(value, basePath, issues)
  if (!directives) return
  for (const [key, item] of Object.entries(directives)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      issues.push(
        issue(
          path(basePath, key),
          ISSUE_CODE.invalidType,
          `${path(basePath, key)} must be a string, number, or boolean`
        )
      )
    }
  }
}

const INSPECTION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const INSPECTION_IDENTIFIER_MAX_LENGTH = 160

function validateCatalogAgentInspection(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  validateOptionalInspectionIdentifier(params['projectId'], path(basePath, 'projectId'), issues)
  rejectUnknownParams(params, new Set(['projectId']), basePath, issues)
}

function validateInspectAgentSelection(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  validateInspectionIdentifier(params['agentId'], path(basePath, 'agentId'), issues)
  appendInspectionIssues(
    () => validateAgentInspectionRequest(params['request']),
    path(basePath, 'request'),
    issues
  )
  validateStrictInspectionRequest(params['request'], path(basePath, 'request'), issues)
  rejectUnknownParams(params, new Set(['agentId', 'request']), basePath, issues)
}

function validateStrictInspectionRequest(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return
  rejectUnknownParams(
    request,
    new Set(['schemaVersion', 'identifiers', 'declaredOverrides']),
    basePath,
    issues
  )
  const identifiersPath = path(basePath, 'identifiers')
  const identifiers = requireRecord(request['identifiers'], identifiersPath, issues)
  if (identifiers === undefined) return
  const required = [
    'agentId',
    'projectId',
    'mode',
    'scope',
    'lane',
    'harness',
    'frontend',
    'interaction',
  ] as const
  for (const field of required) {
    validateInspectionIdentifier(identifiers[field], path(identifiersPath, field), issues)
  }
  for (const field of ['agentName', 'taskId'] as const) {
    validateOptionalInspectionIdentifier(identifiers[field], path(identifiersPath, field), issues)
  }
  rejectUnknownParams(
    identifiers,
    new Set([...required, 'agentName', 'taskId']),
    identifiersPath,
    issues
  )
}

function validateInspectionIdentifier(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > INSPECTION_IDENTIFIER_MAX_LENGTH ||
    !INSPECTION_IDENTIFIER_PATTERN.test(value)
  ) {
    issues.push(
      issue(
        basePath,
        ISSUE_CODE.invalidType,
        `${basePath} must be a validated identifier of at most ${INSPECTION_IDENTIFIER_MAX_LENGTH} characters`
      )
    )
  }
}

function validateOptionalInspectionIdentifier(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value !== undefined) validateInspectionIdentifier(value, basePath, issues)
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
