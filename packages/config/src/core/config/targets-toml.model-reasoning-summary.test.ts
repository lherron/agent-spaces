import { describe, expect, test } from 'bun:test'
import type { ProjectManifest } from '../types/targets.js'
import { getEffectiveCodexOptions, mergeCodexOptions } from '../types/targets.js'
import { parseTargetsToml, serializeTargetsToml } from './targets-toml.js'

describe('asp-targets.toml model_reasoning_summary', () => {
  test('parses top-level and target values', () => {
    const parsed = parseTargetsToml(`
schema = 1

[codex]
model_reasoning_summary = "concise"

[targets.default]
compose = ["space:test@stable"]

[targets.default.codex]
model_reasoning_summary = "detailed"
`)

    expect(parsed.codex?.model_reasoning_summary).toBe('concise')
    expect(parsed.targets.default.codex?.model_reasoning_summary).toBe('detailed')
  })

  test('rejects unsupported values', () => {
    expect(() =>
      parseTargetsToml(`
schema = 1

[codex]
model_reasoning_summary = "verbose"
`)
    ).toThrow()
  })

  test('target value overrides the top-level value, including none', () => {
    const merged = mergeCodexOptions(
      { model_reasoning_summary: 'detailed' },
      { model_reasoning_summary: 'none' }
    )
    expect(merged.model_reasoning_summary).toBe('none')

    const manifest: ProjectManifest = {
      schema: 1,
      codex: { model_reasoning_summary: 'auto' },
      targets: {
        default: { codex: { model_reasoning_summary: 'concise' } },
      },
    }
    expect(getEffectiveCodexOptions(manifest, 'default').model_reasoning_summary).toBe('concise')
  })

  test('round-trips top-level and target values', () => {
    const original: ProjectManifest = {
      schema: 1,
      codex: { model_reasoning_summary: 'auto' },
      targets: {
        default: { codex: { model_reasoning_summary: 'none' } },
      },
    }

    const parsed = parseTargetsToml(serializeTargetsToml(original))
    expect(parsed.codex?.model_reasoning_summary).toBe('auto')
    expect(parsed.targets.default.codex?.model_reasoning_summary).toBe('none')
  })
})
