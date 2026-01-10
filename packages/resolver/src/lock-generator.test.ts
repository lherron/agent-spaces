/**
 * Tests for lock file generation.
 *
 * WHY: Lock files are the reproducibility anchor. We need to verify
 * that the generator correctly computes warnings and all lock fields.
 */

import { describe, expect, test } from 'bun:test'
import type { CommitSha, SpaceId, SpaceKey, SpaceManifest } from '@agent-spaces/core'
import type { ClosureResult, ResolvedSpace } from './closure.js'
import { type LockGeneratorOptions, type TargetInput, generateLockFile } from './lock-generator.js'

// Mock resolved spaces for testing
function createMockSpace(
  id: string,
  commit: string,
  pluginName?: string,
  deps: SpaceKey[] = []
): ResolvedSpace {
  const manifest: SpaceManifest = {
    schema: 1,
    id: id as SpaceId,
  }
  if (pluginName !== undefined) {
    manifest.plugin = { name: pluginName }
  }

  const commitSha = commit as CommitSha
  const spaceKey = `${id}@${commit}` as SpaceKey

  return {
    key: spaceKey,
    id: id as SpaceId,
    commit: commitSha,
    path: `spaces/${id}`,
    manifest,
    deps,
    resolvedFrom: {
      commit: commitSha,
      selector: { kind: 'dist-tag', tag: 'stable' },
      tag: 'stable',
    },
  }
}

describe('lock-generator', () => {
  describe('W205 plugin name collision warnings', () => {
    test('detects plugin name collisions in lock file', async () => {
      // Create two spaces with the same plugin name
      const spaceA = createMockSpace('space-a', 'abc1234', 'shared-plugin')
      const spaceB = createMockSpace('space-b', 'def5678', 'shared-plugin')

      const keyA = 'space-a@abc1234' as SpaceKey
      const keyB = 'space-b@def5678' as SpaceKey

      const spacesMap = new Map<SpaceKey, ResolvedSpace>([
        [keyA, spaceA],
        [keyB, spaceB],
      ])

      const closure: ClosureResult = {
        spaces: spacesMap,
        roots: [keyA, keyB],
        loadOrder: [keyA, keyB],
      }

      const target: TargetInput = {
        name: 'test-target',
        compose: ['space:space-a@stable', 'space:space-b@stable'],
        closure,
      }

      const options: LockGeneratorOptions = {
        cwd: '/mock/registry',
        registry: { type: 'git', url: 'https://example.com/repo' },
      }

      // Generate lock file
      const lock = await generateLockFile([target], options)

      // Should have warnings in the target entry
      const targetEntry = lock.targets['test-target']
      expect(targetEntry).toBeDefined()
      if (!targetEntry) throw new Error('targetEntry is undefined')
      expect(targetEntry.warnings).toBeDefined()
      if (!targetEntry.warnings) throw new Error('warnings is undefined')
      expect(targetEntry.warnings.length).toBe(1)

      const warning = targetEntry.warnings[0]
      expect(warning).toBeDefined()
      if (!warning) throw new Error('warning is undefined')
      expect(warning.code).toBe('W205')
      expect(warning.message).toContain('shared-plugin')
      expect(warning.message).toContain('space-a')
      expect(warning.message).toContain('space-b')
    })

    test('no warnings when plugin names are unique', async () => {
      // Create two spaces with different plugin names
      const spaceA = createMockSpace('space-a', 'abc1234', 'plugin-a')
      const spaceB = createMockSpace('space-b', 'def5678', 'plugin-b')

      const keyA = 'space-a@abc1234' as SpaceKey
      const keyB = 'space-b@def5678' as SpaceKey

      const spacesMap = new Map<SpaceKey, ResolvedSpace>([
        [keyA, spaceA],
        [keyB, spaceB],
      ])

      const closure: ClosureResult = {
        spaces: spacesMap,
        roots: [keyA, keyB],
        loadOrder: [keyA, keyB],
      }

      const target: TargetInput = {
        name: 'test-target',
        compose: ['space:space-a@stable', 'space:space-b@stable'],
        closure,
      }

      const options: LockGeneratorOptions = {
        cwd: '/mock/registry',
        registry: { type: 'git', url: 'https://example.com/repo' },
      }

      // Generate lock file
      const lock = await generateLockFile([target], options)

      // Should have no warnings
      const targetEntry = lock.targets['test-target']
      expect(targetEntry).toBeDefined()
      if (!targetEntry) throw new Error('targetEntry is undefined')
      expect(targetEntry.warnings).toBeUndefined()
    })

    test('uses space id as plugin name when plugin.name not specified', async () => {
      // Create two spaces with the same ID would be invalid,
      // but if they somehow got the same derived plugin name, it should warn
      const spaceA = createMockSpace('shared', 'abc1234') // Uses id as plugin name
      const spaceB = createMockSpace('other', 'def5678', 'shared') // Overrides to same name

      const keyA = 'shared@abc1234' as SpaceKey
      const keyB = 'other@def5678' as SpaceKey

      const spacesMap = new Map<SpaceKey, ResolvedSpace>([
        [keyA, spaceA],
        [keyB, spaceB],
      ])

      const closure: ClosureResult = {
        spaces: spacesMap,
        roots: [keyA, keyB],
        loadOrder: [keyA, keyB],
      }

      const target: TargetInput = {
        name: 'test-target',
        compose: ['space:shared@stable', 'space:other@stable'],
        closure,
      }

      const options: LockGeneratorOptions = {
        cwd: '/mock/registry',
        registry: { type: 'git', url: 'https://example.com/repo' },
      }

      // Generate lock file
      const lock = await generateLockFile([target], options)

      // Should have warning for the 'shared' plugin name
      const targetEntry = lock.targets['test-target']
      expect(targetEntry).toBeDefined()
      if (!targetEntry) throw new Error('targetEntry is undefined')
      expect(targetEntry.warnings).toBeDefined()
      if (!targetEntry.warnings) throw new Error('warnings is undefined')
      expect(targetEntry.warnings.length).toBe(1)
      expect(targetEntry.warnings[0]?.code).toBe('W205')
    })
  })
})
