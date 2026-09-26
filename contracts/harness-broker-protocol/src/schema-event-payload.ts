import type { ValidationIssue } from './errors.js'
import type { InvocationEventType } from './events'
import { PROVIDER_TRANSCRIPT_ARTIFACT_KIND } from './events.js'
import { requireBoolean } from './schema-command.js'
import {
  validateAbsolutePath,
  validateOptionalPositiveInteger,
  validateRequiredPositiveInteger,
} from './schema-shapes.js'
import { eventTypes } from './schemas.js'
import type { SchemaRecord } from './schemas.js'
import { validateTmuxPaneIds } from './tmux-ids.js'
import {
  asRecord,
  makeIssue,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalNumberOrNull,
  optionalString,
  requireArray,
  requireNonEmptyString,
  requireNumber,
  requirePayloadRecord,
  requireString,
  requireStringArray,
  requireTrue,
} from './validation-primitives.js'

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
  'queue.withdrawn': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireString(payload['reason'], 'payload.reason', issues)
    requireNumber(payload['position'], 'payload.position', issues)
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
  'submission.withdrawn': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    requireString(payload['reason'], 'payload.reason', issues)
  },
  'submission.cancelled': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(
      payload['reason'],
      ['recalled', 'removed', 'teardown', 'broker-cancelled', 'merged-into-foreign-turn'],
      'payload.reason',
      issues
    )
  },
  'submission.lost': (payload, issues) => {
    requireString(payload['submissionId'], 'payload.submissionId', issues)
    optionalEnum(payload['reason'], ['turn-correlation-lost'], 'payload.reason', issues, true)
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
    optionalEnum(
      payload['source'],
      ['broker-delivery', 'hook-observed', 'observed'],
      'payload.source',
      issues
    )
    optionalString(payload['sessionId'], 'payload.sessionId', issues)
    optionalString(payload['prompt'], 'payload.prompt', issues)
  },
  'turn.attributed': (payload, issues) => {
    requireString(payload['turnId'], 'payload.turnId', issues)
    optionalEnum(
      payload['ownership'],
      ['own', 'foreign', 'unknown'],
      'payload.ownership',
      issues,
      true
    )
    optionalString(payload['inputId'], 'payload.inputId', issues)
    optionalEnum(
      payload['origin'],
      ['broker', 'human', 'autonomous', 'unknown'],
      'payload.origin',
      issues,
      true
    )
    if (payload['ownership'] === 'own' && typeof payload['inputId'] !== 'string') {
      issues.push(makeIssue('payload.inputId', 'required', 'own attribution requires inputId'))
    }
    if (payload['ownership'] !== 'own' && payload['inputId'] !== undefined) {
      issues.push(
        makeIssue('payload.inputId', 'forbidden', 'non-own attribution must not carry inputId')
      )
    }
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
  // T-08430 — `model` is OPTIONAL on the wire (a driver with no truthful source
  // omits it), but when carried it must be complete: an identifier AND the
  // marker saying whether the provider or the harness config named it. A half
  // model — an id with no source — would read as provider evidence it is not.
  'usage.updated': (payload, issues) => {
    if (!Object.hasOwn(payload, 'usage')) {
      issues.push(makeIssue('payload.usage', 'required', 'usage is required'))
    }
    const model = payload['model']
    if (model === undefined) return
    const record = asRecord(model)
    if (record === undefined) {
      issues.push(makeIssue('payload.model', 'invalid_type', 'payload.model must be an object'))
      return
    }
    requireNonEmptyString(record['id'], 'payload.model.id', issues)
    optionalEnum(
      record['source'],
      ['provider-response', 'harness-config'],
      'payload.model.source',
      issues,
      true
    )
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
  optionalEnum(
    payload['deliveryEvidence'],
    ['not_written', 'possibly_written'],
    'payload.deliveryEvidence',
    issues
  )
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
    driverKind === 'muse-cli-tmux'

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

export function validateEventPayload(
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
