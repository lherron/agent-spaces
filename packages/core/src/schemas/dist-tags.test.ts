/**
 * Tests for dist-tags.schema.json validation
 *
 * WHY: Dist-tags.json is committed metadata in the registry that maps
 * space IDs to channel (stable, latest, beta) -> version mappings.
 * This enables PR-reviewable channel promotions.
 */

import { describe, expect, test } from 'bun:test'
import { validateDistTagsFile } from './index.js'

describe('validateDistTagsFile', () => {
  test('accepts empty object', () => {
    const result = validateDistTagsFile({})
    expect(result.valid).toBe(true)
  })

  test('accepts valid dist-tags file', () => {
    const result = validateDistTagsFile({
      'todo-frontend': {
        stable: 'v1.2.0',
        latest: 'v1.3.0-beta.1',
        beta: 'v1.3.0-beta.1',
      },
      'shared-quality': {
        stable: 'v1.3.2',
        latest: 'v1.3.2',
      },
    })
    expect(result.valid).toBe(true)
  })

  test('accepts version without v prefix', () => {
    const result = validateDistTagsFile({
      'my-space': {
        stable: '1.2.0',
      },
    })
    expect(result.valid).toBe(true)
  })

  test('accepts prerelease versions', () => {
    const result = validateDistTagsFile({
      'my-space': {
        stable: 'v1.0.0-alpha.1',
        beta: 'v2.0.0-rc.1+build.123',
      },
    })
    expect(result.valid).toBe(true)
  })

  test('rejects invalid version format', () => {
    const result = validateDistTagsFile({
      'my-space': {
        stable: 'invalid-version',
      },
    })
    expect(result.valid).toBe(false)
  })

  test('rejects non-string version values', () => {
    const result = validateDistTagsFile({
      'my-space': {
        stable: 123,
      },
    })
    expect(result.valid).toBe(false)
  })

  test('rejects arrays as values', () => {
    const result = validateDistTagsFile([])
    expect(result.valid).toBe(false)
  })

  test('rejects string as top-level value', () => {
    const result = validateDistTagsFile({
      'my-space': 'v1.0.0',
    })
    expect(result.valid).toBe(false)
  })
})
