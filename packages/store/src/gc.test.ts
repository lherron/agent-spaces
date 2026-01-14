/**
 * Tests for gc module.
 *
 * WHY: Garbage collection prevents disk space exhaustion.
 * These tests verify reachability computation.
 */

import { describe, expect, it } from 'bun:test'
import {
  type LockFile,
  type Sha256Integrity,
  type SpaceKey,
  asCommitSha,
  asSpaceId,
} from 'spaces-core'
import { computeReachableCacheKeys, computeReachableIntegrities } from './gc.js'

function createMockLock(
  spaces: Record<string, { integrity: string; pluginName: string; version: string }>
): LockFile {
  const lock: LockFile = {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: new Date().toISOString(),
    registry: { type: 'git', url: 'https://example.com/repo' },
    spaces: {},
    targets: {},
  }

  for (const [key, { integrity, pluginName, version }] of Object.entries(spaces)) {
    const [spaceId, commitSha] = key.split('@')
    lock.spaces[key as SpaceKey] = {
      id: asSpaceId(spaceId ?? ''),
      commit: asCommitSha(commitSha ?? ''),
      path: `spaces/${spaceId}`,
      integrity: integrity as Sha256Integrity,
      plugin: { name: pluginName, version },
      deps: { spaces: [] },
    }
  }

  return lock
}

describe('computeReachableIntegrities', () => {
  it('should collect all integrities from locks', () => {
    const lock1 = createMockLock({
      'space-a@1111111': { integrity: 'sha256:111', pluginName: 'a', version: '1.0.0' },
      'space-b@2222222': { integrity: 'sha256:222', pluginName: 'b', version: '1.0.0' },
    })
    const lock2 = createMockLock({
      'space-c@3333333': { integrity: 'sha256:333', pluginName: 'c', version: '1.0.0' },
    })

    const reachable = computeReachableIntegrities([lock1, lock2])
    expect(reachable.size).toBe(3)
    expect(reachable.has('sha256:111' as Sha256Integrity)).toBe(true)
    expect(reachable.has('sha256:222' as Sha256Integrity)).toBe(true)
    expect(reachable.has('sha256:333' as Sha256Integrity)).toBe(true)
  })

  it('should dedupe same integrity across locks', () => {
    const lock1 = createMockLock({
      'space-a@1111111': { integrity: 'sha256:111', pluginName: 'a', version: '1.0.0' },
    })
    const lock2 = createMockLock({
      'space-a@1111111': { integrity: 'sha256:111', pluginName: 'a', version: '1.0.0' },
    })

    const reachable = computeReachableIntegrities([lock1, lock2])
    expect(reachable.size).toBe(1)
  })

  it('should return empty set for no locks', () => {
    const reachable = computeReachableIntegrities([])
    expect(reachable.size).toBe(0)
  })
})

describe('computeReachableCacheKeys', () => {
  it('should compute cache keys for all spaces', () => {
    const lock = createMockLock({
      'space-a@1111111': { integrity: 'sha256:111', pluginName: 'a', version: '1.0.0' },
      'space-b@2222222': { integrity: 'sha256:222', pluginName: 'b', version: '2.0.0' },
    })

    const reachable = computeReachableCacheKeys([lock])
    expect(reachable.size).toBe(2)
  })

  it('should use 0.0.0 for missing version', () => {
    const lock = createMockLock({
      'space-a@1111111': { integrity: 'sha256:111', pluginName: 'a', version: '' },
    })
    // This tests that the function handles undefined/empty version
    const reachable = computeReachableCacheKeys([lock])
    expect(reachable.size).toBe(1)
  })
})
