import type { BrokerCommand, BrokerMethod } from './commands'
import type {
  InvocationDispatchRequest,
  InvocationInput,
  InvocationStartRequest,
  PermissionRequestParams,
} from './commands'
import type { InvocationEventEnvelope, InvocationEventType } from './events'
import type { HarnessInvocationSpec } from './invocation'
import { isJsonRpcRequest } from './jsonrpc'
import type { BrokerLifecyclePolicyOverlay } from './lifecycle.js'
import { lifecyclePolicyHash } from './lifecycle.js'

// Env-key classification policy lives in ./env-keys; re-export to preserve the
// public package surface (ENV_KEY_PATTERN / isAmbientEnvKey / etc.).
export * from './env-keys.js'
import {
  ENV_KEY_PATTERN,
  isAmbientEnvKey,
  isCredentialEnvKey,
  isReservedEnvKey,
} from './env-keys.js'
import {
  path,
  asRecord,
  issue,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireNumber,
  requirePayloadRecord,
  requireString,
  requireStringArray,
  requireTrue,
} from './validation-primitives.js'

export interface ValidationIssue {
  path: string
  code: string
  message: string
}

export class InvocationSpecValidationError extends Error {
  readonly code = 'INVALID_INVOCATION_SPEC'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid harness invocation spec')
    this.name = 'InvocationSpecValidationError'
    this.issues = issues
  }
}

export class InvocationInputValidationError extends Error {
  readonly code = 'INVALID_INVOCATION_INPUT'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid invocation input')
    this.name = 'InvocationInputValidationError'
    this.issues = issues
  }
}

export class InvocationStartRequestValidationError extends Error {
  readonly code = 'INVALID_INVOCATION_START_REQUEST'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid invocation start request')
    this.name = 'InvocationStartRequestValidationError'
    this.issues = issues
  }
}

export class InvocationDispatchRequestValidationError extends Error {
  readonly code = 'INVALID_INVOCATION_DISPATCH_REQUEST'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid invocation dispatch request')
    this.name = 'InvocationDispatchRequestValidationError'
    this.issues = issues
  }
}

export class PermissionRequestParamsValidationError extends Error {
  readonly code = 'INVALID_PERMISSION_REQUEST_PARAMS'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid permission request params')
    this.name = 'PermissionRequestParamsValidationError'
    this.issues = issues
  }
}

export class CommandValidationError extends Error {
  readonly code = 'INVALID_COMMAND'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid broker command')
    this.name = 'CommandValidationError'
    this.issues = issues
  }
}

export class EventEnvelopeValidationError extends Error {
  readonly code = 'INVALID_EVENT_ENVELOPE'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid invocation event envelope')
    this.name = 'EventEnvelopeValidationError'
    this.issues = issues
  }
}

export type SchemaRecord = Record<string, unknown> & {
  approvalPolicy?: unknown
  args?: unknown
  capabilities?: unknown
  clientInfo?: unknown
  cols?: unknown
  command?: unknown
  continuation?: unknown
  content?: unknown
  correlation?: unknown
  cwd?: unknown
  defaultImageAttachments?: unknown
  driver?: unknown
  env?: unknown
  dispatchEnv?: unknown
  frontend?: unknown
  harness?: unknown
  harnessTransport?: unknown
  inputQueue?: unknown
  input?: unknown
  inputId?: unknown
  interaction?: unknown
  invocationId?: unknown
  key?: unknown
  kind?: unknown
  labels?: unknown
  launch?: unknown
  limits?: unknown
  lockedEnv?: unknown
  maxEventBytes?: unknown
  metadata?: unknown
  mimeType?: unknown
  mode?: unknown
  model?: unknown
  modelReasoningEffort?: unknown
  name?: unknown
  path?: unknown
  pathPrepend?: unknown
  permissionRequests?: unknown
  permissionPolicy?: unknown
  policy?: unknown
  paneId?: unknown
  probeDrivers?: unknown
  process?: unknown
  profile?: unknown
  provider?: unknown
  protocolVersions?: unknown
  reason?: unknown
  resumeFallback?: unknown
  resumeThreadId?: unknown
  rows?: unknown
  sandboxMode?: unknown
  seq?: unknown
  sessionName?: unknown
  spec?: unknown
  specVersion?: unknown
  socketPath?: unknown
  startupTimeoutMs?: unknown
  stopGraceMs?: unknown
  text?: unknown
  timeoutMs?: unknown
  time?: unknown
  turnConcurrency?: unknown
  turnTimeoutMs?: unknown
  type?: unknown
  version?: unknown
  whenBusy?: unknown
  eventAcks?: unknown
  graceMs?: unknown
  initialInput?: unknown
  lifecyclePolicy?: unknown
  policyHash?: unknown
  policyId?: unknown
  schemaVersion?: unknown
  retention?: unknown
  harnessRecovery?: unknown
  turnRetry?: unknown
  idleTtlMs?: unknown
  retire?: unknown
  onTimeout?: unknown
  stallDetection?: unknown
  escalation?: unknown
  maxGenerationsPerInvocation?: unknown
  activeTurnDisposition?: unknown
  recycle?: unknown
  onRecoveryFailure?: unknown
  healthProbe?: unknown
  noProgressMs?: unknown
  minTurnAgeMs?: unknown
  killGraceMs?: unknown
  killProcessTree?: unknown
  restartFrom?: unknown
  requireContinuation?: unknown
  maxAttempts?: unknown
  retryOn?: unknown
  requires?: unknown
  identity?: unknown
  semantics?: unknown
  onUnsafe?: unknown
  generation?: unknown
  harnessGeneration?: unknown
  turnAttempt?: unknown
  fromGeneration?: unknown
  toGeneration?: unknown
  ready?: unknown
  fromAttempt?: unknown
  toAttempt?: unknown
  fromHarnessGeneration?: unknown
  toHarnessGeneration?: unknown
  thresholdMs?: unknown
  requestedAction?: unknown
  permissionRequestId?: unknown
  startRequest?: unknown
  scope?: unknown
  runtimeId?: unknown
  hostSessionId?: unknown
  startRequestHash?: unknown
  selectedProfileHash?: unknown
  controllerInstanceId?: unknown
  attachToken?: unknown
  lastProjectedSeq?: unknown
  clientCapabilities?: unknown
  afterSeq?: unknown
  live?: unknown
  throughSeq?: unknown
  decision?: unknown
  message?: unknown
}

const brokerMethods = new Set<BrokerMethod>([
  'broker.hello',
  'broker.health',
  'broker.attach',
  'invocation.start',
  'invocation.input',
  'invocation.interrupt',
  'invocation.stop',
  'invocation.status',
  'invocation.dispose',
  'invocation.eventsSince',
  'invocation.ackEvents',
  'invocation.snapshot',
  'invocation.permission.respond',
])

const eventTypes = new Set<InvocationEventType>([
  'invocation.started',
  'invocation.ready',
  'invocation.stopping',
  'invocation.exited',
  'invocation.failed',
  'invocation.disposed',
  'lifecycle.policy.accepted',
  'lifecycle.escalation',
  'harness.started',
  'harness.exited',
  'harness.recovery.started',
  'harness.recovery.completed',
  'harness.recovery.failed',
  'continuation.updated',
  'continuation.cleared',
  'input.accepted',
  'input.rejected',
  'input.queued',
  'turn.started',
  'turn.stalled',
  'turn.retry',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'assistant.message.started',
  'assistant.message.delta',
  'assistant.message.completed',
  'tool.call.started',
  'tool.call.delta',
  'tool.call.completed',
  'tool.call.failed',
  'usage.updated',
  'diagnostic',
  'driver.notice',
  'terminal.surface.reported',
  'permission.requested',
  'permission.resolved',
  'permission.cancelled',
])

export function validateInvocationSpec(value: unknown): HarnessInvocationSpec {
  const issues: ValidationIssue[] = []
  validateSpec(value, issues)
  if (issues.length > 0) {
    throw new InvocationSpecValidationError(issues)
  }
  return value as HarnessInvocationSpec
}

export function validateInvocationInput(value: unknown): InvocationInput {
  const issues: ValidationIssue[] = []
  validateInvocationInputShape(value, '', issues)
  if (issues.length > 0) {
    throw new InvocationInputValidationError(issues)
  }
  return value as InvocationInput
}

export function validateInvocationStartRequest(value: unknown): InvocationStartRequest {
  const issues: ValidationIssue[] = []
  const request = asRecord(value)
  if (!request) {
    issues.push(issue('', 'invalid_type', 'Invocation start request must be an object'))
  } else {
    validateSpec(request.spec, issues, 'spec')
    if (request.initialInput !== undefined) {
      validateInvocationInputShape(request.initialInput, 'initialInput', issues)
    }
    rejectStaleStartRequestRuntime(request, '', issues)
  }
  if (issues.length > 0) {
    throw new InvocationStartRequestValidationError(issues)
  }
  return value as InvocationStartRequest
}

export function validateInvocationDispatchRequest(value: unknown): InvocationDispatchRequest {
  const issues: ValidationIssue[] = []
  validateInvocationDispatchRequestShape(value, '', issues)
  if (issues.length > 0) {
    throw new InvocationDispatchRequestValidationError(issues)
  }
  return value as InvocationDispatchRequest
}

export function validatePermissionRequestParams(value: unknown): PermissionRequestParams {
  const issues: ValidationIssue[] = []
  validatePermissionRequestParamsShape(value, '', issues)
  if (issues.length > 0) {
    throw new PermissionRequestParamsValidationError(issues)
  }
  return value as PermissionRequestParams
}

export function validateCommand(value: unknown): BrokerCommand {
  const issues: ValidationIssue[] = []
  if (!isJsonRpcRequest(value)) {
    issues.push(issue('', 'invalid_jsonrpc_request', 'Command must be a JSON-RPC request'))
  } else if (!brokerMethods.has(value.method as BrokerMethod)) {
    issues.push(issue('method', 'unknown_method', 'Unsupported broker method'))
  } else {
    validateCommandParams(value.method as BrokerMethod, value.params, issues)
  }

  if (issues.length > 0) {
    throw new CommandValidationError(issues)
  }
  return value as BrokerCommand
}

export function validateEventEnvelope(value: unknown): InvocationEventEnvelope {
  const issues: ValidationIssue[] = []
  const envelope = asRecord(value)
  if (!envelope) {
    issues.push(issue('', 'invalid_type', 'Event envelope must be an object'))
  } else {
    requireString(envelope.invocationId, 'invocationId', issues)
    requireNumber(envelope.seq, 'seq', issues)
    requireString(envelope.time, 'time', issues)
    if (
      typeof envelope.type !== 'string' ||
      !eventTypes.has(envelope.type as InvocationEventType)
    ) {
      issues.push(issue('type', 'invalid_event_type', 'Unsupported event type'))
    }
    if (!Object.hasOwn(envelope, 'payload')) {
      issues.push(issue('payload', 'required', 'payload is required'))
    } else if (typeof envelope.type === 'string') {
      const driverKind = asRecord(envelope['driver'])?.['kind']
      validateOptionalPositiveInteger(envelope['harnessGeneration'], 'harnessGeneration', issues)
      validateOptionalPositiveInteger(envelope['turnAttempt'], 'turnAttempt', issues)
      validateEventPayload(envelope.type as InvocationEventType, envelope['payload'], issues, {
        driverKind: typeof driverKind === 'string' ? driverKind : undefined,
      })
    }
  }

  if (issues.length > 0) {
    throw new EventEnvelopeValidationError(issues)
  }
  return value as InvocationEventEnvelope
}

function validateSpec(value: unknown, issues: ValidationIssue[], prefix = ''): void {
  const spec = asRecord(value)
  if (!spec) {
    issues.push(issue(prefix, 'invalid_type', 'Spec must be an object'))
    return
  }

  if (spec.specVersion !== 'harness-broker.invocation/v1') {
    issues.push(issue(path(prefix, 'specVersion'), 'invalid_literal', 'Unsupported specVersion'))
  }
  if (Object.hasOwn(spec, 'lifecyclePolicy')) {
    issues.push(
      issue(
        path(prefix, 'lifecyclePolicy'),
        'stale_lifecycle_overlay',
        'spec.lifecyclePolicy is not accepted; put lifecyclePolicy on the InvocationDispatchRequest envelope'
      )
    )
  }

  validateStringRecord(spec.labels, path(prefix, 'labels'), issues, false)
  validateStringRecord(spec.correlation, path(prefix, 'correlation'), issues, false)

  const harness = asRecord(spec.harness)
  if (!harness) {
    issues.push(issue(path(prefix, 'harness'), 'required', 'harness is required'))
  } else {
    requireString(harness.frontend, path(prefix, 'harness.frontend'), issues)
    requireString(harness.driver, path(prefix, 'harness.driver'), issues)
    if (harness.provider !== undefined && typeof harness.provider !== 'string') {
      issues.push(
        issue(path(prefix, 'harness.provider'), 'invalid_type', 'provider must be a string')
      )
    }
  }

  const process = asRecord(spec.process)
  if (!process) {
    issues.push(issue(path(prefix, 'process'), 'required', 'process is required'))
  } else {
    requireString(process.command, path(prefix, 'process.command'), issues)
    requireStringArray(process.args, path(prefix, 'process.args'), issues)
    requireString(process.cwd, path(prefix, 'process.cwd'), issues)
    validateEnv(process.lockedEnv, path(prefix, 'process.lockedEnv'), issues, 'lockedEnv')
    optionalStringArray(process.pathPrepend, path(prefix, 'process.pathPrepend'), issues)
    validateHarnessTransport(
      process.harnessTransport,
      path(prefix, 'process.harnessTransport'),
      issues
    )
    validateProcessLimits(process.limits, path(prefix, 'process.limits'), issues)
  }

  validateInteraction(spec.interaction, path(prefix, 'interaction'), issues)
  validateContinuation(spec.continuation, path(prefix, 'continuation'), issues)

  const driver = asRecord(spec.driver)
  if (!driver) {
    issues.push(issue(path(prefix, 'driver'), 'required', 'driver is required'))
  } else {
    requireString(driver.kind, path(prefix, 'driver.kind'), issues)
    if (
      typeof harness?.driver === 'string' &&
      typeof driver.kind === 'string' &&
      harness.driver !== driver.kind
    ) {
      issues.push(
        issue(
          path(prefix, 'harness.driver'),
          'invalid_driver',
          'harness.driver must match driver.kind'
        )
      )
    }
    if (driver.kind === 'codex-app-server') {
      validateCodexDriver(driver, path(prefix, 'driver'), issues)
    }
  }

  validateLaunch(spec.launch, path(prefix, 'launch'), issues)
}

function validateLaunch(value: unknown, prefix: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const launch = asRecord(value)
  if (!launch) {
    issues.push(issue(prefix, 'invalid_type', 'launch must be an object'))
    return
  }
  const systemPromptFile = launch['systemPromptFile']
  const systemPromptMode = launch['systemPromptMode']
  const initialPrompt = launch['initialPrompt']
  if (systemPromptFile !== undefined && typeof systemPromptFile !== 'string') {
    issues.push(
      issue(path(prefix, 'systemPromptFile'), 'invalid_type', 'systemPromptFile must be a string')
    )
  }
  if (
    systemPromptMode !== undefined &&
    systemPromptMode !== 'append' &&
    systemPromptMode !== 'replace'
  ) {
    issues.push(
      issue(
        path(prefix, 'systemPromptMode'),
        'invalid_literal',
        'systemPromptMode must be "append" or "replace"'
      )
    )
  }
  if (initialPrompt !== undefined && typeof initialPrompt !== 'string') {
    issues.push(
      issue(path(prefix, 'initialPrompt'), 'invalid_type', 'initialPrompt must be a string')
    )
  }
}

function validateCommandParams(
  method: BrokerMethod,
  params: unknown,
  issues: ValidationIssue[]
): void {
  if (method === 'broker.health') {
    if (params !== undefined) {
      const health = asRecord(params)
      if (!health) {
        issues.push(issue('params', 'invalid_type', 'params must be an object'))
      } else if (health.probeDrivers !== undefined && typeof health.probeDrivers !== 'boolean') {
        issues.push(issue('params.probeDrivers', 'invalid_type', 'probeDrivers must be a boolean'))
      }
    }
    return
  }

  const commandParams = asRecord(params)
  if (!commandParams) {
    issues.push(issue('params', 'required', 'params is required'))
    return
  }

  switch (method) {
    case 'broker.hello':
      validateBrokerHelloParams(commandParams, issues)
      return
    case 'broker.attach':
      requireString(commandParams.runtimeId, 'params.runtimeId', issues)
      requireString(commandParams.hostSessionId, 'params.hostSessionId', issues)
      requireNumber(commandParams.generation, 'params.generation', issues)
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      requireString(commandParams.startRequestHash, 'params.startRequestHash', issues)
      requireString(commandParams.selectedProfileHash, 'params.selectedProfileHash', issues)
      requireString(commandParams.controllerInstanceId, 'params.controllerInstanceId', issues)
      requireString(commandParams.attachToken, 'params.attachToken', issues)
      optionalNumber(commandParams.lastProjectedSeq, 'params.lastProjectedSeq', issues)
      validateClientCapabilities(
        commandParams.clientCapabilities,
        'params.clientCapabilities',
        issues
      )
      return
    case 'invocation.start':
      validateInvocationDispatchRequestShape(commandParams, 'params', issues)
      return
    case 'invocation.input':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      validateInvocationInputShape(commandParams.input, 'params.input', issues)
      validateInputPolicy(commandParams.policy, 'params.policy', issues)
      return
    case 'invocation.interrupt':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      optionalEnum(commandParams.scope, ['turn', 'invocation'], 'params.scope', issues, true)
      optionalString(commandParams.reason, 'params.reason', issues)
      optionalNumber(commandParams.graceMs, 'params.graceMs', issues)
      return
    case 'invocation.stop':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      optionalString(commandParams.reason, 'params.reason', issues)
      optionalNumber(commandParams.graceMs, 'params.graceMs', issues)
      return
    case 'invocation.status':
    case 'invocation.dispose':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      return
    case 'invocation.eventsSince':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      requireNumber(commandParams.afterSeq, 'params.afterSeq', issues)
      optionalBoolean(commandParams.live, 'params.live', issues)
      return
    case 'invocation.ackEvents':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      requireNumber(commandParams.throughSeq, 'params.throughSeq', issues)
      requireString(commandParams.controllerInstanceId, 'params.controllerInstanceId', issues)
      return
    case 'invocation.snapshot':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      return
    case 'invocation.permission.respond':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      requireString(commandParams.permissionRequestId, 'params.permissionRequestId', issues)
      optionalEnum(commandParams.decision, ['allow', 'deny'], 'params.decision', issues, true)
      optionalString(commandParams.controllerInstanceId, 'params.controllerInstanceId', issues)
      optionalString(commandParams.message, 'params.message', issues)
      return
  }
}

function validatePermissionRequestParamsShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = asRecord(value)
  if (!params) {
    issues.push(issue(basePath, 'invalid_type', 'Permission request params must be an object'))
    return
  }

  requireString(params.invocationId, path(basePath, 'invocationId'), issues)
  optionalString(params['turnId'], path(basePath, 'turnId'), issues)
  validateOptionalPositiveInteger(
    params['harnessGeneration'],
    path(basePath, 'harnessGeneration'),
    issues
  )
  validateOptionalPositiveInteger(params['turnAttempt'], path(basePath, 'turnAttempt'), issues)
  requireString(params['permissionRequestId'], path(basePath, 'permissionRequestId'), issues)
  requireString(params.kind, path(basePath, 'kind'), issues)
  if (!Object.hasOwn(params, 'subject')) {
    issues.push(issue(path(basePath, 'subject'), 'required', 'subject is required'))
  }
  optionalEnum(
    params['defaultDecision'],
    ['allow', 'deny'],
    path(basePath, 'defaultDecision'),
    issues,
    true
  )
  optionalNumber(params['deadlineMs'], path(basePath, 'deadlineMs'), issues)
}

function validateInvocationDispatchRequestShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = asRecord(value)
  if (!request) {
    issues.push(issue(basePath, 'invalid_type', 'Invocation dispatch request must be an object'))
    return
  }

  const startRequest = asRecord(request.startRequest)
  if (!startRequest) {
    issues.push(issue(path(basePath, 'startRequest'), 'required', 'startRequest is required'))
  } else {
    const startPath = path(basePath, 'startRequest')
    validateSpec(startRequest.spec, issues, path(startPath, 'spec'))
    if (startRequest.initialInput !== undefined) {
      validateInvocationInputShape(
        startRequest.initialInput,
        path(startPath, 'initialInput'),
        issues
      )
    }
    rejectStaleStartRequestRuntime(startRequest, startPath, issues)
  }

  const lockedEnv =
    asRecord(startRequest?.spec)?.process !== undefined
      ? asRecord(asRecord(startRequest?.spec)?.process)?.lockedEnv
      : undefined
  validateEnv(request.dispatchEnv, path(basePath, 'dispatchEnv'), issues, 'dispatchEnv', lockedEnv)
  validateDispatchRuntime(request, basePath, issues)
  if (request.lifecyclePolicy !== undefined) {
    validateLifecyclePolicyOverlay(
      request.lifecyclePolicy,
      path(basePath, 'lifecyclePolicy'),
      issues
    )
  }
}

function validateLifecyclePolicyOverlay(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(issue(basePath, 'invalid_type', 'lifecyclePolicy must be an object'))
    return
  }

  optionalEnum(
    policy.schemaVersion,
    ['harness-broker.lifecycle-policy/v1'],
    path(basePath, 'schemaVersion'),
    issues,
    true
  )
  requireString(policy.policyId, path(basePath, 'policyId'), issues)
  requireString(policy.policyHash, path(basePath, 'policyHash'), issues)
  validateRuntimeRetentionPolicy(policy.retention, path(basePath, 'retention'), issues)
  validateHarnessRecoveryPolicy(policy.harnessRecovery, path(basePath, 'harnessRecovery'), issues)
  validateTurnRetryPolicy(policy.turnRetry, path(basePath, 'turnRetry'), issues)

  if (typeof policy.policyHash === 'string') {
    let expected: string | undefined
    try {
      expected = lifecyclePolicyHash(policy as BrokerLifecyclePolicyOverlay)
    } catch {
      expected = undefined
    }
    if (expected !== undefined && policy.policyHash !== expected) {
      issues.push(
        issue(
          path(basePath, 'policyHash'),
          'lifecycle_policy_hash_mismatch',
          'lifecyclePolicy.policyHash must match canonical policy JSON excluding policyHash'
        )
      )
    }
  }
}

function validateRuntimeRetentionPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(issue(basePath, 'required', 'retention is required'))
    return
  }
  optionalEnum(
    policy.mode,
    ['keep-alive', 'idle-ttl', 'unmanaged'],
    path(basePath, 'mode'),
    issues,
    true
  )
  if (policy.mode === 'idle-ttl') {
    requireNumber(policy.idleTtlMs, path(basePath, 'idleTtlMs'), issues)
    const retire = asRecord(policy.retire)
    if (!retire) {
      issues.push(issue(path(basePath, 'retire'), 'required', 'retention.retire is required'))
    } else {
      optionalEnum(retire.mode, ['driver-retire'], path(basePath, 'retire.mode'), issues, true)
      requireNumber(retire.graceMs, path(basePath, 'retire.graceMs'), issues)
      optionalEnum(
        retire.onTimeout,
        ['fail-invocation', 'escalate-hard-reap'],
        path(basePath, 'retire.onTimeout'),
        issues,
        true
      )
    }
  }
  if (policy.mode === 'unmanaged') {
    requireString(policy.reason, path(basePath, 'reason'), issues)
  }
}

function validateHarnessRecoveryPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(issue(basePath, 'required', 'harnessRecovery is required'))
    return
  }
  optionalEnum(
    policy.mode,
    ['none', 'fail-and-escalate', 'recycle-child'],
    path(basePath, 'mode'),
    issues,
    true
  )
  if (policy.mode === 'fail-and-escalate') {
    if (policy.stallDetection !== undefined) {
      validateStallDetectionPolicy(policy.stallDetection, path(basePath, 'stallDetection'), issues)
    }
    optionalEnum(
      policy.escalation,
      ['fail-turn', 'fail-invocation', 'escalate-hard-reap'],
      path(basePath, 'escalation'),
      issues,
      true
    )
  }
  if (policy.mode === 'recycle-child') {
    requireNumber(
      policy.maxGenerationsPerInvocation,
      path(basePath, 'maxGenerationsPerInvocation'),
      issues
    )
    optionalEnum(
      policy.activeTurnDisposition,
      ['fail-before-recycle', 'escalate-only'],
      path(basePath, 'activeTurnDisposition'),
      issues,
      true
    )
    validateStallDetectionPolicy(policy.stallDetection, path(basePath, 'stallDetection'), issues)
    const recycle = asRecord(policy.recycle)
    if (!recycle) {
      issues.push(
        issue(path(basePath, 'recycle'), 'required', 'harnessRecovery.recycle is required')
      )
    } else {
      optionalEnum(
        recycle['mechanism'],
        ['capability-selected', 'in-pane-runner', 'direct-child'],
        path(basePath, 'recycle.mechanism'),
        issues,
        true
      )
      requireNumber(recycle['killGraceMs'], path(basePath, 'recycle.killGraceMs'), issues)
      if (typeof recycle['killProcessTree'] !== 'boolean') {
        issues.push(
          issue(
            path(basePath, 'recycle.killProcessTree'),
            recycle['killProcessTree'] === undefined ? 'required' : 'invalid_type',
            'harnessRecovery.recycle.killProcessTree must be a boolean'
          )
        )
      }
      optionalEnum(
        recycle['restartFrom'],
        ['latest-continuation'],
        path(basePath, 'recycle.restartFrom'),
        issues,
        true
      )
      if (typeof recycle['requireContinuation'] !== 'boolean') {
        issues.push(
          issue(
            path(basePath, 'recycle.requireContinuation'),
            recycle['requireContinuation'] === undefined ? 'required' : 'invalid_type',
            'harnessRecovery.recycle.requireContinuation must be a boolean'
          )
        )
      }
    }
    optionalEnum(
      policy.onRecoveryFailure,
      ['fail-invocation', 'escalate-hard-reap'],
      path(basePath, 'onRecoveryFailure'),
      issues,
      true
    )
  }
}

function validateStallDetectionPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(issue(basePath, 'required', 'stallDetection is required'))
    return
  }
  optionalEnum(
    policy.mode,
    ['disabled', 'no-progress-plus-health'],
    path(basePath, 'mode'),
    issues,
    true
  )
  if (policy.mode === 'no-progress-plus-health') {
    requireNumber(policy.noProgressMs, path(basePath, 'noProgressMs'), issues)
    optionalNumber(policy.minTurnAgeMs, path(basePath, 'minTurnAgeMs'), issues)
    optionalEnum(
      policy.healthProbe,
      ['runner-status', 'driver-status', 'native-heartbeat'],
      path(basePath, 'healthProbe'),
      issues,
      true
    )
  }
}

function validateTurnRetryPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(issue(basePath, 'required', 'turnRetry is required'))
    return
  }
  optionalEnum(policy.mode, ['none', 'safe-retry'], path(basePath, 'mode'), issues, true)
  if (policy.mode !== 'safe-retry') return
  requireNumber(policy.maxAttempts, path(basePath, 'maxAttempts'), issues)
  validateEnumArray(
    policy.retryOn,
    ['harness-stalled', 'harness-crashed'],
    path(basePath, 'retryOn'),
    issues
  )
  const requires = asRecord(policy.requires)
  if (!requires) {
    issues.push(issue(path(basePath, 'requires'), 'required', 'turnRetry.requires is required'))
  } else {
    requireTrue(
      requires['noToolCallObserved'],
      path(basePath, 'requires.noToolCallObserved'),
      issues
    )
    requireTrue(
      requires['noPermissionRequestPending'],
      path(basePath, 'requires.noPermissionRequestPending'),
      issues
    )
    if (requires['noPermissionRequestObserved'] !== undefined) {
      requireTrue(
        requires['noPermissionRequestObserved'],
        path(basePath, 'requires.noPermissionRequestObserved'),
        issues
      )
    }
    requireTrue(
      requires['noAssistantFinalObserved'],
      path(basePath, 'requires.noAssistantFinalObserved'),
      issues
    )
    requireTrue(
      requires['noExternalMutationObserved'],
      path(basePath, 'requires.noExternalMutationObserved'),
      issues
    )
    requireTrue(requires['continuationKnown'], path(basePath, 'requires.continuationKnown'), issues)
    requireTrue(
      requires['driverCanProvePriorTurnIncomplete'],
      path(basePath, 'requires.driverCanProvePriorTurnIncomplete'),
      issues
    )
  }
  const identity = asRecord(policy.identity)
  if (!identity) {
    issues.push(issue(path(basePath, 'identity'), 'required', 'turnRetry.identity is required'))
  } else {
    optionalEnum(identity['inputId'], ['same'], path(basePath, 'identity.inputId'), issues, true)
    optionalEnum(
      identity['logicalTurnId'],
      ['same'],
      path(basePath, 'identity.logicalTurnId'),
      issues,
      true
    )
    optionalEnum(
      identity['turnAttempt'],
      ['increment'],
      path(basePath, 'identity.turnAttempt'),
      issues,
      true
    )
  }
  optionalEnum(policy.semantics, ['at-least-once'], path(basePath, 'semantics'), issues, true)
  optionalEnum(policy.onUnsafe, ['fail-turn'], path(basePath, 'onUnsafe'), issues, true)
}

/**
 * tmux id shape rules — enforced at the protocol layer so consumers can rely
 * on the lease carrying canonical tmux ids without re-parsing.
 *
 *   - sessionId: tmux session ids look like `$3`
 *   - windowId:  tmux window  ids look like `@7`
 *   - paneId:    tmux pane    ids look like `%12`
 */
const TMUX_SESSION_ID_PATTERN = /^\$\d+$/
const TMUX_WINDOW_ID_PATTERN = /^@\d+$/
const TMUX_PANE_ID_PATTERN = /^%\d+$/

/**
 * Spec §3.3 dispatch-time contract: a `claude-code-tmux` / `codex-cli-tmux`
 * dispatch MUST carry a runtime-owned terminal surface on the dispatch
 * envelope. The compiled profile emits launch INTENT only — the concrete
 * tmux server socket and pane are runtime allocations supplied by HRC (or
 * the pre-HRC harness stand-in) at dispatch time. The driver attaches to
 * this socket / pane; it never owns the server.
 *
 * Two shapes are accepted during the Phase A→D migration:
 *
 *   - NEW: `runtime.terminalSurface` carries a full `tmux-pane` lease with
 *     pane coordinates and an `allowedOps` capability scope. Driver code
 *     (Phase C/D) reads ONLY this field.
 *   - LEGACY: `runtime.tmux.socketPath` is a bare runtime-owned tmux server
 *     socket. Accepted unchanged for backward compatibility.
 *
 * If BOTH are present, `terminalSurface` wins at runtime (downstream
 * consumers prefer the lease); the protocol layer accepts both without
 * raising a conflict issue, leaving the wire format permissive during
 * migration. NO stdout/stderr deprecation diagnostics are emitted — broker
 * stdio is the wire protocol.
 */
function validateDispatchRuntime(
  dispatchRequest: Record<string, unknown>,
  dispatchPath: string,
  issues: ValidationIssue[]
): void {
  const startRequest = asRecord(dispatchRequest['startRequest'])
  const driverKind = asRecord(asRecord(startRequest?.['spec'])?.['harness'])?.['driver']
  const runtimePath = path(dispatchPath, 'runtime')
  const runtime = asRecord(dispatchRequest['runtime'])
  if (dispatchRequest['runtime'] !== undefined && !runtime) {
    issues.push(issue(runtimePath, 'invalid_type', 'runtime must be an object'))
    return
  }

  if (runtime?.['tmux'] !== undefined) {
    const tmux = asRecord(runtime['tmux'])
    if (!tmux) {
      issues.push(issue(path(runtimePath, 'tmux'), 'invalid_type', 'tmux must be an object'))
      return
    }
    if (typeof tmux['socketPath'] !== 'string' || tmux['socketPath'].length === 0) {
      issues.push(
        issue(
          path(runtimePath, 'tmux.socketPath'),
          'required',
          'runtime tmux socketPath must be a non-empty string'
        )
      )
    }
  }

  // Validate `runtime.terminalSurface` whenever it is present, regardless of
  // driver kind. (Protocol layer rejects malformed leases up-front.)
  const terminalSurfaceRaw = runtime?.['terminalSurface']
  let terminalSurfaceLooksValid = false
  if (terminalSurfaceRaw !== undefined) {
    terminalSurfaceLooksValid = validateTerminalSurfaceLease(
      terminalSurfaceRaw,
      path(runtimePath, 'terminalSurface'),
      issues
    )
  }

  if (driverKind !== 'claude-code-tmux' && driverKind !== 'codex-cli-tmux') {
    return
  }

  const tmux = runtime ? asRecord(runtime['tmux']) : undefined
  const legacyShimSatisfied =
    !!tmux && typeof tmux['socketPath'] === 'string' && tmux['socketPath'].length > 0

  if (!legacyShimSatisfied && terminalSurfaceRaw === undefined) {
    issues.push(
      issue(
        path(runtimePath, 'terminalSurface'),
        'required',
        `${driverKind} dispatch requires either runtime.terminalSurface (tmux-pane lease) or legacy runtime.tmux.socketPath`
      )
    )
    return
  }

  // If neither the legacy shim nor a well-formed lease is present, the
  // detailed lease issues already emitted by validateTerminalSurfaceLease
  // cover the rejection. No extra issue needed.
  void terminalSurfaceLooksValid
}

/**
 * Validate a `runtime.terminalSurface` pane lease. Returns true when the
 * lease shape is well-formed (kind/ownership/ids/allowedOps all valid).
 * Issues are pushed onto the shared list; the boolean is for callers that
 * need to know whether downstream tmux drivers can rely on the lease.
 */
function validateTerminalSurfaceLease(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): boolean {
  const surface = asRecord(value)
  if (!surface) {
    issues.push(issue(basePath, 'invalid_type', 'terminalSurface must be an object'))
    return false
  }

  let ok = true

  if (surface['kind'] !== 'tmux-pane') {
    issues.push(
      issue(path(basePath, 'kind'), 'invalid_literal', "terminalSurface.kind must be 'tmux-pane'")
    )
    ok = false
  }
  if (surface['ownership'] !== 'hrc') {
    issues.push(
      issue(
        path(basePath, 'ownership'),
        'invalid_literal',
        "terminalSurface.ownership must be 'hrc'"
      )
    )
    ok = false
  }

  const socketPath = surface['socketPath']
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    issues.push(
      issue(
        path(basePath, 'socketPath'),
        'required',
        'terminalSurface.socketPath must be a non-empty string'
      )
    )
    ok = false
  }

  const validateTmuxId = (
    fieldName: 'sessionId' | 'windowId' | 'paneId',
    pattern: RegExp
  ): void => {
    const raw = surface[fieldName]
    if (typeof raw !== 'string' || raw.length === 0) {
      issues.push(
        issue(
          path(basePath, fieldName),
          'required',
          `terminalSurface.${fieldName} must be a non-empty string`
        )
      )
      ok = false
      return
    }
    if (!pattern.test(raw)) {
      issues.push(
        issue(
          path(basePath, fieldName),
          'invalid_tmux_id',
          `terminalSurface.${fieldName} must match ${String(pattern)}`
        )
      )
      ok = false
    }
  }

  validateTmuxId('sessionId', TMUX_SESSION_ID_PATTERN)
  validateTmuxId('windowId', TMUX_WINDOW_ID_PATTERN)
  validateTmuxId('paneId', TMUX_PANE_ID_PATTERN)

  optionalString(surface['sessionName'], path(basePath, 'sessionName'), issues)
  optionalString(surface['windowName'], path(basePath, 'windowName'), issues)

  const allowedOps = asRecord(surface['allowedOps'])
  const allowedOpsPath = path(basePath, 'allowedOps')
  if (!allowedOps) {
    issues.push(issue(allowedOpsPath, 'required', 'terminalSurface.allowedOps is required'))
    ok = false
  } else {
    requireTrue(allowedOps['inspect'], path(allowedOpsPath, 'inspect'), issues)
    requireTrue(allowedOps['sendInput'], path(allowedOpsPath, 'sendInput'), issues)
    requireTrue(allowedOps['sendInterrupt'], path(allowedOpsPath, 'sendInterrupt'), issues)
    optionalBoolean(allowedOps['capture'], path(allowedOpsPath, 'capture'), issues)
    optionalBoolean(allowedOps['resize'], path(allowedOpsPath, 'resize'), issues)
    if (
      allowedOps['inspect'] !== true ||
      allowedOps['sendInput'] !== true ||
      allowedOps['sendInterrupt'] !== true
    ) {
      ok = false
    }
  }

  return ok
}

function rejectStaleStartRequestRuntime(
  startRequest: Record<string, unknown>,
  startPath: string,
  issues: ValidationIssue[]
): void {
  if (Object.hasOwn(startRequest, 'runtime')) {
    issues.push(
      issue(
        path(startPath, 'runtime'),
        'stale_runtime_overlay',
        'startRequest.runtime is no longer accepted; put runtime on the InvocationDispatchRequest envelope'
      )
    )
  }
  if (Object.hasOwn(startRequest, 'lifecyclePolicy')) {
    issues.push(
      issue(
        path(startPath, 'lifecyclePolicy'),
        'stale_lifecycle_overlay',
        'startRequest.lifecyclePolicy is not accepted; put lifecyclePolicy on the InvocationDispatchRequest envelope'
      )
    )
  }
}

interface EventPayloadContext {
  driverKind?: string | undefined
}

function validateEventPayload(
  eventType: InvocationEventType,
  value: unknown,
  issues: ValidationIssue[],
  context: EventPayloadContext = {}
): void {
  switch (eventType) {
    case 'lifecycle.policy.accepted': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireString(payload['policyId'], 'payload.policyId', issues)
      requireString(payload['policyHash'], 'payload.policyHash', issues)
      optionalEnum(
        payload['retentionMode'],
        ['keep-alive', 'idle-ttl', 'unmanaged'],
        'payload.retentionMode',
        issues,
        true
      )
      optionalEnum(
        payload['harnessRecoveryMode'],
        ['none', 'fail-and-escalate', 'recycle-child'],
        'payload.harnessRecoveryMode',
        issues,
        true
      )
      optionalEnum(
        payload['turnRetryMode'],
        ['none', 'safe-retry'],
        'payload.turnRetryMode',
        issues,
        true
      )
      return
    }
    case 'lifecycle.escalation': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      optionalEnum(
        payload.reason,
        [
          'idle-retire-timeout',
          'recycle-failed',
          'runner-unresponsive',
          'retry-exhausted',
          'broker-degraded',
        ],
        'payload.reason',
        issues,
        true
      )
      optionalEnum(
        payload['requestedAction'],
        ['hard-reap', 'operator-attention'],
        'payload.requestedAction',
        issues,
        true
      )
      validateOptionalPositiveInteger(
        payload['harnessGeneration'],
        'payload.harnessGeneration',
        issues
      )
      optionalString(payload['inputId'], 'payload.inputId', issues)
      optionalString(payload['turnId'], 'payload.turnId', issues)
      validateOptionalPositiveInteger(payload['turnAttempt'], 'payload.turnAttempt', issues)
      optionalString(payload['policyHash'], 'payload.policyHash', issues)
      return
    }
    case 'harness.started': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      validateRequiredPositiveInteger(payload.generation, 'payload.generation', issues)
      optionalEnum(payload.mode, ['initial', 'recycle'], 'payload.mode', issues, true)
      optionalEnum(
        payload['mechanism'],
        ['in-pane-runner', 'direct-child'],
        'payload.mechanism',
        issues,
        true
      )
      optionalNumber(payload['pid'], 'payload.pid', issues)
      optionalString(payload['argvHash'], 'payload.argvHash', issues)
      optionalString(payload['controlSocketId'], 'payload.controlSocketId', issues)
      return
    }
    case 'harness.exited': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      validateRequiredPositiveInteger(payload.generation, 'payload.generation', issues)
      optionalEnum(
        payload.reason,
        ['idle-retire', 'operator-stop', 'crash', 'recycle-kill', 'process-exit', 'runner-exit'],
        'payload.reason',
        issues,
        true
      )
      if (payload['exitCode'] !== null) {
        optionalNumber(payload['exitCode'], 'payload.exitCode', issues)
      }
      optionalString(payload['signal'], 'payload.signal', issues)
      return
    }
    case 'harness.recovery.started': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      validateRequiredPositiveInteger(payload['fromGeneration'], 'payload.fromGeneration', issues)
      optionalEnum(
        payload.reason,
        ['child-exit', 'stall', 'healthcheck-failed'],
        'payload.reason',
        issues,
        true
      )
      optionalEnum(
        payload['activeTurnDisposition'],
        ['fail-before-recycle', 'escalate-only', 'none'],
        'payload.activeTurnDisposition',
        issues,
        true
      )
      return
    }
    case 'harness.recovery.completed': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      validateRequiredPositiveInteger(payload['fromGeneration'], 'payload.fromGeneration', issues)
      validateRequiredPositiveInteger(payload['toGeneration'], 'payload.toGeneration', issues)
      if (typeof payload.ready !== 'boolean') {
        issues.push(
          issue(
            'payload.ready',
            payload.ready === undefined ? 'required' : 'invalid_type',
            'payload.ready must be a boolean'
          )
        )
      }
      return
    }
    case 'harness.recovery.failed': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      validateRequiredPositiveInteger(payload['fromGeneration'], 'payload.fromGeneration', issues)
      optionalEnum(
        payload.reason,
        ['runner-unresponsive', 'kill-timeout', 'spawn-failed', 'continuation-missing'],
        'payload.reason',
        issues,
        true
      )
      optionalEnum(payload['requestedAction'], ['hard-reap'], 'payload.requestedAction', issues)
      return
    }
    case 'invocation.ready': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      optionalEnum(payload['state'], ['ready'], 'payload.state', issues, true)
      return
    }
    case 'invocation.disposed': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireTrue(payload['disposed'], 'payload.disposed', issues)
      return
    }
    case 'permission.requested': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireString(payload['permissionRequestId'], 'payload.permissionRequestId', issues)
      requireString(payload.kind, 'payload.kind', issues)
      if (!Object.hasOwn(payload, 'subjectDisplay')) {
        issues.push(issue('payload.subjectDisplay', 'required', 'subjectDisplay is required'))
      }
      optionalEnum(
        payload['defaultDecision'],
        ['allow', 'deny'],
        'payload.defaultDecision',
        issues,
        true
      )
      optionalNumber(payload['deadlineMs'], 'payload.deadlineMs', issues)
      return
    }
    case 'turn.stalled': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireString(payload['inputId'], 'payload.inputId', issues)
      requireString(payload['turnId'], 'payload.turnId', issues)
      requireNumber(payload['noProgressMs'], 'payload.noProgressMs', issues)
      requireNumber(payload['thresholdMs'], 'payload.thresholdMs', issues)
      optionalEnum(
        payload['healthProbe'],
        ['runner-status', 'driver-status', 'native-heartbeat'],
        'payload.healthProbe',
        issues,
        true
      )
      validateRequiredPositiveInteger(
        payload['harnessGeneration'],
        'payload.harnessGeneration',
        issues
      )
      validateRequiredPositiveInteger(payload['turnAttempt'], 'payload.turnAttempt', issues)
      return
    }
    case 'turn.retry': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireString(payload['inputId'], 'payload.inputId', issues)
      requireString(payload['turnId'], 'payload.turnId', issues)
      validateRequiredPositiveInteger(payload['fromAttempt'], 'payload.fromAttempt', issues)
      validateRequiredPositiveInteger(payload['toAttempt'], 'payload.toAttempt', issues)
      validateRequiredPositiveInteger(
        payload['fromHarnessGeneration'],
        'payload.fromHarnessGeneration',
        issues
      )
      validateRequiredPositiveInteger(
        payload['toHarnessGeneration'],
        'payload.toHarnessGeneration',
        issues
      )
      optionalEnum(
        payload.reason,
        ['harness-stalled', 'harness-crashed'],
        'payload.reason',
        issues,
        true
      )
      optionalEnum(payload.semantics, ['at-least-once'], 'payload.semantics', issues, true)
      return
    }
    case 'terminal.surface.reported': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      const driverKind = context.driverKind
      const requiresPaneKind = driverKind === 'claude-code-tmux' || driverKind === 'codex-cli-tmux'

      if (payload.kind === 'tmux-pane') {
        requireString(payload['socketPath'], 'payload.socketPath', issues)
        const sessionId = payload['sessionId']
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          issues.push(
            issue('payload.sessionId', 'required', 'payload.sessionId must be a non-empty string')
          )
        } else if (!TMUX_SESSION_ID_PATTERN.test(sessionId)) {
          issues.push(
            issue(
              'payload.sessionId',
              'invalid_tmux_id',
              `payload.sessionId must match ${String(TMUX_SESSION_ID_PATTERN)}`
            )
          )
        }
        const windowId = payload['windowId']
        if (typeof windowId !== 'string' || windowId.length === 0) {
          issues.push(
            issue('payload.windowId', 'required', 'payload.windowId must be a non-empty string')
          )
        } else if (!TMUX_WINDOW_ID_PATTERN.test(windowId)) {
          issues.push(
            issue(
              'payload.windowId',
              'invalid_tmux_id',
              `payload.windowId must match ${String(TMUX_WINDOW_ID_PATTERN)}`
            )
          )
        }
        const paneId = payload['paneId']
        if (typeof paneId !== 'string' || paneId.length === 0) {
          issues.push(
            issue('payload.paneId', 'required', 'payload.paneId must be a non-empty string')
          )
        } else if (!TMUX_PANE_ID_PATTERN.test(paneId)) {
          issues.push(
            issue(
              'payload.paneId',
              'invalid_tmux_id',
              `payload.paneId must match ${String(TMUX_PANE_ID_PATTERN)}`
            )
          )
        }
        optionalString(payload['sessionName'], 'payload.sessionName', issues)
        optionalString(payload['windowName'], 'payload.windowName', issues)
      } else if (payload.kind === 'tmux-session') {
        if (requiresPaneKind) {
          issues.push(
            issue(
              'payload.kind',
              'invalid_literal',
              `${driverKind} driver requires terminal.surface.reported payload kind 'tmux-pane'`
            )
          )
        }
        requireString(payload['socketPath'], 'payload.socketPath', issues)
        requireString(payload['sessionName'], 'payload.sessionName', issues)
        optionalString(payload['paneId'], 'payload.paneId', issues)
      } else {
        optionalEnum(payload.kind, ['tmux-session', 'tmux-pane'], 'payload.kind', issues, true)
      }
      return
    }
    case 'permission.resolved': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireString(payload['permissionRequestId'], 'payload.permissionRequestId', issues)
      optionalEnum(payload['decision'], ['allow', 'deny'], 'payload.decision', issues, true)
      optionalEnum(
        payload['decidedBy'],
        ['policy', 'user', 'api', 'timeout'],
        'payload.decidedBy',
        issues,
        true
      )
      optionalString(payload['message'], 'payload.message', issues)
      return
    }
    case 'permission.cancelled': {
      const payload = requirePayloadRecord(value, issues)
      if (!payload) return
      requireString(payload['permissionRequestId'], 'payload.permissionRequestId', issues)
      optionalEnum(
        payload.reason,
        ['harness-generation-ended', 'turn-failed', 'invocation-stopping'],
        'payload.reason',
        issues,
        true
      )
      validateOptionalPositiveInteger(
        payload['harnessGeneration'],
        'payload.harnessGeneration',
        issues
      )
      validateOptionalPositiveInteger(payload['turnAttempt'], 'payload.turnAttempt', issues)
      return
    }
    default:
      return
  }
}

function validateBrokerHelloParams(params: SchemaRecord, issues: ValidationIssue[]): void {
  const clientInfo = asRecord(params.clientInfo)
  if (!clientInfo) {
    issues.push(issue('params.clientInfo', 'required', 'clientInfo is required'))
  } else {
    requireString(clientInfo.name, 'params.clientInfo.name', issues)
    optionalString(clientInfo.version, 'params.clientInfo.version', issues)
  }

  requireStringArray(params.protocolVersions, 'params.protocolVersions', issues)

  if (params.capabilities !== undefined) {
    validateClientCapabilities(params.capabilities, 'params.capabilities', issues)
  }
}

function validateClientCapabilities(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    return
  }
  const capabilities = asRecord(value)
  if (!capabilities) {
    issues.push(issue(basePath, 'invalid_type', 'capabilities must be an object'))
  } else {
    optionalBoolean(capabilities.permissionRequests, path(basePath, 'permissionRequests'), issues)
    optionalBoolean(capabilities.eventAcks, path(basePath, 'eventAcks'), issues)
  }
}

function validateInvocationInputShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const input = asRecord(value)
  if (!input) {
    issues.push(issue(basePath, 'required', 'input is required'))
    return
  }

  optionalString(input.inputId, path(basePath, 'inputId'), issues)
  optionalEnum(
    input.kind,
    ['user', 'steer', 'append_context'],
    path(basePath, 'kind'),
    issues,
    true
  )
  validateInputContent(input.content, path(basePath, 'content'), issues)
  validateStringRecord(input.metadata, path(basePath, 'metadata'), issues, false)
}

function validateInputContent(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(
      issue(basePath, value === undefined ? 'required' : 'invalid_type', 'content must be an array')
    )
    return
  }

  value.forEach((item, index) => {
    const itemPath = path(basePath, String(index))
    const content = asRecord(item)
    if (!content) {
      issues.push(issue(itemPath, 'invalid_type', 'content item must be an object'))
      return
    }

    if (content.type === 'text') {
      requireString(content.text, path(itemPath, 'text'), issues)
    } else if (content.type === 'local_image') {
      requireString(content.path, path(itemPath, 'path'), issues)
    } else if (content.type === 'file_ref') {
      requireString(content.path, path(itemPath, 'path'), issues)
      optionalString(content.mimeType, path(itemPath, 'mimeType'), issues)
    } else {
      issues.push(
        issue(path(itemPath, 'type'), 'invalid_literal', 'Unsupported input content type')
      )
    }
  })
}

function validateInputPolicy(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const policy = asRecord(value)
  if (!policy) {
    issues.push(issue(basePath, 'invalid_type', 'policy must be an object'))
    return
  }
  optionalEnum(
    policy.whenBusy,
    ['reject', 'queue', 'interrupt_then_apply'],
    path(basePath, 'whenBusy'),
    issues,
    true
  )
  optionalNumber(policy.timeoutMs, path(basePath, 'timeoutMs'), issues)
}

type EnvChannel = 'lockedEnv' | 'dispatchEnv'

function validateEnv(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  channel: EnvChannel,
  lockedEnv?: unknown
): void {
  if (value === undefined) {
    return
  }
  const record = asRecord(value)
  if (!record) {
    issues.push(issue(basePath, 'invalid_type', `${channel} must be an object`))
    return
  }
  const lockedEnvKeys = new Set(
    asRecord(lockedEnv) ? Object.keys(asRecord(lockedEnv) as SchemaRecord) : []
  )
  for (const [key, envValue] of Object.entries(record)) {
    const envPath = path(basePath, key)
    if (!ENV_KEY_PATTERN.test(key)) {
      issues.push(
        issue(envPath, 'invalid_env_key', `${channel} key must match ${String(ENV_KEY_PATTERN)}`)
      )
    }
    if (isAmbientEnvKey(key)) {
      issues.push(issue(envPath, 'ambient_env_key', `${channel} key conflicts with ambient env`))
    }
    if (isCredentialEnvKey(key)) {
      issues.push(
        issue(envPath, 'credential_env_key', `${channel} key conflicts with credential env`)
      )
    }
    if (isReservedEnvKey(key)) {
      issues.push(issue(envPath, 'reserved_env_key', `${channel} key is reserved`))
    }
    if (channel === 'dispatchEnv' && lockedEnvKeys.has(key)) {
      issues.push(issue(envPath, 'dispatch_env_shadow', 'dispatchEnv must not shadow lockedEnv'))
    }
    if (typeof envValue !== 'string') {
      issues.push(issue(envPath, 'invalid_type', `${channel} value must be a string`))
    }
  }
}

function validateHarnessTransport(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const transport = asRecord(value)
  if (!transport) {
    issues.push(issue(basePath, 'required', 'harnessTransport is required'))
    return
  }
  if (!['jsonrpc-stdio', 'pipes', 'pty'].includes(String(transport.kind))) {
    issues.push(issue(path(basePath, 'kind'), 'invalid_literal', 'Unsupported harness transport'))
  }
  if (transport.kind === 'pty') {
    optionalNumber(transport.cols, path(basePath, 'cols'), issues)
    optionalNumber(transport.rows, path(basePath, 'rows'), issues)
  }
}

function validateProcessLimits(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const limits = asRecord(value)
  if (!limits) {
    issues.push(issue(basePath, 'invalid_type', 'limits must be an object'))
    return
  }
  optionalNumber(limits.startupTimeoutMs, path(basePath, 'startupTimeoutMs'), issues)
  optionalNumber(limits.turnTimeoutMs, path(basePath, 'turnTimeoutMs'), issues)
  optionalNumber(limits.stopGraceMs, path(basePath, 'stopGraceMs'), issues)
  optionalNumber(limits.maxEventBytes, path(basePath, 'maxEventBytes'), issues)
}

function validateInteraction(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const interaction = asRecord(value)
  if (!interaction) {
    issues.push(issue(basePath, 'invalid_type', 'interaction must be an object'))
    return
  }
  if (!['headless', 'interactive', 'service'].includes(String(interaction.mode))) {
    issues.push(issue(path(basePath, 'mode'), 'invalid_literal', 'Unsupported interaction mode'))
  }
  if (interaction.turnConcurrency !== undefined && interaction.turnConcurrency !== 'single') {
    issues.push(
      issue(path(basePath, 'turnConcurrency'), 'invalid_literal', 'Unsupported turn concurrency')
    )
  }
  if (
    interaction.inputQueue !== undefined &&
    !['none', 'fifo'].includes(String(interaction.inputQueue))
  ) {
    issues.push(issue(path(basePath, 'inputQueue'), 'invalid_literal', 'Unsupported input queue'))
  }
}

function validateContinuation(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const continuation = asRecord(value)
  if (!continuation) {
    issues.push(issue(basePath, 'invalid_type', 'continuation must be an object'))
    return
  }
  requireString(continuation.provider, path(basePath, 'provider'), issues)
  requireString(continuation.key, path(basePath, 'key'), issues)
  if (continuation.kind !== undefined && typeof continuation.kind !== 'string') {
    issues.push(issue(path(basePath, 'kind'), 'invalid_type', 'kind must be a string'))
  }
}

function validateCodexDriver(
  driver: SchemaRecord,
  basePath: string,
  issues: ValidationIssue[]
): void {
  optionalString(driver.resumeThreadId, path(basePath, 'resumeThreadId'), issues)
  optionalString(driver.model, path(basePath, 'model'), issues)
  optionalString(driver.modelReasoningEffort, path(basePath, 'modelReasoningEffort'), issues)
  optionalString(driver.profile, path(basePath, 'profile'), issues)
  optionalStringArray(
    driver.defaultImageAttachments,
    path(basePath, 'defaultImageAttachments'),
    issues
  )
  optionalEnum(
    driver.approvalPolicy,
    ['untrusted', 'on-failure', 'on-request', 'never'],
    path(basePath, 'approvalPolicy'),
    issues
  )
  optionalEnum(
    driver.sandboxMode,
    ['read-only', 'workspace-write', 'danger-full-access'],
    path(basePath, 'sandboxMode'),
    issues
  )
  optionalEnum(
    driver.resumeFallback,
    ['start-fresh', 'fail'],
    path(basePath, 'resumeFallback'),
    issues
  )

  if (driver.permissionPolicy !== undefined) {
    const policy = asRecord(driver.permissionPolicy)
    if (!policy) {
      issues.push(
        issue(
          path(basePath, 'permissionPolicy'),
          'invalid_type',
          'permissionPolicy must be an object'
        )
      )
    } else {
      optionalEnum(
        policy.mode,
        ['deny', 'allow', 'ask-client'],
        path(basePath, 'permissionPolicy.mode'),
        issues,
        true
      )
      optionalNumber(policy.timeoutMs, path(basePath, 'permissionPolicy.timeoutMs'), issues)
      optionalEnum(
        policy['defaultDecision'],
        ['allow', 'deny'],
        path(basePath, 'permissionPolicy.defaultDecision'),
        issues
      )
    }
  }
}

function validateStringRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  required: boolean
): void {
  if (value === undefined) {
    if (required) {
      issues.push(issue(basePath, 'required', `${basePath} is required`))
    }
    return
  }
  const record = asRecord(value)
  if (!record) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be an object`))
    return
  }
  for (const [key, recordValue] of Object.entries(record)) {
    if (typeof recordValue !== 'string') {
      issues.push(issue(path(basePath, key), 'invalid_type', 'value must be a string'))
    }
  }
}

function validateEnumArray(
  value: unknown,
  allowed: string[],
  basePath: string,
  issues: ValidationIssue[]
): void {
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
    if (typeof item !== 'string' || !allowed.includes(item)) {
      issues.push(
        issue(
          path(basePath, String(index)),
          'invalid_literal',
          'array item has an unsupported value'
        )
      )
    }
  })
}

function validateOptionalPositiveInteger(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    issues.push(
      issue(basePath, 'invalid_positive_integer', `${basePath} must be a positive integer`)
    )
  }
}

function validateRequiredPositiveInteger(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    issues.push(issue(basePath, 'required', `${basePath} is required`))
    return
  }
  validateOptionalPositiveInteger(value, basePath, issues)
}
