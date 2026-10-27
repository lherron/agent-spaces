import { listTree, parseMode } from './tree.js'
/**
 * Tests for git tree module.
 *
 * WHY: Tree operations are critical for integrity hashing.
 * These tests verify correct parsing of git ls-tree output.
 */

import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { filterTreeEntries, listTreeRecursive } from './tree.js'

// Go up from core/config/src/git to project root
const projectRoot = resolve(import.meta.dir, '../../../..')

describe('listTreeRecursive', () => {
  it('should list all files recursively', async () => {
    // Use apps/cli/src since it exists in HEAD
    const entries = await listTreeRecursive('HEAD', 'apps/cli/src', { cwd: projectRoot })
    expect(entries.length).toBeGreaterThan(0)
    // All entries should be blobs (files)
    expect(entries.every((e) => e.type === 'blob')).toBe(true)
  })
})

describe('filterTreeEntries', () => {
  it.each([
    { row: 'node_modules directory entry', path: 'node_modules', type: 'tree' as const },
    {
      row: 'file nested under node_modules/',
      path: 'node_modules/foo/bar.js',
      type: 'blob' as const,
    },
  ])('integrity input excludes node_modules: $row', ({ path, type }) => {
    const entries = [
      { mode: type === 'tree' ? '040000' : '100644', type, oid: 'abc', path },
      { mode: '100644', type: 'blob' as const, oid: 'def', path: 'src/index.ts' },
    ]
    expect(filterTreeEntries(entries).map((entry) => entry.path)).toEqual(['src/index.ts'])
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for git tree module.
   *
   * WHY: Tree operations are critical for integrity hashing.
   * These tests verify correct parsing of git ls-tree output.
   */

  // Go up from core/config/src/git to project root
  const projectRoot = resolve(import.meta.dir, '../../../..')

  describe('listTree', () => {
    it('should list entries at HEAD', async () => {
      const entries = await listTree('HEAD', '', { cwd: projectRoot })
      expect(entries.length).toBeGreaterThan(0)
      // Check structure of entries
      const entry = entries[0]
      expect(entry).toBeDefined()
      expect(entry?.mode).toBeDefined()
      expect(entry?.type).toBeDefined()
      expect(entry?.oid).toBeDefined()
      expect(entry?.path).toBeDefined()
    })

    it('should list entries in a subdirectory', async () => {
      const entries = await listTree('HEAD', 'apps', { cwd: projectRoot })
      expect(entries.length).toBeGreaterThan(0)
    })
  })

  describe('parseMode', () => {
    it('should identify regular files', () => {
      const mode = parseMode('100644')
      expect(mode.isRegularFile).toBe(true)
      expect(mode.isExecutable).toBe(false)
      expect(mode.isSymlink).toBe(false)
      expect(mode.isDirectory).toBe(false)
    })

    it('should identify executable files', () => {
      const mode = parseMode('100755')
      expect(mode.isRegularFile).toBe(true)
      expect(mode.isExecutable).toBe(true)
    })

    it('should identify symlinks', () => {
      const mode = parseMode('120000')
      expect(mode.isSymlink).toBe(true)
    })

    it('should identify directories', () => {
      const mode = parseMode('040000')
      expect(mode.isDirectory).toBe(true)
    })
  })
})
