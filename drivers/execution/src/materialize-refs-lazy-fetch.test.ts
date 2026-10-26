/**
 * Lazy registry fetch (T-11840).
 *
 * WHY: materializeFromRefs used to `git fetch` the shared spaces root before
 * every compile (~92% of a live compile), though only registry spaces read git
 * and they read it from the immutable root. The fetch now runs only when a
 * registry space first reads the repository it updates; FETCH_HEAD in that
 * repository is the observable trace of a fetch.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { asCommitSha, git } from 'spaces-config'

import { useTempDirs } from '../test/temp-dirs.js'
import { materializeFromRefs } from './index.js'

const createTempDir = useTempDirs()

async function writeSpace(root: string, id: string): Promise<void> {
  const dir = join(root, 'spaces', id)
  await mkdir(join(dir, 'skills', `${id}-skill`), { recursive: true })
  await writeFile(
    join(dir, 'space.toml'),
    `schema = 1\nid = "${id}"\nversion = "1.0.0"\n\n[plugin]\nname = "${id}"\n`
  )
  await writeFile(
    join(dir, 'skills', `${id}-skill`, 'SKILL.md'),
    `---\nname: ${id}-skill\ndescription: ${id} fixture skill.\n---\n\nLoaded.\n`
  )
}

async function initRepo(path: string): Promise<void> {
  await git.initRepo(path, { initialBranch: 'main' })
  await git.gitExec(['config', 'user.email', 'lazy-fetch@example.test'], { cwd: path })
  await git.gitExec(['config', 'user.name', 'Lazy Fetch Test'], { cwd: path })
}

/**
 * A registry repo whose origin holds a commit with space `lazy-pinned` that
 * the registry itself has never fetched, plus a mutable @dev space `lazy-dev`
 * in its working tree.
 */
async function createRegistry(): Promise<{ registry: string; aspHome: string; pinned: string }> {
  const root = await createTempDir('asp-lazy-fetch-')
  const origin = join(root, 'origin.git')
  const publisher = join(root, 'publisher')
  const registry = join(root, 'registry')
  const aspHome = join(root, 'asp-home')
  await mkdir(aspHome, { recursive: true })

  await git.gitExec(['init', '-q', '--bare', origin])
  await initRepo(publisher)
  await writeSpace(publisher, 'lazy-pinned')
  await git.add(['.'], { cwd: publisher })
  const pinned = await git.commit('publish lazy-pinned', { cwd: publisher })
  await git.gitExec(['push', '-q', origin, 'main'], { cwd: publisher })

  await initRepo(registry)
  await git.gitExec(['remote', 'add', 'origin', origin], { cwd: registry })
  await writeSpace(registry, 'lazy-dev')
  return { registry, aspHome, pinned }
}

const fetched = (registry: string) => existsSync(join(registry, '.git', 'FETCH_HEAD'))

describe('materializeFromRefs registry fetch (T-11840)', () => {
  test('a compile of mutable spaces only never fetches the registry', async () => {
    const { registry, aspHome } = await createRegistry()

    const result = await materializeFromRefs({
      targetName: 'dev-only',
      refs: ['space:lazy-dev@dev'],
      registryPath: registry,
      aspHome,
      lockPath: join(aspHome, 'asp-lock.json'),
    })

    expect<string | undefined>(result.lock.spaces['lazy-dev@dev']?.commit).toBe('dev')
    expect(fetched(registry)).toBe(false)
  })

  test('a registry pin missing locally is fetched on first use and resolves', async () => {
    const { registry, aspHome, pinned } = await createRegistry()
    const refs = ['space:lazy-dev@dev', `space:lazy-pinned@git:${pinned}`] as const

    // Control: the pin is genuinely absent from the registry without a fetch.
    await expect(
      materializeFromRefs({
        targetName: 'pinned-no-fetch',
        refs: [...refs],
        registryPath: registry,
        aspHome,
        lockPath: join(aspHome, 'no-fetch-lock.json'),
        fetchRegistry: false,
      })
    ).rejects.toThrow()
    expect(fetched(registry)).toBe(false)

    const result = await materializeFromRefs({
      targetName: 'pinned',
      refs: [...refs],
      registryPath: registry,
      aspHome,
      lockPath: join(aspHome, 'asp-lock.json'),
    })

    expect(fetched(registry)).toBe(true)
    expect(result.lock.spaces[`lazy-pinned@${pinned.slice(0, 12)}`]?.commit).toBe(
      asCommitSha(pinned)
    )
    expect(result.snapshotsCreated).toBe(1)
  })

  test('registry spaces read from a separate immutable root never fetch the shared root', async () => {
    const { registry, aspHome, pinned } = await createRegistry()
    // The live shape: the shared root is the agents checkout, registry pins
    // read a node-local immutable mirror that already holds the commit.
    const mirror = join(await createTempDir('asp-lazy-fetch-mirror-'), 'mirror')
    await initRepo(mirror)
    await git.gitExec(['fetch', '-q', join(registry, '..', 'origin.git'), 'main'], {
      cwd: mirror,
    })

    const result = await materializeFromRefs({
      targetName: 'mirror',
      refs: ['space:lazy-dev@dev', `space:lazy-pinned@git:${pinned}`],
      registryPath: registry,
      immutableRegistryPath: mirror,
      aspHome,
      lockPath: join(aspHome, 'asp-lock.json'),
    })

    expect(result.lock.spaces[`lazy-pinned@${pinned.slice(0, 12)}`]?.commit).toBe(
      asCommitSha(pinned)
    )
    expect(fetched(registry)).toBe(false)
  })
})
