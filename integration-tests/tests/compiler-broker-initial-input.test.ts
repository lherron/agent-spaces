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
  test.each([false, true])(
    'puts the caller prompt in the only start request with the allocated input id, omitPriming=%s',
    async (omitPriming) => {
      const input = await initial({
        namespace: 'initial-prompt',
        omitPriming,
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: false,
        prompt: 'initial input must be canonical',
      })
      expect(String(input?.inputId)).toBe('input_initial-prompt')
      expect(input?.content).toEqual([{ type: 'text', text: 'initial input must be canonical' }])
    }
  )

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

  test('suppresses text input for an explicitly empty caller prompt', async () => {
    const input = await initial({
      namespace: 'initial-empty',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: '',
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
      omitPriming: true,
      attachments: [{ kind: 'image', path: image, mimeType: 'image/png' }],
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.omitPriming).toBe(true)
    const start = response.plan.execution.dispatchRequest.startRequest
    expect(start.initialInput?.content).toContainEqual({ type: 'local_image', path: image })
    expect(start.spec.driver).not.toHaveProperty('defaultImageAttachments')
  })

  test('keeps an image-only input image-only', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const image = `${fixture.projectRoot}/image-only.png`
    const response = await compileV2(fixture, {
      namespace: 'initial-image-only',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: '',
      attachments: [{ kind: 'image', path: image, mimeType: 'image/png' }],
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution.dispatchRequest.startRequest.initialInput?.content).toEqual([
      { type: 'local_image', path: image },
    ])
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

  test.each([
    {
      change: 'prompt',
      first: { prompt: 'first prompt' },
      second: { prompt: 'second prompt' },
    },
    {
      change: 'attachments',
      first: {
        prompt: 'same prompt',
        attachments: [{ kind: 'image' as const, path: 'a.png', mimeType: 'image/png' }],
      },
      second: {
        prompt: 'same prompt',
        attachments: [{ kind: 'image' as const, path: 'b.png', mimeType: 'image/png' }],
      },
    },
    {
      change: 'response format',
      first: {
        prompt: 'return structured output',
        responseFormat: {
          kind: 'json_schema' as const,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
      second: {
        prompt: 'return structured output',
        responseFormat: {
          kind: 'json_schema' as const,
          schema: { type: 'object', properties: { count: { type: 'number' } } },
        },
      },
    },
  ])(
    'start-request hash changes when initial input $change changes',
    async ({ change, first: firstInput, second: secondInput }) => {
      const fixture = createV2CompileFixture()
      fixtures.push(fixture)
      const common = {
        harness: 'codex' as const,
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: false,
      }
      // Attachment paths are made absolute under this fixture's project root.
      const anchor = (input: {
        prompt: string
        attachments?: ReadonlyArray<{ kind: 'image'; path: string; mimeType: string }>
        responseFormat?: Parameters<typeof compileV2>[1]['responseFormat']
      }): Pick<Parameters<typeof compileV2>[1], 'prompt' | 'attachments' | 'responseFormat'> => ({
        prompt: input.prompt,
        ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
        ...(input.attachments === undefined
          ? {}
          : {
              attachments: input.attachments.map((attachment) => ({
                ...attachment,
                path: `${fixture.projectRoot}/${attachment.path}`,
              })),
            }),
      })
      const slug = change.replace(/\s+/g, '-')
      const first = await compileV2(fixture, {
        ...common,
        ...anchor(firstInput),
        namespace: `initial-hash-${slug}-a`,
      })
      const second = await compileV2(fixture, {
        ...common,
        ...anchor(secondInput),
        namespace: `initial-hash-${slug}-b`,
      })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(second.plan.execution.profile.startRequestHash).not.toBe(
        first.plan.execution.profile.startRequestHash
      )
    }
  )

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
