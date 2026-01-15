/**
 * Tests for git repo module.
 *
 * WHY: These tests verify repository operations work correctly
 * using the current project as a real git repository.
 */

import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { getCurrentBranch, getHead, getRepoRoot, getStatus, isGitRepo, isRepoRoot } from './repo.js'

// Go up from packages/config/src/git to project root
const projectRoot = resolve(import.meta.dir, '../../../..')

describe('isGitRepo', () => {
  it('should return true for project root', async () => {
    const result = await isGitRepo(projectRoot)
    expect(result).toBe(true)
  })

  it('should return false for temp directory', async () => {
    const result = await isGitRepo('/tmp')
    expect(result).toBe(false)
  })
})

describe('isRepoRoot', () => {
  it('should return true for project root', async () => {
    const result = await isRepoRoot(projectRoot)
    expect(result).toBe(true)
  })

  it('should return false for subdirectory', async () => {
    const result = await isRepoRoot(resolve(projectRoot, 'packages'))
    expect(result).toBe(false)
  })
})

describe('getRepoRoot', () => {
  it('should return project root from subdirectory', async () => {
    const root = await getRepoRoot(resolve(projectRoot, 'packages/cli'))
    expect(root).toBe(projectRoot)
  })
})

describe('getHead', () => {
  it('should return a commit SHA', async () => {
    const head = await getHead({ cwd: projectRoot })
    expect(head).toMatch(/^[a-f0-9]{40}$/)
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
