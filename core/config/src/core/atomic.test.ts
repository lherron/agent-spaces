/**
 * Tests for atomic file write utilities.
 *
 * WHY: Atomic writes are critical for data integrity. These tests verify
 * that writes are crash-safe and properly handle errors.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicDir, atomicWrite, atomicWriteJson, copyDir, copyFile, linkOrCopy } from './atomic.js'

describe('atomicWrite', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('atomicWrite writes the content to the target path, creating missing parent directories and replacing an existing file', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'test.txt')
    await atomicWrite(filePath, 'hello world')
    expect(await fs.promises.readFile(filePath, 'utf-8')).toBe('hello world')

    await atomicWrite(filePath, 'updated')
    expect(await fs.promises.readFile(filePath, 'utf-8')).toBe('updated')
  })

  test('sets file mode', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    await atomicWrite(filePath, 'content', { mode: 0o600 })

    const stats = await fs.promises.stat(filePath)
    // Check only permission bits (mask off file type)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test('no temp files left after successful write', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    await atomicWrite(filePath, 'content')

    const files = await fs.promises.readdir(tmpDir)
    expect(files).toEqual(['test.txt'])
  })

  test('cleans up temp file on write error', async () => {
    // Create a directory where the file should be - this will cause rename to fail
    const filePath = path.join(tmpDir, 'test-dir')
    await fs.promises.mkdir(filePath)
    await fs.promises.writeFile(path.join(filePath, 'blocker'), 'x')

    try {
      await atomicWrite(filePath, 'content')
      expect.unreachable('should have thrown')
    } catch {
      // Expected to fail
    }

    // Check no temp files are left
    const files = await fs.promises.readdir(tmpDir)
    expect(files.filter((f) => f.startsWith('.'))).toEqual([])
  })
})

describe('atomicWriteJson', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-json-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('writes JSON with pretty printing', async () => {
    const filePath = path.join(tmpDir, 'test.json')
    await atomicWriteJson(filePath, { name: 'test', value: 42 })

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('{\n  "name": "test",\n  "value": 42\n}\n')
  })
})

describe('atomicDir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-dir-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('atomicDir moves the populated temp directory into place and resolves to the createFn result', async () => {
    const targetDir = path.join(tmpDir, 'target')

    const result = await atomicDir(targetDir, async (tempDir) => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'content')
      return { success: true, count: 42 }
    })

    expect(result).toEqual({ success: true, count: 42 })
    const files = await fs.promises.readdir(targetDir)
    expect(files).toContain('test.txt')
  })

  test('cleans up on error', async () => {
    const targetDir = path.join(tmpDir, 'target')

    try {
      await atomicDir(targetDir, async () => {
        throw new Error('test error')
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('test error')
    }

    // No temp directories should remain
    const files = await fs.promises.readdir(tmpDir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('overwrites existing directory', async () => {
    const targetDir = path.join(tmpDir, 'target')
    await fs.promises.mkdir(targetDir)
    await fs.promises.writeFile(path.join(targetDir, 'old.txt'), 'old')

    await atomicDir(targetDir, async (tempDir) => {
      await fs.promises.writeFile(path.join(tempDir, 'new.txt'), 'new')
    })

    const files = await fs.promises.readdir(targetDir)
    expect(files).toEqual(['new.txt'])
  })
})

describe('copyFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copy-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('copyFile copies the content, creating missing parent directories', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'nested', 'deep', 'dest.txt')
    await fs.promises.writeFile(src, 'test content')

    await copyFile(src, dest)

    const content = await fs.promises.readFile(dest, 'utf-8')
    expect(content).toBe('test content')
  })

  test.each([
    { name: 'no mode given preserves the 0o755 source mode', options: {}, expected: 0o755 },
    {
      name: 'an explicit 0o644 mode overrides the 0o755 source mode',
      options: { mode: 0o644 },
      expected: 0o644,
    },
  ])(
    'copyFile preserves the source mode unless an explicit mode is given: $name',
    async ({ options, expected }) => {
      const src = path.join(tmpDir, 'src.txt')
      const dest = path.join(tmpDir, 'dest.txt')
      await fs.promises.writeFile(src, 'content')
      await fs.promises.chmod(src, 0o755)

      await copyFile(src, dest, options)

      const stats = await fs.promises.stat(dest)
      expect(stats.mode & 0o777).toBe(expected)
    }
  )
})

describe('linkOrCopy', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'link-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('linkOrCopy hardlinks the source into a newly created parent directory and reports hardlink', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'nested', 'dest.txt')
    await fs.promises.writeFile(src, 'content')

    const result = await linkOrCopy(src, dest)

    expect(result).toBe('hardlink')
    const srcStat = await fs.promises.stat(src)
    const destStat = await fs.promises.stat(dest)
    expect(srcStat.ino).toBe(destStat.ino) // Same inode = hardlink
  })
})

describe('copyDir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copydir-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test.each([
    { name: 'a plain copy gives each file its own inode', useHardlinks: false, sharesInode: false },
    {
      name: 'useHardlinks hardlinks each file to its source',
      useHardlinks: true,
      sharesInode: true,
    },
  ])(
    'copyDir reproduces files, subdirectories, empty directories and relative symlinks, hardlinking files when asked: $name',
    async ({ useHardlinks, sharesInode }) => {
      const srcDir = path.join(tmpDir, 'src')
      const destDir = path.join(tmpDir, 'dest')

      await fs.promises.mkdir(srcDir)
      await fs.promises.writeFile(path.join(srcDir, 'file1.txt'), 'content1')
      await fs.promises.mkdir(path.join(srcDir, 'subdir'))
      await fs.promises.writeFile(path.join(srcDir, 'subdir', 'file2.txt'), 'content2')
      await fs.promises.mkdir(path.join(srcDir, 'empty'))
      await fs.promises.symlink('file1.txt', path.join(srcDir, 'link'))

      await copyDir(srcDir, destDir, { useHardlinks })

      expect(await fs.promises.readFile(path.join(destDir, 'file1.txt'), 'utf-8')).toBe('content1')
      expect(await fs.promises.readFile(path.join(destDir, 'subdir', 'file2.txt'), 'utf-8')).toBe(
        'content2'
      )
      expect((await fs.promises.stat(path.join(destDir, 'empty'))).isDirectory()).toBe(true)
      expect((await fs.promises.lstat(path.join(destDir, 'link'))).isSymbolicLink()).toBe(true)
      expect(await fs.promises.readlink(path.join(destDir, 'link'))).toBe('file1.txt')

      const srcStat = await fs.promises.stat(path.join(srcDir, 'subdir', 'file2.txt'))
      const destStat = await fs.promises.stat(path.join(destDir, 'subdir', 'file2.txt'))
      expect(srcStat.ino === destStat.ino).toBe(sharesInode)
    }
  )
})
