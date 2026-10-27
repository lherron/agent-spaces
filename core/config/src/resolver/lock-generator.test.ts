/**
 * Tests for lock file generation.
 *
 * WHY: Lock files are the reproducibility anchor. We need to verify
 * that the generator correctly computes warnings and all lock fields.
 */

import { describe, expect, test } from 'bun:test'
import type { CommitSha, SpaceId, SpaceKey, SpaceManifest } from '../core/index.js'
import { LOCK_HARNESSES } from '../core/index.js'
import { must } from '../test-support/must.js'
import type { ResolvedSpace } from './closure.js'
import { computeHarnessEnvHash } from './integrity.js'
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

function lockTargetFor(spaces: ResolvedSpace[]): TargetInput {
  const keys = spaces.map((space) => space.key)
  return {
    name: 'test-target',
    compose: spaces.map((space) => `space:${space.id}@stable` as TargetInput['compose'][number]),
    closure: {
      spaces: new Map<SpaceKey, ResolvedSpace>(spaces.map((space) => [space.key, space])),
      roots: keys,
      loadOrder: keys,
    },
  }
}

const lockOptions: LockGeneratorOptions = {
  cwd: '/mock/registry',
  registry: { type: 'git', url: 'https://example.com/repo' },
}

describe('lock-generator', () => {
  describe('W205 plugin name collision warnings', () => {
    test.each<[string, ResolvedSpace[], string[] | undefined]>([
      [
        'two spaces with the same plugin.name',
        [
          createMockSpace('space-a', 'abc1234', 'shared-plugin'),
          createMockSpace('space-b', 'def5678', 'shared-plugin'),
        ],
        ['shared-plugin', 'space-a', 'space-b'],
      ],
      [
        'a space id colliding with another space plugin.name',
        [createMockSpace('shared', 'abc1234'), createMockSpace('other', 'def5678', 'shared')],
        ['shared'],
      ],
      [
        'unique plugin names',
        [
          createMockSpace('space-a', 'abc1234', 'plugin-a'),
          createMockSpace('space-b', 'def5678', 'plugin-b'),
        ],
        undefined,
      ],
    ])(
      'two spaces sharing a plugin name record a W205 warning in the lock target: %s',
      async (_case, spaces, messageNames) => {
        const lock = await generateLockFile([lockTargetFor(spaces)], lockOptions)
        const targetEntry = must(lock.targets['test-target'], 'targetEntry')

        if (messageNames === undefined) {
          expect(targetEntry.warnings).toBeUndefined()
          return
        }

        const warnings = must(targetEntry.warnings, 'targetEntry.warnings')
        expect(warnings).toHaveLength(1)
        expect(warnings[0]?.code).toBe('W205')
        for (const name of messageNames) {
          expect(warnings[0]?.message).toContain(name)
        }
      }
    )
  })

  describe('harness enumeration (A6)', () => {
    test('the lock records one harness entry per lock harness with its own harness envHash', async () => {
      const space = createMockSpace('space-a', 'abc1234', 'plugin-a')

      const lock = await generateLockFile([lockTargetFor([space])], lockOptions)
      const targetEntry = must(lock.targets['test-target'], 'targetEntry')
      const harnesses = must(targetEntry.harnesses, 'targetEntry.harnesses')

      // Behavior is driven by the shared enumeration, not an inline literal.
      expect(Object.keys(harnesses).sort()).toEqual([...LOCK_HARNESSES].sort())
      // Preserved default: only the agent-harness entry (T-08701 contract default).
      expect(LOCK_HARNESSES).toEqual(['agent-harness'])

      // The harness entry carries the per-harness hash, not the target-level envHash.
      const integrity = must(lock.spaces[space.key], 'lock space entry').integrity
      const expectedHarnessHash = computeHarnessEnvHash('agent-harness', [
        { spaceKey: space.key, integrity, pluginName: 'plugin-a' },
      ])
      expect(harnesses['agent-harness']?.envHash).toBe(expectedHarnessHash)
      expect(harnesses['agent-harness']?.envHash).not.toBe(targetEntry.envHash)
    })
  })
})
