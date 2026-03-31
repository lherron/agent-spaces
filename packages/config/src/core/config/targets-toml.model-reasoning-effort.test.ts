/**
 * RED tests: model_reasoning_effort in asp-targets.toml (T-00947)
 *
 * WHY: Codex supports a per-request reasoning-effort knob. Users need to configure
 * a default via asp-targets.toml ([codex] and [targets.<name>.codex]) and override
 * it at runtime via --model-reasoning-effort CLI flag.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. `CodexOptions` has `model_reasoning_effort?: string | undefined`
 * 2. `mergeCodexOptions` merges the new field (target overrides top-level)
 * 3. `getEffectiveCodexOptions` returns `model_reasoning_effort` from merged options
 * 4. `parseTargetsToml` accepts and validates `model_reasoning_effort` in [codex] and
 *    [targets.<name>.codex] sections without throwing ConfigValidationError
 * 5. `serializeTargetsToml` serializes `model_reasoning_effort` back to TOML
 * 6. Round-trip: serialize → parse preserves `model_reasoning_effort` values
 *
 * wrkq task: T-00947
 */

import { describe, expect, test } from 'bun:test'
import type { ProjectManifest } from '../types/targets.js'
import { getEffectiveCodexOptions, mergeCodexOptions } from '../types/targets.js'
import { parseTargetsToml, serializeTargetsToml } from './targets-toml.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parser: [codex] top-level model_reasoning_effort
// ─────────────────────────────────────────────────────────────────────────────

describe('parseTargetsToml: model_reasoning_effort in [codex]', () => {
  test('parses top-level [codex] model_reasoning_effort', () => {
    const toml = `
schema = 1

[codex]
model_reasoning_effort = "high"

[targets.default]
compose = ["space:my-space@stable"]
`
    const result = parseTargetsToml(toml)
    expect(result.codex?.model_reasoning_effort).toBe('high')
  })

  test('parses target-level [targets.default.codex] model_reasoning_effort', () => {
    const toml = `
schema = 1

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.codex]
model_reasoning_effort = "low"
`
    const result = parseTargetsToml(toml)
    expect(result.targets.default.codex?.model_reasoning_effort).toBe('low')
  })

  test('parses both top-level and target-level together', () => {
    const toml = `
schema = 1

[codex]
model_reasoning_effort = "medium"

[targets.heavy]
compose = ["space:heavy@stable"]

[targets.heavy.codex]
model_reasoning_effort = "high"

[targets.light]
compose = ["space:light@stable"]
`
    const result = parseTargetsToml(toml)
    expect(result.codex?.model_reasoning_effort).toBe('medium')
    expect(result.targets.heavy.codex?.model_reasoning_effort).toBe('high')
    // light target inherits top-level, has no override
    expect(result.targets.light.codex?.model_reasoning_effort).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. mergeCodexOptions: field propagation and override semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeCodexOptions: model_reasoning_effort', () => {
  test('target override beats top-level', () => {
    const merged = mergeCodexOptions(
      { model_reasoning_effort: 'medium' },
      { model_reasoning_effort: 'high' }
    )
    expect(merged.model_reasoning_effort).toBe('high')
  })

  test('top-level used when target does not specify', () => {
    const merged = mergeCodexOptions({ model_reasoning_effort: 'low' }, {})
    expect(merged.model_reasoning_effort).toBe('low')
  })

  test('undefined top-level + defined target produces target value', () => {
    const merged = mergeCodexOptions({}, { model_reasoning_effort: 'high' })
    expect(merged.model_reasoning_effort).toBe('high')
  })

  test('both undefined → merged result has no model_reasoning_effort', () => {
    const merged = mergeCodexOptions({}, {})
    expect(merged.model_reasoning_effort).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. getEffectiveCodexOptions: end-to-end merge from manifest
// ─────────────────────────────────────────────────────────────────────────────

describe('getEffectiveCodexOptions: model_reasoning_effort', () => {
  test('target-level overrides top-level', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      codex: { model_reasoning_effort: 'medium' },
      targets: {
        fast: {
          compose: ['space:fast@stable'],
          codex: { model_reasoning_effort: 'low' },
        },
      },
    }
    const opts = getEffectiveCodexOptions(manifest, 'fast')
    expect(opts.model_reasoning_effort).toBe('low')
  })

  test('top-level used when target has no codex section', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      codex: { model_reasoning_effort: 'high' },
      targets: {
        default: { compose: ['space:default@stable'] },
      },
    }
    const opts = getEffectiveCodexOptions(manifest, 'default')
    expect(opts.model_reasoning_effort).toBe('high')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Round-trip: serialize → parse preserves model_reasoning_effort
// ─────────────────────────────────────────────────────────────────────────────

describe('round-trip: model_reasoning_effort', () => {
  test('top-level [codex] model_reasoning_effort survives serialize/parse cycle', () => {
    const original: ProjectManifest = {
      schema: 1,
      codex: { model_reasoning_effort: 'high' },
      targets: {
        default: { compose: ['space:default@stable'] },
      },
    }
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(parsed.codex?.model_reasoning_effort).toBe('high')
  })

  test('target-level [targets.x.codex] model_reasoning_effort survives serialize/parse cycle', () => {
    const original: ProjectManifest = {
      schema: 1,
      targets: {
        reasoning: {
          compose: ['space:reasoning@stable'],
          codex: { model_reasoning_effort: 'medium' },
        },
      },
    }
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(parsed.targets.reasoning.codex?.model_reasoning_effort).toBe('medium')
  })
})
