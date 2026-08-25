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
  test('keeps the POC purple/cyan identity and truecolor palette', () => {
    const theme = createResourceLoaderTheme('/runtime/theme.ts')
    expect(theme.name).toBe(RESOURCE_LOADER_THEME_NAME)
    expect(theme.sourcePath).toBe('/runtime/theme.ts')
    expect(theme.getColorMode()).toBe('truecolor')
    expect(theme.getFgAnsi('accent')).toContain('34;211;238')
    expect(theme.getFgAnsi('border')).toContain('168;85;247')
    expect(theme.getFgAnsi('toolOutput')).toContain('207;250;254')
    expect(theme.getBgAnsi('userMessageBg')).toContain('109;40;217')
    expect(theme.getBgAnsi('toolSuccessBg')).toContain('22;101;52')
  })
})
