import { describe, expect, test } from 'bun:test'
import type { InvocationInput, InvocationResponseFormat } from '../src/commands'
import { validateInvocationInput } from '../src/schemas'

/**
 * Symbol-level contract coverage for the per-turn `InvocationResponseFormat`
 * (T-03779). Asserts the typed variants round-trip through validation and that
 * the protocol type composes onto `InvocationInput`.
 */
describe('InvocationResponseFormat contract', () => {
  test('text variant validates and composes onto InvocationInput', () => {
    const responseFormat: InvocationResponseFormat = { kind: 'text' }
    const input: InvocationInput = {
      inputId: 'input_text',
      kind: 'user',
      content: [{ type: 'text', text: 'plain' }],
      responseFormat,
    }
    expect(validateInvocationInput(input)).toEqual(input)
  })

  test('json_schema variant carries an object-root schema', () => {
    const responseFormat: InvocationResponseFormat = {
      kind: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { type: 'string' } },
        required: ['status'],
      },
    }
    const input: InvocationInput = {
      inputId: 'input_schema',
      kind: 'user',
      content: [{ type: 'text', text: 'structured' }],
      responseFormat,
    }
    expect(validateInvocationInput(input)).toEqual(input)
  })
})
