import { describe, expect, test } from 'bun:test'
import {
  buildThreadStartParams,
  defaultProviderTranscriptDir,
  validateInitializeHandshake,
} from '../../../src/drivers/codex-app-server/driver'
import { buildTurnStartParams } from '../../../src/drivers/codex-app-server/input'
import { scenarioSpec, userInput } from './fake-codex-scenario'

describe('fallback provider transcript root', () => {
  test('fallback provider transcript roots are fenced by OS user', () => {
    expect(defaultProviderTranscriptDir('/tmp', 501)).toBe(
      '/tmp/spaces-harness-broker-provider-transcripts-uid-501'
    )
    expect(defaultProviderTranscriptDir('/tmp', 502)).toBe(
      '/tmp/spaces-harness-broker-provider-transcripts-uid-502'
    )
    expect(defaultProviderTranscriptDir('/tmp', null)).toBe(
      '/tmp/spaces-harness-broker-provider-transcripts-current-user'
    )
    expect(defaultProviderTranscriptDir('/tmp', 501)).not.toBe(
      defaultProviderTranscriptDir('/tmp', 502)
    )
  })
})

describe('buildTurnStartParams outputSchema', () => {
  test('maps each input responseFormat JSON Schema to that turn/start outputSchema only', () => {
    const firstSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' } },
      required: ['status'],
    }
    const secondSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { count: { type: 'number' } },
      required: ['count'],
    }
    const base = {
      threadId: 'thread_structured_response',
      cwd: '/workspace/project',
      driver: {
        kind: 'codex-app-server' as const,
        approvalPolicy: 'never' as const,
        sandboxMode: 'workspace-write' as const,
      },
    }

    // T-03779: structured output is per-turn input data, not a sticky
    // invocation-level Codex driver setting.
    expect(
      buildTurnStartParams({
        ...base,
        input: {
          ...userInput,
          inputId: 'input_schema_1',
          responseFormat: { kind: 'json_schema', schema: firstSchema },
        } as typeof userInput,
      }).outputSchema
    ).toEqual(firstSchema)
    expect(
      buildTurnStartParams({
        ...base,
        input: {
          ...userInput,
          inputId: 'input_schema_2',
          responseFormat: { kind: 'json_schema', schema: secondSchema },
        } as typeof userInput,
      }).outputSchema
    ).toEqual(secondSchema)
    expect(
      buildTurnStartParams({
        ...base,
        input: {
          ...userInput,
          inputId: 'input_text_response',
          responseFormat: { kind: 'text' },
        } as typeof userInput,
      }).outputSchema
    ).toBeNull()
    expect(buildTurnStartParams({ ...base, input: userInput }).outputSchema).toBeNull()
  })
})

describe('buildThreadStartParams driver-spec field handling (H6)', () => {
  const baseSpec = scenarioSpec('start-fresh-turn')

  test('forwards model, approvalPolicy and sandboxMode', () => {
    const params = buildThreadStartParams(baseSpec, {
      kind: 'codex-app-server',
      model: 'gpt-5-codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
    })
    expect(params).toMatchObject({
      model: 'gpt-5-codex',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      cwd: baseSpec.process.cwd,
    })
  })

  test('sends no profile: Codex app-server thread/start has no profile field (T-08582)', () => {
    const params = buildThreadStartParams(baseSpec, { kind: 'codex-app-server' })
    expect(Object.hasOwn(params, 'profile')).toBe(false)
  })

  test('forwards modelReasoningEffort as a thread-scope config override', () => {
    const params = buildThreadStartParams(baseSpec, {
      kind: 'codex-app-server',
      modelReasoningEffort: 'high',
    })
    expect(params['config']).toEqual({ model_reasoning_effort: 'high' })
  })

  test('defaults to safe nulls and never-approve when fields are absent', () => {
    const params = buildThreadStartParams(baseSpec, { kind: 'codex-app-server' })
    expect(params).toMatchObject({
      model: null,
      sandbox: null,
      config: null,
      approvalPolicy: 'never',
    })
  })
})

describe('validateInitializeHandshake tolerance (H6)', () => {
  function collectDiagnostics() {
    const diagnostics: Array<{ level: string; message: string }> = []
    const emit = (level: string, message: string) => {
      diagnostics.push({ level, message })
    }
    return { diagnostics, emit: emit as Parameters<typeof validateInitializeHandshake>[1] }
  }

  test('accepts a namespaced protocolVersion with no diagnostics', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() =>
      validateInitializeHandshake({ protocolVersion: 'codex-app-server/v0' }, emit)
    ).not.toThrow()
    expect(diagnostics).toHaveLength(0)
  })

  test('throws on a clearly-unsupported protocolVersion', () => {
    const { emit } = collectDiagnostics()
    expect(() =>
      validateInitializeHandshake({ protocolVersion: 'acp-incompatible/v1' }, emit)
    ).toThrow(/Unsupported Codex app-server protocol version/)
  })

  test('tolerates a missing protocolVersion with a debug diagnostic', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() => validateInitializeHandshake({ capabilities: {} }, emit)).not.toThrow()
    expect(diagnostics).toEqual([
      { level: 'debug', message: 'Codex initialize response omitted protocolVersion' },
    ])
  })

  test('tolerates a non-object response with a warn diagnostic', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() => validateInitializeHandshake(null, emit)).not.toThrow()
    expect(diagnostics[0]?.level).toBe('warn')
  })

  test('tolerates a non-string protocolVersion with a warn diagnostic', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() => validateInitializeHandshake({ protocolVersion: 42 }, emit)).not.toThrow()
    expect(diagnostics[0]?.level).toBe('warn')
  })
})
