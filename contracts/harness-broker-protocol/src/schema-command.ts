import type { BrokerMethod } from './commands'
import type { ValidationIssue } from './errors.js'
import type { InvocationEventType } from './events'
import type { BrokerLifecyclePolicyOverlay } from './lifecycle.js'
import { lifecyclePolicyHash } from './lifecycle.js'
import { validateDispatchRuntime, validateStartRequestBody } from './schema-dispatch.js'
import {
  validateBrokerHelloParams,
  validateClientCapabilities,
  validateEnumArray,
  validateEnv,
  validateInputPolicy,
  validateInvocationInputShape,
  validateOptionalEventTypeArray,
  validateOptionalPositiveInteger,
  validateResponseFormat,
} from './schema-shapes.js'
import { eventTypes } from './schemas.js'
import type { SchemaRecord } from './schemas.js'
import {
  asRecord,
  joinPath,
  makeIssue,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  requireNonEmptyString,
  requireNumber,
  requireString,
  requireTrue,
} from './validation-primitives.js'

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
  'broker.installIdentity': (commandParams, issues) => {
    validateRuntimeIdentityShape(commandParams, 'params', issues)
  },
  'broker.ensureInvocation': (commandParams, issues) => {
    requireNonEmptyString(commandParams['startAttemptId'], 'params.startAttemptId', issues)
    requireNonEmptyString(commandParams['invocationId'], 'params.invocationId', issues)
    requireNumber(commandParams['attachEpoch'], 'params.attachEpoch', issues)
    // The start request and its dispatch options are the ORDINARY dispatch
    // envelope, validated by the ordinary validator — `ensureInvocation` wraps
    // `invocation.start`, it does not define a parallel start shape.
    validateInvocationDispatchRequestShape(commandParams, 'params', issues)
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
  'invocation.capture.release': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireNonEmptyString(commandParams['rawRecordId'], 'params.rawRecordId', issues)
    optionalEnum(
      commandParams['disposition'],
      ['ignored-known', 'normalized-as'],
      'params.disposition',
      issues,
      true
    )
    optionalString(commandParams['note'], 'params.note', issues)
    // `normalized-as` is the operator authoring a normalized event for the
    // blocked record, so the event it authors must be a real, known event type
    // with a payload — never a free-form bag that would enter the ledger
    // unvalidated. Its payload is validated against the event contract at emit.
    const normalizedAs = asRecord(commandParams['normalizedAs'])
    if (commandParams['disposition'] === 'normalized-as') {
      if (!normalizedAs) {
        issues.push(
          makeIssue(
            'params.normalizedAs',
            'required',
            "normalizedAs is required when disposition is 'normalized-as'"
          )
        )
      }
    } else if (Object.hasOwn(commandParams, 'normalizedAs') && normalizedAs === undefined) {
      issues.push(
        makeIssue('params.normalizedAs', 'invalid_type', 'normalizedAs must be an object')
      )
    }
    if (normalizedAs) {
      if (
        typeof normalizedAs['type'] !== 'string' ||
        !eventTypes.has(normalizedAs['type'] as InvocationEventType)
      ) {
        issues.push(
          makeIssue('params.normalizedAs.type', 'invalid_event_type', 'Unsupported event type')
        )
      }
      if (!Object.hasOwn(normalizedAs, 'payload')) {
        issues.push(
          makeIssue('params.normalizedAs.payload', 'required', 'normalizedAs.payload is required')
        )
      }
      optionalString(normalizedAs['turnId'], 'params.normalizedAs.turnId', issues)
      optionalString(normalizedAs['itemId'], 'params.normalizedAs.itemId', issues)
    }
  },
  'submission.steer': (commandParams, issues) => {
    validateSubmissionParams(commandParams, issues, false, false)
  },
  'submission.enqueue': (commandParams, issues) => {
    validateSubmissionParams(commandParams, issues, true, true)
  },
  'submission.invoke': (commandParams, issues) => {
    validateSubmissionParams(commandParams, issues, false, true)
  },
  'submission.preempt': (commandParams, issues) => {
    validateSubmissionParams(commandParams, issues, true, true)
  },
  'submission.withdraw': (commandParams, issues) => {
    const allowed = new Set(['submissionId', 'envelopeId', 'reason'])
    for (const key of Object.keys(commandParams)) {
      if (!allowed.has(key)) {
        issues.push(makeIssue(`params.${key}`, 'unexpected_key', `${key} is not accepted`))
      }
    }
    const submissionId = commandParams['submissionId']
    const envelopeId = commandParams['envelopeId']
    if ((submissionId === undefined) === (envelopeId === undefined)) {
      issues.push(
        makeIssue(
          'params',
          'invalid_selector',
          'Exactly one of submissionId or envelopeId is required'
        )
      )
    } else if (submissionId !== undefined) {
      requireString(submissionId, 'params.submissionId', issues)
    } else {
      requireString(envelopeId, 'params.envelopeId', issues)
    }
    requireString(commandParams['reason'], 'params.reason', issues)
  },
  'queue.list': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
  },
  'queue.jump': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireString(commandParams['submissionId'], 'params.submissionId', issues)
    requireNumber(commandParams['position'], 'params.position', issues)
    requireString(commandParams['principalRef'], 'params.principalRef', issues)
  },
  'queue.cancel': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireString(commandParams['submissionId'], 'params.submissionId', issues)
    requireString(commandParams['principalRef'], 'params.principalRef', issues)
  },
  'turn.manifest': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
    requireString(commandParams['turnId'], 'params.turnId', issues)
  },
  'seat.probe': (commandParams, issues) => {
    requireString(commandParams['invocationId'], 'params.invocationId', issues)
  },
}

function validateSubmissionParams(
  params: SchemaRecord,
  issues: ValidationIssue[],
  allowTtl: boolean,
  allowTurnPolicy: boolean
): void {
  const allowed = new Set([
    'invocationId',
    'origin',
    'body',
    'responseFormat',
    'freshContext',
    ...(allowTtl ? ['ttlMs'] : []),
    ...(allowTurnPolicy ? ['turnPolicy'] : []),
  ])
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      issues.push(makeIssue(`params.${key}`, 'unexpected_key', `${key} is not accepted`))
    }
  }
  requireString(params['invocationId'], 'params.invocationId', issues)
  const origin = asRecord(params['origin'])
  if (!origin) {
    issues.push(makeIssue('params.origin', 'required', 'origin is required'))
  } else {
    requireString(origin['principalRef'], 'params.origin.principalRef', issues)
    optionalString(origin['scopeRef'], 'params.origin.scopeRef', issues)
    optionalString(origin['envelopeId'], 'params.origin.envelopeId', issues)
  }
  requireString(params['body'], 'params.body', issues)
  validateResponseFormat(params['responseFormat'], 'params.responseFormat', issues)
  optionalBoolean(params['freshContext'], 'params.freshContext', issues)
  if (allowTtl) {
    optionalNumber(params['ttlMs'], 'params.ttlMs', issues)
    if (typeof params['ttlMs'] === 'number' && params['ttlMs'] <= 0) {
      issues.push(makeIssue('params.ttlMs', 'out_of_range', 'ttlMs must be greater than zero'))
    }
  }
  if (allowTurnPolicy) {
    optionalEnum(params['turnPolicy'], ['open', 'guarded'], 'params.turnPolicy', issues)
  }
}

export function validateCommandParams(
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

export function validatePermissionRequestParamsShape(
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

/**
 * The eight-field runtime identity `broker.installIdentity` carries (§C.5).
 * Structural only: whether the identity is ADMISSIBLE — matching the launch
 * identity, and not conflicting with one already installed — is the broker's
 * decision, not the wire schema's.
 */
function validateRuntimeIdentityShape(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const identity = asRecord(value)
  if (!identity) {
    issues.push(makeIssue(basePath, 'invalid_type', 'Runtime identity must be an object'))
    return
  }
  requireNonEmptyString(identity['runtimeId'], joinPath(basePath, 'runtimeId'), issues)
  requireNonEmptyString(identity['hostSessionId'], joinPath(basePath, 'hostSessionId'), issues)
  requireNumber(identity['generation'], joinPath(basePath, 'generation'), issues)
  requireNumber(identity['attachEpoch'], joinPath(basePath, 'attachEpoch'), issues)
  requireNonEmptyString(identity['invocationId'], joinPath(basePath, 'invocationId'), issues)
  requireNonEmptyString(
    identity['startRequestHash'],
    joinPath(basePath, 'startRequestHash'),
    issues
  )
  requireNonEmptyString(
    identity['selectedProfileHash'],
    joinPath(basePath, 'selectedProfileHash'),
    issues
  )
  requireNonEmptyString(identity['attachToken'], joinPath(basePath, 'attachToken'), issues)
}

export function validateInvocationDispatchRequestShape(
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
export function requireBoolean(
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
