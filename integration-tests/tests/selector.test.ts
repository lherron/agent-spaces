/**
 * Integration tests for selector resolution (semver ranges, git pins).
 *
 * WHY: The resolver must correctly resolve different selector types:
 * - Dist-tags (@stable, @latest) - resolve via dist-tags.json
 * - Semver exact (1.2.3) - match specific version tag
 * - Semver ranges (^1.0.0, ~1.0.0) - find highest matching version
 * - Git pins (git:abc1234) - use commit directly
 *
 * These tests verify the full resolution flow from selector parsing
 * through git tag resolution to the final commit SHA.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { asSpaceId, parseSelector } from 'spaces-core'
import {
  computeClosure,
  getLatestVersion,
  listVersionTags,
  resolveExactVersion,
  resolveSelector,
  resolveSemverRange,
  versionExists,
} from 'spaces-resolver'

import { SAMPLE_REGISTRY_DIR, cleanupSampleRegistry, initSampleRegistry } from './setup.js'

const execAsync = promisify(exec)

describe('selector resolution', () => {
  beforeAll(async () => {
    // Clean up any existing registry to get fresh tags
    await cleanupSampleRegistry()
    // Initialize sample registry with git tags
    await initSampleRegistry()
  })

  afterAll(async () => {
    // Optional: Leave registry for debugging
    // await cleanupSampleRegistry()
  })

  describe('dist-tag resolution', () => {
    test('resolves @stable to correct commit', async () => {
      const selector = parseSelector('stable')
      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      expect(result.commit).toMatch(/^[a-f0-9]{7,40}$/)
      expect(result.selector.kind).toBe('dist-tag')
    })

    test('resolves @latest to correct commit', async () => {
      const selector = parseSelector('latest')
      const result = await resolveSelector(asSpaceId('frontend'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      expect(result.commit).toMatch(/^[a-f0-9]{7,40}$/)
    })
  })

  describe('semver exact resolution', () => {
    test('resolves exact version 1.0.0', async () => {
      const selector = parseSelector('1.0.0')
      expect(selector.kind).toBe('semver')
      expect(selector.kind === 'semver' && selector.exact).toBe(true)

      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      expect(result.tag).toBe('space/base/v1.0.0')
      expect(result.semver).toBe('1.0.0')
    })

    test('resolves exact version 1.1.0', async () => {
      const selector = parseSelector('1.1.0')
      const result = await resolveSelector(asSpaceId('frontend'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      expect(result.tag).toBe('space/frontend/v1.1.0')
      expect(result.semver).toBe('1.1.0')
    })

    test('throws for non-existent exact version', async () => {
      const selector = parseSelector('9.9.9')

      await expect(
        resolveSelector(asSpaceId('base'), selector, {
          cwd: SAMPLE_REGISTRY_DIR,
        })
      ).rejects.toThrow()
    })
  })

  describe('semver range resolution', () => {
    test('resolves ^1.0.0 to highest compatible version', async () => {
      const selector = parseSelector('^1.0.0')
      expect(selector.kind).toBe('semver')
      expect(selector.kind === 'semver' && selector.exact).toBe(false)

      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      // Should resolve to v1.1.0 (highest 1.x.x version)
      expect(result.semver).toBe('1.1.0')
      expect(result.tag).toBe('space/base/v1.1.0')
    })

    test('resolves ~1.0.0 to highest patch version', async () => {
      const selector = parseSelector('~1.0.0')
      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      // Should resolve to v1.0.1 (highest 1.0.x version)
      expect(result.semver).toBe('1.0.1')
      expect(result.tag).toBe('space/base/v1.0.1')
    })

    test('resolves ^2.0.0 to exact version when only one match', async () => {
      const selector = parseSelector('^2.0.0')
      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBeDefined()
      expect(result.semver).toBe('2.0.0')
      expect(result.tag).toBe('space/base/v2.0.0')
    })

    test('throws for range with no matching versions', async () => {
      const selector = parseSelector('^3.0.0')

      await expect(
        resolveSelector(asSpaceId('base'), selector, {
          cwd: SAMPLE_REGISTRY_DIR,
        })
      ).rejects.toThrow()
    })
  })

  describe('git pin resolution', () => {
    let headCommit: string

    beforeAll(async () => {
      // Get the current HEAD commit for testing
      const { stdout } = await execAsync('git rev-parse HEAD', {
        cwd: SAMPLE_REGISTRY_DIR,
      })
      headCommit = stdout.trim()
    })

    test('resolves git pin to exact commit', async () => {
      const shortSha = headCommit.slice(0, 12)
      const selector = parseSelector(`git:${shortSha}`)
      expect(selector.kind).toBe('git-pin')

      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      // Git pin should return exactly what was provided
      expect(result.commit).toBe(shortSha)
      // No tag metadata for git pins
      expect(result.tag).toBeUndefined()
      expect(result.semver).toBeUndefined()
    })

    test('git pin preserves full SHA when provided', async () => {
      const selector = parseSelector(`git:${headCommit}`)
      const result = await resolveSelector(asSpaceId('base'), selector, {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.commit).toBe(headCommit)
    })
  })

  describe('version tag utilities', () => {
    test('listVersionTags returns all version tags for space', async () => {
      const tags = await listVersionTags(asSpaceId('base'), {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(tags.length).toBeGreaterThanOrEqual(4)
      expect(tags.some((t) => t.version === '1.0.0')).toBe(true)
      expect(tags.some((t) => t.version === '1.0.1')).toBe(true)
      expect(tags.some((t) => t.version === '1.1.0')).toBe(true)
      expect(tags.some((t) => t.version === '2.0.0')).toBe(true)
    })

    test('getLatestVersion returns highest version', async () => {
      const latest = await getLatestVersion(asSpaceId('base'), {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(latest).toBeDefined()
      expect(latest!.version).toBe('2.0.0')
    })

    test('versionExists returns true for existing version', async () => {
      const exists = await versionExists(asSpaceId('base'), '1.0.0', {
        cwd: SAMPLE_REGISTRY_DIR,
      })
      expect(exists).toBe(true)
    })

    test('versionExists returns false for non-existing version', async () => {
      const exists = await versionExists(asSpaceId('base'), '9.9.9', {
        cwd: SAMPLE_REGISTRY_DIR,
      })
      expect(exists).toBe(false)
    })
  })

  describe('resolver with semver selectors', () => {
    test('resolveSemverRange finds highest matching version', async () => {
      const result = await resolveSemverRange(asSpaceId('base'), '^1.0.0', {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.version).toBe('1.1.0')
      expect(result.tag).toBe('space/base/v1.1.0')
      expect(result.commit).toBeDefined()
    })

    test('resolveExactVersion finds specific version', async () => {
      const result = await resolveExactVersion(asSpaceId('base'), '1.0.1', {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(result.version).toBe('1.0.1')
      expect(result.tag).toBe('space/base/v1.0.1')
      expect(result.commit).toBeDefined()
    })
  })

  describe('closure computation with selectors', () => {
    test('computeClosure resolves space with semver range', async () => {
      const closure = await computeClosure(['space:base@^1.0.0'], {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(closure.loadOrder.length).toBe(1)
      // Should have resolved to v1.1.0
      const spaceKey = closure.loadOrder[0]!
      expect(spaceKey).toMatch(/^base@[a-f0-9]+$/)

      const space = closure.spaces.get(spaceKey)
      expect(space).toBeDefined()
    })

    test('computeClosure resolves space with exact version', async () => {
      const closure = await computeClosure(['space:base@1.0.0'], {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(closure.loadOrder.length).toBe(1)
      const spaceKey = closure.loadOrder[0]!
      const space = closure.spaces.get(spaceKey)
      expect(space).toBeDefined()
    })

    test('computeClosure includes dependencies with selectors', async () => {
      // Frontend depends on base
      const closure = await computeClosure(['space:frontend@^1.0.0'], {
        cwd: SAMPLE_REGISTRY_DIR,
      })

      expect(closure.loadOrder.length).toBeGreaterThanOrEqual(2)
      // Base should come before frontend (deps first)
      const baseIdx = closure.loadOrder.findIndex((k) => k.startsWith('base@'))
      const frontendIdx = closure.loadOrder.findIndex((k) => k.startsWith('frontend@'))
      expect(baseIdx).toBeLessThan(frontendIdx)
    })
  })
})
