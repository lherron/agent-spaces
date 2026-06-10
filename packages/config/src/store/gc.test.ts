/**
 * Tests for gc module.
 *
 * WHY: Garbage collection prevents disk space exhaustion.
 * These tests verify reachability computation.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'
import {
  type LockFile,
  type Sha256Integrity,
  type SpaceKey,
  asCommitSha,
  asSpaceId,
} from '../core/index.js'
import { computeReachableCacheKeys, computeReachableIntegrities, runGC } from './gc.js'
import { PathResolver } from './paths.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

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

describe('runGC target bundle versions (T-04053)', () => {
  it('prunes only stale excess .versions entries and preserves live bundle artifacts', async () => {
    const aspHome = await createTempDir('asp-gc-versions-')
    const paths = new PathResolver({ aspHome })
    await paths.ensureAll()

    const scopeRoot = join(aspHome, 'codex-homes', 'agent-spaces_smokey')
    const versionsRoot = join(scopeRoot, 'bundles', '.versions')
    const targetName = 'smokey'
    const harnessId = 'codex'
    const old = new Date('2026-06-01T00:00:00.000Z')
    const recentA = new Date('2026-06-08T00:00:00.000Z')
    const recentB = new Date('2026-06-09T00:00:00.000Z')
    const fresh = new Date()

    async function createVersion(
      fingerprint: string,
      mtime: Date,
      options: { prompt?: string | undefined } = {}
    ): Promise<string> {
      const bundleRoot = join(versionsRoot, fingerprint, targetName, harnessId)
      await mkdir(bundleRoot, { recursive: true })
      await writeFile(
        join(bundleRoot, '.asp-materialized.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          complete: true,
          fingerprint,
          harnessId,
          targetName,
        })}\n`
      )
      if (options.prompt) {
        const hash =
          `${fingerprint}0000000000000000000000000000000000000000000000000000000000000000`
            .slice(0, 64)
            .replace(/[^a-f0-9]/g, 'a')
        const promptPath = join(
          bundleRoot,
          '.asp-runtime-artifacts',
          'system-prompts',
          hash.slice(0, 2),
          hash,
          'system-prompt.md'
        )
        await mkdir(join(promptPath, '..'), { recursive: true })
        await writeFile(promptPath, options.prompt)
      }
      await utimes(join(versionsRoot, fingerprint), mtime, mtime)
      await utimes(bundleRoot, mtime, mtime)
      return bundleRoot
    }

    const pruneFingerprint = '1111111111111111111111111111111111111111111111111111111111111111'
    const activeFingerprint = '2222222222222222222222222222222222222222222222222222222222222222'
    const freshFingerprint = '3333333333333333333333333333333333333333333333333333333333333333'
    const recentFingerprintA = '4444444444444444444444444444444444444444444444444444444444444444'
    const recentFingerprintB = '5555555555555555555555555555555555555555555555555555555555555555'
    const currentFingerprint = '6666666666666666666666666666666666666666666666666666666666666666'

    const prunePath = await createVersion(pruneFingerprint, old)
    const activePath = await createVersion(activeFingerprint, old)
    const currentPath = await createVersion(currentFingerprint, fresh, {
      prompt: 'current prompt must remain\n',
    })
    const recentPathA = await createVersion(recentFingerprintA, recentA)
    const recentPathB = await createVersion(recentFingerprintB, recentB, {
      prompt: 'recent prompt must remain\n',
    })
    const freshPath = await createVersion(freshFingerprint, fresh)

    // T-04053 regression guard: a resumable/active runtime may still reference
    // an older content-addressed bundle through launch artifact env. GC must
    // not remove that version just because it is older than the retention set.
    await mkdir(join(aspHome, 'tmp', 'launch-artifacts'), { recursive: true })
    await writeFile(
      join(aspHome, 'tmp', 'launch-artifacts', 'active-session.json'),
      `${JSON.stringify({
        env: {
          ASP_PLUGIN_ROOT: activePath,
        },
      })}\n`
    )

    const result = await runGC([], { paths, cwd: aspHome })

    expect(await pathExists(prunePath)).toBe(false)
    expect(await pathExists(activePath)).toBe(true)
    expect(await pathExists(currentPath)).toBe(true)
    expect(await pathExists(recentPathA)).toBe(true)
    expect(await pathExists(recentPathB)).toBe(true)
    expect(await pathExists(freshPath)).toBe(true)
    expect((await readdir(versionsRoot)).sort()).toEqual(
      [
        activeFingerprint,
        freshFingerprint,
        recentFingerprintA,
        recentFingerprintB,
        currentFingerprint,
      ].sort()
    )
    expect(
      await readFile(
        join(
          currentPath,
          '.asp-runtime-artifacts',
          'system-prompts',
          currentFingerprint.slice(0, 2),
          currentFingerprint,
          'system-prompt.md'
        ),
        'utf-8'
      )
    ).toBe('current prompt must remain\n')
    expect(result.bytesFreed).toBeGreaterThan(0)
  })
})
