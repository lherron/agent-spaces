import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function initial(options: Parameters<typeof compileV2>[1]) {
  const fixture = createV2CompileFixture()
  fixtures.push(fixture)
  const response = await compileV2(fixture, options)
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return response.plan.execution.dispatchRequest.startRequest.initialInput
}

describe('v2 broker initial input composition', () => {
  test('puts the caller prompt in the only start request with the allocated input id', async () => {
    const input = await initial({
      namespace: 'initial-prompt',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'initial input must be canonical',
    })
    expect(String(input?.inputId)).toBe('input_initial-prompt')
    expect(input?.content).toContainEqual({ type: 'text', text: 'initial input must be canonical' })
  })

  test('does not create an input when prompt, attachments, and response format are absent', async () => {
    const input = await initial({
      namespace: 'initial-absent',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      omitPriming: true,
    })
    expect(input).toBeUndefined()
  })

  test('preserves image attachments in the start input without duplicating them into driver fields', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const image = `${fixture.projectRoot}/diagram.png`
    const response = await compileV2(fixture, {
      namespace: 'initial-image',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'inspect image',
      attachments: [{ kind: 'image', path: image, mimeType: 'image/png' }],
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const start = response.plan.execution.dispatchRequest.startRequest
    expect(start.initialInput?.content).toContainEqual({ type: 'local_image', path: image })
    expect(start.spec.driver).not.toHaveProperty('defaultImageAttachments')
  })

  test('threads a response schema onto the initial input rather than the driver spec', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const schema = {
      kind: 'json_schema' as const,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { type: 'string' } },
        required: ['status'],
      },
    }
    const response = await compileV2(fixture, {
      namespace: 'initial-format',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'return a status',
      responseFormat: schema,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution.dispatchRequest.startRequest.initialInput).toMatchObject({
      responseFormat: schema,
    })
    expect(response.plan.execution.dispatchRequest.startRequest.spec.driver).not.toHaveProperty(
      'responseFormat'
    )
  })

  test('response format alone does not create a synthetic user turn', async () => {
    const input = await initial({
      namespace: 'initial-format-only',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      omitPriming: true,
      responseFormat: {
        kind: 'json_schema',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    })
    expect(input).toBeUndefined()
  })

  test('retains materialization task context as correlation-safe labels on the start spec', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'initial-task-context',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      taskContext: {
        taskId: 'T-08704',
        phase: 'compile',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'initial input task context',
      },
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution.dispatchRequest.startRequest.spec.labels).toMatchObject({
      task: 'T-08704',
    })
  })
})
