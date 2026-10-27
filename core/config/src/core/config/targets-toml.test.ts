import type { ProjectManifest } from '../types/targets.js'
import { serializeTargetsToml } from './targets-toml.js'
/**
 * Tests for project manifest (asp-targets.toml) parser
 *
 * WHY: Project manifest parsing is essential for reading target definitions
 * from the user's project. These tests verify TOML parsing, schema validation,
 * and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { must } from '../../test-support/must.js'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import { parseTargetsToml, readTargetsToml } from './targets-toml.js'

function validationErrorOf(toml: string): ConfigValidationError {
  try {
    parseTargetsToml(toml)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError)
    return error as ConfigValidationError
  }
  throw new Error('expected parseTargetsToml to reject')
}

describe('parseTargetsToml', () => {
  describe('valid input', () => {
    test('a full asp-targets.toml parses to exactly the manifest it encodes', () => {
      const toml = `
schema = 2

[claude]
model = "claude-3-opus"
permission_mode = "auto"
args = ["--verbose"]

[codex]
model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_reasoning_effort = "high"
model_reasoning_summary = "concise"
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]

[targets.dev]
description = "My development target"
priming = "Register with agentchat and send READY"
compose_mode = "replace"
compose = ["space:core@stable", "space:frontend@^1.0.0", "space:backend@latest"]

[targets.dev.provisioning.claude]
model = "claude-3-sonnet"

[targets.dev.provisioning.codex]
model = "gpt-5.1-codex-mini"
approval_policy = "never"
sandbox_mode = "danger-full-access"
model_reasoning_effort = "low"
model_reasoning_summary = "detailed"
status_line = ["model", "context-remaining", "git-branch"]

[targets.dev.resolver]
locked = true
allow_dirty = false

[targets.larry]
compose_mode = "merge"
compose = ["space:praesidium-defaults@dev"]
priming_append = "Extra context only."
`

      expect(parseTargetsToml(toml)).toEqual({
        schema: 2,
        claude: { model: 'claude-3-opus', permission_mode: 'auto', args: ['--verbose'] },
        codex: {
          model: 'gpt-5.3-codex',
          approval_policy: 'on-request',
          sandbox_mode: 'workspace-write',
          model_reasoning_effort: 'high',
          model_reasoning_summary: 'concise',
          status_line: ['model-with-reasoning', 'context-remaining', 'current-dir'],
        },
        targets: {
          dev: {
            description: 'My development target',
            priming: 'Register with agentchat and send READY',
            compose_mode: 'replace',
            compose: ['space:core@stable', 'space:frontend@^1.0.0', 'space:backend@latest'],
            provisioning: {
              claude: { model: 'claude-3-sonnet' },
              codex: {
                model: 'gpt-5.1-codex-mini',
                approval_policy: 'never',
                sandbox_mode: 'danger-full-access',
                model_reasoning_effort: 'low',
                model_reasoning_summary: 'detailed',
                status_line: ['model', 'context-remaining', 'git-branch'],
              },
            },
            resolver: { locked: true, allow_dirty: false },
          },
          larry: {
            compose_mode: 'merge',
            compose: ['space:praesidium-defaults@dev'],
            priming_append: 'Extra context only.',
          },
        },
      })
    })
  })

  describe('TOML parse errors', () => {
    test('malformed asp-targets.toml raises ConfigParseError naming the file and the TOML error', () => {
      expect(() => parseTargetsToml('[invalid', '/custom/asp-targets.toml')).toThrow(
        expect.objectContaining({
          name: 'ConfigParseError',
          source: '/custom/asp-targets.toml',
          message: expect.stringContaining('Failed to parse TOML'),
        })
      )
    })
  })

  describe('schema validation errors', () => {
    test.each([
      ['marker-only file', 'schema = 2', {}],
      ['empty [targets] table', 'schema = 2\n\n[targets]\n', {}],
      [
        'target without compose (agent-profile provides defaults)',
        'schema = 2\n\n[targets.default]\ndescription = "No compose"\n',
        { default: { description: 'No compose' } },
      ],
      [
        'target with empty compose array',
        'schema = 2\n\n[targets.default]\ncompose = []\n',
        { default: { compose: [] } },
      ],
    ])('a schema 2 file with no compose entries is valid: %s', (_label, toml, targets) => {
      expect(parseTargetsToml(toml).targets).toEqual(targets)
    })

    test.each([
      ['missing schema', 'version = "1.0.0"', '/', 'required', "required property 'schema'"],
      ['schema 1 marker', 'schema = 1', '/schema', 'const', '/schema'],
      [
        'schema 1 with targets',
        'schema = 1\n[targets.default]\ncompose = []\n',
        '/schema',
        'const',
        '/schema',
      ],
      [
        'compose entry that is not a space ref',
        'schema = 2\n[targets.default]\ncompose = ["invalid-ref"]\n',
        '/targets/default/compose/0',
        'pattern',
        '"invalid-ref" is not a valid space reference',
      ],
      [
        '301-char description',
        `schema = 2\n[targets.default]\ndescription = "${'a'.repeat(301)}"\n`,
        '/targets/default/description',
        'maxLength',
        '300 characters',
      ],
      [
        'compose_mode append',
        'schema = 2\n[targets.larry]\ncompose_mode = "append"\n',
        '/targets/larry/compose_mode',
        'enum',
        '"append"',
      ],
      [
        'model_reasoning_summary verbose',
        'schema = 2\n[codex]\nmodel_reasoning_summary = "verbose"\n',
        '/codex/model_reasoning_summary',
        'enum',
        '"verbose"',
      ],
      [
        '[codex] profile selector',
        'schema = 2\n[codex]\nprofile = "meta"\n[targets]\n',
        '/codex',
        'additionalProperties',
        'unknown property "profile"',
      ],
      [
        'target provisioning.codex profile selector',
        'schema = 2\n[targets.default]\ncompose = []\n[targets.default.provisioning.codex]\nprofile = "meta"\n',
        '/targets/default/provisioning/codex',
        'additionalProperties',
        'unknown property "profile"',
      ],
      [
        'removed provisioning viewer key',
        'schema = 2\n[targets.default]\ncompose = []\n[targets.default.provisioning]\nviewer = "none"\n',
        '/targets/default/provisioning',
        'additionalProperties',
        'unknown property "viewer"',
      ],
      [
        'removed provisioning reasoning key',
        'schema = 2\n[targets.default]\ncompose = []\n[targets.default.provisioning]\nreasoning = "high"\n',
        '/targets/default/provisioning',
        'additionalProperties',
        'unknown property "reasoning"',
      ],
      [
        'unknown target field',
        'schema = 2\n\n[targets.manager]\ncompose = ["space:my-space@stable"]\nunknownField = "bad"\n',
        '/targets/manager',
        'additionalProperties',
        'unknown property "unknownField"',
      ],
    ])(
      'asp-targets.toml violating the schema is rejected at the offending path: %s',
      (_label, toml, path, keyword, messageFragment) => {
        const error = validationErrorOf(toml)
        expect(error.validationErrors[0]).toMatchObject({ path, keyword })
        expect(error.message).toContain(messageFragment)
      }
    )
  })
})

describe('readTargetsToml', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'targets-toml-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('reads and parses valid asp-targets.toml', async () => {
    const filePath = join(testDir, 'asp-targets.toml')
    const toml = `
schema = 2

[targets.default]
compose = ["space:my-space@stable"]
`
    await Bun.write(filePath, toml)

    const result = await readTargetsToml(filePath)
    expect(result.schema).toBe(2)
    expect(result.targets['default']).toBeDefined()
  })

  test('a missing asp-targets.toml rejects with ConfigFileNotFoundError naming the path', async () => {
    const filePath = join(testDir, 'nonexistent.toml')
    const read = readTargetsToml(filePath)
    await expect(read).rejects.toBeInstanceOf(ConfigParseError)
    await expect(read).rejects.toMatchObject({
      name: 'ConfigFileNotFoundError',
      source: filePath,
      message: 'File not found',
    })
  })

  test('throws ConfigValidationError for invalid content', async () => {
    const filePath = join(testDir, 'asp-targets.toml')
    await Bun.write(filePath, 'invalid_field = true')

    await expect(readTargetsToml(filePath)).rejects.toThrow(ConfigValidationError)
  })
})

describe('parseTargetsToml: v4 selection vocabulary (T-08701)', () => {
  test.each([
    [
      'explicit presentation false',
      'presentation = false\n',
      {
        harness: 'codex',
        model_provider: 'openai-codex',
        model: 'gpt-5.5',
        reasoning_effort: 'high',
        presentation: false,
        yolo: true,
      },
      true,
    ],
    [
      'omitted presentation',
      '',
      {
        harness: 'codex',
        model_provider: 'openai-codex',
        model: 'gpt-5.5',
        reasoning_effort: 'high',
        yolo: true,
      },
      false,
    ],
  ])(
    'target provisioning parses the selection scalars and keeps presentation only when authored: %s',
    (_label, presentationLine, expected, present) => {
      const manifest = parseTargetsToml(`
schema = 2

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.provisioning]
harness = "codex"
model_provider = "openai-codex"
model = "gpt-5.5"
reasoning_effort = "high"
yolo = true
${presentationLine}`)
      const provisioning = must(manifest.targets['default']).provisioning
      expect(provisioning).toEqual(expected)
      expect(Object.hasOwn(provisioning ?? {}, 'presentation')).toBe(present)
    }
  )

  test('rejects harness aliases and removed harness ids', () => {
    for (const harness of ['claude-code', 'agent-sdk', 'pi', 'pi-sdk']) {
      expect(() =>
        parseTargetsToml(
          `schema = 2\n[targets.default]\ncompose = []\n[targets.default.provisioning]\nharness = "${harness}"\n`
        )
      ).toThrow(ConfigValidationError)
    }
  })

  test('rejects provider-prefixed model strings', () => {
    expect(() =>
      parseTargetsToml(
        `schema = 2\n[targets.default]\ncompose = []\n[targets.default.provisioning]\nmodel = "openai-codex/gpt-5.5"\n`
      )
    ).toThrow(ConfigValidationError)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for project manifest (asp-targets.toml) parser
   *
   * WHY: Project manifest parsing is essential for reading target definitions
   * from the user's project. These tests verify TOML parsing, schema validation,
   * serialization, and error handling.
   */

  /** Create a minimal valid project manifest */
  function createValidManifest(): ProjectManifest {
    return {
      schema: 2,
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
      schema: 2,
      claude: {
        model: 'claude-3-opus',
        permission_mode: 'auto',
        args: ['--verbose'],
      },
      targets: {
        default: {
          description: 'Default development target',
          priming: 'Initialize tools and announce ready status.',
          compose: ['space:core@stable', 'space:frontend@^1.0.0'],
          provisioning: {
            claude: {
              model: 'claude-3-sonnet',
            },
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

  describe('serializeTargetsToml', () => {
    test('serializes minimal manifest to TOML', () => {
      const manifest = createValidManifest()
      const result = serializeTargetsToml(manifest)

      expect(result).toContain('schema = 2')
      expect(result).toContain('[targets.default]')
      expect(result).toContain('space:my-space@stable')
    })

    test('serializes full manifest to TOML', () => {
      const manifest = createFullManifest()
      const result = serializeTargetsToml(manifest)

      expect(result).toContain('schema = 2')
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
      expect(must(parsed.targets['default']).compose).toEqual(
        must(original.targets['default']).compose
      )
    })

    test('round-trip with full manifest', () => {
      const original = createFullManifest()
      const serialized = serializeTargetsToml(original)
      const parsed = parseTargetsToml(serialized)

      expect(parsed.schema).toBe(original.schema)
      expect(parsed.claude?.model).toBe(original.claude?.model)
      expect(must(parsed.targets['default']).compose).toEqual(
        must(original.targets['default']).compose
      )
      expect(must(parsed.targets['default']).resolver?.locked).toBe(
        must(original.targets['default']).resolver?.locked
      )
      expect(must(parsed.targets['default']).priming).toBe(
        must(original.targets['default']).priming
      )
    })
  })

  describe('published lock and serialization behavior', () => {
    test('omitted presentation stays absent through parse and round-trip', () => {
      const manifest = parseTargetsToml(`
schema = 2

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.provisioning]
harness = "codex"
`)
      expect(
        Object.hasOwn(must(manifest.targets['default']).provisioning ?? {}, 'presentation')
      ).toBe(false)
      const roundTripped = parseTargetsToml(serializeTargetsToml(manifest))
      expect(
        Object.hasOwn(must(roundTripped.targets['default']).provisioning ?? {}, 'presentation')
      ).toBe(false)
    })
  })
})
