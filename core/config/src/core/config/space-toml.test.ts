import { asSpaceId } from '../types/refs.js'
import type { SpaceManifest } from '../types/space.js'
import { serializeSpaceToml } from './space-toml.js'
/**
 * Tests for space manifest (space.toml) parser
 *
 * WHY: Space manifest parsing is essential for reading space definitions
 * from the registry. These tests verify TOML parsing, schema validation,
 * and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import { parseSpaceToml, readSpaceToml } from './space-toml.js'

function firstValidationIssue(toml: string) {
  try {
    parseSpaceToml(toml)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError)
    return (error as ConfigValidationError).validationErrors[0]
  }
  throw new Error('expected parseSpaceToml to reject')
}

describe('parseSpaceToml', () => {
  test('a full space.toml (kebab-case id with digits) parses to exactly the manifest it encodes', () => {
    const toml = `
schema = 1
id = "my-space-123"
version = "1.0.0"
description = "A test space"

[plugin]
name = "my-plugin"
version = "1.0.0"
description = "A test plugin"
homepage = "https://example.com/my-plugin"
repository = "https://github.com/example/my-plugin"
license = "MIT"
keywords = ["test", "example"]

[plugin.author]
name = "Test Author"
email = "test@example.com"
url = "https://example.com"

[deps]
spaces = ["space:dep-a@stable", "space:dep-b@^1.0.0"]

[settings]
cleanupPeriodDays = 36500

[harness]
supports = ["codex"]

[codex]
model = "gpt-5.3-codex"

[codex.prompts]
enabled = false

[codex.skills]
enabled = true

[codex.config]
"features.web_search_request" = false
`

    expect(parseSpaceToml(toml)).toEqual({
      schema: 1,
      id: 'my-space-123',
      version: '1.0.0',
      description: 'A test space',
      plugin: {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        homepage: 'https://example.com/my-plugin',
        repository: 'https://github.com/example/my-plugin',
        license: 'MIT',
        keywords: ['test', 'example'],
        author: { name: 'Test Author', email: 'test@example.com', url: 'https://example.com' },
      },
      deps: { spaces: ['space:dep-a@stable', 'space:dep-b@^1.0.0'] },
      settings: { cleanupPeriodDays: 36500 },
      harness: { supports: ['codex'] },
      codex: {
        model: 'gpt-5.3-codex',
        prompts: { enabled: false },
        skills: { enabled: true },
        config: { 'features.web_search_request': false },
      },
    } as never)
  })

  test('malformed space.toml raises ConfigParseError naming the file and the TOML error', () => {
    expect(() => parseSpaceToml('[invalid', '/custom/space.toml')).toThrow(
      expect.objectContaining({
        name: 'ConfigParseError',
        source: '/custom/space.toml',
        message: expect.stringContaining('Failed to parse TOML'),
      })
    )
  })

  test.each([
    ['missing schema and id', 'version = "1.0.0"\n', '/', 'required'],
    ['schema 2', 'schema = 2\nid = "my-space"\n', '/schema', 'const'],
    ['uppercase id', 'schema = 1\nid = "MySpace"\n', '/id', 'pattern'],
    ['underscore id', 'schema = 1\nid = "my_space"\n', '/id', 'pattern'],
    ['65-char id', `schema = 1\nid = "${'a'.repeat(65)}"\n`, '/id', 'maxLength'],
    [
      'non-semver version',
      'schema = 1\nid = "my-space"\nversion = "not-semver"\n',
      '/version',
      'pattern',
    ],
    [
      'plugin name with underscore',
      'schema = 1\nid = "my-space"\n[plugin]\nname = "Invalid_Name"\n',
      '/plugin/name',
      'pattern',
    ],
    [
      '501-char description',
      `schema = 1\nid = "my-space"\ndescription = "${'a'.repeat(501)}"\n`,
      '/description',
      'maxLength',
    ],
    [
      'dep that is not a space ref',
      'schema = 1\nid = "my-space"\n[deps]\nspaces = ["invalid-ref"]\n',
      '/deps/spaces/0',
      'pattern',
    ],
    ...['agent-sdk', 'claude-agent-sdk', 'pi', 'pi-sdk'].map(
      (harness) =>
        [
          `retired harness ${harness}`,
          `schema = 1\nid = "my-space"\n[harness]\nsupports = ["${harness}"]\n`,
          '/harness/supports/0',
          'enum',
        ] as const
    ),
  ])(
    'space.toml violating the manifest schema is rejected at the offending path: %s',
    (_label, toml, path, keyword) => {
      expect(firstValidationIssue(toml)).toMatchObject({ path, keyword })
    }
  )
})

describe('readSpaceToml', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'space-toml-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('reads and parses valid space.toml', async () => {
    const filePath = join(testDir, 'space.toml')
    await Bun.write(filePath, 'schema = 1\nid = "my-space"\n')

    const result = await readSpaceToml(filePath)
    expect(result.schema).toBe(1)
    expect<string>(result.id).toBe('my-space')
  })

  test('a missing space.toml rejects with ConfigFileNotFoundError naming the path', async () => {
    const filePath = join(testDir, 'nonexistent.toml')
    const read = readSpaceToml(filePath)
    await expect(read).rejects.toBeInstanceOf(ConfigParseError)
    await expect(read).rejects.toMatchObject({
      name: 'ConfigFileNotFoundError',
      source: filePath,
      message: 'File not found',
    })
  })

  test('throws ConfigValidationError for invalid content', async () => {
    const filePath = join(testDir, 'space.toml')
    await Bun.write(filePath, 'invalid_field = true')

    await expect(readSpaceToml(filePath)).rejects.toThrow(ConfigValidationError)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for space manifest (space.toml) parser
   *
   * WHY: Space manifest parsing is essential for reading space definitions
   * from the registry. These tests verify TOML parsing, schema validation,
   * serialization, and error handling.
   */

  /** Create a minimal valid space manifest */
  function createValidManifest(): SpaceManifest {
    return {
      schema: 1,
      id: asSpaceId('my-space'),
    }
  }

  /** Create a full-featured space manifest */
  function createFullManifest(): SpaceManifest {
    return {
      schema: 1,
      id: asSpaceId('my-space'),
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
        id: asSpaceId('my-space'),
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
})
