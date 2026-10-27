/**
 * Tests for git-tags module.
 *
 * WHY: Git tag parsing is critical for semver resolution.
 * These tests verify tag parsing and pattern building.
 */

import { describe, expect, it } from 'bun:test'
import type { SpaceId } from '../core/index.js'
import { buildTagPattern, parseVersionTag } from './git-tags.js'

describe('buildTagPattern', () => {
  it('should build pattern for space tags', () => {
    const pattern = buildTagPattern('my-space' as SpaceId)
    expect(pattern).toBe('space/my-space/v*')
  })
})

describe('parseVersionTag', () => {
  it('should parse valid version tag', () => {
    const result = parseVersionTag('space/my-space/v1.2.3')
    expect(result).not.toBeNull()
    expect(result?.spaceId).toBe('my-space')
    expect(result?.version).toBe('1.2.3')
  })

  it.each<[string, { spaceId: string; version: string } | null]>([
    ['space/my-space/v1.0.0-beta.1', { spaceId: 'my-space', version: '1.0.0-beta.1' }],
    ['not-a-tag', null],
    ['space/my-space', null],
    ['space/my-space/1.2.3', null], // missing v
    ['space/my-space/vabc', null],
    ['space/my-space/v1.2', null],
  ])(
    'tags that are not space/<id>/v<semver> are ignored by version resolution: %s -> %p',
    (tag, expected) => {
      const result = parseVersionTag(tag)
      if (expected === null) {
        expect(result).toBeNull()
      } else {
        expect(result).toMatchObject(expected)
      }
    }
  )
})
