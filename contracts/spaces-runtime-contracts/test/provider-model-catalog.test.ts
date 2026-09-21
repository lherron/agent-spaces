import { describe, expect, test } from 'bun:test'
import type { PiProviderModelCatalogEntry } from '../src/index'
import { PI_PROVIDER_MODEL_CATALOG, findPiProviderModelCatalogEntry } from '../src/index'

describe('PI_PROVIDER_MODEL_CATALOG', () => {
  test('keeps API-key and OAuth model identities explicit without a harness route', () => {
    const catalog: readonly PiProviderModelCatalogEntry[] = PI_PROVIDER_MODEL_CATALOG
    expect(PI_PROVIDER_MODEL_CATALOG).toEqual(
      expect.arrayContaining([
        {
          alias: 'openai-codex/gpt-5.6-sol',
          modelProvider: 'openai-codex',
          piProvider: 'openai-codex',
          piModelId: 'openai-codex/gpt-5.6-sol',
          authMode: 'oauth',
        },
        {
          alias: 'anthropic-max/claude-sonnet-4-5',
          modelProvider: 'anthropic-max',
          piProvider: 'anthropic',
          piModelId: 'anthropic/claude-sonnet-4-5',
          authMode: 'oauth',
        },
      ])
    )
    expect(
      findPiProviderModelCatalogEntry('anthropic-max', 'anthropic-max/claude-sonnet-4-5')
    ).toEqual({
      alias: 'anthropic-max/claude-sonnet-4-5',
      modelProvider: 'anthropic-max',
      piProvider: 'anthropic',
      piModelId: 'anthropic/claude-sonnet-4-5',
      authMode: 'oauth',
    })
    expect(catalog).toBe(PI_PROVIDER_MODEL_CATALOG)
  })
})
