/**
 * Tests for space manifest (space.toml) parser
 *
 * WHY: Space manifest parsing is essential for reading space definitions
 * from the registry. These tests verify TOML parsing, schema validation,
 * serialization, and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import type { SpaceManifest } from '../types/space.js'
import { parseSpaceToml, readSpaceToml, serializeSpaceToml } from './space-toml.js'

/** Create a minimal valid space manifest */
function createValidManifest(): SpaceManifest {
  return {
    schema: 1,
    id: 'my-space',
  }
}

/** Create a full-featured space manifest */
function createFullManifest(): SpaceManifest {
  return {
    schema: 1,
    id: 'my-space',
    version: '1.0.0',
    description: 'A test space',
    plugin: {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A test plugin',
      author: {
        name: 'Test Author',
        email: 'test@example.com',
        url: 'https://example.com',
      },
      homepage: 'https://example.com/my-plugin',
      repository: 'https://github.com/example/my-plugin',
      license: 'MIT',
      keywords: ['test', 'example'],
    },
    deps: {
      spaces: ['space:other-space@stable'],
    },
  }
}

/** Convert a SpaceManifest to TOML string for testing */
function toToml(manifest: SpaceManifest): string {
  const lines: string[] = []
  lines.push(`schema = ${manifest.schema}`)
  lines.push(`id = "${manifest.id}"`)

  if (manifest.version) {
    lines.push(`version = "${manifest.version}"`)
  }
  if (manifest.description) {
    lines.push(`description = "${manifest.description}"`)
  }

  if (manifest.plugin) {
    lines.push('')
    lines.push('[plugin]')
    if (manifest.plugin.name) lines.push(`name = "${manifest.plugin.name}"`)
    if (manifest.plugin.version) lines.push(`version = "${manifest.plugin.version}"`)
    if (manifest.plugin.description) lines.push(`description = "${manifest.plugin.description}"`)
    if (manifest.plugin.homepage) lines.push(`homepage = "${manifest.plugin.homepage}"`)
    if (manifest.plugin.repository) lines.push(`repository = "${manifest.plugin.repository}"`)
    if (manifest.plugin.license) lines.push(`license = "${manifest.plugin.license}"`)
    if (manifest.plugin.keywords) {
      lines.push(`keywords = [${manifest.plugin.keywords.map((k) => `"${k}"`).join(', ')}]`)
    }
    if (manifest.plugin.author) {
      lines.push('')
      lines.push('[plugin.author]')
      if (manifest.plugin.author.name) lines.push(`name = "${manifest.plugin.author.name}"`)
      if (manifest.plugin.author.email) lines.push(`email = "${manifest.plugin.author.email}"`)
      if (manifest.plugin.author.url) lines.push(`url = "${manifest.plugin.author.url}"`)
    }
  }

  if (manifest.deps?.spaces && manifest.deps.spaces.length > 0) {
    lines.push('')
    lines.push('[deps]')
    lines.push(`spaces = [${manifest.deps.spaces.map((s) => `"${s}"`).join(', ')}]`)
  }

  return lines.join('\n') + '\n'
}

describe('parseSpaceToml', () => {
  describe('valid input', () => {
    test('parses minimal valid manifest', () => {
      const toml = 'schema = 1\nid = "my-space"\n'
      const result = parseSpaceToml(toml)

      expect(result.schema).toBe(1)
      expect(result.id).toBe('my-space')
    })

    test('parses manifest with version and description', () => {
      const toml = `
schema = 1
id = "my-space"
version = "1.0.0"
description = "A test space"
`
      const result = parseSpaceToml(toml)

      expect(result.version).toBe('1.0.0')
      expect(result.description).toBe('A test space')
    })

    test('parses manifest with plugin config', () => {
      const manifest = createFullManifest()
      const toml = toToml(manifest)
      const result = parseSpaceToml(toml)

      expect(result.plugin?.name).toBe('my-plugin')
      expect(result.plugin?.version).toBe('1.0.0')
      expect(result.plugin?.license).toBe('MIT')
      expect(result.plugin?.keywords).toEqual(['test', 'example'])
    })

    test('parses manifest with author info', () => {
      const manifest = createFullManifest()
      const toml = toToml(manifest)
      const result = parseSpaceToml(toml)

      expect(result.plugin?.author?.name).toBe('Test Author')
      expect(result.plugin?.author?.email).toBe('test@example.com')
      expect(result.plugin?.author?.url).toBe('https://example.com')
    })

    test('parses manifest with dependencies', () => {
      const toml = `
schema = 1
id = "my-space"

[deps]
spaces = ["space:dep-a@stable", "space:dep-b@^1.0.0"]
`
      const result = parseSpaceToml(toml)

      expect(result.deps?.spaces).toHaveLength(2)
      expect(result.deps?.spaces).toContain('space:dep-a@stable')
      expect(result.deps?.spaces).toContain('space:dep-b@^1.0.0')
    })

    test('parses kebab-case id', () => {
      const toml = 'schema = 1\nid = "my-awesome-space"\n'
      const result = parseSpaceToml(toml)

      expect(result.id).toBe('my-awesome-space')
    })

    test('parses id with numbers', () => {
      const toml = 'schema = 1\nid = "space123"\n'
      const result = parseSpaceToml(toml)

      expect(result.id).toBe('space123')
    })

    test('uses provided filePath in error messages', () => {
      const toml = 'invalid toml ['
      try {
        parseSpaceToml(toml, '/custom/space.toml')
      } catch (e) {
        expect((e as ConfigParseError).source).toBe('/custom/space.toml')
      }
    })

    test('uses default filename when filePath not provided', () => {
      const toml = 'invalid toml ['
      try {
        parseSpaceToml(toml)
      } catch (e) {
        expect((e as ConfigParseError).source).toBe('space.toml')
      }
    })
  })

  describe('TOML parse errors', () => {
    test('throws ConfigParseError for invalid TOML syntax', () => {
      expect(() => parseSpaceToml('[invalid')).toThrow(ConfigParseError)
    })

    test('throws ConfigParseError for unclosed string', () => {
      expect(() => parseSpaceToml('id = "unclosed')).toThrow(ConfigParseError)
    })

    test('throws ConfigParseError for invalid table', () => {
      expect(() => parseSpaceToml('[not.valid.]')).toThrow(ConfigParseError)
    })

    test('includes original error message in ConfigParseError', () => {
      try {
        parseSpaceToml('[invalid')
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigParseError)
        expect((e as ConfigParseError).message).toContain('Failed to parse TOML')
      }
    })
  })

  describe('schema validation errors', () => {
    test('throws ConfigValidationError for missing required fields', () => {
      const toml = 'version = "1.0.0"'
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for wrong schema version', () => {
      const toml = 'schema = 2\nid = "my-space"\n'
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for invalid id format (uppercase)', () => {
      const toml = 'schema = 1\nid = "MySpace"\n'
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for invalid id format (special chars)', () => {
      const toml = 'schema = 1\nid = "my_space"\n'
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for id too long', () => {
      const toml = `schema = 1\nid = "${'a'.repeat(65)}"\n`
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for invalid version format', () => {
      const toml = 'schema = 1\nid = "my-space"\nversion = "not-semver"\n'
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for invalid plugin name format', () => {
      const toml = `
schema = 1
id = "my-space"

[plugin]
name = "Invalid_Name"
`
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for description too long', () => {
      const toml = `schema = 1\nid = "my-space"\ndescription = "${'a'.repeat(501)}"\n`
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('throws ConfigValidationError for invalid space ref format', () => {
      const toml = `
schema = 1
id = "my-space"

[deps]
spaces = ["invalid-ref"]
`
      expect(() => parseSpaceToml(toml)).toThrow(ConfigValidationError)
    })

    test('includes validation errors in ConfigValidationError', () => {
      const toml = 'schema = 2\nid = "Invalid"\n'
      try {
        parseSpaceToml(toml)
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError)
        expect((e as ConfigValidationError).validationErrors.length).toBeGreaterThan(0)
      }
    })
  })
})

describe('readSpaceToml', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `space-toml-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('reads and parses valid space.toml', async () => {
    const filePath = join(testDir, 'space.toml')
    await Bun.write(filePath, 'schema = 1\nid = "my-space"\n')

    const result = await readSpaceToml(filePath)
    expect(result.schema).toBe(1)
    expect(result.id).toBe('my-space')
  })

  test('reads and parses full-featured space.toml', async () => {
    const manifest = createFullManifest()
    const filePath = join(testDir, 'space.toml')
    await Bun.write(filePath, toToml(manifest))

    const result = await readSpaceToml(filePath)
    expect(result.id).toBe('my-space')
    expect(result.version).toBe('1.0.0')
    expect(result.plugin?.name).toBe('my-plugin')
  })

  test('throws ConfigParseError for non-existent file', async () => {
    const filePath = join(testDir, 'nonexistent.toml')
    await expect(readSpaceToml(filePath)).rejects.toThrow(ConfigParseError)
  })

  test('includes file path in error for non-existent file', async () => {
    const filePath = join(testDir, 'nonexistent.toml')
    try {
      await readSpaceToml(filePath)
    } catch (e) {
      expect((e as ConfigParseError).source).toBe(filePath)
      expect((e as ConfigParseError).message).toContain('File not found')
    }
  })

  test('throws ConfigValidationError for invalid content', async () => {
    const filePath = join(testDir, 'space.toml')
    await Bun.write(filePath, 'invalid_field = true')

    await expect(readSpaceToml(filePath)).rejects.toThrow(ConfigValidationError)
  })
})

describe('serializeSpaceToml', () => {
  test('serializes minimal manifest to TOML', () => {
    const manifest = createValidManifest()
    const result = serializeSpaceToml(manifest)

    expect(result).toContain('schema = 1')
    expect(result).toContain('id = "my-space"')
  })

  test('serializes full manifest to TOML', () => {
    const manifest = createFullManifest()
    const result = serializeSpaceToml(manifest)

    expect(result).toContain('schema = 1')
    expect(result).toContain('id = "my-space"')
    expect(result).toContain('version = "1.0.0"')
    expect(result).toContain('[plugin]')
    expect(result).toContain('name = "my-plugin"')
  })

  test('serializes dependencies correctly', () => {
    const manifest: SpaceManifest = {
      schema: 1,
      id: 'my-space',
      deps: {
        spaces: ['space:dep-a@stable', 'space:dep-b@latest'],
      },
    }
    const result = serializeSpaceToml(manifest)

    expect(result).toContain('[deps]')
    expect(result).toContain('space:dep-a@stable')
    expect(result).toContain('space:dep-b@latest')
  })

  test('round-trip: serialize then parse produces equivalent object', () => {
    const original = createValidManifest()
    const serialized = serializeSpaceToml(original)
    const parsed = parseSpaceToml(serialized)

    expect(parsed.schema).toBe(original.schema)
    expect(parsed.id).toBe(original.id)
  })

  test('round-trip with full manifest', () => {
    const original = createFullManifest()
    const serialized = serializeSpaceToml(original)
    const parsed = parseSpaceToml(serialized)

    expect(parsed.schema).toBe(original.schema)
    expect(parsed.id).toBe(original.id)
    expect(parsed.version).toBe(original.version)
    expect(parsed.plugin?.name).toBe(original.plugin?.name)
    expect(parsed.deps?.spaces).toEqual(original.deps?.spaces)
  })
})
