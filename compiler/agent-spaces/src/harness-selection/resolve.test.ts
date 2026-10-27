import { describe, expect, test } from 'bun:test'
import {
  catalogProcessImplementationForFrontend,
  catalogProcessImplementationForHarness,
} from './catalog-projections.js'
import { resolveHarnessExecution } from './resolve.js'

describe('central harness selection catalog', () => {
  test('projects direct process facts only from the selected catalog harness', () => {
    expect(catalogProcessImplementationForHarness('agent-harness')).toBeUndefined()
    expect(catalogProcessImplementationForHarness('claude')).toMatchObject({
      frontend: 'claude-code',
      provider: 'anthropic',
      harness: 'claude',
    })
    expect(catalogProcessImplementationForHarness('codex')).toMatchObject({
      frontend: 'codex-cli',
      provider: 'openai',
      harness: 'codex',
    })
    expect(catalogProcessImplementationForHarness('muse')).toMatchObject({
      frontend: 'muse-cli',
      provider: 'meta',
      harness: 'muse',
    })
    expect(catalogProcessImplementationForFrontend('pi-cli')).toBeUndefined()
  })

  test.each([
    [
      'agent-harness',
      false,
      'agent-harness',
      'native-worker',
      false,
      'native-worker',
      'birth-variant',
    ],
    [
      'agent-harness',
      true,
      'agent-harness-tmux',
      'native-worker',
      true,
      'native-worker',
      'birth-variant',
    ],
    ['claude', false, 'claude-code-tmux', 'pty', true, 'broker-process', 'intrinsic'],
    ['claude', true, 'claude-code-tmux', 'pty', true, 'broker-process', 'intrinsic'],
    ['codex', false, 'codex-app-server', 'jsonrpc-stdio', false, 'broker-process', 'attachable'],
    ['codex', true, 'codex-app-server', 'jsonrpc-stdio', true, 'broker-process', 'attachable'],
    ['muse', false, 'muse-serve', 'jsonrpc-stdio', false, 'broker-process', 'birth-variant'],
    ['muse', true, 'muse-cli-tmux', 'pty', true, 'broker-process', 'birth-variant'],
  ] as const)(
    '%s presentation=%s resolves the exact recipe',
    (
      harness,
      presentation,
      driver,
      executionTransport,
      terminalRequired,
      processExecution,
      fulfillment
    ) => {
      const result = resolveHarnessExecution({
        agent: { id: 'cody' },
        requested: { harness, presentation },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.selection.harness).toBe(harness)
      expect(result.selection.presentation).toBe(presentation)
      expect(result.recipe.driver).toBe(driver)
      expect(result.recipe.protocol).toBe('harness-broker/0.2')
      expect(result.recipe.hosting.executionTransport).toBe(executionTransport)
      expect(result.recipe.hosting.terminalRequired).toBe(terminalRequired)
      expect(result.recipe.hosting.processExecution).toBe(processExecution)
      expect(result.recipe.presentationFulfillment).toBe(fulfillment)
      if (harness === 'codex' && presentation) {
        expect(result.recipe.presentationSurface).toEqual({
          transport: 'websocket-unix',
          terminalHost: 'tmux',
        })
      } else expect(result.recipe.presentationSurface).toBeUndefined()
    }
  )

  test('defaults to agent-harness and true presentation', () => {
    const result = resolveHarnessExecution({ agent: { id: 'cody' } })
    expect(result).toMatchObject({
      ok: true,
      selection: {
        harness: 'agent-harness',
        modelProvider: 'openai-codex',
        model: 'gpt-5.5',
        presentation: true,
        provenance: { harness: 'catalog-default', presentation: 'catalog-default' },
      },
    })
  })

  test('uses independent provider/model defaults and rejects incompatible explicit values', () => {
    expect(
      resolveHarnessExecution({ agent: { id: 'cody' }, requested: { harness: 'codex' } })
    ).toMatchObject({
      ok: true,
      selection: { modelProvider: 'openai-codex', model: 'gpt-5.6-terra' },
    })
    expect(
      resolveHarnessExecution({
        agent: { id: 'cody' },
        requested: { harness: 'agent-harness', modelProvider: 'anthropic-max' },
      })
    ).toMatchObject({
      ok: true,
      selection: { modelProvider: 'anthropic-max', model: 'claude-sonnet-4-5' },
    })
    expect(
      resolveHarnessExecution({
        agent: { id: 'cody' },
        requested: { harness: 'codex', modelProvider: 'anthropic' },
      })
    ).toMatchObject({
      ok: false,
      code: 'unsupported_model_provider',
    })
    expect(
      resolveHarnessExecution({
        agent: { id: 'cody' },
        requested: { harness: 'codex', model: 'openai/gpt-5.5' },
      })
    ).toMatchObject({
      ok: false,
      code: 'unsupported_model',
    })
  })

  test.each(['opus[1m]', 'opus', 'fable', 'sonnet', 'haiku', 'claude-sonnet-4-5'])(
    'accepts the retained Claude Code model %s',
    (model) => {
      expect(
        resolveHarnessExecution({
          agent: { id: 'cody' },
          requested: { harness: 'claude', model },
        })
      ).toMatchObject({
        ok: true,
        selection: { harness: 'claude', modelProvider: 'anthropic', model },
      })
    }
  )

  test('refuses disagreement among explicit agent identities', () => {
    expect(
      resolveHarnessExecution({ agent: { id: 'cody' }, consistency: { agentIds: ['other'] } })
    ).toMatchObject({
      ok: false,
      code: 'configured_context_mismatch',
    })
  })
})
