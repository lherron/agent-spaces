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
import { must } from '../../test-support/must.js'
import type { ProjectManifest } from '../types/targets.js'
import { getEffectiveCodexOptions } from '../types/targets.js'
import { parseTargetsToml, serializeTargetsToml } from './targets-toml.js'

// ─────────────────────────────────────────────────────────────────────────────
// 3. getEffectiveCodexOptions: end-to-end merge from manifest
// ─────────────────────────────────────────────────────────────────────────────

describe('getEffectiveCodexOptions: model_reasoning_effort', () => {
  test('target-level overrides top-level', () => {
    const manifest: ProjectManifest = {
      schema: 2,
      codex: { model_reasoning_effort: 'medium' },
      targets: {
        fast: {
          compose: ['space:fast@stable'],
          provisioning: { codex: { model_reasoning_effort: 'low' } },
        },
      },
    }
    const opts = getEffectiveCodexOptions(manifest, 'fast')
    expect(opts.model_reasoning_effort).toBe('low')
  })

  test('top-level used when target has no codex section', () => {
    const manifest: ProjectManifest = {
      schema: 2,
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
      schema: 2,
      codex: { model_reasoning_effort: 'high' },
      targets: {
        default: { compose: ['space:default@stable'] },
      },
    }
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(parsed.codex?.model_reasoning_effort).toBe('high')
  })

  test('target-level [targets.x.provisioning.codex] model_reasoning_effort survives serialize/parse cycle', () => {
    const original: ProjectManifest = {
      schema: 2,
      targets: {
        reasoning: {
          compose: ['space:reasoning@stable'],
          provisioning: { codex: { model_reasoning_effort: 'medium' } },
        },
      },
    }
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(must(parsed.targets['reasoning']).provisioning?.codex?.model_reasoning_effort).toBe(
      'medium'
    )
  })
})
