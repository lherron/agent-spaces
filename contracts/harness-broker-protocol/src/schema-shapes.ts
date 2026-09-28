import {
  ENV_KEY_PATTERN,
  isAmbientEnvKey,
  isCredentialEnvKey,
  isReservedEnvKey,
} from './env-keys.js'
import type { ValidationIssue } from './errors.js'
import type { InvocationEventType } from './events'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from './invocation'
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
  optionalStringArray,
  requireArray,
  requireString,
  requireStringArray,
} from './validation-primitives.js'

export function validateBrokerHelloParams(params: SchemaRecord, issues: ValidationIssue[]): void {
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

export function validateClientCapabilities(
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

export function validateInvocationInputShape(
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
export function validateResponseFormat(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
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

export function validateInputPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
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

export function validateEnv(
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

export function validateHarnessTransport(
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
    ['jsonrpc-stdio', 'pipes', 'pty', 'in-process', 'native-worker'],
    joinPath(basePath, 'kind'),
    issues,
    true
  )
  if (transport['kind'] === 'pty') {
    optionalNumber(transport['cols'], joinPath(basePath, 'cols'), issues)
    optionalNumber(transport['rows'], joinPath(basePath, 'rows'), issues)
  }
}

export function validateProcessLimits(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
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

export function validateInteraction(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
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

export function validateContinuation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
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

export function validateCodexDriver(
  driver: SchemaRecord,
  basePath: string,
  issues: ValidationIssue[]
): void {
  optionalEnum(
    driver['presentation'],
    ['none', 'tmux-tui', 'codex-tui'],
    joinPath(basePath, 'presentation'),
    issues
  )
  optionalEnum(
    driver['transport'],
    ['jsonrpc-stdio', 'websocket-unix'],
    joinPath(basePath, 'transport'),
    issues
  )
  optionalString(driver['resumeThreadId'], joinPath(basePath, 'resumeThreadId'), issues)
  optionalString(driver['model'], joinPath(basePath, 'model'), issues)
  optionalString(driver['modelReasoningEffort'], joinPath(basePath, 'modelReasoningEffort'), issues)
  optionalString(
    driver['developerInstructions'],
    joinPath(basePath, 'developerInstructions'),
    issues
  )
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

export function validateMuseDriver(
  driver: SchemaRecord,
  basePath: string,
  issues: ValidationIssue[]
): void {
  optionalString(driver['serveBin'], joinPath(basePath, 'serveBin'), issues)
  optionalString(driver['workspace'], joinPath(basePath, 'workspace'), issues)
  optionalEnum(driver['homeMode'], ['isolated', 'operator'], joinPath(basePath, 'homeMode'), issues)
  optionalString(driver['model'], joinPath(basePath, 'model'), issues)
  optionalString(driver['reasoningEffort'], joinPath(basePath, 'reasoningEffort'), issues)
  optionalEnum(
    driver['approvalMode'],
    ['allowAll', 'promptUnmatched', 'onRequest', 'denyUnmatched'],
    joinPath(basePath, 'approvalMode'),
    issues
  )
  optionalString(driver['resumeSessionId'], joinPath(basePath, 'resumeSessionId'), issues)
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

export function validateStringRecord(
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

export function validateEnumArray(
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

export function validateOptionalEventTypeArray(
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
export function validateAbsolutePath(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
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

export function validateOptionalPositiveInteger(
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

export function validateRequiredPositiveInteger(
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
