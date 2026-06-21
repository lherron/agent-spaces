import type { BrokerCommand, BrokerMethod } from './commands'
import type {
  InvocationDispatchRequest,
  InvocationInput,
  InvocationStartRequest,
  PermissionRequestParams,
} from './commands'
import {
  CommandValidationError,
  EventEnvelopeValidationError,
  InvocationDispatchRequestValidationError,
  InvocationInputValidationError,
  InvocationSpecValidationError,
  InvocationStartRequestValidationError,
  PermissionRequestParamsValidationError,
  type ValidationIssue,
} from './errors.js'
import type { InvocationEventEnvelope, InvocationEventType } from './events'
import type { HarnessInvocationSpec } from './invocation'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from './invocation'
import { isJsonRpcRequest } from './jsonrpc'
import type { BrokerLifecyclePolicyOverlay } from './lifecycle.js'
import { lifecyclePolicyHash } from './lifecycle.js'
import { validateTmuxPaneIds } from './tmux-ids.js'

// Re-export the validation error family + ValidationIssue from their dedicated
// module so the public package surface (and `export *` from index.ts) is
// unchanged after the extraction.
export {
  CommandValidationError,
  EventEnvelopeValidationError,
  InvocationDispatchRequestValidationError,
  InvocationInputValidationError,
  InvocationSpecValidationError,
  InvocationStartRequestValidationError,
  PermissionRequestParamsValidationError,
  type ValidationIssue,
}

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
  asRecord,
  joinPath,
  makeIssue,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalNumberOrNull,
  optionalString,
  optionalStringArray,
  requireArray,
  requireNumber,
  requirePayloadRecord,
  requireString,
  requireStringArray,
  requireTrue,
} from './validation-primitives.js'

export type SchemaRecord = Record<string, unknown>

/**
 * Single source of truth for the runtime method/event registries. The tuples
 * are `as const` so the `satisfies` clause forces every entry to be a valid
 * compile-time union member, and the {@link AssertExhaustive} helper below
 * fails the build if the union ever gains a member the tuple omits — closing
 * the drift gap the registries used to have against `commands.ts`/`events.ts`.
 */
const BROKER_METHODS = [
  'broker.hello',
  'broker.health',
  'broker.attach',
  'broker.listInvocations',
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
] as const satisfies readonly BrokerMethod[]

const EVENT_TYPES = [
  'invocation.started',
  'invocation.ready',
  'invocation.stopping',
  'invocation.exited',
  'invocation.failed',
  'invocation.disposed',
  'invocation.summary',
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
  'user.message',
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
] as const satisfies readonly InvocationEventType[]

// Compile-time exhaustiveness guard: if a union member is missing from the
// tuple above, `never` is no longer assignable and the build fails.
type AssertExhaustive<Union, Tuple extends readonly Union[]> = Exclude<
  Union,
  Tuple[number]
> extends never
  ? true
  : never
type _BrokerMethodsExhaustive = AssertExhaustive<BrokerMethod, typeof BROKER_METHODS>
type _EventTypesExhaustive = AssertExhaustive<InvocationEventType, typeof EVENT_TYPES>
const _brokerMethodsExhaustive: _BrokerMethodsExhaustive = true
const _eventTypesExhaustive: _EventTypesExhaustive = true
void _brokerMethodsExhaustive
void _eventTypesExhaustive

const brokerMethods: ReadonlySet<BrokerMethod> = new Set(BROKER_METHODS)
const eventTypes: ReadonlySet<InvocationEventType> = new Set(EVENT_TYPES)

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
    issues.push(makeIssue('', 'invalid_type', 'Invocation start request must be an object'))
  } else {
    validateStartRequestBody(request, '', issues)
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
    issues.push(makeIssue('', 'invalid_jsonrpc_request', 'Command must be a JSON-RPC request'))
  } else if (!brokerMethods.has(value.method as BrokerMethod)) {
    issues.push(makeIssue('method', 'unknown_method', 'Unsupported broker method'))
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
    issues.push(makeIssue('', 'invalid_type', 'Event envelope must be an object'))
  } else {
    requireString(envelope['invocationId'], 'invocationId', issues)
    requireNumber(envelope['seq'], 'seq', issues)
    requireString(envelope['time'], 'time', issues)
    if (
      typeof envelope['type'] !== 'string' ||
      !eventTypes.has(envelope['type'] as InvocationEventType)
    ) {
      issues.push(makeIssue('type', 'invalid_event_type', 'Unsupported event type'))
    }
    if (!Object.hasOwn(envelope, 'payload')) {
      issues.push(makeIssue('payload', 'required', 'payload is required'))
    } else if (typeof envelope['type'] === 'string') {
      const driverKind = asRecord(envelope['driver'])?.['kind']
      validateOptionalPositiveInteger(envelope['harnessGeneration'], 'harnessGeneration', issues)
      validateOptionalPositiveInteger(envelope['turnAttempt'], 'turnAttempt', issues)
      validateEventPayload(envelope['type'] as InvocationEventType, envelope['payload'], issues, {
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
    issues.push(makeIssue(prefix, 'invalid_type', 'Spec must be an object'))
    return
  }

  if (spec['specVersion'] !== 'harness-broker.invocation/v1') {
    issues.push(
      makeIssue(joinPath(prefix, 'specVersion'), 'invalid_literal', 'Unsupported specVersion')
    )
  }
  if (Object.hasOwn(spec, 'lifecyclePolicy')) {
    issues.push(
      makeIssue(
        joinPath(prefix, 'lifecyclePolicy'),
        'stale_lifecycle_overlay',
        'spec.lifecyclePolicy is not accepted; put lifecyclePolicy on the InvocationDispatchRequest envelope'
      )
    )
  }

  validateStringRecord(spec['labels'], joinPath(prefix, 'labels'), issues, false)
  validateStringRecord(spec['correlation'], joinPath(prefix, 'correlation'), issues, false)

  const harness = asRecord(spec['harness'])
  if (!harness) {
    issues.push(makeIssue(joinPath(prefix, 'harness'), 'required', 'harness is required'))
  } else {
    requireString(harness['frontend'], joinPath(prefix, 'harness.frontend'), issues)
    requireString(harness['driver'], joinPath(prefix, 'harness.driver'), issues)
    if (harness['provider'] !== undefined && typeof harness['provider'] !== 'string') {
      issues.push(
        makeIssue(joinPath(prefix, 'harness.provider'), 'invalid_type', 'provider must be a string')
      )
    }
  }

  const process = asRecord(spec['process'])
  if (!process) {
    issues.push(makeIssue(joinPath(prefix, 'process'), 'required', 'process is required'))
  } else {
    requireString(process['command'], joinPath(prefix, 'process.command'), issues)
    requireStringArray(process['args'], joinPath(prefix, 'process.args'), issues)
    requireString(process['cwd'], joinPath(prefix, 'process.cwd'), issues)
    validateEnv(process['lockedEnv'], joinPath(prefix, 'process.lockedEnv'), issues, 'lockedEnv')
    optionalStringArray(process['pathPrepend'], joinPath(prefix, 'process.pathPrepend'), issues)
    validateHarnessTransport(
      process['harnessTransport'],
      joinPath(prefix, 'process.harnessTransport'),
      issues
    )
    validateProcessLimits(process['limits'], joinPath(prefix, 'process.limits'), issues)
  }

  validateInteraction(spec['interaction'], joinPath(prefix, 'interaction'), issues)
  validateContinuation(spec['continuation'], joinPath(prefix, 'continuation'), issues)

  const driver = asRecord(spec['driver'])
  if (!driver) {
    issues.push(makeIssue(joinPath(prefix, 'driver'), 'required', 'driver is required'))
  } else {
    requireString(driver['kind'], joinPath(prefix, 'driver.kind'), issues)
    if (
      typeof harness?.['driver'] === 'string' &&
      typeof driver['kind'] === 'string' &&
      harness['driver'] !== driver['kind']
    ) {
      issues.push(
        makeIssue(
          joinPath(prefix, 'harness.driver'),
          'invalid_driver',
          'harness.driver must match driver.kind'
        )
      )
    }
    if (driver['kind'] === 'codex-app-server') {
      validateCodexDriver(driver, joinPath(prefix, 'driver'), issues)
    }
  }

  validateLaunch(spec['launch'], joinPath(prefix, 'launch'), issues)
}

function validateLaunch(value: unknown, prefix: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const launch = asRecord(value)
  if (!launch) {
    issues.push(makeIssue(prefix, 'invalid_type', 'launch must be an object'))
    return
  }
  const systemPromptFile = launch['systemPromptFile']
  const systemPromptMode = launch['systemPromptMode']
  const initialPrompt = launch['initialPrompt']
  if (systemPromptFile !== undefined && typeof systemPromptFile !== 'string') {
    issues.push(
      makeIssue(
        joinPath(prefix, 'systemPromptFile'),
        'invalid_type',
        'systemPromptFile must be a string'
      )
    )
  }
  if (
    systemPromptMode !== undefined &&
    systemPromptMode !== 'append' &&
    systemPromptMode !== 'replace'
  ) {
    issues.push(
      makeIssue(
        joinPath(prefix, 'systemPromptMode'),
        'invalid_literal',
        'systemPromptMode must be "append" or "replace"'
      )
    )
  }
  if (initialPrompt !== undefined && typeof initialPrompt !== 'string') {
    issues.push(
      makeIssue(joinPath(prefix, 'initialPrompt'), 'invalid_type', 'initialPrompt must be a string')
    )
  }
}

/**
 * Per-method validators for broker methods whose params MUST be an object. The
 * `asRecord` guard is applied once in {@link validateCommandParams} before
 * dispatch, so each entry receives the already-unwrapped params record. This
 * registry replaces the former per-method `switch`; adding a broker method is
 * now a single table entry (OCP) instead of a new `case`. `broker.health` is
 * intentionally absent — it permits `params === undefined` and so is handled by
 * a dedicated branch ahead of the record guard.
 */
const COMMAND_PARAM_VALIDATORS: Partial<
  Record<BrokerMethod, (commandParams: SchemaRecord, issues: ValidationIssue[]) => void>
> = {
  'broker.hello': (commandParams, issues) => {
    validateBrokerHelloParams(commandParams, issues)
  },
  'broker.attach': (commandParams, issues) => {
    requireString(commandParams['runtimeId'], 'params.runtimeId', issues)
    requireString(commandParams['hostSessionId'], 'params.hostSessionId', issues)
    requireNumber(commandParams['generation'], 'params.generation', issues)
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireString(commandParams['startRequestHash'], 'params.startRequestHash', issues)
    requireString(commandParams['selectedProfileHash'], 'params.selectedProfileHash', issues)
    requireString(commandParams['controllerInstanceId'], 'params.controllerInstanceId', issues)
    requireString(commandParams['attachToken'], 'params.attachToken', issues)
    optionalNumber(commandParams['lastProjectedSeq'], 'params.lastProjectedSeq', issues)
    validateClientCapabilities(
      commandParams['clientCapabilities'],
      'params.clientCapabilities',
      issues
    )
  },
  'broker.listInvocations': (commandParams, issues) => {
    optionalBoolean(commandParams['includeDisposed'], 'params.includeDisposed', issues)
    optionalBoolean(commandParams['probeLiveness'], 'params.probeLiveness', issues)
  },
  'invocation.start': (commandParams, issues) => {
    validateInvocationDispatchRequestShape(commandParams, 'params', issues)
  },
  'invocation.input': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    validateInvocationInputShape(commandParams['input'], 'params.input', issues)
    validateInputPolicy(commandParams['policy'], 'params.policy', issues)
  },
  'invocation.interrupt': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    optionalEnum(commandParams['scope'], ['turn', 'invocation'], 'params.scope', issues, true)
    optionalString(commandParams['reason'], 'params.reason', issues)
    optionalNumber(commandParams['graceMs'], 'params.graceMs', issues)
  },
  'invocation.stop': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    optionalString(commandParams['reason'], 'params.reason', issues)
    optionalNumber(commandParams['graceMs'], 'params.graceMs', issues)
  },
  'invocation.status': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    optionalBoolean(commandParams['probeLiveness'], 'params.probeLiveness', issues)
  },
  'invocation.dispose': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
  },
  'invocation.eventsSince': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireNumber(commandParams['afterSeq'], 'params.afterSeq', issues)
    optionalBoolean(commandParams['live'], 'params.live', issues)
    validateOptionalEventTypeArray(commandParams['types'], 'params.types', issues)
  },
  'invocation.ackEvents': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireNumber(commandParams['throughSeq'], 'params.throughSeq', issues)
    requireString(commandParams['controllerInstanceId'], 'params.controllerInstanceId', issues)
  },
  'invocation.snapshot': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    optionalBoolean(commandParams['probeLiveness'], 'params.probeLiveness', issues)
  },
  'invocation.permission.respond': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireString(commandParams['permissionRequestId'], 'params.permissionRequestId', issues)
    optionalEnum(commandParams['decision'], ['allow', 'deny'], 'params.decision', issues, true)
    optionalString(commandParams['controllerInstanceId'], 'params.controllerInstanceId', issues)
    optionalString(commandParams['message'], 'params.message', issues)
  },
}

function validateCommandParams(
  method: BrokerMethod,
  params: unknown,
  issues: ValidationIssue[]
): void {
  if (method === 'broker.health') {
    validateBrokerHealthParams(params, issues)
    return
  }

  const commandParams = asRecord(params)
  if (!commandParams) {
    issues.push(makeIssue('params', 'required', 'params is required'))
    return
  }

  const validator = COMMAND_PARAM_VALIDATORS[method]
  validator?.(commandParams, issues)
}

/**
 * `broker.health` params are optional; when present they must be an object with
 * an optional boolean `probeDrivers`. Handled separately from
 * {@link COMMAND_PARAM_VALIDATORS} because every other method requires a params
 * record.
 */
function validateBrokerHealthParams(params: unknown, issues: ValidationIssue[]): void {
  if (params === undefined) {
    return
  }
  const health = asRecord(params)
  if (!health) {
    issues.push(makeIssue('params', 'invalid_type', 'params must be an object'))
  } else if (health['probeDrivers'] !== undefined && typeof health['probeDrivers'] !== 'boolean') {
    issues.push(makeIssue('params.probeDrivers', 'invalid_type', 'probeDrivers must be a boolean'))
  }
}

function validatePermissionRequestParamsShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = asRecord(value)
  if (!params) {
    issues.push(makeIssue(basePath, 'invalid_type', 'Permission request params must be an object'))
    return
  }

  requireString(params['invocationId'], joinPath(basePath, 'invocationId'), issues)
  optionalString(params['turnId'], joinPath(basePath, 'turnId'), issues)
  validateOptionalPositiveInteger(
    params['harnessGeneration'],
    joinPath(basePath, 'harnessGeneration'),
    issues
  )
  validateOptionalPositiveInteger(params['turnAttempt'], joinPath(basePath, 'turnAttempt'), issues)
  requireString(params['permissionRequestId'], joinPath(basePath, 'permissionRequestId'), issues)
  requireString(params['kind'], joinPath(basePath, 'kind'), issues)
  if (!Object.hasOwn(params, 'subject')) {
    issues.push(makeIssue(joinPath(basePath, 'subject'), 'required', 'subject is required'))
  }
  optionalEnum(
    params['defaultDecision'],
    ['allow', 'deny'],
    joinPath(basePath, 'defaultDecision'),
    issues,
    true
  )
  optionalNumber(params['deadlineMs'], joinPath(basePath, 'deadlineMs'), issues)
}

function validateInvocationDispatchRequestShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = asRecord(value)
  if (!request) {
    issues.push(
      makeIssue(basePath, 'invalid_type', 'Invocation dispatch request must be an object')
    )
    return
  }

  const startRequest = asRecord(request['startRequest'])
  if (!startRequest) {
    issues.push(
      makeIssue(joinPath(basePath, 'startRequest'), 'required', 'startRequest is required')
    )
  } else {
    validateStartRequestBody(startRequest, joinPath(basePath, 'startRequest'), issues)
  }

  const specRecord = asRecord(startRequest?.['spec'])
  const processRecord = asRecord(specRecord?.['process'])
  const lockedEnv = processRecord?.['lockedEnv']
  validateEnv(
    request['dispatchEnv'],
    joinPath(basePath, 'dispatchEnv'),
    issues,
    'dispatchEnv',
    lockedEnv
  )
  validateDispatchRuntime(request, basePath, issues)
  if (request['lifecyclePolicy'] !== undefined) {
    validateLifecyclePolicyOverlay(
      request['lifecyclePolicy'],
      joinPath(basePath, 'lifecyclePolicy'),
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
    issues.push(makeIssue(basePath, 'invalid_type', 'lifecyclePolicy must be an object'))
    return
  }

  optionalEnum(
    policy['schemaVersion'],
    ['harness-broker.lifecycle-policy/v1'],
    joinPath(basePath, 'schemaVersion'),
    issues,
    true
  )
  requireString(policy['policyId'], joinPath(basePath, 'policyId'), issues)
  requireString(policy['policyHash'], joinPath(basePath, 'policyHash'), issues)
  validateRuntimeRetentionPolicy(policy['retention'], joinPath(basePath, 'retention'), issues)
  validateHarnessRecoveryPolicy(
    policy['harnessRecovery'],
    joinPath(basePath, 'harnessRecovery'),
    issues
  )
  validateTurnRetryPolicy(policy['turnRetry'], joinPath(basePath, 'turnRetry'), issues)

  if (typeof policy['policyHash'] === 'string') {
    let expected: string | undefined
    try {
      expected = lifecyclePolicyHash(policy as unknown as BrokerLifecyclePolicyOverlay)
    } catch {
      expected = undefined
    }
    if (expected !== undefined && policy['policyHash'] !== expected) {
      issues.push(
        makeIssue(
          joinPath(basePath, 'policyHash'),
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
    issues.push(makeIssue(basePath, 'required', 'retention is required'))
    return
  }
  optionalEnum(
    policy['mode'],
    ['keep-alive', 'idle-ttl', 'unmanaged'],
    joinPath(basePath, 'mode'),
    issues,
    true
  )
  if (policy['mode'] === 'idle-ttl') {
    requireNumber(policy['idleTtlMs'], joinPath(basePath, 'idleTtlMs'), issues)
    const retire = asRecord(policy['retire'])
    if (!retire) {
      issues.push(
        makeIssue(joinPath(basePath, 'retire'), 'required', 'retention.retire is required')
      )
    } else {
      optionalEnum(
        retire['mode'],
        ['driver-retire'],
        joinPath(basePath, 'retire.mode'),
        issues,
        true
      )
      requireNumber(retire['graceMs'], joinPath(basePath, 'retire.graceMs'), issues)
      optionalEnum(
        retire['onTimeout'],
        ['fail-invocation', 'escalate-hard-reap'],
        joinPath(basePath, 'retire.onTimeout'),
        issues,
        true
      )
    }
  }
  if (policy['mode'] === 'unmanaged') {
    requireString(policy['reason'], joinPath(basePath, 'reason'), issues)
  }
}

/**
 * Per-mode harness-recovery validators, keyed by `policy.mode`. Splitting the
 * mode bodies out of the parent (a) isolates each mode's contract and (b)
 * mirrors the discriminated union in lifecycle.ts so each mode is one entry.
 */
const HARNESS_RECOVERY_MODE_VALIDATORS: Record<
  'fail-and-escalate' | 'recycle-child',
  (policy: SchemaRecord, basePath: string, issues: ValidationIssue[]) => void
> = {
  'fail-and-escalate': validateFailAndEscalateRecovery,
  'recycle-child': validateRecycleChildRecovery,
}

function validateHarnessRecoveryPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(makeIssue(basePath, 'required', 'harnessRecovery is required'))
    return
  }
  optionalEnum(
    policy['mode'],
    ['none', 'fail-and-escalate', 'recycle-child'],
    joinPath(basePath, 'mode'),
    issues,
    true
  )
  if (typeof policy['mode'] !== 'string') return
  const modeValidator =
    HARNESS_RECOVERY_MODE_VALIDATORS[policy['mode'] as 'fail-and-escalate' | 'recycle-child']
  modeValidator?.(policy, basePath, issues)
}

function validateFailAndEscalateRecovery(
  policy: SchemaRecord,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (policy['stallDetection'] !== undefined) {
    validateStallDetectionPolicy(
      policy['stallDetection'],
      joinPath(basePath, 'stallDetection'),
      issues
    )
  }
  optionalEnum(
    policy['escalation'],
    ['fail-turn', 'fail-invocation', 'escalate-hard-reap'],
    joinPath(basePath, 'escalation'),
    issues,
    true
  )
}

function validateRecycleChildRecovery(
  policy: SchemaRecord,
  basePath: string,
  issues: ValidationIssue[]
): void {
  requireNumber(
    policy['maxGenerationsPerInvocation'],
    joinPath(basePath, 'maxGenerationsPerInvocation'),
    issues
  )
  optionalEnum(
    policy['activeTurnDisposition'],
    ['fail-before-recycle', 'escalate-only'],
    joinPath(basePath, 'activeTurnDisposition'),
    issues,
    true
  )
  validateStallDetectionPolicy(
    policy['stallDetection'],
    joinPath(basePath, 'stallDetection'),
    issues
  )
  validateRecycleSpec(policy['recycle'], joinPath(basePath, 'recycle'), issues)
  optionalEnum(
    policy['onRecoveryFailure'],
    ['fail-invocation', 'escalate-hard-reap'],
    joinPath(basePath, 'onRecoveryFailure'),
    issues,
    true
  )
}

function validateRecycleSpec(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const recycle = asRecord(value)
  if (!recycle) {
    issues.push(makeIssue(basePath, 'required', 'harnessRecovery.recycle is required'))
    return
  }
  optionalEnum(
    recycle['mechanism'],
    ['capability-selected', 'in-pane-runner', 'direct-child'],
    joinPath(basePath, 'mechanism'),
    issues,
    true
  )
  requireNumber(recycle['killGraceMs'], joinPath(basePath, 'killGraceMs'), issues)
  requireBoolean(
    recycle['killProcessTree'],
    joinPath(basePath, 'killProcessTree'),
    'harnessRecovery.recycle.killProcessTree must be a boolean',
    issues
  )
  optionalEnum(
    recycle['restartFrom'],
    ['latest-continuation'],
    joinPath(basePath, 'restartFrom'),
    issues,
    true
  )
  requireBoolean(
    recycle['requireContinuation'],
    joinPath(basePath, 'requireContinuation'),
    'harnessRecovery.recycle.requireContinuation must be a boolean',
    issues
  )
}

/**
 * Required-boolean field check that distinguishes a missing value (`required`)
 * from a present-but-wrong-typed one (`invalid_type`), matching the inline
 * checks it replaces.
 */
function requireBoolean(
  value: unknown,
  basePath: string,
  message: string,
  issues: ValidationIssue[]
): void {
  if (typeof value !== 'boolean') {
    issues.push(makeIssue(basePath, value === undefined ? 'required' : 'invalid_type', message))
  }
}

function validateStallDetectionPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = asRecord(value)
  if (!policy) {
    issues.push(makeIssue(basePath, 'required', 'stallDetection is required'))
    return
  }
  optionalEnum(
    policy['mode'],
    ['disabled', 'no-progress-plus-health'],
    joinPath(basePath, 'mode'),
    issues,
    true
  )
  if (policy['mode'] === 'no-progress-plus-health') {
    requireNumber(policy['noProgressMs'], joinPath(basePath, 'noProgressMs'), issues)
    optionalNumber(policy['minTurnAgeMs'], joinPath(basePath, 'minTurnAgeMs'), issues)
    optionalEnum(
      policy['healthProbe'],
      ['runner-status', 'driver-status', 'native-heartbeat'],
      joinPath(basePath, 'healthProbe'),
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
    issues.push(makeIssue(basePath, 'required', 'turnRetry is required'))
    return
  }
  optionalEnum(policy['mode'], ['none', 'safe-retry'], joinPath(basePath, 'mode'), issues, true)
  if (policy['mode'] !== 'safe-retry') return
  requireNumber(policy['maxAttempts'], joinPath(basePath, 'maxAttempts'), issues)
  validateEnumArray(
    policy['retryOn'],
    ['harness-stalled', 'harness-crashed'],
    joinPath(basePath, 'retryOn'),
    issues
  )
  const requires = asRecord(policy['requires'])
  if (!requires) {
    issues.push(
      makeIssue(joinPath(basePath, 'requires'), 'required', 'turnRetry.requires is required')
    )
  } else {
    requireTrue(
      requires['noToolCallObserved'],
      joinPath(basePath, 'requires.noToolCallObserved'),
      issues
    )
    requireTrue(
      requires['noPermissionRequestPending'],
      joinPath(basePath, 'requires.noPermissionRequestPending'),
      issues
    )
    if (requires['noPermissionRequestObserved'] !== undefined) {
      requireTrue(
        requires['noPermissionRequestObserved'],
        joinPath(basePath, 'requires.noPermissionRequestObserved'),
        issues
      )
    }
    requireTrue(
      requires['noAssistantFinalObserved'],
      joinPath(basePath, 'requires.noAssistantFinalObserved'),
      issues
    )
    requireTrue(
      requires['noExternalMutationObserved'],
      joinPath(basePath, 'requires.noExternalMutationObserved'),
      issues
    )
    requireTrue(
      requires['continuationKnown'],
      joinPath(basePath, 'requires.continuationKnown'),
      issues
    )
    requireTrue(
      requires['driverCanProvePriorTurnIncomplete'],
      joinPath(basePath, 'requires.driverCanProvePriorTurnIncomplete'),
      issues
    )
  }
  const identity = asRecord(policy['identity'])
  if (!identity) {
    issues.push(
      makeIssue(joinPath(basePath, 'identity'), 'required', 'turnRetry.identity is required')
    )
  } else {
    optionalEnum(
      identity['inputId'],
      ['same'],
      joinPath(basePath, 'identity.inputId'),
      issues,
      true
    )
    optionalEnum(
      identity['logicalTurnId'],
      ['same'],
      joinPath(basePath, 'identity.logicalTurnId'),
      issues,
      true
    )
    optionalEnum(
      identity['turnAttempt'],
      ['increment'],
      joinPath(basePath, 'identity.turnAttempt'),
      issues,
      true
    )
  }
  optionalEnum(
    policy['semantics'],
    ['at-least-once'],
    joinPath(basePath, 'semantics'),
    issues,
    true
  )
  optionalEnum(policy['onUnsafe'], ['fail-turn'], joinPath(basePath, 'onUnsafe'), issues, true)
}

// tmux id shape rules (regexes + validators) live in ./tmux-ids.

/**
 * Spec §3.3 dispatch-time contract: a `claude-code-tmux` / `codex-cli-tmux` /
 * `pi-tui-tmux`
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
  const runtimePath = joinPath(dispatchPath, 'runtime')
  const runtime = asRecord(dispatchRequest['runtime'])
  if (dispatchRequest['runtime'] !== undefined && !runtime) {
    issues.push(makeIssue(runtimePath, 'invalid_type', 'runtime must be an object'))
    return
  }

  // `tmux` is computed once: when present-but-not-an-object the legacy block
  // emits its issue and returns; past that point `tmux` is either undefined or
  // a valid record, so the driver-kind shim check below can reuse it.
  let tmux: SchemaRecord | undefined
  if (runtime?.['tmux'] !== undefined) {
    tmux = asRecord(runtime['tmux'])
    if (!tmux) {
      issues.push(
        makeIssue(joinPath(runtimePath, 'tmux'), 'invalid_type', 'tmux must be an object')
      )
      return
    }
    if (typeof tmux['socketPath'] !== 'string' || tmux['socketPath'].length === 0) {
      issues.push(
        makeIssue(
          joinPath(runtimePath, 'tmux.socketPath'),
          'required',
          'runtime tmux socketPath must be a non-empty string'
        )
      )
    }
  }

  // Validate `runtime.terminalSurface` whenever it is present, regardless of
  // driver kind. (Protocol layer rejects malformed leases up-front.)
  const terminalSurfaceRaw = runtime?.['terminalSurface']
  if (terminalSurfaceRaw !== undefined) {
    // Called for its side effect of emitting lease issues; the boolean return
    // is not consumed here (the detailed issues already cover any rejection).
    validateTerminalSurfaceLease(
      terminalSurfaceRaw,
      joinPath(runtimePath, 'terminalSurface'),
      issues
    )
  }
  optionalBoolean(
    runtime?.['terminalSurfaceRequired'],
    joinPath(runtimePath, 'terminalSurfaceRequired'),
    issues
  )

  if (
    driverKind !== 'claude-code-tmux' &&
    driverKind !== 'codex-cli-tmux' &&
    driverKind !== 'pi-tui-tmux'
  ) {
    return
  }

  const legacyShimSatisfied =
    !!tmux && typeof tmux['socketPath'] === 'string' && tmux['socketPath'].length > 0

  if (!legacyShimSatisfied && terminalSurfaceRaw === undefined) {
    issues.push(
      makeIssue(
        joinPath(runtimePath, 'terminalSurface'),
        'required',
        `${driverKind} dispatch requires either runtime.terminalSurface (tmux-pane lease) or legacy runtime.tmux.socketPath`
      )
    )
    return
  }

  // If neither the legacy shim nor a well-formed lease is present, the
  // detailed lease issues already emitted by validateTerminalSurfaceLease
  // cover the rejection. No extra issue needed.
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
    issues.push(makeIssue(basePath, 'invalid_type', 'terminalSurface must be an object'))
    return false
  }

  let ok = true

  if (surface['kind'] !== 'tmux-pane') {
    issues.push(
      makeIssue(
        joinPath(basePath, 'kind'),
        'invalid_literal',
        "terminalSurface.kind must be 'tmux-pane'"
      )
    )
    ok = false
  }
  if (surface['ownership'] !== 'hrc') {
    issues.push(
      makeIssue(
        joinPath(basePath, 'ownership'),
        'invalid_literal',
        "terminalSurface.ownership must be 'hrc'"
      )
    )
    ok = false
  }

  const socketPath = surface['socketPath']
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    issues.push(
      makeIssue(
        joinPath(basePath, 'socketPath'),
        'required',
        'terminalSurface.socketPath must be a non-empty string'
      )
    )
    ok = false
  }

  ok = validateTmuxPaneIds(surface, basePath, 'terminalSurface', issues) && ok

  optionalString(surface['sessionName'], joinPath(basePath, 'sessionName'), issues)
  optionalString(surface['windowName'], joinPath(basePath, 'windowName'), issues)

  const allowedOps = asRecord(surface['allowedOps'])
  const allowedOpsPath = joinPath(basePath, 'allowedOps')
  if (!allowedOps) {
    issues.push(makeIssue(allowedOpsPath, 'required', 'terminalSurface.allowedOps is required'))
    ok = false
  } else {
    requireTrue(allowedOps['inspect'], joinPath(allowedOpsPath, 'inspect'), issues)
    requireTrue(allowedOps['sendInput'], joinPath(allowedOpsPath, 'sendInput'), issues)
    requireTrue(allowedOps['sendInterrupt'], joinPath(allowedOpsPath, 'sendInterrupt'), issues)
    optionalBoolean(allowedOps['capture'], joinPath(allowedOpsPath, 'capture'), issues)
    optionalBoolean(allowedOps['resize'], joinPath(allowedOpsPath, 'resize'), issues)
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

/**
 * Validate the body of an invocation start request: a spec, an optional
 * initialInput, and the absence of any stale runtime/lifecycle overlay. Used by
 * both the top-level start-request validator (basePath `''`) and the nested
 * `startRequest` field of a dispatch request (basePath `'…startRequest'`). All
 * issue paths are derived from `basePath` so the two callers produce identical
 * {@link ValidationIssue.path} strings.
 */
function validateStartRequestBody(
  record: Record<string, unknown>,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateSpec(record['spec'], issues, joinPath(basePath, 'spec'))
  if (record['initialInput'] !== undefined) {
    validateInvocationInputShape(record['initialInput'], joinPath(basePath, 'initialInput'), issues)
  }
  rejectStaleStartRequestRuntime(record, basePath, issues)
}

function rejectStaleStartRequestRuntime(
  startRequest: Record<string, unknown>,
  startPath: string,
  issues: ValidationIssue[]
): void {
  if (Object.hasOwn(startRequest, 'runtime')) {
    issues.push(
      makeIssue(
        joinPath(startPath, 'runtime'),
        'stale_runtime_overlay',
        'startRequest.runtime is no longer accepted; put runtime on the InvocationDispatchRequest envelope'
      )
    )
  }
  if (Object.hasOwn(startRequest, 'lifecyclePolicy')) {
    issues.push(
      makeIssue(
        joinPath(startPath, 'lifecyclePolicy'),
        'stale_lifecycle_overlay',
        'startRequest.lifecyclePolicy is not accepted; put lifecyclePolicy on the InvocationDispatchRequest envelope'
      )
    )
  }
}

interface EventPayloadContext {
  driverKind?: string | undefined
}

/**
 * One validator per event type that carries a payload contract. Each receives
 * the already-unwrapped payload record (the `requirePayloadRecord` guard is
 * applied once in {@link validateEventPayload}). Event types without a payload
 * contract are simply absent from the table — the dispatcher no-ops on them,
 * replacing the former 27-case switch + `default: return`.
 */
type EventPayloadValidator = (
  payload: SchemaRecord,
  issues: ValidationIssue[],
  context: EventPayloadContext
) => void

const EVENT_PAYLOAD_VALIDATORS: Partial<Record<InvocationEventType, EventPayloadValidator>> = {
  'lifecycle.policy.accepted': (payload, issues) => {
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
  },
  'lifecycle.escalation': (payload, issues) => {
    optionalEnum(
      payload['reason'],
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
  },
  'harness.started': (payload, issues) => {
    validateRequiredPositiveInteger(payload['generation'], 'payload.generation', issues)
    optionalEnum(payload['mode'], ['initial', 'recycle'], 'payload.mode', issues, true)
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
  },
  'harness.exited': (payload, issues) => {
    validateRequiredPositiveInteger(payload['generation'], 'payload.generation', issues)
    optionalEnum(
      payload['reason'],
      ['idle-retire', 'operator-stop', 'crash', 'recycle-kill', 'process-exit', 'runner-exit'],
      'payload.reason',
      issues,
      true
    )
    optionalNumberOrNull(payload['exitCode'], 'payload.exitCode', issues)
    optionalString(payload['signal'], 'payload.signal', issues)
  },
  'harness.recovery.started': (payload, issues) => {
    validateRequiredPositiveInteger(payload['fromGeneration'], 'payload.fromGeneration', issues)
    optionalEnum(
      payload['reason'],
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
  },
  'harness.recovery.completed': (payload, issues) => {
    validateRequiredPositiveInteger(payload['fromGeneration'], 'payload.fromGeneration', issues)
    validateRequiredPositiveInteger(payload['toGeneration'], 'payload.toGeneration', issues)
    requireBoolean(payload['ready'], 'payload.ready', 'payload.ready must be a boolean', issues)
  },
  'harness.recovery.failed': (payload, issues) => {
    validateRequiredPositiveInteger(payload['fromGeneration'], 'payload.fromGeneration', issues)
    optionalEnum(
      payload['reason'],
      ['runner-unresponsive', 'kill-timeout', 'spawn-failed', 'continuation-missing'],
      'payload.reason',
      issues,
      true
    )
    optionalEnum(payload['requestedAction'], ['hard-reap'], 'payload.requestedAction', issues)
  },
  'invocation.ready': (payload, issues) => {
    optionalEnum(payload['state'], ['ready'], 'payload.state', issues, true)
  },
  'invocation.disposed': (payload, issues) => {
    requireTrue(payload['disposed'], 'payload.disposed', issues)
  },
  'permission.requested': (payload, issues) => {
    requireString(payload['permissionRequestId'], 'payload.permissionRequestId', issues)
    requireString(payload['kind'], 'payload.kind', issues)
    if (!Object.hasOwn(payload, 'subjectDisplay')) {
      issues.push(makeIssue('payload.subjectDisplay', 'required', 'subjectDisplay is required'))
    }
    optionalEnum(
      payload['defaultDecision'],
      ['allow', 'deny'],
      'payload.defaultDecision',
      issues,
      true
    )
    optionalNumber(payload['deadlineMs'], 'payload.deadlineMs', issues)
  },
  'turn.stalled': (payload, issues) => {
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
  },
  'turn.retry': (payload, issues) => {
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
      payload['reason'],
      ['harness-stalled', 'harness-crashed'],
      'payload.reason',
      issues,
      true
    )
    optionalEnum(payload['semantics'], ['at-least-once'], 'payload.semantics', issues, true)
  },
  'terminal.surface.reported': validateTerminalSurfaceReportedPayload,
  'permission.resolved': (payload, issues) => {
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
  },
  'permission.cancelled': (payload, issues) => {
    requireString(payload['permissionRequestId'], 'payload.permissionRequestId', issues)
    optionalEnum(
      payload['reason'],
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
  },
}

function validateTerminalSurfaceReportedPayload(
  payload: SchemaRecord,
  issues: ValidationIssue[],
  context: EventPayloadContext
): void {
  const driverKind = context.driverKind
  const requiresPaneKind =
    driverKind === 'claude-code-tmux' ||
    driverKind === 'codex-cli-tmux' ||
    driverKind === 'pi-tui-tmux'

  if (payload['kind'] === 'tmux-pane') {
    requireString(payload['socketPath'], 'payload.socketPath', issues)
    validateTmuxPaneIds(payload, 'payload', 'payload', issues)
    optionalString(payload['sessionName'], 'payload.sessionName', issues)
    optionalString(payload['windowName'], 'payload.windowName', issues)
  } else if (payload['kind'] === 'tmux-session') {
    if (requiresPaneKind) {
      issues.push(
        makeIssue(
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
    optionalEnum(payload['kind'], ['tmux-session', 'tmux-pane'], 'payload.kind', issues, true)
  }
}

function validateEventPayload(
  eventType: InvocationEventType,
  value: unknown,
  issues: ValidationIssue[],
  context: EventPayloadContext = {}
): void {
  const validator = EVENT_PAYLOAD_VALIDATORS[eventType]
  if (!validator) return
  const payload = requirePayloadRecord(value, issues)
  if (!payload) return
  validator(payload, issues, context)
}

function validateBrokerHelloParams(params: SchemaRecord, issues: ValidationIssue[]): void {
  const clientInfo = asRecord(params['clientInfo'])
  if (!clientInfo) {
    issues.push(makeIssue('params.clientInfo', 'required', 'clientInfo is required'))
  } else {
    requireString(clientInfo['name'], 'params.clientInfo.name', issues)
    optionalString(clientInfo['version'], 'params.clientInfo.version', issues)
  }

  requireStringArray(params['protocolVersions'], 'params.protocolVersions', issues)
  if (Array.isArray(params['protocolVersions'])) {
    params['protocolVersions'].forEach((version, index) => {
      if (
        typeof version === 'string' &&
        !(SUPPORTED_BROKER_PROTOCOL_VERSIONS as readonly string[]).includes(version)
      ) {
        issues.push(
          makeIssue(
            `params.protocolVersions.${index}`,
            'unsupported_broker_protocol',
            `unsupported broker protocol version: ${version}`
          )
        )
      }
    })
  }

  if (params['capabilities'] !== undefined) {
    validateClientCapabilities(params['capabilities'], 'params.capabilities', issues)
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
    issues.push(makeIssue(basePath, 'invalid_type', 'capabilities must be an object'))
  } else {
    optionalBoolean(
      capabilities['permissionRequests'],
      joinPath(basePath, 'permissionRequests'),
      issues
    )
    optionalBoolean(capabilities['eventAcks'], joinPath(basePath, 'eventAcks'), issues)
  }
}

function validateInvocationInputShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const input = asRecord(value)
  if (!input) {
    issues.push(makeIssue(basePath, 'required', 'input is required'))
    return
  }

  optionalString(input['inputId'], joinPath(basePath, 'inputId'), issues)
  optionalEnum(
    input['kind'],
    ['user', 'steer', 'append_context'],
    joinPath(basePath, 'kind'),
    issues,
    true
  )
  validateInputContent(input['content'], joinPath(basePath, 'content'), issues)
  validateStringRecord(input['metadata'], joinPath(basePath, 'metadata'), issues, false)
}

function validateInputContent(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const items = requireArray(value, basePath, issues, 'content must be an array')
  if (!items) {
    return
  }

  items.forEach((item, index) => {
    const itemPath = joinPath(basePath, String(index))
    const content = asRecord(item)
    if (!content) {
      issues.push(makeIssue(itemPath, 'invalid_type', 'content item must be an object'))
      return
    }

    if (content['type'] === 'text') {
      requireString(content['text'], joinPath(itemPath, 'text'), issues)
    } else if (content['type'] === 'local_image') {
      requireString(content['path'], joinPath(itemPath, 'path'), issues)
    } else if (content['type'] === 'file_ref') {
      requireString(content['path'], joinPath(itemPath, 'path'), issues)
      optionalString(content['mimeType'], joinPath(itemPath, 'mimeType'), issues)
    } else {
      issues.push(
        makeIssue(joinPath(itemPath, 'type'), 'invalid_literal', 'Unsupported input content type')
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
    issues.push(makeIssue(basePath, 'invalid_type', 'policy must be an object'))
    return
  }
  optionalEnum(
    policy['whenBusy'],
    ['reject', 'queue', 'interrupt_then_apply'],
    joinPath(basePath, 'whenBusy'),
    issues,
    true
  )
  optionalNumber(policy['timeoutMs'], joinPath(basePath, 'timeoutMs'), issues)
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
    issues.push(makeIssue(basePath, 'invalid_type', `${channel} must be an object`))
    return
  }
  const lockedRecord = asRecord(lockedEnv)
  const lockedEnvKeys = new Set(lockedRecord ? Object.keys(lockedRecord) : [])
  for (const [key, envValue] of Object.entries(record)) {
    const envPath = joinPath(basePath, key)
    if (!ENV_KEY_PATTERN.test(key)) {
      issues.push(
        makeIssue(
          envPath,
          'invalid_env_key',
          `${channel} key must match ${String(ENV_KEY_PATTERN)}`
        )
      )
    }
    if (isAmbientEnvKey(key)) {
      issues.push(
        makeIssue(envPath, 'ambient_env_key', `${channel} key conflicts with ambient env`)
      )
    }
    if (isCredentialEnvKey(key)) {
      issues.push(
        makeIssue(envPath, 'credential_env_key', `${channel} key conflicts with credential env`)
      )
    }
    if (isReservedEnvKey(key)) {
      issues.push(makeIssue(envPath, 'reserved_env_key', `${channel} key is reserved`))
    }
    if (channel === 'dispatchEnv' && lockedEnvKeys.has(key)) {
      issues.push(
        makeIssue(envPath, 'dispatch_env_shadow', 'dispatchEnv must not shadow lockedEnv')
      )
    }
    if (typeof envValue !== 'string') {
      issues.push(makeIssue(envPath, 'invalid_type', `${channel} value must be a string`))
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
    issues.push(makeIssue(basePath, 'required', 'harnessTransport is required'))
    return
  }
  optionalEnum(
    transport['kind'],
    ['jsonrpc-stdio', 'pipes', 'pty'],
    joinPath(basePath, 'kind'),
    issues,
    true
  )
  if (transport['kind'] === 'pty') {
    optionalNumber(transport['cols'], joinPath(basePath, 'cols'), issues)
    optionalNumber(transport['rows'], joinPath(basePath, 'rows'), issues)
  }
}

function validateProcessLimits(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const limits = asRecord(value)
  if (!limits) {
    issues.push(makeIssue(basePath, 'invalid_type', 'limits must be an object'))
    return
  }
  optionalNumber(limits['startupTimeoutMs'], joinPath(basePath, 'startupTimeoutMs'), issues)
  optionalNumber(limits['turnTimeoutMs'], joinPath(basePath, 'turnTimeoutMs'), issues)
  optionalNumber(limits['stopGraceMs'], joinPath(basePath, 'stopGraceMs'), issues)
  optionalNumber(limits['maxEventBytes'], joinPath(basePath, 'maxEventBytes'), issues)
}

function validateInteraction(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const interaction = asRecord(value)
  if (!interaction) {
    issues.push(makeIssue(basePath, 'invalid_type', 'interaction must be an object'))
    return
  }
  optionalEnum(
    interaction['mode'],
    ['headless', 'interactive', 'service'],
    joinPath(basePath, 'mode'),
    issues,
    true
  )
  if (interaction['turnConcurrency'] !== undefined && interaction['turnConcurrency'] !== 'single') {
    issues.push(
      makeIssue(
        joinPath(basePath, 'turnConcurrency'),
        'invalid_literal',
        'Unsupported turn concurrency'
      )
    )
  }
  optionalEnum(
    interaction['inputQueue'],
    ['none', 'fifo'],
    joinPath(basePath, 'inputQueue'),
    issues
  )
}

function validateContinuation(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const continuation = asRecord(value)
  if (!continuation) {
    issues.push(makeIssue(basePath, 'invalid_type', 'continuation must be an object'))
    return
  }
  requireString(continuation['provider'], joinPath(basePath, 'provider'), issues)
  requireString(continuation['key'], joinPath(basePath, 'key'), issues)
  if (continuation['kind'] !== undefined && typeof continuation['kind'] !== 'string') {
    issues.push(makeIssue(joinPath(basePath, 'kind'), 'invalid_type', 'kind must be a string'))
  }
}

function validateCodexDriver(
  driver: SchemaRecord,
  basePath: string,
  issues: ValidationIssue[]
): void {
  optionalString(driver['resumeThreadId'], joinPath(basePath, 'resumeThreadId'), issues)
  optionalString(driver['model'], joinPath(basePath, 'model'), issues)
  optionalString(driver['modelReasoningEffort'], joinPath(basePath, 'modelReasoningEffort'), issues)
  optionalString(driver['profile'], joinPath(basePath, 'profile'), issues)
  optionalStringArray(
    driver['defaultImageAttachments'],
    joinPath(basePath, 'defaultImageAttachments'),
    issues
  )
  optionalEnum(
    driver['approvalPolicy'],
    ['untrusted', 'on-failure', 'on-request', 'never'],
    joinPath(basePath, 'approvalPolicy'),
    issues
  )
  optionalEnum(
    driver['sandboxMode'],
    ['read-only', 'workspace-write', 'danger-full-access'],
    joinPath(basePath, 'sandboxMode'),
    issues
  )
  optionalEnum(
    driver['resumeFallback'],
    ['start-fresh', 'fail'],
    joinPath(basePath, 'resumeFallback'),
    issues
  )

  if (driver['permissionPolicy'] !== undefined) {
    const policy = asRecord(driver['permissionPolicy'])
    if (!policy) {
      issues.push(
        makeIssue(
          joinPath(basePath, 'permissionPolicy'),
          'invalid_type',
          'permissionPolicy must be an object'
        )
      )
    } else {
      optionalEnum(
        policy['mode'],
        ['deny', 'allow', 'ask-client'],
        joinPath(basePath, 'permissionPolicy.mode'),
        issues,
        true
      )
      optionalNumber(policy['timeoutMs'], joinPath(basePath, 'permissionPolicy.timeoutMs'), issues)
      optionalEnum(
        policy['defaultDecision'],
        ['allow', 'deny'],
        joinPath(basePath, 'permissionPolicy.defaultDecision'),
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
      issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
    }
    return
  }
  const record = asRecord(value)
  if (!record) {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be an object`))
    return
  }
  for (const [key, recordValue] of Object.entries(record)) {
    if (typeof recordValue !== 'string') {
      issues.push(makeIssue(joinPath(basePath, key), 'invalid_type', 'value must be a string'))
    }
  }
}

function validateEnumArray(
  value: unknown,
  allowed: string[],
  basePath: string,
  issues: ValidationIssue[]
): void {
  const items = requireArray(value, basePath, issues)
  if (!items) {
    return
  }
  items.forEach((item, index) => {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      issues.push(
        makeIssue(
          joinPath(basePath, String(index)),
          'invalid_literal',
          'array item has an unsupported value'
        )
      )
    }
  })
}

function validateOptionalEventTypeArray(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    return
  }
  const items = requireArray(value, basePath, issues)
  if (!items) {
    return
  }
  items.forEach((item, index) => {
    if (typeof item !== 'string' || !eventTypes.has(item as InvocationEventType)) {
      issues.push(
        makeIssue(joinPath(basePath, String(index)), 'invalid_event_type', 'Unsupported event type')
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
      makeIssue(basePath, 'invalid_positive_integer', `${basePath} must be a positive integer`)
    )
  }
}

function validateRequiredPositiveInteger(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
    return
  }
  validateOptionalPositiveInteger(value, basePath, issues)
}
