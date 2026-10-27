import { describe, expect, test } from 'bun:test'
import { codexNativeToolIdentity } from '../../src/drivers/codex-tool-identity'
import { toolCallIdFrom } from '../ids'

describe('Codex cross-adapter tool identity conformance', () => {
  test('shared identity mapping does not invent lifecycle or erase adapter-specific aliases', () => {
    expect(
      codexNativeToolIdentity(
        'DynamicToolCall',
        { type: 'DynamicToolCall', id: 'dynamic-1' },
        'DynamicToolCall'
      )
    ).toEqual({
      itemId: 'dynamic-1',
      toolCallId: toolCallIdFrom('dynamic-1'),
      name: 'DynamicToolCall',
    })
    expect(codexNativeToolIdentity('CommandExecution', {}, 'CommandExecution')).toBeUndefined()
  })
})
