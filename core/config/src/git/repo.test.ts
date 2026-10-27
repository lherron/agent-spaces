import { getCurrentBranch, getRepoRoot, getStatus, isRepoRoot } from './repo.js'
/**
 * Tests for git repo module.
 *
 * WHY: These tests verify repository operations work correctly
 * against real git repositories.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getHead, initRepo, isGitRepo } from './repo.js'

// Go up from core/config/src/git to project root
const projectRoot = resolve(import.meta.dir, '../../../..')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('isGitRepo', () => {
  it.each([
    { row: 'plain temp directory', init: false, expected: false },
    { row: 'temp directory after git init', init: true, expected: true },
  ])('isGitRepo is true only inside a git work tree: $row', async ({ init, expected }) => {
    const dir = await mkdtemp(join(tmpdir(), 'asp-is-git-repo-'))
    roots.push(dir)
    if (init) await initRepo(dir, { initialBranch: 'main' })

    expect(await isGitRepo(dir)).toBe(expected)
  })
})

describe('getHead', () => {
  it('should return a commit SHA', async () => {
    const head = await getHead({ cwd: projectRoot })
    expect(head).toMatch(/^[a-f0-9]{40}$/)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for git repo module.
   *
   * WHY: These tests verify repository operations work correctly
   * using the current project as a real git repository.
   */

  // Go up from core/config/src/git to project root
  const projectRoot = resolve(import.meta.dir, '../../../..')

  describe('isRepoRoot', () => {
    it('should return true for project root', async () => {
      const result = await isRepoRoot(projectRoot)
      expect(result).toBe(true)
    })

    it('should return false for subdirectory', async () => {
      const result = await isRepoRoot(resolve(projectRoot, 'apps'))
      expect(result).toBe(false)
    })
  })

  describe('getRepoRoot', () => {
    it('should return project root from subdirectory', async () => {
      const root = await getRepoRoot(resolve(projectRoot, 'apps/cli'))
      expect(root).toBe(projectRoot)
    })
  })

  describe('getCurrentBranch', () => {
    it('should return a branch name or null', async () => {
      const branch = await getCurrentBranch({ cwd: projectRoot })
      // Either a branch name or null (detached HEAD)
      expect(branch === null || typeof branch === 'string').toBe(true)
    })
  })

  describe('getStatus', () => {
    it('should return status object', async () => {
      const status = await getStatus({ cwd: projectRoot })
      expect(typeof status.clean).toBe('boolean')
      expect(typeof status.ahead).toBe('number')
      expect(typeof status.behind).toBe('number')
      expect(Array.isArray(status.modified)).toBe(true)
      expect(Array.isArray(status.untracked)).toBe(true)
      expect(Array.isArray(status.staged)).toBe(true)
    })
  })
})
