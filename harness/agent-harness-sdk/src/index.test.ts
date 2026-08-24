import { describe, expect, test } from 'bun:test'

import { resolveAgentHarnessModel } from './index'

describe('resolveAgentHarnessModel', () => {
  test('maps Cody bare GPT-5.6 identity onto the OAuth Pi namespace', () => {
    expect(resolveAgentHarnessModel(undefined, 'gpt-5.6-sol')).toEqual({
      alias: 'openai-codex/gpt-5.6-sol',
      piProvider: 'openai-codex',
      piModelId: 'openai-codex/gpt-5.6-sol',
      authMode: 'oauth',
    })
  })

  test('rejects uncatalogued direct-harness models', () => {
    expect(() => resolveAgentHarnessModel('openai', 'not-a-real-model')).toThrow(
      'Unsupported direct-harness model'
    )
  })
})
