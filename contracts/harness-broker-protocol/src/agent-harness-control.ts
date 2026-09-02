import {
  AgentHarnessControlValidationError,
  ProtocolError,
  type ValidationIssue,
} from './errors.js'
import type { InvocationEventEnvelope } from './events.js'
import type { AgentHarnessSpec, DriverPermissionPolicy } from './invocation.js'
import { validateEventEnvelope } from './schemas.js'
import { asRecord, makeIssue } from './validation-primitives.js'

/** The only version of the first-party agent-harness control channel. */
export const AGENT_HARNESS_CONTROL_PROTOCOL_VERSION = 'agent-harness-control/v1' as const

export type AgentHarnessControlProtocolVersion = typeof AGENT_HARNESS_CONTROL_PROTOCOL_VERSION

/**
 * The broker-projected authentication binding. It deliberately contains only
 * selectors and a credential-store path; no credential material crosses this
 * channel.
 */
export interface AgentHarnessControlAuth {
  authMode: 'api-key' | 'oauth'
  authPath: string
  providerId: string
  credentialType: 'api-key' | 'oauth'
  storeBound: boolean
}

/** The model inputs projected from `spec.sdk`. */
export interface AgentHarnessControlSdk {
  modelId: string
  thinkingLevel?: string | undefined
}

/**
 * A hash-covered projection made by the driver. The TUI receives this object;
 * it must never recreate any of these broker-owned values.
 */
export interface AgentHarnessSessionConfig {
  permissionPolicy: DriverPermissionPolicy
  auth: AgentHarnessControlAuth
  sdk: AgentHarnessControlSdk
  agent: AgentHarnessSpec
  /**
   * Present ONLY to resume an existing session. `spec.continuation` is itself
   * optional, and the child feeds this key straight to `SessionManager.open`,
   * which requires the session to already exist — so a mandatory key would make
   * a FIRST launch unrepresentable. Absent means "start fresh" (T-07585).
   */
  continuation?:
    | {
        key: string
      }
    | undefined
}

export interface AgentHarnessControlHelloFrame {
  verb: 'hello'
  payload: {
    protocolVersion: AgentHarnessControlProtocolVersion
  }
}

export interface AgentHarnessControlSessionConfigFrame {
  verb: 'session.config'
  /** Correlates the required acknowledgement from the TUI. */
  requestId: string
  payload: AgentHarnessSessionConfig
}

export interface AgentHarnessControlReadyFrame {
  verb: 'ready'
  payload: {
    sessionFile: string
  }
}

export interface AgentHarnessControlTurnBeginFrame {
  verb: 'turn.begin'
  /** Correlates the required acknowledgement from the TUI. */
  requestId: string
  payload: {
    turnId: string
    inputId: string
    structured: false
  }
}

export interface AgentHarnessControlTurnInterruptFrame {
  verb: 'turn.interrupt'
  /** Correlates the required acknowledgement from the TUI. */
  requestId: string
  payload: {
    reason: string
  }
}

export interface AgentHarnessControlEventFrame {
  verb: 'event'
  payload: InvocationEventEnvelope
}

/** The closed set of six wire verbs. */
export type AgentHarnessControlFrame =
  | AgentHarnessControlHelloFrame
  | AgentHarnessControlSessionConfigFrame
  | AgentHarnessControlReadyFrame
  | AgentHarnessControlTurnBeginFrame
  | AgentHarnessControlTurnInterruptFrame
  | AgentHarnessControlEventFrame

/** Driver-to-TUI messages for which a positive acknowledgement is mandatory. */
export type AgentHarnessControlRequest =
  | AgentHarnessControlSessionConfigFrame
  | AgentHarnessControlTurnBeginFrame
  | AgentHarnessControlTurnInterruptFrame

/** Frames that are legal to send without awaiting a response. */
export type AgentHarnessControlNotification =
  | AgentHarnessControlHelloFrame
  | AgentHarnessControlReadyFrame
  | AgentHarnessControlEventFrame

/**
 * The closed code set for a recoverable turn-control refusal.
 * `turn_already_active` and `turn_begin_failed` belong to `turn.begin`;
 * `no_active_turn` belongs to `turn.interrupt`. There is deliberately no code
 * for a `session.config` refusal: that path stays fail-closed and destroys the
 * channel, because a configuration that does not validate has no recoverable
 * continuation.
 */
export const AGENT_HARNESS_CONTROL_NACK_CODES = [
  'turn_already_active',
  'turn_begin_failed',
  'no_active_turn',
] as const

export type AgentHarnessControlNackCode = (typeof AGENT_HARNESS_CONTROL_NACK_CODES)[number]

export interface AgentHarnessControlPositiveAck {
  ack: true
}

/**
 * "I cannot bind this turn" — distinct on the wire from "I crashed". The child
 * writes this INSTEAD of dying, so the control channel, the runtime, and every
 * later turn on it survive a single turn's refusal.
 */
export interface AgentHarnessControlNegativeAck {
  ack: false
  code: AgentHarnessControlNackCode
  message: string
}

/** The acknowledgement result, discriminated on `ack`. */
export type AgentHarnessControlAck = AgentHarnessControlPositiveAck | AgentHarnessControlNegativeAck

/**
 * Consumer-facing split that makes an acknowledgement-bearing frame impossible
 * to pass to the fire-and-forget `send` surface.
 */
export interface AgentHarnessControlChannel {
  request(frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck>
  send(frame: AgentHarnessControlNotification): void
}

export type AgentHarnessControlFrameResult =
  | { ok: true; value: AgentHarnessControlFrame }
  | { ok: false; error: AgentHarnessControlFrameError }

export class AgentHarnessControlFrameError extends ProtocolError {
  readonly code = 'INVALID_AGENT_HARNESS_CONTROL_FRAME'
  readonly line: string
  readonly causeError?: unknown

  constructor(line: string, causeError?: unknown) {
    super('AgentHarnessControlFrameError', 'Invalid agent-harness control frame')
    this.line = line
    this.causeError = causeError
  }
}

/** Streaming NDJSON decoder for the agent-harness control socket. */
export class AgentHarnessControlDecoder {
  #buffer = ''

  push(chunk: string | Uint8Array): AgentHarnessControlFrameResult[] {
    this.#buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)

    const frames: AgentHarnessControlFrameResult[] = []
    let newlineIndex = this.#buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = this.#buffer.slice(0, newlineIndex)
      this.#buffer = this.#buffer.slice(newlineIndex + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.length > 0) {
        frames.push(decodeControlLine(line))
      }
      newlineIndex = this.#buffer.indexOf('\n')
    }

    return frames
  }

  flush(): AgentHarnessControlFrameResult[] {
    if (this.#buffer.length === 0) {
      return []
    }

    const line = this.#buffer
    this.#buffer = ''
    return [decodeControlLine(line)]
  }
}

/** Validates a control frame and serializes it as one NDJSON line. */
export function encodeAgentHarnessControlFrame(frame: AgentHarnessControlFrame): string {
  return `${JSON.stringify(validateAgentHarnessControlFrame(frame))}\n`
}

export function validateAgentHarnessSessionConfig(value: unknown): AgentHarnessSessionConfig {
  const issues: ValidationIssue[] = []
  const config = asRecord(value)
  if (!config) {
    issues.push(makeIssue('', 'invalid_type', 'session.config payload must be an object'))
  } else {
    rejectUnknownKeys(
      config,
      ['permissionPolicy', 'auth', 'sdk', 'agent', 'continuation'],
      '',
      issues
    )
    validatePermissionPolicy(config['permissionPolicy'], 'permissionPolicy', issues)
    validateAuth(config['auth'], 'auth', issues)
    validateSdk(config['sdk'], 'sdk', issues)
    validateAgent(config['agent'], 'agent', issues)
    // Absent is legal (fresh session). Present-but-malformed is not.
    if (config['continuation'] !== undefined) {
      validateContinuation(config['continuation'], 'continuation', issues)
    }
  }

  throwForIssues(issues)
  return value as AgentHarnessSessionConfig
}

/**
 * Acknowledgements are NOT control frames — the verb set is closed to the six
 * wire verbs — so they are recognized and validated on their own path, ahead of
 * the frame decoder, by the presence of a boolean `ack`. Returns false for any
 * line that is a frame (or garbage) so the caller can hand it to the decoder.
 */
export function isAgentHarnessControlAckLine(value: unknown): boolean {
  const line = asRecord(value)
  return line !== undefined && typeof line['ack'] === 'boolean'
}

/** Validate one acknowledgement line. Throws for a malformed or unknown-code ack. */
export function validateAgentHarnessControlAck(value: unknown): AgentHarnessControlAck {
  const issues: ValidationIssue[] = []
  const line = asRecord(value)
  if (!line) {
    issues.push(makeIssue('', 'invalid_type', 'Acknowledgement must be an object'))
    throwForIssues(issues)
    return value as AgentHarnessControlAck
  }

  rejectUnknownKeys(line, ['ack', 'requestId', 'code', 'message'], '', issues)
  if (line['requestId'] !== undefined && typeof line['requestId'] !== 'string') {
    issues.push(makeIssue('requestId', 'invalid_type', 'requestId must be a string'))
  }

  if (line['ack'] === true) {
    for (const key of ['code', 'message']) {
      if (line[key] !== undefined) {
        issues.push(makeIssue(key, 'forbidden', `A positive acknowledgement must not carry ${key}`))
      }
    }
    throwForIssues(issues)
    return { ack: true }
  }

  if (line['ack'] !== false) {
    issues.push(makeIssue('ack', 'invalid_type', 'ack must be a boolean'))
    throwForIssues(issues)
  }

  if (!isOneOf(line['code'], AGENT_HARNESS_CONTROL_NACK_CODES)) {
    issues.push(
      makeIssue('code', 'invalid_literal', 'A negative acknowledgement needs a closed-set code')
    )
  }
  requireNonEmptyString(line['message'], 'message', issues)
  throwForIssues(issues)
  return {
    ack: false,
    code: line['code'] as AgentHarnessControlNackCode,
    message: line['message'] as string,
  }
}

export function validateAgentHarnessControlFrame(value: unknown): AgentHarnessControlFrame {
  const issues: ValidationIssue[] = []
  const frame = asRecord(value)
  if (!frame) {
    issues.push(makeIssue('', 'invalid_type', 'Control frame must be an object'))
  } else {
    rejectUnknownKeys(frame, ['verb', 'requestId', 'payload'], '', issues)
    switch (frame['verb']) {
      case 'hello':
        rejectRequestId(frame, issues)
        validateHello(frame['payload'], 'payload', issues)
        break
      case 'session.config':
        requireRequestId(frame, issues)
        validateConfigWithIssues(frame['payload'], 'payload', issues)
        break
      case 'ready':
        rejectRequestId(frame, issues)
        validateReady(frame['payload'], 'payload', issues)
        break
      case 'turn.begin':
        requireRequestId(frame, issues)
        validateTurnBegin(frame['payload'], 'payload', issues)
        break
      case 'turn.interrupt':
        requireRequestId(frame, issues)
        validateTurnInterrupt(frame['payload'], 'payload', issues)
        break
      case 'event':
        rejectRequestId(frame, issues)
        validateEvent(frame['payload'], 'payload', issues)
        break
      default:
        issues.push(makeIssue('verb', 'invalid_literal', 'Unsupported control-channel verb'))
    }
  }

  throwForIssues(issues)
  return value as AgentHarnessControlFrame
}

function decodeControlLine(line: string): AgentHarnessControlFrameResult {
  try {
    return { ok: true, value: validateAgentHarnessControlFrame(JSON.parse(line)) }
  } catch (error) {
    return { ok: false, error: new AgentHarnessControlFrameError(line, error) }
  }
}

function throwForIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) {
    throw new AgentHarnessControlValidationError(issues)
  }
}

function validateConfigWithIssues(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  try {
    validateAgentHarnessSessionConfig(value)
  } catch (error) {
    if (error instanceof AgentHarnessControlValidationError) {
      for (const issue of error.issues) {
        issues.push({ ...issue, path: prefixedPath(basePath, issue.path) })
      }
      return
    }
    throw error
  }
}

function validateHello(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const payload = requireRecord(value, basePath, issues)
  if (!payload) return
  rejectUnknownKeys(payload, ['protocolVersion'], basePath, issues)
  if (payload['protocolVersion'] !== AGENT_HARNESS_CONTROL_PROTOCOL_VERSION) {
    issues.push(
      makeIssue(`${basePath}.protocolVersion`, 'invalid_literal', 'Unsupported protocol version')
    )
  }
}

function validateReady(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const payload = requireRecord(value, basePath, issues)
  if (!payload) return
  rejectUnknownKeys(payload, ['sessionFile'], basePath, issues)
  requireNonEmptyString(payload['sessionFile'], `${basePath}.sessionFile`, issues)
}

function validateTurnBegin(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const payload = requireRecord(value, basePath, issues)
  if (!payload) return
  rejectUnknownKeys(payload, ['turnId', 'inputId', 'structured'], basePath, issues)
  requireNonEmptyString(payload['turnId'], `${basePath}.turnId`, issues)
  requireNonEmptyString(payload['inputId'], `${basePath}.inputId`, issues)
  if (payload['structured'] !== false) {
    issues.push(makeIssue(`${basePath}.structured`, 'invalid_literal', 'structured must be false'))
  }
}

function validateTurnInterrupt(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const payload = requireRecord(value, basePath, issues)
  if (!payload) return
  rejectUnknownKeys(payload, ['reason'], basePath, issues)
  requireNonEmptyString(payload['reason'], `${basePath}.reason`, issues)
}

function validateEvent(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  try {
    validateEventEnvelope(value)
  } catch (error) {
    if (error instanceof ProtocolError && 'issues' in error && Array.isArray(error.issues)) {
      for (const issue of error.issues) {
        issues.push({ ...issue, path: prefixedPath(basePath, issue.path) })
      }
      return
    }
    throw error
  }
}

function validatePermissionPolicy(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const policy = requireRecord(value, basePath, issues)
  if (!policy) return
  rejectUnknownKeys(policy, ['mode', 'timeoutMs', 'defaultDecision'], basePath, issues)
  if (!isOneOf(policy['mode'], ['deny', 'allow', 'ask-client'])) {
    issues.push(
      makeIssue(`${basePath}.mode`, 'invalid_literal', 'Unsupported permission policy mode')
    )
  }
  if (policy['timeoutMs'] !== undefined && typeof policy['timeoutMs'] !== 'number') {
    issues.push(makeIssue(`${basePath}.timeoutMs`, 'invalid_type', 'timeoutMs must be a number'))
  }
  if (
    policy['defaultDecision'] !== undefined &&
    !isOneOf(policy['defaultDecision'], ['allow', 'deny'])
  ) {
    issues.push(
      makeIssue(`${basePath}.defaultDecision`, 'invalid_literal', 'Unsupported default decision')
    )
  }
}

function validateAuth(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const auth = requireRecord(value, basePath, issues)
  if (!auth) return
  rejectUnknownKeys(
    auth,
    ['authMode', 'authPath', 'providerId', 'credentialType', 'storeBound'],
    basePath,
    issues
  )
  if (!isOneOf(auth['authMode'], ['api-key', 'oauth'])) {
    issues.push(makeIssue(`${basePath}.authMode`, 'invalid_literal', 'Unsupported auth mode'))
  }
  requireNonEmptyString(auth['authPath'], `${basePath}.authPath`, issues)
  requireNonEmptyString(auth['providerId'], `${basePath}.providerId`, issues)
  if (!isOneOf(auth['credentialType'], ['api-key', 'oauth'])) {
    issues.push(
      makeIssue(`${basePath}.credentialType`, 'invalid_literal', 'Unsupported credential type')
    )
  }
  if (typeof auth['storeBound'] !== 'boolean') {
    issues.push(makeIssue(`${basePath}.storeBound`, 'invalid_type', 'storeBound must be a boolean'))
  }
}

function validateSdk(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const sdk = requireRecord(value, basePath, issues)
  if (!sdk) return
  rejectUnknownKeys(sdk, ['modelId', 'thinkingLevel'], basePath, issues)
  requireNonEmptyString(sdk['modelId'], `${basePath}.modelId`, issues)
  if (sdk['thinkingLevel'] !== undefined && typeof sdk['thinkingLevel'] !== 'string') {
    issues.push(
      makeIssue(`${basePath}.thinkingLevel`, 'invalid_type', 'thinkingLevel must be a string')
    )
  }
}

function validateAgent(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const agent = requireRecord(value, basePath, issues)
  if (!agent) return
  rejectUnknownKeys(
    agent,
    [
      'agentId',
      'projectId',
      'agentRoot',
      'projectRoot',
      'aspHome',
      'runMode',
      'scopeRef',
      'laneRef',
      'runId',
      'hostSessionId',
      'generation',
    ],
    basePath,
    issues
  )
  requireNonEmptyString(agent['agentId'], `${basePath}.agentId`, issues)
  for (const key of [
    'projectId',
    'agentRoot',
    'projectRoot',
    'aspHome',
    'scopeRef',
    'laneRef',
    'runId',
    'hostSessionId',
  ]) {
    if (agent[key] !== undefined && typeof agent[key] !== 'string') {
      issues.push(makeIssue(`${basePath}.${key}`, 'invalid_type', `${key} must be a string`))
    }
  }
  if (
    agent['runMode'] !== undefined &&
    !isOneOf(agent['runMode'], ['query', 'heartbeat', 'task', 'maintenance'])
  ) {
    issues.push(makeIssue(`${basePath}.runMode`, 'invalid_literal', 'Unsupported agent run mode'))
  }
  if (agent['generation'] !== undefined && typeof agent['generation'] !== 'number') {
    issues.push(makeIssue(`${basePath}.generation`, 'invalid_type', 'generation must be a number'))
  }
}

function validateContinuation(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const continuation = requireRecord(value, basePath, issues)
  if (!continuation) return
  rejectUnknownKeys(continuation, ['key'], basePath, issues)
  requireNonEmptyString(continuation['key'], `${basePath}.key`, issues)
}

function requireRequestId(frame: Record<string, unknown>, issues: ValidationIssue[]): void {
  requireNonEmptyString(frame['requestId'], 'requestId', issues)
}

function rejectRequestId(frame: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (frame['requestId'] !== undefined) {
    issues.push(
      makeIssue('requestId', 'forbidden', 'Only ack-bearing control frames may have requestId')
    )
  }
}

function requireRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (!record) {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be an object`))
  }
  return record
}

function requireNonEmptyString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(makeIssue(path, 'required', `${path} must be a non-empty string`))
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  basePath: string,
  issues: ValidationIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      issues.push(
        makeIssue(prefixedPath(basePath, key), 'unknown_field', `Unsupported field ${key}`)
      )
    }
  }
}

function prefixedPath(prefix: string, path: string): string {
  if (prefix.length === 0) return path
  if (path.length === 0) return prefix
  return `${prefix}.${path}`
}

function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
