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
import { PROVIDER_TRANSCRIPT_ARTIFACT_KIND } from './events.js'
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
  requireNonEmptyString,
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
  'invocation.capture.release',
  'submission.steer',
  'submission.enqueue',
  'submission.invoke',
  'submission.preempt',
  'queue.list',
  'queue.jump',
  'queue.cancel',
  'turn.manifest',
  'seat.probe',
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
  'admission.requested',
  'admission.admitted',
  'admission.rejected',
  'queue.enqueued',
  'queue.jumped',
  'queue.cancelled',
  'queue.expired',
  'interrupt.requested',
  'interrupt.landed',
  'interrupt.failed',
  'submission.absorbed',
  'submission.executed',
  'submission.rejected',
  'submission.expired',
  'submission.cancelled',
  'capture.warning',
  'capture.released',
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
  'provider.transcript.reported',
] as const satisfies readonly InvocationEventType[]

const BROKER_PROVENANCE_EVENT_TYPES = new Set<InvocationEventType>([
  'admission.requested',
  'admission.admitted',
  'admission.rejected',
  'queue.enqueued',
  'queue.jumped',
  'queue.cancelled',
  'queue.expired',
  'interrupt.requested',
  'interrupt.landed',
  'interrupt.failed',
  'submission.absorbed',
  'submission.executed',
  'submission.rejected',
  'submission.expired',
  'submission.cancelled',
  'capture.warning',
])

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

export function validateEventEnvelope<K extends InvocationEventType>(
  value: InvocationEventEnvelope<K>
): InvocationEventEnvelope<K>
export function validateEventEnvelope(value: unknown): InvocationEventEnvelope
export function validateEventEnvelope(value: unknown): InvocationEventEnvelope {
  const issues: ValidationIssue[] = []
  const envelope = asRecord(value)
  if (!envelope) {
    issues.push(makeIssue('', 'invalid_type', 'Event envelope must be an object'))
  } else {
    requireString(envelope['invocationId'], 'invocationId', issues)
    requireNumber(envelope['seq'], 'seq', issues)
    requireString(envelope['time'], 'time', issues)
    const eventType =
      typeof envelope['type'] !== 'string' ||
      !eventTypes.has(envelope['type'] as InvocationEventType)
        ? undefined
        : (envelope['type'] as InvocationEventType)
    if (eventType === undefined) {
      issues.push(makeIssue('type', 'invalid_event_type', 'Unsupported event type'))
    }
    if (!Object.hasOwn(envelope, 'payload')) {
      issues.push(makeIssue('payload', 'required', 'payload is required'))
    } else if (eventType !== undefined) {
      const driverKind = asRecord(envelope['driver'])?.['kind']
      validateEventProvenance(envelope['provenance'], issues)
      validateOptionalPositiveInteger(envelope['harnessGeneration'], 'harnessGeneration', issues)
      validateOptionalPositiveInteger(envelope['turnAttempt'], 'turnAttempt', issues)
      validateEventPayload(eventType, envelope['payload'], issues, {
        driverKind: typeof driverKind === 'string' ? driverKind : undefined,
      })
      if (BROKER_PROVENANCE_EVENT_TYPES.has(eventType)) {
        validateBrokerProvenance(envelope['provenance'], issues)
      }
    }
  }

  if (issues.length > 0) {
    throw new EventEnvelopeValidationError(issues)
  }
  return value as InvocationEventEnvelope
}

/**
 * Optional envelope provenance (T-07853 §7.2). Optional on the wire so ledger
 * records committed before the capture contract landed still replay; when
 * PRESENT it must be complete enough to be actionable — a source kind and a
 * named/versioned normalizer — rather than a half-filled bag.
 */
function validateEventProvenance(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const provenance = asRecord(value)
  if (!provenance) {
    issues.push(makeIssue('provenance', 'invalid_type', 'provenance must be an object'))
    return
  }
  optionalEnum(
    provenance['sourceKind'],
    ['provider-jsonl', 'provider-jsonrpc', 'hook', 'broker'],
    'provenance.sourceKind',
    issues,
    true
  )
  const normalizer = asRecord(provenance['normalizer'])
  if (!normalizer) {
    issues.push(makeIssue('provenance.normalizer', 'required', 'normalizer is required'))
  } else {
    requireNonEmptyString(normalizer['name'], 'provenance.normalizer.name', issues)
    requireNonEmptyString(normalizer['version'], 'provenance.normalizer.version', issues)
  }
  optionalString(provenance['rawRecordId'], 'provenance.rawRecordId', issues)
  optionalString(provenance['sourceEpoch'], 'provenance.sourceEpoch', issues)
  optionalString(provenance['nativeType'], 'provenance.nativeType', issues)
  optionalString(provenance['nativeId'], 'provenance.nativeId', issues)
  optionalString(provenance['rawSha256'], 'provenance.rawSha256', issues)
  if (provenance['sourceCursor'] !== undefined) {
    const cursor = asRecord(provenance['sourceCursor'])
    if (!cursor) {
      issues.push(
        makeIssue('provenance.sourceCursor', 'invalid_type', 'sourceCursor must be an object')
      )
    } else {
      for (const [key, entry] of Object.entries(cursor)) {
        if (typeof entry !== 'string' && typeof entry !== 'number') {
          issues.push(
            makeIssue(
              `provenance.sourceCursor.${key}`,
              'invalid_type',
              'sourceCursor values must be strings or numbers'
            )
          )
        }
      }
    }
  }
}

function validateBrokerProvenance(value: unknown, issues: ValidationIssue[]): void {
  const provenance = asRecord(value)
  if (!provenance) {
    issues.push(makeIssue('provenance', 'required', 'broker decision provenance is required'))
    return
  }
  optionalEnum(provenance['sourceKind'], ['broker'], 'provenance.sourceKind', issues, true)
  const normalizer = asRecord(provenance['normalizer'])
  if (!normalizer) {
    issues.push(makeIssue('provenance.normalizer', 'required', 'normalizer is required'))
    return
  }
  requireString(normalizer['name'], 'provenance.normalizer.name', issues)
  requireString(normalizer['version'], 'provenance.normalizer.version', issues)
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

  validateSdkContract(spec, harness, process, prefix, issues)
  validateAgentHarnessSpec(spec['agent'], joinPath(prefix, 'agent'), issues)
  validateLaunch(spec['launch'], joinPath(prefix, 'launch'), issues)
}

function validateAgentHarnessSpec(value: unknown, prefix: string, issues: ValidationIssue[]): void {
  if (value === undefined) return
  const agent = asRecord(value)
  if (!agent) {
    issues.push(makeIssue(prefix, 'invalid_type', 'agent must be an object'))
    return
  }
  requireNonEmptyString(agent['agentId'], joinPath(prefix, 'agentId'), issues)
  optionalString(agent['projectId'], joinPath(prefix, 'projectId'), issues)
  optionalString(agent['agentRoot'], joinPath(prefix, 'agentRoot'), issues)
  optionalString(agent['projectRoot'], joinPath(prefix, 'projectRoot'), issues)
  optionalString(agent['aspHome'], joinPath(prefix, 'aspHome'), issues)
  optionalEnum(
    agent['runMode'],
    ['query', 'heartbeat', 'task', 'maintenance'],
    joinPath(prefix, 'runMode'),
    issues
  )
  optionalString(agent['scopeRef'], joinPath(prefix, 'scopeRef'), issues)
  optionalString(agent['laneRef'], joinPath(prefix, 'laneRef'), issues)
  optionalString(agent['runId'], joinPath(prefix, 'runId'), issues)
  optionalString(agent['hostSessionId'], joinPath(prefix, 'hostSessionId'), issues)
  optionalNumber(agent['generation'], joinPath(prefix, 'generation'), issues)
}

function validateSdkContract(
  spec: SchemaRecord,
  harness: SchemaRecord | undefined,
  process: SchemaRecord | undefined,
  prefix: string,
  issues: ValidationIssue[]
): void {
  const sdkPath = joinPath(prefix, 'sdk')
  const driverKind = harness?.['driver']
  const carriesSdkBlock =
    driverKind === 'pi-sdk' || driverKind === 'agent-harness' || driverKind === 'agent-harness-tmux'
  const requiresInProcessHost = driverKind === 'pi-sdk' || driverKind === 'agent-harness'
  const sdk = asRecord(spec['sdk'])

  if (!carriesSdkBlock) {
    if (Object.hasOwn(spec, 'sdk')) {
      issues.push(makeIssue(sdkPath, 'forbidden', 'sdk is only supported by Pi SDK-backed drivers'))
    }
    if (asRecord(process?.['harnessTransport'])?.['kind'] === 'in-process') {
      issues.push(
        makeIssue(
          joinPath(prefix, 'process.harnessTransport.kind'),
          'forbidden',
          'in-process transport is only supported by the pi-sdk driver'
        )
      )
    }
    return
  }

  if (!sdk) {
    issues.push(makeIssue(sdkPath, 'required', 'sdk is required for the pi-sdk driver'))
  } else {
    optionalEnum(sdk['runtime'], ['pi-sdk'], joinPath(sdkPath, 'runtime'), issues, true)
    requireString(sdk['provider'], joinPath(sdkPath, 'provider'), issues)
    requireString(sdk['modelId'], joinPath(sdkPath, 'modelId'), issues)
    optionalEnum(sdk['authMode'], ['api-key', 'oauth'], joinPath(sdkPath, 'authMode'), issues, true)
    optionalString(sdk['thinkingLevel'], joinPath(sdkPath, 'thinkingLevel'), issues)
  }

  if (!process) {
    return
  }
  if (requiresInProcessHost && asRecord(process['harnessTransport'])?.['kind'] !== 'in-process') {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.harnessTransport.kind'),
        'invalid_literal',
        'pi-sdk requires in-process transport'
      )
    )
  }
  if (requiresInProcessHost && process['command'] !== 'in-process') {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.command'),
        'invalid_literal',
        'pi-sdk requires the in-process command sentinel'
      )
    )
  }
  if (requiresInProcessHost && Array.isArray(process['args']) && process['args'].length !== 0) {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.args'),
        'invalid_literal',
        'pi-sdk requires an empty args array'
      )
    )
  }
  if (
    driverKind === 'agent-harness-tmux' &&
    asRecord(process['harnessTransport'])?.['kind'] !== 'pty'
  ) {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.harnessTransport.kind'),
        'invalid_literal',
        'agent-harness-tmux requires pty transport'
      )
    )
  }
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
    driverKind !== 'pi-tui-tmux' &&
    driverKind !== 'agent-harness-tmux'
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
 * One validator per event type. Each receives the already-unwrapped payload
 * record (the `requirePayloadRecord` guard is applied once in
 * {@link validateEventPayload}). The mapped table is deliberately total so a
 * new map key cannot ship without an explicit runtime validation decision.
 */
type EventPayloadValidator = (
  payload: SchemaRecord,
  issues: ValidationIssue[],
  context: EventPayloadContext
) => void

type EventPayloadValidators = {
  [K in InvocationEventType]: EventPayloadValidator
}

const EVENT_PAYLOAD_VALIDATORS = {
  'invocation.started': (payload, issues) => {
    optionalNumber(payload['pid'], 'payload.pid', issues)
    requireString(payload['command'], 'payload.command', issues)
    requireStringArray(payload['args'], 'payload.args', issues)
    requireString(payload['cwd'], 'payload.cwd', issues)
  },
  'invocation.ready': (payload, issues) => {
    optionalEnum(payload['state'], ['ready'], 'payload.state', issues, true)
  },
  'invocation.stopping': (payload, issues) => {
    optionalString(payload['reason'], 'payload.reason', issues)
  },
  'invocation.exited': (payload, issues) => {
    optionalNumberOrNull(payload['exitCode'], 'payload.exitCode', issues)
    optionalStringOrNull(payload['signal'], 'payload.signal', issues)
    optionalString(payload['reason'], 'payload.reason', issues)
    optionalBoolean(payload['droppedContinuation'], 'payload.droppedContinuation', issues)
  },
  'invocation.failed': (payload, issues) => {
    requireString(payload['message'], 'payload.message', issues)
    optionalString(payload['code'], 'payload.code', issues)
    optionalBoolean(payload['retryable'], 'payload.retryable', issues)
    optionalString(payload['reason'], 'payload.reason', issues)
  },
  'invocation.disposed': (payload, issues) => {
    requireTrue(payload['disposed'], 'payload.disposed', issues)
  },
  'invocation.summary': (payload, issues) => {
    if (!asRecord(payload['summary'])) {
      issues.push(
        makeIssue(
          'payload.summary',
          payload['summary'] === undefined ? 'required' : 'invalid_type',
          'payload.summary must be an object'
        )
      )
    }
    optionalString(payload['reason'], 'payload.reason', issues)
  },
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
  'continuation.updated': (payload, issues) => {
    requireString(payload['provider'], 'payload.provider', issues)
    requireString(payload['key'], 'payload.key', issues)
    optionalString(payload['kind'], 'payload.kind', issues)
  },
  'continuation.cleared': (payload, issues) => {
    optionalString(payload['reason'], 'payload.reason', issues)
  },
  'input.accepted': validateInputDispositionPayload,
  'input.rejected': validateInputDispositionPayload,
  'input.queued': validateInputDispositionPayload,
  'admission.requested': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(
      payload['class'],
      ['steer', 'queue', 'exclusive', 'preempt'],
      'payload.class',
      issues,
      true
    )
    const origin = asRecord(payload['origin'])
    if (!origin) {
      issues.push(makeIssue('payload.origin', 'required', 'origin is required'))
    } else {
      requireString(origin['principalRef'], 'payload.origin.principalRef', issues)
      optionalString(origin['scopeRef'], 'payload.origin.scopeRef', issues)
      optionalString(origin['envelopeId'], 'payload.origin.envelopeId', issues)
    }
    optionalEnum(payload['turnPolicy'], ['open', 'guarded'], 'payload.turnPolicy', issues)
    optionalBoolean(payload['freshContext'], 'payload.freshContext', issues)
  },
  'admission.admitted': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(
      payload['class'],
      ['steer', 'queue', 'exclusive', 'preempt'],
      'payload.class',
      issues,
      true
    )
  },
  'admission.rejected': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(
      payload['class'],
      ['steer', 'queue', 'exclusive', 'preempt'],
      'payload.class',
      issues,
      true
    )
    optionalEnum(
      payload['layer'],
      ['capability', 'policy', 'authority', 'state'],
      'payload.layer',
      issues,
      true
    )
    requireString(payload['reason'], 'payload.reason', issues)
  },
  'queue.enqueued': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(payload['class'], ['queue', 'preempt'], 'payload.class', issues, true)
    requireNumber(payload['position'], 'payload.position', issues)
    optionalNumber(payload['ttlMs'], 'payload.ttlMs', issues)
  },
  'queue.jumped': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireNumber(payload['fromPosition'], 'payload.fromPosition', issues)
    requireNumber(payload['toPosition'], 'payload.toPosition', issues)
    requireString(payload['principalRef'], 'payload.principalRef', issues)
  },
  'queue.cancelled': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireString(payload['principalRef'], 'payload.principalRef', issues)
  },
  'queue.expired': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
  },
  'interrupt.requested': validateInterruptDecisionPayload,
  'interrupt.landed': validateInterruptDecisionPayload,
  'interrupt.failed': (payload, issues) => {
    validateInterruptDecisionPayload(payload, issues)
    requireString(payload['reason'], 'payload.reason', issues)
  },
  'submission.absorbed': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireString(payload['turnId'], 'payload.turnId', issues)
  },
  'submission.executed': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireString(payload['turnId'], 'payload.turnId', issues)
  },
  'submission.rejected': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireString(payload['reason'], 'payload.reason', issues)
  },
  'submission.expired': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
  },
  'submission.cancelled': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(
      payload['reason'],
      ['recalled', 'removed', 'teardown', 'broker-cancelled'],
      'payload.reason',
      issues
    )
  },
  'capture.warning': (payload, issues) => {
    requireString(payload['message'], 'payload.message', issues)
    if (!Object.hasOwn(payload, 'raw')) {
      issues.push(makeIssue('payload.raw', 'required', 'payload.raw is required'))
    }
    optionalString(payload['kind'], 'payload.kind', issues)
  },
  'capture.released': (payload, issues) => {
    requireNonEmptyString(payload['rawRecordId'], 'payload.rawRecordId', issues)
    optionalEnum(
      payload['disposition'],
      ['ignored-known', 'normalized'],
      'payload.disposition',
      issues,
      true
    )
    requireNumber(payload['resumedRecords'], 'payload.resumedRecords', issues)
    optionalString(payload['nativeType'], 'payload.nativeType', issues)
    optionalString(payload['family'], 'payload.family', issues)
    optionalString(payload['note'], 'payload.note', issues)
    const normalizedAs = asRecord(payload['normalizedAs'])
    if (normalizedAs) {
      if (
        typeof normalizedAs['type'] !== 'string' ||
        !eventTypes.has(normalizedAs['type'] as InvocationEventType)
      ) {
        issues.push(
          makeIssue('payload.normalizedAs.type', 'invalid_event_type', 'Unsupported event type')
        )
      }
    }
  },
  'turn.started': (payload, issues) => {
    requireString(payload['turnId'], 'payload.turnId', issues)
    optionalString(payload['inputId'], 'payload.inputId', issues)
    validateOptionalPositiveInteger(payload['turnAttempt'], 'payload.turnAttempt', issues)
    optionalEnum(payload['source'], ['broker-delivery', 'hook-observed'], 'payload.source', issues)
    optionalString(payload['sessionId'], 'payload.sessionId', issues)
    optionalString(payload['prompt'], 'payload.prompt', issues)
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
  'turn.completed': (payload, issues) => {
    requireString(payload['turnId'], 'payload.turnId', issues)
    optionalEnum(
      payload['status'],
      ['completed', 'failed', 'interrupted'],
      'payload.status',
      issues,
      true
    )
    optionalString(payload['finalOutput'], 'payload.finalOutput', issues)
    optionalBoolean(payload['producedContent'], 'payload.producedContent', issues)
  },
  'turn.failed': (payload, issues) => {
    requireString(payload['turnId'], 'payload.turnId', issues)
    optionalEnum(payload['status'], ['failed'], 'payload.status', issues)
    requireNonEmptyString(payload['message'], 'payload.message', issues)
    optionalString(payload['finalOutput'], 'payload.finalOutput', issues)
    optionalString(payload['code'], 'payload.code', issues)
    optionalBoolean(payload['retryable'], 'payload.retryable', issues)
    optionalString(payload['reason'], 'payload.reason', issues)
    validateOptionalPositiveInteger(payload['turnAttempt'], 'payload.turnAttempt', issues)
    optionalBoolean(payload['retrySuppressed'], 'payload.retrySuppressed', issues)
  },
  'turn.interrupted': (payload, issues) => {
    requireString(payload['turnId'], 'payload.turnId', issues)
    optionalEnum(payload['status'], ['interrupted'], 'payload.status', issues)
    optionalString(payload['finalOutput'], 'payload.finalOutput', issues)
    optionalString(payload['reason'], 'payload.reason', issues)
  },
  'assistant.message.started': (payload, issues) => {
    requireString(payload['messageId'], 'payload.messageId', issues)
  },
  'assistant.message.delta': (payload, issues) => {
    requireString(payload['messageId'], 'payload.messageId', issues)
    requireString(payload['text'], 'payload.text', issues)
  },
  'assistant.message.completed': (payload, issues) => {
    requireString(payload['messageId'], 'payload.messageId', issues)
    validateAssistantMessageContent(payload['content'], issues)
    optionalBoolean(payload['final'], 'payload.final', issues)
  },
  'user.message': (payload, issues) => {
    requireString(payload['content'], 'payload.content', issues)
    optionalString(payload['inputId'], 'payload.inputId', issues)
    optionalEnum(payload['role'], ['user'], 'payload.role', issues)
    optionalString(payload['turnId'], 'payload.turnId', issues)
  },
  'tool.call.started': (payload, issues) => {
    requireString(payload['toolCallId'], 'payload.toolCallId', issues)
    requireString(payload['name'], 'payload.name', issues)
  },
  'tool.call.delta': (payload, issues) => {
    requireString(payload['toolCallId'], 'payload.toolCallId', issues)
    optionalString(payload['text'], 'payload.text', issues)
  },
  'tool.call.completed': (payload, issues) => {
    requireString(payload['toolCallId'], 'payload.toolCallId', issues)
    requireString(payload['name'], 'payload.name', issues)
    optionalBoolean(payload['isError'], 'payload.isError', issues)
    optionalNumber(payload['durationMs'], 'payload.durationMs', issues)
  },
  // Terminal-outcome contract (T-06550): a failed tool call carries a REQUIRED
  // human `message` and an ALWAYS-populated machine-readable `code` — the code
  // is required, not optional, so the normative carrier rejects any producer
  // (driver or the broker teardown synthesizer) that omits it.
  'tool.call.failed': (payload, issues) => {
    requireString(payload['toolCallId'], 'payload.toolCallId', issues)
    requireString(payload['name'], 'payload.name', issues)
    requireString(payload['message'], 'payload.message', issues)
    requireString(payload['code'], 'payload.code', issues)
  },
  'usage.updated': (payload, issues) => {
    if (!Object.hasOwn(payload, 'usage')) {
      issues.push(makeIssue('payload.usage', 'required', 'usage is required'))
    }
  },
  diagnostic: (payload, issues) => {
    optionalEnum(
      payload['level'],
      ['debug', 'info', 'warn', 'error'],
      'payload.level',
      issues,
      true
    )
    requireString(payload['message'], 'payload.message', issues)
    optionalEnum(payload['source'], ['broker', 'harness', 'driver'], 'payload.source', issues)
    optionalString(payload['kind'], 'payload.kind', issues)
  },
  'driver.notice': (payload, issues) => {
    requireString(payload['message'], 'payload.message', issues)
    optionalString(payload['code'], 'payload.code', issues)
  },
  'terminal.surface.reported': validateTerminalSurfaceReportedPayload,
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
  'provider.transcript.reported': (payload, issues) => {
    if (payload['kind'] !== PROVIDER_TRANSCRIPT_ARTIFACT_KIND) {
      issues.push(
        makeIssue(
          'payload.kind',
          'invalid_literal',
          `payload.kind must be '${PROVIDER_TRANSCRIPT_ARTIFACT_KIND}'`
        )
      )
    }
    if (payload['provider'] !== 'codex') {
      issues.push(
        makeIssue('payload.provider', 'invalid_literal', "payload.provider must be 'codex'")
      )
    }
    validateAbsolutePath(payload['artifactPath'], 'payload.artifactPath', issues)
    validateOptionalPositiveInteger(
      payload['harnessGeneration'],
      'payload.harnessGeneration',
      issues
    )
  },
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
} satisfies EventPayloadValidators

function optionalStringOrNull(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== null) {
    optionalString(value, basePath, issues)
  }
}

function validateInputDispositionPayload(payload: SchemaRecord, issues: ValidationIssue[]): void {
  requireString(payload['inputId'], 'payload.inputId', issues)
  optionalEnum(
    payload['disposition'],
    ['started', 'queued', 'attempted_steer', 'rejected'],
    'payload.disposition',
    issues
  )
  optionalString(payload['reason'], 'payload.reason', issues)
}

function validateInterruptDecisionPayload(payload: SchemaRecord, issues: ValidationIssue[]): void {
  optionalString(payload['submissionId'], 'payload.submissionId', issues)
  optionalString(payload['turnId'], 'payload.turnId', issues)
}

function validateAssistantMessageContent(value: unknown, issues: ValidationIssue[]): void {
  const content = requireArray(value, 'payload.content', issues)
  if (!content) {
    return
  }
  content.forEach((item, index) => {
    const path = `payload.content.${index}`
    const record = asRecord(item)
    if (!record) {
      issues.push(makeIssue(path, 'invalid_type', `${path} must be an object`))
      return
    }
    optionalEnum(record['type'], ['text'], `${path}.type`, issues, true)
    requireString(record['text'], `${path}.text`, issues)
  })
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
    driverKind === 'pi-tui-tmux' ||
    driverKind === 'agent-harness-tmux'

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
  validateResponseFormat(input['responseFormat'], joinPath(basePath, 'responseFormat'), issues)
  validateStringRecord(input['metadata'], joinPath(basePath, 'metadata'), issues, false)
}

/**
 * Validate an optional per-turn `responseFormat` (T-03779). Accepts only
 * `{ kind: 'text' }` (no `schema`) and `{ kind: 'json_schema', schema }` with a
 * plain-object schema root whose values are all JSON-representable. Rejects
 * null/array/primitive schema roots, missing schema, text formats carrying a
 * schema, unknown kinds, and any non-JSON value nested anywhere in the schema.
 */
function validateResponseFormat(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const format = asRecord(value)
  if (!format) {
    issues.push(makeIssue(basePath, 'invalid_type', 'responseFormat must be an object'))
    return
  }
  const kind = format['kind']
  if (kind === 'text') {
    if ('schema' in format) {
      issues.push(
        makeIssue(
          joinPath(basePath, 'schema'),
          'unexpected_key',
          'text responseFormat must not carry a schema'
        )
      )
    }
    return
  }
  if (kind === 'json_schema') {
    const schemaPath = joinPath(basePath, 'schema')
    const schema = asRecord(format['schema'])
    if (!schema) {
      issues.push(
        makeIssue(
          schemaPath,
          'invalid_type',
          'json_schema responseFormat schema must be a plain object'
        )
      )
      return
    }
    validateJsonValue(schema, schemaPath, issues)
    return
  }
  issues.push(
    makeIssue(joinPath(basePath, 'kind'), 'invalid_literal', 'responseFormat kind is unsupported')
  )
}

/** True only for objects with a plain (`Object.prototype` or null) prototype. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively assert `value` is JSON-representable. Permits null, string,
 * boolean, finite number, arrays, and plain objects; rejects undefined,
 * function, symbol, bigint, NaN/Infinity, and non-plain objects (Date, Map,
 * Set, class instances). Offending values are reported at their nested path.
 */
function validateJsonValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === null) {
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push(makeIssue(path, 'invalid_type', `${path} must be a finite number`))
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateJsonValue(item, joinPath(path, String(index)), issues)
    })
    return
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      validateJsonValue(nested, joinPath(path, key), issues)
    }
    return
  }
  issues.push(makeIssue(path, 'invalid_type', `${path} must be a JSON value`))
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
    ['reject', 'queue', 'interrupt_then_apply', 'steer'],
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
    ['jsonrpc-stdio', 'pipes', 'pty', 'in-process'],
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

/**
 * Validate a present, non-empty, absolute filesystem path string. Absolute-path
 * detection is implemented locally so the protocol package pulls in no HRC /
 * node path helper. POSIX absolute paths begin with `/`; Windows absolute paths
 * are a drive letter (`C:\` / `C:/`) or a UNC prefix (`\\`).
 */
function validateAbsolutePath(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
    return
  }
  if (typeof value !== 'string') {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be a string`))
    return
  }
  if (!isAbsolutePath(value)) {
    issues.push(makeIssue(basePath, 'invalid_path', `${basePath} must be an absolute path`))
  }
}

function isAbsolutePath(value: string): boolean {
  if (value.length === 0) return false
  if (value.startsWith('/')) return true
  if (value.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(value)
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
