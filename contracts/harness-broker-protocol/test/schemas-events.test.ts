import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as protocol from '../src'
import type {
  CaptureReleasedPayload,
  CaptureWarningPayload,
  InputId,
  InvocationEventPayloadMap,
  InvocationId,
  MessageId,
  PermissionRequestId,
  SubmissionCancelledPayload,
  SubmissionTurnDispositionPayload,
  ToolCallId,
  TurnAttributedPayload,
  TurnId,
  UsageModelIdentity,
  UsageModelSource,
  UsageUpdatedPayload,
} from '../src'
import { conservativeDefaultLifecyclePolicyOverlay } from '../src/lifecycle'
import { validateEventEnvelope } from '../src/schemas'
import { expectInvalidEventEnvelope } from './schema-test-helpers'

describe('validateEventEnvelope', () => {
  const providerTranscriptConstants = protocol as Record<string, unknown>
  const envelope = (type: string, payload: unknown) => ({
    invocationId: 'inv_1',
    seq: 1,
    time: '2026-05-24T00:00:00.000Z',
    type,
    payload,
    provenance: {
      sourceKind: 'broker' as const,
      normalizer: { name: 'test', version: '1' },
    },
  })

  // `envelope` builds untyped wire input (it also feeds the rejection tests),
  // so round-trips compare the validated envelope as plain data.
  const expectValidatesTo = (input: unknown, expected: unknown = input) => {
    const validated: unknown = validateEventEnvelope(input)
    expect(validated).toEqual(expected)
  }

  const eventPayloads = {
    'invocation.started': {
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
    },
    'invocation.ready': { state: 'ready' },
    'invocation.stopping': { reason: 'requested' },
    'invocation.exited': { exitCode: 0, signal: null },
    'invocation.failed': { message: 'failed' },
    'invocation.disposed': { disposed: true },
    'invocation.summary': {
      summary: {
        invocationId: 'inv_1' as InvocationId,
        state: 'ready',
        driver: 'codex-app-server',
        startedAt: '2026-05-24T00:00:00.000Z',
        lastActivityAt: '2026-05-24T00:00:00.000Z',
      },
    },
    'lifecycle.policy.accepted': {
      policyId: 'policy_1',
      policyHash: 'hash_1',
      retentionMode: 'keep-alive',
      harnessRecoveryMode: 'none',
      turnRetryMode: 'none',
    },
    'lifecycle.escalation': {
      reason: 'broker-degraded',
      requestedAction: 'operator-attention',
    },
    'harness.started': {
      generation: 1,
      mode: 'initial',
      mechanism: 'direct-child',
    },
    'harness.exited': {
      generation: 1,
      reason: 'process-exit',
      exitCode: 0,
    },
    'harness.recovery.started': {
      fromGeneration: 1,
      reason: 'child-exit',
      activeTurnDisposition: 'none',
    },
    'harness.recovery.completed': {
      fromGeneration: 1,
      toGeneration: 2,
      ready: true,
    },
    'harness.recovery.failed': {
      fromGeneration: 1,
      reason: 'spawn-failed',
    },
    'continuation.updated': { provider: 'openai', key: 'thread_1' },
    'continuation.cleared': { reason: 'prompt_input_exit' },
    'input.accepted': { inputId: 'input_1' as InputId },
    'input.rejected': { inputId: 'input_1' as InputId, reason: 'busy' },
    'input.queued': { inputId: 'input_1' as InputId },
    'admission.requested': {
      submissionId: 'submission_1',
      class: 'queue',
      origin: { principalRef: 'agent:test' },
      turnPolicy: 'open',
    },
    'admission.admitted': { submissionId: 'submission_1', class: 'queue' },
    'admission.rejected': {
      submissionId: 'submission_1',
      class: 'exclusive',
      layer: 'state',
      reason: 'busy',
    },
    'queue.enqueued': { submissionId: 'submission_1', class: 'queue', position: 0 },
    'queue.jumped': {
      submissionId: 'submission_1',
      fromPosition: 2,
      toPosition: 0,
      principalRef: 'human:lance',
    },
    'queue.cancelled': { submissionId: 'submission_1', principalRef: 'agent:test' },
    'queue.expired': { submissionId: 'submission_1' },
    'queue.withdrawn': {
      submissionId: 'submission_1',
      reason: 'envelope-acked',
      position: 0,
    },
    'interrupt.requested': { submissionId: 'submission_1', turnId: 'turn_1' as TurnId },
    'interrupt.landed': { submissionId: 'submission_1', turnId: 'turn_1' as TurnId },
    'interrupt.failed': {
      submissionId: 'submission_1',
      turnId: 'turn_1' as TurnId,
      reason: 'unsupported',
    },
    'submission.absorbed': {
      submissionId: 'submission_1',
      turnId: 'turn_1' as TurnId,
    } satisfies SubmissionTurnDispositionPayload,
    'submission.executed': {
      submissionId: 'submission_1',
      turnId: 'turn_1' as TurnId,
    } satisfies SubmissionTurnDispositionPayload,
    'submission.rejected': { submissionId: 'submission_1', reason: 'busy' },
    'submission.expired': { submissionId: 'submission_1' },
    'submission.withdrawn': { submissionId: 'submission_1', reason: 'envelope-acked' },
    'submission.cancelled': {
      submissionId: 'submission_1',
      reason: 'merged-into-foreign-turn',
    } satisfies SubmissionCancelledPayload,
    'submission.lost': {
      submissionId: 'submission_1',
      reason: 'turn-correlation-lost',
    },
    'capture.warning': {
      message: 'unknown queue operation',
      raw: { type: 'queue-operation', operation: 'unknown' },
    } satisfies CaptureWarningPayload,
    'capture.released': {
      rawRecordId: 'raw_1',
      disposition: 'normalized',
      normalizedAs: { type: 'submission.cancelled' },
      resumedRecords: 2,
    } satisfies CaptureReleasedPayload,
    'turn.started': { turnId: 'turn_1' as TurnId, source: 'observed' },
    'turn.attributed': {
      turnId: 'turn_1' as TurnId,
      ownership: 'own',
      inputId: 'input_1' as InputId,
      origin: 'broker',
    } satisfies TurnAttributedPayload,
    'turn.stalled': {
      inputId: 'input_1' as InputId,
      turnId: 'turn_1' as TurnId,
      noProgressMs: 1000,
      thresholdMs: 1000,
      healthProbe: 'driver-status',
      harnessGeneration: 1,
      turnAttempt: 1,
    },
    'turn.retry': {
      inputId: 'input_1' as InputId,
      turnId: 'turn_1' as TurnId,
      fromAttempt: 1,
      toAttempt: 2,
      fromHarnessGeneration: 1,
      toHarnessGeneration: 2,
      reason: 'harness-stalled',
      semantics: 'at-least-once',
    },
    'turn.completed': { turnId: 'turn_1' as TurnId, status: 'completed' },
    'turn.failed': { turnId: 'turn_1' as TurnId, message: 'failed' },
    'turn.interrupted': { turnId: 'turn_1' as TurnId, reason: 'requested' },
    'assistant.message.started': { messageId: 'msg_1' as MessageId },
    'assistant.message.delta': { messageId: 'msg_1' as MessageId, text: 'hello' },
    'assistant.message.completed': {
      messageId: 'msg_1' as MessageId,
      content: [{ type: 'text', text: 'hello' }],
    },
    'user.message': { content: 'hello', role: 'user' },
    'tool.call.started': { toolCallId: 'tool_1' as ToolCallId, name: 'read' },
    'tool.call.delta': { toolCallId: 'tool_1' as ToolCallId, text: 'chunk' },
    'tool.call.completed': { toolCallId: 'tool_1' as ToolCallId, name: 'read' },
    'tool.call.failed': {
      toolCallId: 'tool_1' as ToolCallId,
      name: 'read',
      message: 'failed',
      code: 'codex_failed',
    },
    'usage.updated': { usage: { inputTokens: 1 } },
    diagnostic: { level: 'info', message: 'notice' },
    'driver.notice': { message: 'notice' },
    'terminal.surface.reported': {
      kind: 'tmux-session',
      socketPath: '/tmp/tmux-501/default',
      sessionName: 'asp-claude',
      paneId: '%1',
    },
    'permission.requested': {
      permissionRequestId: 'perm_1' as PermissionRequestId,
      kind: 'command',
      subjectDisplay: { argv: ['ls'] },
      defaultDecision: 'deny',
      deadlineMs: 1000,
    },
    'permission.resolved': {
      permissionRequestId: 'perm_1' as PermissionRequestId,
      decision: 'deny',
      decidedBy: 'policy',
      message: 'blocked',
    },
    'permission.cancelled': {
      permissionRequestId: 'perm_1' as PermissionRequestId,
      reason: 'invocation-stopping',
    },
    'provider.transcript.reported': {
      kind: 'provider-transcript-jsonl',
      artifactPath: '/tmp/provider-transcript.jsonl',
      provider: 'codex',
    },
  } satisfies InvocationEventPayloadMap

  test('accepts every final v1 invocation event type', () => {
    for (const [type, payload] of Object.entries(eventPayloads)) {
      expectValidatesTo(envelope(type, payload), envelope(type, payload))
    }
  })

  test('T-08430: usage.updated accepts a complete model identity from either source', () => {
    // Both members of UsageModelSource are accepted; the enum is exactly these
    // two, so an added member shows up here as an unused-case type error.
    const sources: UsageModelSource[] = ['provider-response', 'harness-config']
    for (const source of sources) {
      const model: UsageModelIdentity = { id: 'claude-opus-5', source }
      const payload: UsageUpdatedPayload = { usage: { inputTokens: 1 }, model }
      expectValidatesTo(envelope('usage.updated', payload), envelope('usage.updated', payload))
    }
  })

  test('T-08430: the model field is optional, so a driver may omit it', () => {
    const payload: UsageUpdatedPayload = { usage: { inputTokens: 1 } }
    expectValidatesTo(envelope('usage.updated', payload), envelope('usage.updated', payload))
  })

  test('T-08430: usage.updated rejects a half model identity', () => {
    // An id with no source would read as provider evidence it is not.
    expectInvalidEventEnvelope(
      envelope('usage.updated', { usage: {}, model: { id: 'claude-opus-5' } }),
      { path: 'payload.model.source', code: 'required' }
    )
    expectInvalidEventEnvelope(
      envelope('usage.updated', { usage: {}, model: { source: 'provider-response' } }),
      { path: 'payload.model.id', code: 'required' }
    )
    expectInvalidEventEnvelope(
      envelope('usage.updated', { usage: {}, model: { id: 'x', source: 'guessed' } }),
      { path: 'payload.model.source', code: 'invalid_literal' }
    )
    expectInvalidEventEnvelope(envelope('usage.updated', { usage: {}, model: 'claude-opus-5' }), {
      path: 'payload.model',
      code: 'invalid_type',
    })
  })

  test('rejects unsupported event types', () => {
    expectInvalidEventEnvelope(envelope('invocation.permission.request', {}), {
      path: 'type',
      code: 'invalid_event_type',
    })
  })

  test('validates invocation.ready and invocation.disposed payloads', () => {
    expectInvalidEventEnvelope(envelope('invocation.ready', {}), {
      path: 'payload.state',
      code: 'required',
    })
    expectInvalidEventEnvelope(envelope('invocation.disposed', {}), {
      path: 'payload.disposed',
      code: 'required',
    })
  })

  test('rejects a valid event name paired with another event payload', () => {
    expectInvalidEventEnvelope(
      envelope('assistant.message.delta', {
        turnId: 'turn_1',
        status: 'completed',
      }),
      {
        path: 'payload.messageId',
        code: 'required',
      }
    )
  })

  test('turn.failed requires a non-empty message with a stable validation issue', () => {
    for (const payload of [
      { turnId: 'turn_1', status: 'failed', finalOutput: 'legacy failure' },
      { turnId: 'turn_1', message: '' },
      { turnId: 'turn_1', message: '   ' },
    ]) {
      expectInvalidEventEnvelope(envelope('turn.failed', payload), {
        path: 'payload.message',
        code: 'required',
      })
    }
  })

  test('turn.attributed enforces ownership identity and origin literals', () => {
    expectValidatesTo(
      envelope('turn.attributed', {
        turnId: 'turn_foreign',
        ownership: 'foreign',
        origin: 'human',
      }),
      envelope('turn.attributed', {
        turnId: 'turn_foreign',
        ownership: 'foreign',
        origin: 'human',
      })
    )
    expectInvalidEventEnvelope(
      envelope('turn.attributed', {
        turnId: 'turn_own',
        ownership: 'own',
        origin: 'broker',
      }),
      { path: 'payload.inputId', code: 'required' }
    )
    expectInvalidEventEnvelope(
      envelope('turn.attributed', {
        turnId: 'turn_foreign',
        ownership: 'foreign',
        inputId: 'input_borrowed',
        origin: 'human',
      }),
      { path: 'payload.inputId', code: 'forbidden' }
    )
  })

  test('accepts terminal.surface.reported with kind:tmux-pane and full tmux ids', () => {
    const env = envelope('terminal.surface.reported', {
      kind: 'tmux-pane',
      socketPath: '/tmp/tmux-501/default',
      sessionId: '$3',
      windowId: '@7',
      paneId: '%12',
      sessionName: 'asp-claude',
      windowName: 'main',
    })
    expectValidatesTo(env)
  })

  test('accepts provider transcript reported with protocol-owned constants', () => {
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE']).toBe(
      'provider.transcript.reported'
    )
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_ARTIFACT_KIND']).toBe(
      'provider-transcript-jsonl'
    )
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_STORAGE']).toBe('file-path')
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_MEDIA_TYPE']).toBe(
      'application/x-ndjson'
    )
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_SCHEMA']).toBe(
      'harness-broker.provider-transcript.codex-jsonrpc-notification-jsonl/v1'
    )

    const env = envelope(
      providerTranscriptConstants['PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE'] as string,
      {
        kind: providerTranscriptConstants['PROVIDER_TRANSCRIPT_ARTIFACT_KIND'],
        artifactPath: '/tmp/provider-transcript.jsonl',
        provider: 'codex',
        harnessGeneration: 1,
      }
    )
    expectValidatesTo(env)
  })

  test('rejects provider transcript reported without an absolute string artifactPath', () => {
    const basePayload = {
      kind: 'provider-transcript-jsonl',
      artifactPath: '/tmp/provider-transcript.jsonl',
      provider: 'codex',
    }
    const eventType = 'provider.transcript.reported'

    // missing artifactPath -> required (build the payload WITHOUT the field;
    // spreading basePayload would keep a valid artifactPath and never trigger `required`)
    const payloadMissingArtifactPath = {
      kind: basePayload.kind,
      provider: basePayload.provider,
    }
    expectInvalidEventEnvelope(envelope(eventType, payloadMissingArtifactPath), {
      path: 'payload.artifactPath',
      code: 'required',
    })

    // present but invalid artifactPath -> invalid_type / invalid_path
    for (const { artifactPath, code } of [
      { artifactPath: 42, code: 'invalid_type' },
      { artifactPath: 'relative/provider-transcript.jsonl', code: 'invalid_path' },
    ]) {
      expectInvalidEventEnvelope(envelope(eventType, { ...basePayload, artifactPath }), {
        path: 'payload.artifactPath',
        code,
      })
    }
  })

  test('rejects terminal.surface.reported tmux-pane with malformed paneId', () => {
    expectInvalidEventEnvelope(
      envelope('terminal.surface.reported', {
        kind: 'tmux-pane',
        socketPath: '/tmp/tmux-501/default',
        sessionId: '$3',
        windowId: '@7',
        paneId: 'pane-12',
      }),
      {
        path: 'payload.paneId',
        code: 'invalid_tmux_id',
      }
    )
  })

  test('rejects terminal.surface.reported tmux-pane missing windowId', () => {
    expectInvalidEventEnvelope(
      envelope('terminal.surface.reported', {
        kind: 'tmux-pane',
        socketPath: '/tmp/tmux-501/default',
        sessionId: '$3',
        paneId: '%12',
      }),
      {
        path: 'payload.windowId',
        code: 'required',
      }
    )
  })

  test('requires terminal.surface.reported kind:tmux-pane when driver is claude-code-tmux', () => {
    const env = {
      invocationId: 'inv_1',
      seq: 1,
      time: '2026-05-28T00:00:00.000Z',
      type: 'terminal.surface.reported',
      payload: {
        kind: 'tmux-session',
        socketPath: '/tmp/tmux-501/default',
        sessionName: 'asp-claude',
        paneId: '%12',
      },
      driver: { kind: 'claude-code-tmux' },
    }
    expectInvalidEventEnvelope(env, {
      path: 'payload.kind',
      code: 'invalid_literal',
    })
  })

  test('requires terminal.surface.reported kind:tmux-pane when driver is codex-cli-tmux', () => {
    const env = {
      invocationId: 'inv_1',
      seq: 1,
      time: '2026-05-28T00:00:00.000Z',
      type: 'terminal.surface.reported',
      payload: {
        kind: 'tmux-session',
        socketPath: '/tmp/tmux-501/default',
        sessionName: 'asp-codex',
      },
      driver: { kind: 'codex-cli-tmux' },
    }
    expectInvalidEventEnvelope(env, {
      path: 'payload.kind',
      code: 'invalid_literal',
    })
  })

  test('validates permission event payloads', () => {
    expectInvalidEventEnvelope(
      envelope('permission.requested', {
        permissionRequestId: 'perm_1',
        kind: 'command',
        subjectDisplay: { argv: ['ls'] },
        defaultDecision: 'prompt',
      }),
      {
        path: 'payload.defaultDecision',
        code: 'invalid_literal',
      }
    )
    expectInvalidEventEnvelope(
      envelope('permission.resolved', {
        permissionRequestId: 'perm_1',
        decision: 'deny',
        decidedBy: 'client',
      }),
      {
        path: 'payload.decidedBy',
        code: 'invalid_literal',
      }
    )
  })

  // Terminal-outcome contract (T-06550): the tool.call.* payloads are the
  // normative carrier. tool.call.failed REQUIRES both message and an
  // always-populated machine-readable code; tool.call.started/completed require
  // toolCallId + name.
  test('tool.call.failed requires message AND an always-populated code', () => {
    expectInvalidEventEnvelope(
      envelope('tool.call.failed', { toolCallId: 'tool_1', name: 'read', code: 'x' }),
      { path: 'payload.message', code: 'required' }
    )
    expectInvalidEventEnvelope(
      envelope('tool.call.failed', { toolCallId: 'tool_1', name: 'read', message: 'boom' }),
      { path: 'payload.code', code: 'required' }
    )
    const valid = envelope('tool.call.failed', {
      toolCallId: 'tool_1',
      name: 'read',
      message: 'boom',
      code: 'codex_mcp_error',
    })
    expectValidatesTo(valid)
  })

  test('tool.call.started and tool.call.completed require toolCallId and name', () => {
    expectInvalidEventEnvelope(envelope('tool.call.started', { name: 'read' }), {
      path: 'payload.toolCallId',
      code: 'required',
    })
    expectInvalidEventEnvelope(envelope('tool.call.completed', { toolCallId: 'tool_1' }), {
      path: 'payload.name',
      code: 'required',
    })
  })

  test('validates lifecycle event payloads and generation fences', () => {
    const policy = conservativeDefaultLifecyclePolicyOverlay('policy_event')
    expect(
      validateEventEnvelope({
        invocationId: 'inv_1',
        seq: 1,
        time: '2026-05-24T00:00:00.000Z',
        type: 'lifecycle.policy.accepted',
        payload: {
          policyId: policy.policyId,
          policyHash: policy.policyHash,
          retentionMode: 'keep-alive',
          harnessRecoveryMode: 'none',
          turnRetryMode: 'none',
        },
      })
    ).toMatchObject({ type: 'lifecycle.policy.accepted' })

    expect(
      validateEventEnvelope({
        invocationId: 'inv_1',
        seq: 2,
        time: '2026-05-24T00:00:00.000Z',
        type: 'permission.cancelled',
        harnessGeneration: 1,
        turnAttempt: 1,
        payload: {
          permissionRequestId: 'perm_1',
          reason: 'harness-generation-ended',
          harnessGeneration: 1,
          turnAttempt: 1,
        },
      })
    ).toMatchObject({ type: 'permission.cancelled', harnessGeneration: 1, turnAttempt: 1 })

    expectInvalidEventEnvelope(
      {
        invocationId: 'inv_1',
        seq: 3,
        time: '2026-05-24T00:00:00.000Z',
        type: 'harness.started',
        harnessGeneration: 0,
        payload: {
          generation: 1,
          mode: 'initial',
          mechanism: 'direct-child',
        },
      },
      {
        path: 'harnessGeneration',
        code: 'invalid_positive_integer',
      }
    )
  })
})

describe('package boundaries', () => {
  test('event validator registry remains a total mapped type', () => {
    const eventPayloadSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'schema-event-payload.ts'),
      'utf8'
    )
    expect(eventPayloadSource).toContain('satisfies EventPayloadValidators')
    expect(eventPayloadSource).not.toContain(
      'Partial<Record<InvocationEventType, EventPayloadValidator>>'
    )
  })

  test('protocol source does not import spaces-runtime-contracts', () => {
    const sourceRoot = join(import.meta.dir, '..', 'src')
    for (const file of [
      'capabilities.ts',
      'commands.ts',
      'events.ts',
      'index.ts',
      'lifecycle.ts',
      'schemas.ts',
    ]) {
      expect(readFileSync(join(sourceRoot, file), 'utf8')).not.toContain('spaces-runtime-contracts')
    }
  })
})
