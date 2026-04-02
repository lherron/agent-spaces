/**
 * RED tests: compose_mode and priming_prompt_append in asp-targets.toml (T-00992)
 *
 * WHY: Project-level asp-targets.toml needs compose_mode (replace|merge) to control
 * how project compose lists interact with agent defaults, and priming_prompt_append
 * to additively extend an agent's priming prompt without replacing it entirely.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. TargetDefinition type includes compose_mode?: 'replace' | 'merge'
 * 2. TargetDefinition type includes priming_prompt_append?: string
 * 3. parseTargetsToml accepts compose_mode in target definitions
 * 4. parseTargetsToml accepts priming_prompt_append in target definitions
 * 5. parseTargetsToml rejects both priming_prompt + priming_prompt_append on same target
 * 6. JSON schema (targets.schema.json) updated to allow compose_mode and priming_prompt_append
 * 7. serializeTargetsToml round-trips compose_mode and priming_prompt_append
 *
 * wrkq task: T-00992
 */

import { describe, expect, test } from 'bun:test'
import { ConfigValidationError } from '../errors.js'
import { parseTargetsToml, serializeTargetsToml } from './targets-toml.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. compose_mode parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseTargetsToml: compose_mode', () => {
  test('parses compose_mode = "replace"', () => {
    const toml = `
schema = 1

[targets.larry]
compose_mode = "replace"
compose = ["space:defaults@dev"]
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.compose_mode).toBe('replace')
  })

  test('parses compose_mode = "merge"', () => {
    const toml = `
schema = 1

[targets.larry]
compose_mode = "merge"
compose = ["space:praesidium-defaults@dev"]
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.compose_mode).toBe('merge')
  })

  test('compose_mode defaults to undefined when not specified', () => {
    const toml = `
schema = 1

[targets.larry]
compose = ["space:defaults@dev"]
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.compose_mode).toBeUndefined()
  })

  test('rejects invalid compose_mode value', () => {
    const toml = `
schema = 1

[targets.larry]
compose_mode = "append"
compose = ["space:defaults@dev"]
`
    expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. priming_prompt_append parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseTargetsToml: priming_prompt_append', () => {
  test('parses priming_prompt_append as string', () => {
    const toml = `
schema = 1

[targets.larry]
compose = ["space:defaults@dev"]
priming_prompt_append = "\\n## Project: agent-spaces\\nUses Bun workspace."
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.priming_prompt_append).toContain('## Project: agent-spaces')
  })

  test('parses multiline priming_prompt_append', () => {
    const toml = `
schema = 1

[targets.larry]
compose = ["space:defaults@dev"]
priming_prompt_append = """

## Project: agent-spaces
- Uses Bun workspace, TypeScript.
- Run just verify before committing.
"""
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.priming_prompt_append).toContain('## Project: agent-spaces')
    expect(result.targets.larry.priming_prompt_append).toContain('Run just verify')
  })

  test('rejects both priming_prompt and priming_prompt_append on same target', () => {
    const toml = `
schema = 1

[targets.larry]
compose = ["space:defaults@dev"]
priming_prompt = "You are Larry."
priming_prompt_append = "\\n## Extra context"
`
    expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
  })

  test('allows priming_prompt alone (no conflict)', () => {
    const toml = `
schema = 1

[targets.larry]
compose = ["space:defaults@dev"]
priming_prompt = "You are Larry."
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.priming_prompt).toBe('You are Larry.')
    expect(result.targets.larry.priming_prompt_append).toBeUndefined()
  })

  test('allows priming_prompt_append alone (no conflict)', () => {
    const toml = `
schema = 1

[targets.larry]
compose = ["space:defaults@dev"]
priming_prompt_append = "Extra context only."
`
    const result = parseTargetsToml(toml)
    expect(result.targets.larry.priming_prompt_append).toBe('Extra context only.')
    expect(result.targets.larry.priming_prompt).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Round-trip serialization
// ─────────────────────────────────────────────────────────────────────────────

describe('round-trip: compose_mode and priming_prompt_append', () => {
  test('compose_mode survives serialize/parse cycle', () => {
    const original = {
      schema: 1 as const,
      targets: {
        larry: {
          compose: ['space:defaults@dev' as const],
          compose_mode: 'merge' as const,
        },
      },
    }
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(parsed.targets.larry.compose_mode).toBe('merge')
  })

  test('priming_prompt_append survives serialize/parse cycle', () => {
    const original = {
      schema: 1 as const,
      targets: {
        larry: {
          compose: ['space:defaults@dev' as const],
          priming_prompt_append: 'Extra project context.',
        },
      },
    }
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(parsed.targets.larry.priming_prompt_append).toBe('Extra project context.')
  })
})
