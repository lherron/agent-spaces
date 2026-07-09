import { describe, expect, test } from 'bun:test'
import {
  CODEX_CLI_FRONTEND,
  PI_CLI_FRONTEND,
  resolveFrontend,
  resolveModel,
} from './client-support.js'

describe('GPT-5.6 frontend support', () => {
  test('defaults Codex to Terra and accepts every GPT-5.6 variant', () => {
    const codex = resolveFrontend(CODEX_CLI_FRONTEND)

    expect(codex.defaultModel).toBe('gpt-5.6-terra')
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(resolveModel(codex, model).ok).toBe(true)
    }
  })

  test('does not advertise GPT-5.6 through Pi before Pi supports it', () => {
    const pi = resolveFrontend(PI_CLI_FRONTEND)

    expect(pi.defaultModel).toBe('gpt-5.5')
    expect(resolveModel(pi, 'gpt-5.6-terra')).toEqual({
      ok: false,
      modelId: 'gpt-5.6-terra',
    })
  })
})
