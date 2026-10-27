import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { LOCK_FILENAME, readLockJson, resolveTarget } from 'spaces-config'
import { install } from 'spaces-execution'
import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

beforeAll(initSampleRegistry)

describe('install lock edge association', () => {
  let projectPath: string
  let aspHome: string
  let registryPath: string
  let outputPath: string
  const lockPath = () => path.join(projectPath, LOCK_FILENAME)
  const run = (options: Partial<Parameters<typeof install>[0]> = {}) =>
    install({ projectPath, aspHome, registryPath, ...options })
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: registryPath, encoding: 'utf8' }).trim()
  const entry = (lock: Awaited<ReturnType<typeof readLockJson>>, id: string) =>
    Object.values(lock.spaces).find((space) => space.id === id)!
  const advance = async (space: string) => {
    await fs.writeFile(
      path.join(registryPath, `spaces/${space}/edge-marker.txt`),
      `${space} moved\n`
    )
    git('add', `spaces/${space}/edge-marker.txt`)
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      `move ${space}`
    )
    git('tag', '-f', `space/${space}/v1.0.0`)
  }
  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectPath = await createTempProject({ dev: { compose: ['space:frontend@stable'] } })
    registryPath = path.join(projectPath, 'registry')
    await fs.cp(SAMPLE_REGISTRY_DIR, registryPath, { recursive: true })
    const result = await run()
    outputPath = result.materializations[0]!.outputPath
  })
  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectPath)
  })

  test('selective transitive update moves base while keeping its frontend parent and provenance', async () => {
    const before = await readLockJson(lockPath())
    await advance('base')
    await run({ update: true, upgradeSpaceIds: ['base'] })
    const after = await readLockJson(lockPath())
    expect(entry(after, 'frontend').commit).toBe(entry(before, 'frontend').commit)
    expect(entry(after, 'frontend').resolvedFrom).toEqual(entry(before, 'frontend').resolvedFrom)
    expect(entry(after, 'base').commit).not.toBe(entry(before, 'base').commit)
    expect(entry(after, 'frontend').deps.spaces).toContain(
      Object.keys(after.spaces).find((k) => k.startsWith('base@'))! as `${string}@${string}`
    )
    await run()
    const repeated = await readLockJson(lockPath())
    expect(repeated.spaces).toEqual(after.spaces)
    expect(repeated.targets['dev']?.loadOrder).toEqual(after.targets['dev']?.loadOrder)
  })

  test('duplicate and reordered roots preserve their individual locked commits', async () => {
    const targets = path.join(projectPath, 'asp-targets.toml')
    await fs.writeFile(
      targets,
      'schema = 2\n[targets.dev]\ncompose = ["space:frontend@stable", "space:base@stable", "space:frontend@stable"]\n'
    )
    await run()
    const before = await readLockJson(lockPath())
    await advance('frontend')
    await fs.writeFile(
      targets,
      'schema = 2\n[targets.dev]\ncompose = ["space:base@stable", "space:frontend@stable", "space:frontend@stable"]\n'
    )
    await run()
    const after = await readLockJson(lockPath())
    expect(after.targets['dev']?.roots).toEqual([
      before.targets['dev']!.roots[1]!,
      before.targets['dev']!.roots[0]!,
      before.targets['dev']!.roots[2]!,
    ])
    expect(entry(after, 'frontend').commit).toBe(entry(before, 'frontend').commit)
    expect(after.targets['dev']?.loadOrder).toEqual(before.targets['dev']?.loadOrder)
  })

  test('useLock false follows the current selector even on a plain install', async () => {
    const before = await readLockJson(lockPath())
    await advance('frontend')
    await run({ useLock: false })
    const after = await readLockJson(lockPath())
    expect(entry(after, 'frontend').commit).not.toBe(entry(before, 'frontend').commit)
    expect(entry(after, 'frontend').resolvedFrom?.selector).toBe('stable')
  })

  test.each(['missing', 'synthetic'] as const)(
    'preserves %s legacy provenance through repeated installs',
    async (kind) => {
      const original = await readLockJson(lockPath())
      const frontend = entry(original, 'frontend')
      const expected = kind === 'missing' ? undefined : { selector: `git:${frontend.commit}` }
      const serialized = JSON.parse(JSON.stringify(original)) as {
        spaces: Record<string, Record<string, unknown>>
      }
      const key = Object.keys(serialized.spaces).find((k) => k.startsWith('frontend@'))!
      serialized.spaces[key]!['resolvedFrom'] = expected
      await fs.writeFile(lockPath(), JSON.stringify(serialized, null, 2))
      await advance('frontend')
      await run()
      await run()
      const after = await readLockJson(lockPath())
      expect(entry(after, 'frontend').commit).toBe(frontend.commit)
      expect(entry(after, 'frontend').resolvedFrom).toEqual(expected)
    }
  )
  test('a malformed dependency association refuses atomically and full update repairs it', async () => {
    const lock = await readLockJson(lockPath())
    entry(lock, 'frontend').deps.spaces = []
    await fs.writeFile(lockPath(), JSON.stringify(lock, null, 2))
    const damaged = await fs.readFile(lockPath(), 'utf8')
    const marker = path.join(outputPath, 'atomicity-marker.txt')
    await fs.writeFile(marker, 'original materialization')
    let message = ''
    try {
      await run()
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/frontend|dev/)
    expect(message).toMatch(/update/i)
    expect(await fs.readFile(lockPath(), 'utf8')).toBe(damaged)
    expect(await fs.readFile(marker, 'utf8')).toBe('original materialization')
    await run({ update: true })
    const repaired = await readLockJson(lockPath())
    expect(entry(repaired, 'frontend').deps.spaces).toHaveLength(1)
    expect(entry(repaired, 'base').commit).toBeDefined()
  })

  test('updating a parent keeps unchanged dependency edges but resolves an added edge', async () => {
    const before = await readLockJson(lockPath())
    await advance('base')
    const manifestPath = path.join(registryPath, 'spaces/frontend/space.toml')
    const manifest = await fs.readFile(manifestPath, 'utf8')
    await fs.writeFile(
      manifestPath,
      manifest.replace('space:base@stable', 'space:base@stable", "space:backend@stable')
    )
    git('add', 'spaces/frontend/space.toml')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'add backend dependency'
    )
    git('tag', '-f', 'space/frontend/v1.0.0')
    await run({ update: true, upgradeSpaceIds: ['frontend'] })
    const after = await readLockJson(lockPath())
    expect(entry(after, 'frontend').commit).not.toBe(entry(before, 'frontend').commit)
    expect(entry(after, 'base').commit).toBe(entry(before, 'base').commit)
    expect(entry(after, 'backend').commit).toBeDefined()
    expect(entry(after, 'frontend').deps.spaces).toHaveLength(2)
  })
  test('a live dev parent resolves its child afresh because old edge selectors are unavailable', async () => {
    const local = path.join(projectPath, 'live-frontend')
    await fs.cp(path.join(registryPath, 'spaces/frontend'), local, { recursive: true })
    await fs.writeFile(
      path.join(projectPath, 'asp-targets.toml'),
      `schema = 2\n[targets.dev]\ncompose = ["space:path:${local}@dev"]\n`
    )
    await run()
    const before = await readLockJson(lockPath())
    await advance('base')
    await run()
    const after = await readLockJson(lockPath())
    expect(entry(after, 'base').commit).not.toBe(entry(before, 'base').commit)
    expect(after.spaces[after.targets['dev']!.roots[0]!]!.deps.spaces).toContain(
      Object.keys(after.spaces).find((k) => k.startsWith('base@'))! as `${string}@${string}`
    )
  })
  test('a registry missing the locked Git object refuses without writing and full update recovers', async () => {
    const before = await fs.readFile(lockPath(), 'utf8')
    await fs.rm(path.join(registryPath, '.git'), { recursive: true, force: true })
    git('init')
    git('add', '.')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'new registry history'
    )
    for (const name of ['frontend', 'base', 'backend']) git('tag', `space/${name}/v1.0.0`)
    let message = ''
    try {
      await run()
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/frontend|dev/)
    expect(message).toMatch(/update/i)
    expect(await fs.readFile(lockPath(), 'utf8')).toBe(before)
    await run({ update: true })
    const after = await readLockJson(lockPath())
    expect(String(entry(after, 'frontend').commit)).toBe(git('rev-parse', 'HEAD'))
  })
  test('ambiguous duplicate old selectors refuse atomically and full update repairs them', async () => {
    await advance('frontend')
    const targets = path.join(projectPath, 'asp-targets.toml')
    await fs.writeFile(
      targets,
      'schema = 2\n[targets.dev]\ncompose = ["space:frontend@stable", "space:frontend@latest"]\n'
    )
    await run({ update: true })
    const lock = await readLockJson(lockPath())
    expect(lock.targets['dev']!.roots[0]).not.toBe(lock.targets['dev']!.roots[1])
    lock.targets['dev']!.compose = ['space:frontend@stable', 'space:frontend@stable']
    await fs.writeFile(lockPath(), JSON.stringify(lock, null, 2))
    await fs.writeFile(
      targets,
      'schema = 2\n[targets.dev]\ncompose = ["space:frontend@stable", "space:frontend@stable"]\n'
    )
    const damaged = await fs.readFile(lockPath(), 'utf8')
    let message = ''
    try {
      await run()
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/frontend|dev/)
    expect(message).toMatch(/update/i)
    expect(await fs.readFile(lockPath(), 'utf8')).toBe(damaged)
    await run({ update: true })
    const repaired = await readLockJson(lockPath())
    expect(repaired.targets['dev']!.roots[0]).toBe(repaired.targets['dev']!.roots[1])
  })
  test('an updated parent drops removed edges and resolves changed selectors freshly', async () => {
    const before = await readLockJson(lockPath())
    await advance('base')
    git('tag', '-f', 'space/base/v1.1.0')
    const manifestPath = path.join(registryPath, 'spaces/frontend/space.toml')
    const manifest = await fs.readFile(manifestPath, 'utf8')
    await fs.writeFile(manifestPath, manifest.replace('space:base@stable', 'space:base@latest'))
    git('add', 'spaces/frontend/space.toml')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'change dependency selector'
    )
    git('tag', '-f', 'space/frontend/v1.0.0')
    await run({ update: true, upgradeSpaceIds: ['frontend'] })
    const changed = await readLockJson(lockPath())
    expect(entry(changed, 'base').commit).not.toBe(entry(before, 'base').commit)
    expect(entry(changed, 'base').resolvedFrom?.selector).toBe('latest')
    await fs.writeFile(
      manifestPath,
      manifest.replace('spaces = ["space:base@stable"]', 'spaces = []')
    )
    git('add', 'spaces/frontend/space.toml')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'remove dependency'
    )
    git('tag', '-f', 'space/frontend/v1.0.0')
    await run({ update: true, upgradeSpaceIds: ['frontend'] })
    const removed = await readLockJson(lockPath())
    expect(entry(removed, 'frontend').deps.spaces).toEqual([])
    expect(Object.values(removed.spaces).some((space) => space.id === 'base')).toBe(false)
  })
  test('distinct selectors converging on one commit retain the existing node and provenance', async () => {
    const before = await readLockJson(lockPath())
    const commit = entry(before, 'frontend').commit
    git('tag', '-f', 'space/frontend/v1.1.0', commit)
    const targets = path.join(projectPath, 'asp-targets.toml')
    await fs.writeFile(
      targets,
      'schema = 2\n[targets.dev]\ncompose = ["space:frontend@stable", "space:frontend@latest"]\n'
    )
    await run()
    const after = await readLockJson(lockPath())
    expect(after.targets['dev']!.roots[0]).toBe(after.targets['dev']!.roots[1])
    expect(Object.values(after.spaces).filter((space) => space.id === 'frontend')).toHaveLength(1)
    expect(entry(after, 'frontend').resolvedFrom).toEqual(entry(before, 'frontend').resolvedFrom)
    expect(entry(after, 'frontend').deps.spaces).toEqual(entry(before, 'frontend').deps.spaces)
  })
  test('registry lock entry with a project source marker refuses atomically', async () => {
    const lock = await readLockJson(lockPath())
    entry(lock, 'frontend').projectSpace = true
    await fs.writeFile(lockPath(), JSON.stringify(lock, null, 2))
    const damaged = await fs.readFile(lockPath(), 'utf8')
    let message = ''
    try {
      await run()
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/frontend|dev/)
    expect(message).toMatch(/update/i)
    expect(await fs.readFile(lockPath(), 'utf8')).toBe(damaged)
  })

  test('partial full update refuses an invalid preserved target before writing', async () => {
    await fs.appendFile(
      path.join(projectPath, 'asp-targets.toml'),
      '\n[targets.other]\ncompose = ["space:backend@stable"]\n'
    )
    await run()
    const lock = await readLockJson(lockPath())
    lock.targets['dev']!.roots = []
    await fs.writeFile(lockPath(), JSON.stringify(lock, null, 2))
    const damaged = await fs.readFile(lockPath(), 'utf8')
    let message = ''
    try {
      await run({ targets: ['other'], update: true })
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/dev/)
    expect(await fs.readFile(lockPath(), 'utf8')).toBe(damaged)
  })

  test('direct resolveTarget reports whether it actually reused the lock', async () => {
    const before = await readLockJson(lockPath())
    await advance('frontend')
    const result = await resolveTarget('dev', { projectPath, aspHome, registryPath })
    expect(result.fromLock).toBe(true)
    expect(entry(result.lock, 'frontend').commit).toBe(entry(before, 'frontend').commit)
    const fresh = await resolveTarget('dev', { projectPath, aspHome, registryPath, useLock: false })
    expect(fresh.fromLock).toBe(false)
    expect(String(entry(fresh.lock, 'frontend').commit)).toBe(git('rev-parse', 'HEAD'))
  })
})
