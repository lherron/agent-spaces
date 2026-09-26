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
import { isJsonRpcRequest } from './jsonrpc'
import {
  validateCommandParams,
  validateInvocationDispatchRequestShape,
  validatePermissionRequestParamsShape,
} from './schema-command.js'
import { validateStartRequestBody } from './schema-dispatch.js'
import { validateEventPayload } from './schema-event-payload.js'
import {
  validateCodexDriver,
  validateContinuation,
  validateEnv,
  validateHarnessTransport,
  validateInteraction,
  validateInvocationInputShape,
  validateMuseDriver,
  validateOptionalPositiveInteger,
  validateProcessLimits,
  validateStringRecord,
} from './schema-shapes.js'

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
  asRecord,
  joinPath,
  makeIssue,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireNonEmptyString,
  requireNumber,
  requireString,
  requireStringArray,
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
  'submission.withdraw',
  'queue.list',
  'queue.jump',
  'queue.cancel',
  'turn.manifest',
  'seat.probe',
  'broker.installIdentity',
  'broker.ensureInvocation',
] as const satisfies readonly BrokerMethod[]

/**
 * The authoritative RUNTIME roster of event types, kept exhaustive against
 * `InvocationEventType` by `_EventTypesExhaustive` below. Exported so a consumer
 * can iterate every event the protocol defines — a renderer proving it has a
 * decision for all of them, say — without re-listing them and re-listing them
 * wrong (T-07906).
 */
export const INVOCATION_EVENT_TYPES = [
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
  'queue.withdrawn',
  'interrupt.requested',
  'interrupt.landed',
  'interrupt.failed',
  'submission.absorbed',
  'submission.executed',
  'submission.rejected',
  'submission.expired',
  'submission.withdrawn',
  'submission.cancelled',
  'submission.lost',
  'capture.warning',
  'capture.released',
  'turn.started',
  'turn.attributed',
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

/**
 * Events that can ONLY be broker facts, and whose provenance must therefore say
 * so. Admission, the broker-held queue and interrupt actuation are decisions the
 * broker makes; `submission.rejected` is an admission refusal and
 * `submission.expired` a TTL — no provider reports any of them.
 *
 * `submission.absorbed`, `submission.executed` and `submission.cancelled` were
 * in this set and have been REMOVED (mable's ruling on wrkq T-07863, recorded
 * there and on T-07860). They are DISPOSITIONS, and a disposition reports what
 * the harness did with a submission:
 *   - `absorbed`/`executed` are minted only from native context-entry or turn
 *     evidence. Transport/API acknowledgement is acceptance, not landing;
 *   - `cancelled{reason:'recalled'}` is the transcript `popAll` row (provider),
 *     while `cancelled{reason:'teardown'}` is broker lifecycle knowledge.
 * Requiring `sourceKind:'broker'` on them forced the emitter to overwrite a true
 * record with a false one — falsifying the very field T-07853 §7.2 exists to
 * make truthful. They still require WELL-FORMED provenance; they simply accept
 * whichever source actually produced them.
 */
const BROKER_PROVENANCE_EVENT_TYPES = new Set<InvocationEventType>([
  'admission.requested',
  'admission.admitted',
  'admission.rejected',
  'queue.enqueued',
  'queue.jumped',
  'queue.cancelled',
  'queue.expired',
  'queue.withdrawn',
  'interrupt.requested',
  'interrupt.landed',
  'interrupt.failed',
  'submission.rejected',
  'submission.expired',
  'submission.withdrawn',
  'submission.lost',
  'capture.warning',
])

/**
 * Dispositions: provenance is REQUIRED and must be well-formed, but any source
 * kind is legitimate because the emitter's true record is the authority.
 */
const REQUIRED_PROVENANCE_EVENT_TYPES = new Set<InvocationEventType>([
  'submission.absorbed',
  'submission.executed',
  'submission.cancelled',
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
type _EventTypesExhaustive = AssertExhaustive<InvocationEventType, typeof INVOCATION_EVENT_TYPES>
const _brokerMethodsExhaustive: _BrokerMethodsExhaustive = true
const _eventTypesExhaustive: _EventTypesExhaustive = true
void _brokerMethodsExhaustive
void _eventTypesExhaustive

const brokerMethods: ReadonlySet<BrokerMethod> = new Set(BROKER_METHODS)
export const eventTypes: ReadonlySet<InvocationEventType> = new Set(INVOCATION_EVENT_TYPES)

/**
 * Driver kinds admitted to `native-worker` process execution/transport.
 * Driver kinds are open strings at the protocol layer; these sets gate the
 * cross-field rules only, not which drivers a broker registers.
 */
export const NATIVE_WORKER_DRIVER_KINDS: ReadonlySet<string> = new Set([
  'agent-harness',
  'agent-harness-tmux',
  'foundry-resident',
])

/**
 * Pi SDK-backed driver kinds that carry (and require) a spec `sdk` block.
 * Members that are also native-worker kinds get the agent-harness rules.
 */
export const SDK_BLOCK_DRIVER_KINDS: ReadonlySet<string> = new Set([
  'pi-sdk',
  'agent-harness',
  'agent-harness-tmux',
  'foundry-resident',
])

/**
 * Driver kinds eligible for `in-process` harness transport. Distinct from
 * SDK_BLOCK_DRIVER_KINDS: `arris-resident` dials the Arris control socket
 * itself, so it is truthfully in-process without being Pi SDK-backed.
 */
export const IN_PROCESS_TRANSPORT_DRIVER_KINDS: ReadonlySet<string> = new Set([
  'pi-sdk',
  'arris-resident',
])

/**
 * Driver kinds whose dispatch must present a terminal surface
 * (runtime.terminalSurface lease or legacy runtime.tmux.socketPath).
 * Membership means "must present a surface", not "has a pane".
 */
export const TMUX_SURFACE_DRIVER_KINDS: ReadonlySet<string> = new Set([
  'claude-code-tmux',
  'codex-cli-tmux',
  'pi-tui-tmux',
  'muse-cli-tmux',
  'agent-harness-tmux',
])

export function isDriverKindIn(kinds: ReadonlySet<string>, driverKind: unknown): boolean {
  return typeof driverKind === 'string' && kinds.has(driverKind)
}

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
      } else if (REQUIRED_PROVENANCE_EVENT_TYPES.has(eventType)) {
        requireEventProvenance(envelope['provenance'], issues)
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

/**
 * Provenance must be PRESENT and well-formed, with any source kind. Shape
 * checking is `validateEventProvenance`'s job and has already run on the
 * envelope; this only adds the presence requirement.
 */
function requireEventProvenance(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(makeIssue('provenance', 'required', 'disposition provenance is required'))
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

export function validateSpec(value: unknown, issues: ValidationIssue[], prefix = ''): void {
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
    const nativeWorker = process['execution'] === 'native-worker'
    if (nativeWorker) {
      if (Object.hasOwn(process, 'command')) {
        issues.push(
          makeIssue(
            joinPath(prefix, 'process.command'),
            'forbidden',
            'native-worker process must not declare a command'
          )
        )
      }
      if (Object.hasOwn(process, 'args')) {
        issues.push(
          makeIssue(
            joinPath(prefix, 'process.args'),
            'forbidden',
            'native-worker process must not declare args'
          )
        )
      }
    } else {
      requireString(process['command'], joinPath(prefix, 'process.command'), issues)
      requireStringArray(process['args'], joinPath(prefix, 'process.args'), issues)
    }
    requireString(process['cwd'], joinPath(prefix, 'process.cwd'), issues)
    validateEnv(process['lockedEnv'], joinPath(prefix, 'process.lockedEnv'), issues, 'lockedEnv')
    optionalStringArray(process['pathPrepend'], joinPath(prefix, 'process.pathPrepend'), issues)
    validateHarnessTransport(
      process['harnessTransport'],
      joinPath(prefix, 'process.harnessTransport'),
      issues
    )
    validateProcessLimits(process['limits'], joinPath(prefix, 'process.limits'), issues)
    validateNativeWorkerProcessShape(process, harness, prefix, issues)
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
    } else if (driver['kind'] === 'muse-serve') {
      validateMuseDriver(driver, joinPath(prefix, 'driver'), issues)
    }
  }

  validateSdkContract(spec, harness, process, prefix, issues)
  validateAgentHarnessSpec(spec['agent'], joinPath(prefix, 'agent'), issues)
  validateLaunch(spec['launch'], joinPath(prefix, 'launch'), issues)
}

/**
 * `native-worker` is an agent-harness-only process alternative. Keep this
 * cross-field gate next to the generic process parser so it cannot become a
 * globally admitted transport merely because its vocabulary is public.
 */
function validateNativeWorkerProcessShape(
  process: SchemaRecord,
  harness: SchemaRecord | undefined,
  prefix: string,
  issues: ValidationIssue[]
): void {
  const isAgentHarness = isDriverKindIn(NATIVE_WORKER_DRIVER_KINDS, harness?.['driver'])
  const execution = process['execution']
  const transportKind = asRecord(process['harnessTransport'])?.['kind']

  if (!isAgentHarness && execution !== undefined) {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.execution'),
        'forbidden',
        'execution is only supported by native agent-harness workers'
      )
    )
  }
  if (!isAgentHarness && transportKind === 'native-worker') {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.harnessTransport.kind'),
        'forbidden',
        'native-worker transport is only supported by agent-harness drivers'
      )
    )
  }
  if (execution === 'native-worker' && transportKind !== 'native-worker') {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.harnessTransport.kind'),
        'invalid_literal',
        'native-worker execution requires native-worker transport'
      )
    )
  }
  if (transportKind === 'native-worker' && execution !== 'native-worker') {
    issues.push(
      makeIssue(
        joinPath(prefix, 'process.execution'),
        'invalid_literal',
        'native-worker transport requires native-worker execution'
      )
    )
  }
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
  const carriesSdkBlock = isDriverKindIn(SDK_BLOCK_DRIVER_KINDS, driverKind)
  const isAgentHarness = carriesSdkBlock && isDriverKindIn(NATIVE_WORKER_DRIVER_KINDS, driverKind)
  const allowsInProcessTransport = isDriverKindIn(IN_PROCESS_TRANSPORT_DRIVER_KINDS, driverKind)
  const requiresInProcessHost = driverKind === 'pi-sdk'
  const sdk = asRecord(spec['sdk'])

  if (!carriesSdkBlock) {
    if (Object.hasOwn(spec, 'sdk')) {
      issues.push(makeIssue(sdkPath, 'forbidden', 'sdk is only supported by Pi SDK-backed drivers'))
    }
    if (
      !allowsInProcessTransport &&
      asRecord(process?.['harnessTransport'])?.['kind'] === 'in-process'
    ) {
      issues.push(
        makeIssue(
          joinPath(prefix, 'process.harnessTransport.kind'),
          'forbidden',
          'in-process transport is only supported by the pi-sdk and arris-resident drivers'
        )
      )
    }
    return
  }

  if (!sdk) {
    issues.push(makeIssue(sdkPath, 'required', 'sdk is required for the Pi SDK-backed driver'))
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
  const transportKind = asRecord(process['harnessTransport'])?.['kind']
  if (isAgentHarness) {
    if (transportKind !== 'native-worker') {
      issues.push(
        makeIssue(
          joinPath(prefix, 'process.harnessTransport.kind'),
          'invalid_literal',
          'agent-harness requires native-worker transport'
        )
      )
    }
    if (process['execution'] !== 'native-worker') {
      issues.push(
        makeIssue(
          joinPath(prefix, 'process.execution'),
          'invalid_literal',
          'agent-harness requires native-worker execution'
        )
      )
    }
    if (spec['agent'] === undefined) {
      issues.push(makeIssue(joinPath(prefix, 'agent'), 'required', 'agent-harness requires agent'))
    }
    const driver = asRecord(spec['driver'])
    if (driver?.['controlProtocol'] !== undefined) {
      issues.push(
        makeIssue(
          joinPath(prefix, 'driver.controlProtocol'),
          'forbidden',
          'agent-harness forbids private control protocols'
        )
      )
    }
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
