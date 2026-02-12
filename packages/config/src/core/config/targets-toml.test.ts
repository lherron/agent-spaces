/**
 * Tests for project manifest (asp-targets.toml) parser
 *
 * WHY: Project manifest parsing is essential for reading target definitions
 * from the user's project. These tests verify TOML parsing, schema validation,
 * serialization, and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import type { ProjectManifest } from '../types/targets.js'
import {
  TARGETS_FILENAME,
  parseTargetsToml,
  readTargetsToml,
  serializeTargetsToml,
} from './targets-toml.js'

/** Create a minimal valid project manifest */
function createValidManifest(): ProjectManifest {
  return {
    schema: 1,
    targets: {
      default: {
        compose: ['space:my-space@stable'],
      },
    },
  }
}

/** Create a full-featured project manifest */
function createFullManifest(): ProjectManifest {
  return {
    schema: 1,
    claude: {
      model: 'claude-3-opus',
      permission_mode: 'auto',
      args: ['--verbose'],
    },
    targets: {
      default: {
        description: 'Default development target',
        priming_prompt: 'Initialize tools and announce ready status.',
        compose: ['space:core@stable', 'space:frontend@^1.0.0'],
        claude: {
          model: 'claude-3-sonnet',
        },
        resolver: {
          locked: true,
          allow_dirty: false,
        },
      },
      production: {
        description: 'Production target',
        compose: ['space:core@stable'],
      },
    },
  }
}

/** Convert a ProjectManifest to TOML string for testing */
function toToml(manifest: ProjectManifest): string {
  const lines: string[] = []
  lines.push(`schema = ${manifest.schema}`)

  if (manifest.claude) {
    lines.push('')
    lines.push('[claude]')
    if (manifest.claude.model) lines.push(`model = "${manifest.claude.model}"`)
    if (manifest.claude.permission_mode) {
      lines.push(`permission_mode = "${manifest.claude.permission_mode}"`)
    }
    if (manifest.claude.args) {
      lines.push(`args = [${manifest.claude.args.map((a) => `"${a}"`).join(', ')}]`)
    }
  }

  for (const [name, target] of Object.entries(manifest.targets)) {
    lines.push('')
    lines.push(`[targets.${name}]`)
    if (target.description) lines.push(`description = "${target.description}"`)
    if (target.priming_prompt) lines.push(`priming_prompt = "${target.priming_prompt}"`)
    lines.push(`compose = [${target.compose.map((c) => `"${c}"`).join(', ')}]`)

    if (target.claude) {
      lines.push('')
      lines.push(`[targets.${name}.claude]`)
      if (target.claude.model) lines.push(`model = "${target.claude.model}"`)
      if (target.claude.permission_mode) {
        lines.push(`permission_mode = "${target.claude.permission_mode}"`)
      }
      if (target.claude.args) {
        lines.push(`args = [${target.claude.args.map((a) => `"${a}"`).join(', ')}]`)
      }
    }

    if (target.resolver) {
      lines.push('')
      lines.push(`[targets.${name}.resolver]`)
      if (target.resolver.locked !== undefined) {
        lines.push(`locked = ${target.resolver.locked}`)
      }
      if (target.resolver.allow_dirty !== undefined) {
        lines.push(`allow_dirty = ${target.resolver.allow_dirty}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

describe('TARGETS_FILENAME constant', () => {
  test('has correct value', () => {
    expect(TARGETS_FILENAME).toBe('asp-targets.toml')
  })
})

describe('parseTargetsToml', () => {
  describe('valid input', () => {
    test('parses minimal valid manifest', () => {
      const toml = `
schema = 1

[targets.default]
compose = ["space:my-space@stable"]
`
      const result = parseTargetsToml(toml)

      expect(result.schema).toBe(1)
      expect(result.targets.default).toBeDefined()
      expect(result.targets.default.compose).toEqual(['space:my-space@stable'])
    })

    test('parses manifest with multiple targets', () => {
      const toml = `
schema = 1

[targets.dev]
compose = ["space:dev@latest"]

[targets.prod]
compose = ["space:prod@stable"]
`
      const result = parseTargetsToml(toml)

      expect(Object.keys(result.targets)).toHaveLength(2)
      expect(result.targets.dev.compose).toEqual(['space:dev@latest'])
      expect(result.targets.prod.compose).toEqual(['space:prod@stable'])
    })

    test('parses manifest with global claude options', () => {
      const toml = `
schema = 1

[claude]
model = "claude-3-opus"
permission_mode = "auto"
args = ["--verbose"]

[targets.default]
compose = ["space:my-space@stable"]
`
      const result = parseTargetsToml(toml)

      expect(result.claude?.model).toBe('claude-3-opus')
      expect(result.claude?.permission_mode).toBe('auto')
      expect(result.claude?.args).toEqual(['--verbose'])
    })

    test('parses manifest with codex options', () => {
      const toml = `
schema = 1

[codex]
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
profile = "default"

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.codex]
model = "gpt-5.1-codex-mini"
approval_policy = "never"
sandbox_mode = "danger-full-access"
profile = "dev"
`
      const result = parseTargetsToml(toml)

      expect(result.codex?.model).toBe('gpt-5.2-codex')
      expect(result.codex?.approval_policy).toBe('on-request')
      expect(result.codex?.sandbox_mode).toBe('workspace-write')
      expect(result.codex?.profile).toBe('default')
      expect(result.targets.default.codex?.model).toBe('gpt-5.1-codex-mini')
      expect(result.targets.default.codex?.approval_policy).toBe('never')
      expect(result.targets.default.codex?.sandbox_mode).toBe('danger-full-access')
      expect(result.targets.default.codex?.profile).toBe('dev')
    })

    test('parses manifest with target-specific claude options', () => {
      const toml = `
schema = 1

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.claude]
model = "claude-3-sonnet"
`
      const result = parseTargetsToml(toml)

      expect(result.targets.default.claude?.model).toBe('claude-3-sonnet')
    })

    test('parses manifest with resolver options', () => {
      const toml = `
schema = 1

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.resolver]
locked = true
allow_dirty = false
`
      const result = parseTargetsToml(toml)

      expect(result.targets.default.resolver?.locked).toBe(true)
      expect(result.targets.default.resolver?.allow_dirty).toBe(false)
    })

    test('parses manifest with description', () => {
      const toml = `
schema = 1

[targets.default]
description = "My development target"
compose = ["space:my-space@stable"]
`
      const result = parseTargetsToml(toml)

      expect(result.targets.default.description).toBe('My development target')
    })

    test('parses manifest with priming_prompt', () => {
      const toml = `
schema = 1

[targets.default]
priming_prompt = "Register with agentchat and send READY"
compose = ["space:my-space@stable"]
`
      const result = parseTargetsToml(toml)

      expect(result.targets.default.priming_prompt).toBe('Register with agentchat and send READY')
    })

    test('parses manifest with multiple compose entries', () => {
      const toml = `
schema = 1

[targets.default]
compose = ["space:core@stable", "space:frontend@^1.0.0", "space:backend@latest"]
`
      const result = parseTargetsToml(toml)

      expect(result.targets.default.compose).toHaveLength(3)
      expect(result.targets.default.compose).toContain('space:core@stable')
      expect(result.targets.default.compose).toContain('space:frontend@^1.0.0')
    })

    test('uses provided filePath in error messages', () => {
      const toml = 'invalid toml ['
      try {
        parseTargetsToml(toml, '/custom/asp-targets.toml')
      } catch (e) {
        expect((e as ConfigParseError).source).toBe('/custom/asp-targets.toml')
      }
    })

    test('uses default filename when filePath not provided', () => {
      const toml = 'invalid toml ['
      try {
        parseTargetsToml(toml)
      } catch (e) {
        expect((e as ConfigParseError).source).toBe('asp-targets.toml')
      }
    })
  })

  describe('TOML parse errors', () => {
    test('throws ConfigParseError for invalid TOML syntax', () => {
      expect(() => parseTargetsToml('[invalid')).toThrow(ConfigParseError)
    })

    test('throws ConfigParseError for unclosed string', () => {
      expect(() => parseTargetsToml('key = "unclosed')).toThrow(ConfigParseError)
    })

    test('throws ConfigParseError for duplicate keys', () => {
      const toml = `
schema = 1
schema = 2
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigParseError)
    })

    test('includes original error message in ConfigParseError', () => {
      try {
        parseTargetsToml('[invalid')
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigParseError)
        expect((e as ConfigParseError).message).toContain('Failed to parse TOML')
      }
    })
  })

  describe('schema validation errors', () => {
    test('throws ConfigValidationError for missing required fields', () => {
      const toml = 'version = "1.0.0"'
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for wrong schema version', () => {
      const toml = `
schema = 2

[targets.default]
compose = ["space:my-space@stable"]
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for missing targets', () => {
      const toml = 'schema = 1'
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for empty targets', () => {
      const toml = `
schema = 1

[targets]
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for missing compose in target', () => {
      const toml = `
schema = 1

[targets.default]
description = "Missing compose"
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for empty compose array', () => {
      const toml = `
schema = 1

[targets.default]
compose = []
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for invalid space ref format', () => {
      const toml = `
schema = 1

[targets.default]
compose = ["invalid-ref"]
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for description too long', () => {
      const toml = `
schema = 1

[targets.default]
description = "${'a'.repeat(301)}"
compose = ["space:my-space@stable"]
`
      expect(() => parseTargetsToml(toml)).toThrow(ConfigValidationError)
    })

    test('includes validation errors in ConfigValidationError', () => {
      const toml = 'schema = 2'
      try {
        parseTargetsToml(toml)
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError)
        expect((e as ConfigValidationError).validationErrors.length).toBeGreaterThan(0)
      }
    })

    test('shows property name in additionalProperties error message', () => {
      const toml = `
schema = 1

[targets.manager]
compose = ["space:my-space@stable"]
unknownField = "bad"
`
      try {
        parseTargetsToml(toml)
        expect.unreachable('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError)
        const err = e as ConfigValidationError
        expect(err.message).toContain('unknown property "unknownField"')
      }
    })
  })
})

describe('readTargetsToml', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `targets-toml-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('reads and parses valid asp-targets.toml', async () => {
    const filePath = join(testDir, 'asp-targets.toml')
    const toml = `
schema = 1

[targets.default]
compose = ["space:my-space@stable"]
`
    await Bun.write(filePath, toml)

    const result = await readTargetsToml(filePath)
    expect(result.schema).toBe(1)
    expect(result.targets.default).toBeDefined()
  })

  test('reads and parses full-featured manifest', async () => {
    const manifest = createFullManifest()
    const filePath = join(testDir, 'asp-targets.toml')
    await Bun.write(filePath, toToml(manifest))

    const result = await readTargetsToml(filePath)
    expect(result.schema).toBe(1)
    expect(result.claude?.model).toBe('claude-3-opus')
    expect(result.targets.default.resolver?.locked).toBe(true)
  })

  test('throws ConfigParseError for non-existent file', async () => {
    const filePath = join(testDir, 'nonexistent.toml')
    await expect(readTargetsToml(filePath)).rejects.toThrow(ConfigParseError)
  })

  test('includes file path in error for non-existent file', async () => {
    const filePath = join(testDir, 'nonexistent.toml')
    try {
      await readTargetsToml(filePath)
    } catch (e) {
      expect((e as ConfigParseError).source).toBe(filePath)
      expect((e as ConfigParseError).message).toContain('File not found')
    }
  })

  test('throws ConfigValidationError for invalid content', async () => {
    const filePath = join(testDir, 'asp-targets.toml')
    await Bun.write(filePath, 'invalid_field = true')

    await expect(readTargetsToml(filePath)).rejects.toThrow(ConfigValidationError)
  })
})

describe('serializeTargetsToml', () => {
  test('serializes minimal manifest to TOML', () => {
    const manifest = createValidManifest()
    const result = serializeTargetsToml(manifest)

    expect(result).toContain('schema = 1')
    expect(result).toContain('[targets.default]')
    expect(result).toContain('space:my-space@stable')
  })

  test('serializes full manifest to TOML', () => {
    const manifest = createFullManifest()
    const result = serializeTargetsToml(manifest)

    expect(result).toContain('schema = 1')
    expect(result).toContain('[claude]')
    expect(result).toContain('model = "claude-3-opus"')
    expect(result).toContain('[targets.default]')
    expect(result).toContain('[targets.production]')
  })

  test('serializes multiple targets', () => {
    const manifest = createFullManifest()
    const result = serializeTargetsToml(manifest)

    expect(result).toContain('default')
    expect(result).toContain('production')
  })

  test('round-trip: serialize then parse produces equivalent object', () => {
    const original = createValidManifest()
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)

    expect(parsed.schema).toBe(original.schema)
    expect(parsed.targets.default.compose).toEqual(original.targets.default.compose)
  })

  test('round-trip with full manifest', () => {
    const original = createFullManifest()
    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)

    expect(parsed.schema).toBe(original.schema)
    expect(parsed.claude?.model).toBe(original.claude?.model)
    expect(parsed.targets.default.compose).toEqual(original.targets.default.compose)
    expect(parsed.targets.default.resolver?.locked).toBe(original.targets.default.resolver?.locked)
    expect(parsed.targets.default.priming_prompt).toBe(original.targets.default.priming_prompt)
  })
})
