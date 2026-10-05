import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PORTABLE_SPACES_REGISTRY,
  asCommitSha,
  asSpaceId,
  computeClosure,
  generateLockFileForTarget,
  git,
} from '../index.js'
import { PathResolver } from '../store/paths.js'
import { populateSnapshotsFromLock } from './install.js'
import { deferImmutableRegistry } from './resolve.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

async function createMixedSources(): Promise<{
  mutableRoot: string
  immutableRoot: string
  immutableCommit: string
}> {
  const root = await fixtureRoot('asp-portable-source')
  const mutableRoot = join(root, 'foreign-home', 'agents')
  const immutableRoot = join(root, 'canonical')

  await mkdir(join(mutableRoot, 'spaces', 'current'), { recursive: true })
  await writeFile(
    join(mutableRoot, 'spaces', 'current', 'space.toml'),
    'schema = 1\nid = "current"\n'
  )

  await mkdir(join(immutableRoot, 'spaces', 'legacy'), { recursive: true })
  await writeFile(
    join(immutableRoot, 'spaces', 'legacy', 'space.toml'),
    'schema = 1\nid = "legacy"\n'
  )
  await git.initRepo(immutableRoot, { initialBranch: 'main' })
  await git.gitExec(['config', 'user.email', 'portable-source@example.test'], {
    cwd: immutableRoot,
  })
  await git.gitExec(['config', 'user.name', 'Portable Source Test'], { cwd: immutableRoot })
  await git.add(['spaces/legacy/space.toml'], { cwd: immutableRoot })
  const immutableCommit = await git.commit('fixture', { cwd: immutableRoot })

  return { mutableRoot, immutableRoot, immutableCommit }
}

describe('portable immutable source locks', () => {
  test('materializes a mixed current @dev and immutable lock without serializing node paths', async () => {
    const { mutableRoot, immutableRoot, immutableCommit } = await createMixedSources()
    const aspHome = await fixtureRoot('asp-portable-home')
    const refs = ['space:current@dev', `space:legacy@git:${immutableCommit}`] as const

    const closure = await computeClosure([...refs], {
      cwd: mutableRoot,
      immutableCwd: immutableRoot,
    })
    const lock = await generateLockFileForTarget('mixed', [...refs], closure, {
      cwd: mutableRoot,
      immutableCwd: immutableRoot,
      registry: PORTABLE_SPACES_REGISTRY,
    })

    expect(lock.registry).toEqual(PORTABLE_SPACES_REGISTRY)
    expect(JSON.stringify(lock)).not.toContain(mutableRoot)
    expect(JSON.stringify(lock)).not.toContain(immutableRoot)
    expect<string | undefined>(lock.spaces['current@dev']?.commit).toBe('dev')
    expect(lock.spaces[`legacy@${immutableCommit.slice(0, 12)}`]?.commit).toBe(
      asCommitSha(immutableCommit)
    )

    await expect(populateSnapshotsFromLock(lock, immutableRoot, aspHome)).resolves.toBe(1)
  })

  test('a filesystem-only compile never acquires the immutable mirror', async () => {
    const { mutableRoot } = await createMixedSources()
    const aspHome = await fixtureRoot('asp-portable-home')
    const refs = ['space:current@dev'] as const
    let acquisitions = 0
    const immutableCwd = async (): Promise<string> => {
      acquisitions++
      throw new Error('immutable mirror must not be acquired for @dev-only refs')
    }

    const closure = await computeClosure([...refs], { cwd: mutableRoot, immutableCwd })
    const lock = await generateLockFileForTarget('dev-only', [...refs], closure, {
      cwd: mutableRoot,
      immutableCwd,
      registry: PORTABLE_SPACES_REGISTRY,
    })
    await expect(populateSnapshotsFromLock(lock, immutableCwd, aspHome)).resolves.toBe(0)

    expect(acquisitions).toBe(0)
    expect<string | undefined>(lock.spaces['current@dev']?.commit).toBe('dev')
  })

  test('a registry entry acquires the deferred mirror on first use', async () => {
    const { mutableRoot, immutableRoot, immutableCommit } = await createMixedSources()
    const aspHome = await fixtureRoot('asp-portable-home')
    const refs = ['space:current@dev', `space:legacy@git:${immutableCommit}`] as const
    let acquisitions = 0
    const immutableCwd = async (): Promise<string> => {
      acquisitions++
      return immutableRoot
    }

    const closure = await computeClosure([...refs], { cwd: mutableRoot, immutableCwd })
    const lock = await generateLockFileForTarget('mixed', [...refs], closure, {
      cwd: mutableRoot,
      immutableCwd,
      registry: PORTABLE_SPACES_REGISTRY,
    })
    await expect(populateSnapshotsFromLock(lock, immutableCwd, aspHome)).resolves.toBe(1)

    expect(acquisitions).toBeGreaterThan(0)
    expect(lock.spaces[`legacy@${immutableCommit.slice(0, 12)}`]?.commit).toBe(
      asCommitSha(immutableCommit)
    )
  })

  test('deferred mirror acquisition is single-flight and retries after failure', async () => {
    const aspHome = await fixtureRoot('asp-portable-home')
    // A non-git directory at the mirror placement fails acquisition before any
    // clone or network access.
    const mirror = new PathResolver({ aspHome }).immutableRepository(
      PORTABLE_SPACES_REGISTRY.repository
    )
    await mkdir(mirror, { recursive: true })

    const root = deferImmutableRegistry({ projectPath: aspHome, aspHome }, { fetch: false })
    if (typeof root === 'string') throw new Error('expected a deferred root')

    const first = root()
    const concurrent = root()
    expect(concurrent).toBe(first)
    await expect(first).rejects.toThrow('not a git repository')

    const retry = root()
    expect(retry).not.toBe(first)
    await expect(retry).rejects.toThrow('not a git repository')
  })

  test('an explicit placement is used as-is and never deferred', () => {
    expect(deferImmutableRegistry({ projectPath: '/p', registryPath: '/explicit/registry' })).toBe(
      '/explicit/registry'
    )
  })

  test('regenerates a legacy path-bearing registry into the portable identity', async () => {
    const legacy = {
      lockfileVersion: 1 as const,
      resolverVersion: 1 as const,
      generatedAt: '2026-01-01T00:00:00.000Z',
      registry: {
        type: 'git' as const,
        url: '/Users/someone-else/praesidium/var/spaces-repo/repo',
      },
      spaces: {},
      targets: {},
    }
    const update = {
      ...legacy,
      registry: PORTABLE_SPACES_REGISTRY,
    }

    const { mergeLockFiles } = await import('../resolver/lock-generator.js')
    const regenerated = mergeLockFiles(legacy, update)
    expect(regenerated.registry).toEqual(PORTABLE_SPACES_REGISTRY)
    expect(JSON.stringify(regenerated)).not.toContain('/Users/someone-else')
    expect<string>(asSpaceId('legacy')).toBe('legacy')
  })
})
