import { serializeLockJson } from './lock-json.js'
/**
 * Tests for lock file (asp-lock.json) parser
 *
 * WHY: Lock file parsing is critical for reproducibility. These tests
 * verify parsing, validation, and error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { must } from '../../test-support/must.js'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import type { LockFile } from '../types/lock.js'
import { asCommitSha, asSpaceId } from '../types/refs.js'
import { lockFileExists, parseLockJson, readLockJson } from './lock-json.js'

/** Create a minimal valid lock file object */
function createValidLock(): LockFile {
  return {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: '2024-01-15T12:00:00.000Z',
    registry: {
      type: 'git',
      url: 'https://github.com/example/registry.git',
    },
    spaces: {},
    targets: {},
  }
}

/** Create a lock file with a space entry */
function createLockWithSpace(): LockFile {
  return {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: '2024-01-15T12:00:00.000Z',
    registry: {
      type: 'git',
      url: 'https://github.com/example/registry.git',
      defaultBranch: 'main',
    },
    spaces: {
      'my-space@abc1234': {
        id: asSpaceId('my-space'),
        commit: asCommitSha('abc1234'),
        path: 'spaces/my-space',
        integrity: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        plugin: {
          name: 'my-space',
          version: '1.0.0',
        },
        deps: {
          spaces: [],
        },
      },
    },
    targets: {
      default: {
        compose: ['space:my-space@stable'],
        roots: ['my-space@abc1234'],
        loadOrder: ['my-space@abc1234'],
        envHash: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      },
    },
  }
}

function firstValidationIssue(json: string) {
  try {
    parseLockJson(json)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError)
    return (error as ConfigValidationError).validationErrors[0]
  }
  throw new Error('expected parseLockJson to reject')
}

describe('parseLockJson', () => {
  test('a valid asp-lock.json parses to exactly the lock it encodes, optional fields included', () => {
    const lock = createLockWithSpace()
    must(lock.spaces['my-space@abc1234']).resolvedFrom = {
      selector: 'stable',
      tag: 'space/my-space/stable',
      semver: '1.0.0',
    }
    must(lock.targets['default']).warnings = [
      { code: 'W201', message: 'Command collision detected', details: { command: 'build' } },
    ]

    expect(parseLockJson(JSON.stringify(lock))).toEqual(lock)
  })

  test('malformed asp-lock.json raises ConfigParseError naming the file and the JSON error', () => {
    expect(() => parseLockJson('not valid json', '/custom/path.json')).toThrow(
      expect.objectContaining({
        name: 'ConfigParseError',
        source: '/custom/path.json',
        message: expect.stringContaining('Failed to parse JSON'),
      })
    )
  })

  test.each([
    ['missing required fields', () => ({}), '/', 'required'],
    [
      'lockfileVersion 2',
      () => ({ ...createValidLock(), lockfileVersion: 2 }),
      '/lockfileVersion',
      'const',
    ],
    [
      'resolverVersion 2',
      () => ({ ...createValidLock(), resolverVersion: 2 }),
      '/resolverVersion',
      'const',
    ],
    [
      'registry type svn',
      () => {
        const lock = createValidLock()
        return { ...lock, registry: { ...lock.registry, type: 'svn' } }
      },
      '/registry/type',
      'const',
    ],
    [
      'non-hex commit',
      () => {
        const lock = createLockWithSpace()
        ;(lock.spaces['my-space@abc1234'] as { commit: string }).commit = 'INVALID!'
        return lock
      },
      '/spaces/my-space@abc1234/commit',
      'pattern',
    ],
    [
      'md5 integrity',
      () => {
        const lock = createLockWithSpace()
        must(lock.spaces['my-space@abc1234']).integrity = 'md5:invalid' as never
        return lock
      },
      '/spaces/my-space@abc1234/integrity',
      'pattern',
    ],
  ])(
    'asp-lock.json violating the lock schema is rejected at the offending path: %s',
    (_label, build, path, keyword) => {
      expect(firstValidationIssue(JSON.stringify(build()))).toMatchObject({ path, keyword })
    }
  )
})

describe('readLockJson', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'lock-json-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('reads and parses valid lock file', async () => {
    const lock = createLockWithSpace()
    const filePath = join(testDir, 'asp-lock.json')
    await Bun.write(filePath, JSON.stringify(lock))

    const result = await readLockJson(filePath)
    expect(result.lockfileVersion).toBe(1)
    expect(result.spaces['my-space@abc1234']).toBeDefined()
  })

  test('a missing asp-lock.json rejects with ConfigFileNotFoundError naming the path', async () => {
    const filePath = join(testDir, 'nonexistent.json')
    const read = readLockJson(filePath)
    await expect(read).rejects.toBeInstanceOf(ConfigParseError)
    await expect(read).rejects.toMatchObject({
      name: 'ConfigFileNotFoundError',
      source: filePath,
      message: 'File not found',
    })
  })

  test('throws ConfigValidationError for invalid content', async () => {
    const filePath = join(testDir, 'asp-lock.json')
    await Bun.write(filePath, JSON.stringify({ invalid: true }))

    await expect(readLockJson(filePath)).rejects.toThrow(ConfigValidationError)
  })
})

describe('lockFileExists', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'lock-exists-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('reports true for a present lock file and false for a missing one', async () => {
    const filePath = join(testDir, 'asp-lock.json')
    await Bun.write(filePath, '{}')

    expect(await lockFileExists(filePath)).toBe(true)
    expect(await lockFileExists(join(testDir, 'nonexistent.json'))).toBe(false)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for lock file (asp-lock.json) parser
   *
   * WHY: Lock file parsing is critical for reproducibility. These tests
   * verify parsing, validation, serialization, and error handling.
   */

  /** Create a minimal valid lock file object */
  function createValidLock(): LockFile {
    return {
      lockfileVersion: 1,
      resolverVersion: 1,
      generatedAt: '2024-01-15T12:00:00.000Z',
      registry: {
        type: 'git',
        url: 'https://github.com/example/registry.git',
      },
      spaces: {},
      targets: {},
    }
  }

  /** Create a lock file with a space entry */
  function createLockWithSpace(): LockFile {
    return {
      lockfileVersion: 1,
      resolverVersion: 1,
      generatedAt: '2024-01-15T12:00:00.000Z',
      registry: {
        type: 'git',
        url: 'https://github.com/example/registry.git',
        defaultBranch: 'main',
      },
      spaces: {
        'my-space@abc1234': {
          id: asSpaceId('my-space'),
          commit: asCommitSha('abc1234'),
          path: 'spaces/my-space',
          integrity: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          plugin: {
            name: 'my-space',
            version: '1.0.0',
          },
          deps: {
            spaces: [],
          },
        },
      },
      targets: {
        default: {
          compose: ['space:my-space@stable'],
          roots: ['my-space@abc1234'],
          loadOrder: ['my-space@abc1234'],
          envHash: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      },
    }
  }

  describe('serializeLockJson', () => {
    test('serializes minimal lock file to JSON', () => {
      const lock = createValidLock()
      const result = serializeLockJson(lock)

      expect(result).toContain('"lockfileVersion": 1')
      expect(result).toContain('"resolverVersion": 1')
      expect(result).toContain('"registry"')
    })

    test('produces pretty-printed output with 2-space indentation', () => {
      const lock = createValidLock()
      const result = serializeLockJson(lock)

      // Check for 2-space indentation
      expect(result).toContain('  "lockfileVersion"')
      // Should not have 4-space indentation at top level
      expect(result.split('\n')[1]).toMatch(/^ {2}"/)
    })

    test('ends with newline', () => {
      const lock = createValidLock()
      const result = serializeLockJson(lock)

      expect(result.endsWith('\n')).toBe(true)
    })

    test('serializes complex lock file', () => {
      const lock = createLockWithSpace()
      must(lock.targets['default']).warnings = [{ code: 'W201', message: 'Test warning' }]
      const result = serializeLockJson(lock)

      expect(result).toContain('"my-space@abc1234"')
      expect(result).toContain('"W201"')
    })

    test('round-trip: serialize then parse produces equivalent object', () => {
      const original = createLockWithSpace()
      const serialized = serializeLockJson(original)
      const parsed = parseLockJson(serialized)

      expect(parsed).toEqual(original)
    })
  })
})
