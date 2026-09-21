import { describe, expect, test } from 'bun:test'
import { HARNESS_CATALOG, HARNESS_IDS } from './catalog.js'
import { resolveHarnessExecution } from './resolve.js'

describe('central harness selection catalog', () => {
  test('contains exactly the v2 public harness identities', () => {
    expect(HARNESS_IDS).toEqual(['agent-harness', 'claude', 'codex', 'muse'])
    expect(Object.keys(HARNESS_CATALOG).sort()).toEqual([
      'agent-harness',
      'claude',
      'codex',
      'muse',
    ])
  })

  test.each(
    HARNESS_IDS.flatMap((harness) =>
      [false, true].map((presentation) => ({ harness, presentation }))
    )
  )(
    '$harness presentation=$presentation resolves to its catalog recipe',
    ({ harness, presentation }) => {
      const result = resolveHarnessExecution({
        agent: { id: 'cody' },
        requested: { harness, presentation },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.selection.harness).toBe(harness)
      expect(result.selection.presentation).toBe(presentation)
      expect(result.recipe.driver).toBeDefined()
      expect(result.recipe.protocol).toBe('harness-broker/0.2')
      expect(result.recipe.hosting.terminalRequired).toBe(
        result.recipe.hosting.terminalHost === 'tmux' || harness === 'claude'
      )
    }
  )

  test('defaults to agent-harness and false presentation', () => {
    const result = resolveHarnessExecution({ agent: { id: 'cody' } })
    expect(result).toMatchObject({
      ok: true,
      selection: {
        harness: 'agent-harness',
        modelProvider: 'openai-codex',
        model: 'gpt-5.5',
        presentation: false,
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

  test('preserves an explicit false over a lower presentation true', () => {
    const result = resolveHarnessExecution({
      agent: { id: 'cody' },
      provisioningLayers: { agentProfile: { presentation: true } },
      requested: { presentation: false },
    })
    expect(result).toMatchObject({
      ok: true,
      selection: { presentation: false, provenance: { presentation: 'compile-request' } },
    })
  })

  test('applies every provisioning layer in declared precedence order', () => {
    const result = resolveHarnessExecution({
      agent: { id: 'cody' },
      provisioningLayers: {
        agentProfile: { harness: 'claude', presentation: true },
        projectTarget: { harness: 'muse', presentation: false },
        summonDirectives: { harness: 'codex', presentation: true },
      },
      requested: { harness: 'agent-harness', presentation: false },
    })
    expect(result).toMatchObject({
      ok: true,
      selection: {
        harness: 'agent-harness',
        presentation: false,
        provenance: { harness: 'compile-request', presentation: 'compile-request' },
      },
    })
  })

  test('refuses disagreement among explicit agent identities', () => {
    expect(
      resolveHarnessExecution({ agent: { id: 'cody' }, consistency: { agentIds: ['other'] } })
    ).toMatchObject({
      ok: false,
      code: 'configured_context_mismatch',
    })
  })
})
