import { must } from '../../test-support/must.js'
import { serializeTargetsToml } from './targets-toml.js'
/**
 * priming_append in asp-targets.toml (T-00992)
 *
 * WHY: priming_append additively extends an agent's priming prompt, so a target
 * may not also replace the prompt with priming.
 *
 * compose_mode and priming_append parsing is pinned by the full-manifest test in
 * targets-toml.test.ts; schema rejections are rows of its rejection table.
 *
 * wrkq task: T-00992
 */

import { describe, expect, test } from 'bun:test'
import { ConfigValidationError } from '../errors.js'
import { parseTargetsToml } from './targets-toml.js'

describe('parseTargetsToml: priming_append', () => {
  test('rejects both priming and priming_append on same target', () => {
    const toml = `
schema = 2

[targets.larry]
compose = ["space:defaults@dev"]
priming = "You are Larry."
priming_append = "\\n## Extra context"
`
    expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * RED tests: compose_mode and priming_append in asp-targets.toml (T-00992)
   *
   * WHY: Project-level asp-targets.toml needs compose_mode (replace|merge) to control
   * how project compose lists interact with agent defaults, and priming_append
   * to additively extend an agent's priming prompt without replacing it entirely.
   *
   * PASS CONDITIONS (all tests green when):
   * 1. TargetDefinition type includes compose_mode?: 'replace' | 'merge'
   * 2. TargetDefinition type includes priming_append?: string
   * 3. parseTargetsToml accepts compose_mode in target definitions
   * 4. parseTargetsToml accepts priming_append in target definitions
   * 5. parseTargetsToml rejects both priming + priming_append on same target
   * 6. JSON schema (targets.schema.json) updated to allow compose_mode and priming_append
   * 7. serializeTargetsToml round-trips compose_mode and priming_append
   *
   * wrkq task: T-00992
   */

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Round-trip serialization
  // ─────────────────────────────────────────────────────────────────────────────

  describe('round-trip: compose_mode and priming_append', () => {
    test('compose_mode survives serialize/parse cycle', () => {
      const original = {
        schema: 2 as const,
        targets: {
          larry: {
            compose: ['space:defaults@dev' as const],
            compose_mode: 'merge' as const,
          },
        },
      }
      const serialized = serializeTargetsToml(original)
      const parsed = parseTargetsToml(serialized)
      expect(must(parsed.targets['larry']).compose_mode).toBe('merge')
    })

    test('priming_append survives serialize/parse cycle', () => {
      const original = {
        schema: 2 as const,
        targets: {
          larry: {
            compose: ['space:defaults@dev' as const],
            priming_append: 'Extra project context.',
          },
        },
      }
      const serialized = serializeTargetsToml(original)
      const parsed = parseTargetsToml(serialized)
      expect(must(parsed.targets['larry']).priming_append).toBe('Extra project context.')
    })
  })
})
