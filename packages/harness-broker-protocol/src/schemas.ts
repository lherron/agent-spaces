import type { BrokerCommand, BrokerMethod } from './commands'
import type { InvocationEventEnvelope, InvocationEventType } from './events'
import type { HarnessInvocationSpec } from './invocation'
import { isJsonRpcRequest } from './jsonrpc'

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

type SchemaRecord = Record<string, unknown> & {
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
  limits?: unknown
  maxEventBytes?: unknown
  metadata?: unknown
  mimeType?: unknown
  mode?: unknown
  model?: unknown
  modelReasoningEffort?: unknown
  name?: unknown
  path?: unknown
  permissionRequests?: unknown
  permissionPolicy?: unknown
  policy?: unknown
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
  spec?: unknown
  specVersion?: unknown
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
  scope?: unknown
}

const brokerMethods = new Set<BrokerMethod>([
  'broker.hello',
  'broker.health',
  'invocation.start',
  'invocation.input',
  'invocation.interrupt',
  'invocation.stop',
  'invocation.status',
  'invocation.dispose',
])

const eventTypes = new Set<InvocationEventType>([
  'invocation.started',
  'invocation.ready',
  'invocation.stopping',
  'invocation.exited',
  'invocation.failed',
  'invocation.disposed',
  'continuation.updated',
  'input.accepted',
  'input.rejected',
  'input.queued',
  'turn.started',
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
])

export function validateInvocationSpec(value: unknown): HarnessInvocationSpec {
  const issues: ValidationIssue[] = []
  validateSpec(value, issues)
  if (issues.length > 0) {
    throw new InvocationSpecValidationError(issues)
  }
  return value as HarnessInvocationSpec
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
    validateEnv(process.env, path(prefix, 'process.env'), issues)
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
    case 'invocation.start':
      validateSpec(commandParams.spec, issues, 'params.spec')
      if (commandParams.initialInput !== undefined) {
        validateInvocationInput(commandParams.initialInput, 'params.initialInput', issues)
      }
      return
    case 'invocation.input':
      requireString(commandParams.invocationId, 'params.invocationId', issues)
      validateInvocationInput(commandParams.input, 'params.input', issues)
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
    const capabilities = asRecord(params.capabilities)
    if (!capabilities) {
      issues.push(issue('params.capabilities', 'invalid_type', 'capabilities must be an object'))
    } else {
      optionalBoolean(
        capabilities.permissionRequests,
        'params.capabilities.permissionRequests',
        issues
      )
      optionalBoolean(capabilities.eventAcks, 'params.capabilities.eventAcks', issues)
    }
  }
}

function validateInvocationInput(
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

function validateEnv(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  const record = asRecord(value)
  if (!record) {
    issues.push(issue(basePath, 'invalid_type', 'env must be an object'))
    return
  }
  for (const [key, envValue] of Object.entries(record)) {
    const envPath = path(basePath, key)
    if (key.length === 0 || key.includes('=') || key.includes('\u0000')) {
      issues.push(issue(envPath, 'invalid_env_key', 'env key cannot be empty or contain = or NUL'))
    }
    if (typeof envValue !== 'string') {
      issues.push(issue(envPath, 'invalid_type', 'env value must be a string'))
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

function requireString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'string') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

function requireNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a finite number`))
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

function optionalString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

function optionalNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a finite number`))
  }
}

function optionalBoolean(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'boolean') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a boolean`))
  }
}

function optionalStringArray(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return
  }
  if (!Array.isArray(value)) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be an array`))
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

function optionalEnum(
  value: unknown,
  allowed: string[],
  basePath: string,
  issues: ValidationIssue[],
  required = false
): void {
  if (value === undefined) {
    if (required) {
      issues.push(issue(basePath, 'required', `${basePath} is required`))
    }
    return
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(issue(basePath, 'invalid_literal', `${basePath} has an unsupported value`))
  }
}

function asRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

function path(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : `${prefix}.${suffix}`
}

function issue(pathValue: string, code: string, message: string): ValidationIssue {
  return { path: pathValue, code, message }
}
