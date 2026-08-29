import { describe, expect, test } from 'bun:test'

import {
  RESOURCE_LOADER_THEME_NAME,
  createResourceLoaderTheme,
  resolveAgentHarnessModel,
} from './index'

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

describe('praesidium-loader theme', () => {
  test('uses Pi dark except at the harness interaction boundary', () => {
    const theme = createResourceLoaderTheme('/runtime/theme.ts')
    expect(theme.name).toBe(RESOURCE_LOADER_THEME_NAME)
    expect(theme.sourcePath).toBe('/runtime/theme.ts')
    expect(theme.getColorMode()).toBe('truecolor')

    // Pi dark baseline.
    expect(theme.getFgAnsi('accent')).toContain('138;190;183')
    expect(theme.getFgAnsi('toolOutput')).toContain('128;128;128')
    expect(theme.getBgAnsi('toolSuccessBg')).toContain('40;50;40')

    // Harness-only input, editor-border, and status-line overrides.
    expect(theme.getFgAnsi('userMessageText')).toContain('255;255;255')
    expect(theme.getBgAnsi('userMessageBg')).toContain('109;40;217')
    expect(theme.getFgAnsi('thinkingMedium')).toContain('168;85;247')
    expect(theme.getFgAnsi('bashMode')).toContain('34;211;238')
    expect(theme.getFgAnsi('dim')).toContain('167;139;250')
  })
})
