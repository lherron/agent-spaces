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

  test('writes content to new file', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    await atomicWrite(filePath, 'hello world')

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('hello world')
  })

  test('writes buffer content', async () => {
    const filePath = path.join(tmpDir, 'test.bin')
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03])
    await atomicWrite(filePath, buffer)

    const content = await fs.promises.readFile(filePath)
    expect(content).toEqual(buffer)
  })

  test('overwrites existing file', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    await fs.promises.writeFile(filePath, 'original')

    await atomicWrite(filePath, 'updated')

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('updated')
  })

  test('creates parent directories', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'test.txt')
    await atomicWrite(filePath, 'nested content')

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('nested content')
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

  test('works without fsync (faster)', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    await atomicWrite(filePath, 'content', { fsync: false })

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('content')
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

  test('writes arrays', async () => {
    const filePath = path.join(tmpDir, 'test.json')
    await atomicWriteJson(filePath, [1, 2, 3])

    const content = await fs.promises.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed).toEqual([1, 2, 3])
  })

  test('handles null values', async () => {
    const filePath = path.join(tmpDir, 'test.json')
    await atomicWriteJson(filePath, null)

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(JSON.parse(content)).toBe(null)
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

  test('creates directory atomically', async () => {
    const targetDir = path.join(tmpDir, 'target')

    await atomicDir(targetDir, async (tempDir) => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'content')
    })

    const files = await fs.promises.readdir(targetDir)
    expect(files).toContain('test.txt')
  })

  test('returns result from createFn', async () => {
    const targetDir = path.join(tmpDir, 'target')

    const result = await atomicDir(targetDir, async () => {
      return { success: true, count: 42 }
    })

    expect(result).toEqual({ success: true, count: 42 })
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

  test('copies file content', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'dest.txt')
    await fs.promises.writeFile(src, 'test content')

    await copyFile(src, dest)

    const content = await fs.promises.readFile(dest, 'utf-8')
    expect(content).toBe('test content')
  })

  test('preserves source mode by default', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'dest.txt')
    await fs.promises.writeFile(src, 'content')
    await fs.promises.chmod(src, 0o755)

    await copyFile(src, dest)

    const stats = await fs.promises.stat(dest)
    expect(stats.mode & 0o777).toBe(0o755)
  })

  test('uses specified mode when provided', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'dest.txt')
    await fs.promises.writeFile(src, 'content')
    await fs.promises.chmod(src, 0o755)

    await copyFile(src, dest, { mode: 0o644 })

    const stats = await fs.promises.stat(dest)
    expect(stats.mode & 0o777).toBe(0o644)
  })

  test('creates parent directories', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'nested', 'deep', 'dest.txt')
    await fs.promises.writeFile(src, 'content')

    await copyFile(src, dest)

    const content = await fs.promises.readFile(dest, 'utf-8')
    expect(content).toBe('content')
  })
})

describe('linkOrCopy', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'link-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('creates hardlink when possible', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'dest.txt')
    await fs.promises.writeFile(src, 'content')

    const result = await linkOrCopy(src, dest)

    expect(result).toBe('hardlink')
    const srcStat = await fs.promises.stat(src)
    const destStat = await fs.promises.stat(dest)
    expect(srcStat.ino).toBe(destStat.ino) // Same inode = hardlink
  })

  test('hardlinked files share content', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'dest.txt')
    await fs.promises.writeFile(src, 'original')

    await linkOrCopy(src, dest)

    // Modifying src should affect dest (same inode)
    // But for our purposes, just verify content is same
    const content = await fs.promises.readFile(dest, 'utf-8')
    expect(content).toBe('original')
  })

  test('creates parent directories', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dest = path.join(tmpDir, 'nested', 'dest.txt')
    await fs.promises.writeFile(src, 'content')

    await linkOrCopy(src, dest)

    const exists = await fs.promises
      .access(dest)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
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

  test('copies directory recursively', async () => {
    const srcDir = path.join(tmpDir, 'src')
    const destDir = path.join(tmpDir, 'dest')

    await fs.promises.mkdir(srcDir)
    await fs.promises.writeFile(path.join(srcDir, 'file1.txt'), 'content1')
    await fs.promises.mkdir(path.join(srcDir, 'subdir'))
    await fs.promises.writeFile(path.join(srcDir, 'subdir', 'file2.txt'), 'content2')

    await copyDir(srcDir, destDir)

    const file1 = await fs.promises.readFile(path.join(destDir, 'file1.txt'), 'utf-8')
    const file2 = await fs.promises.readFile(path.join(destDir, 'subdir', 'file2.txt'), 'utf-8')
    expect(file1).toBe('content1')
    expect(file2).toBe('content2')
  })

  test('copies symbolic links', async () => {
    const srcDir = path.join(tmpDir, 'src')
    const destDir = path.join(tmpDir, 'dest')

    await fs.promises.mkdir(srcDir)
    await fs.promises.writeFile(path.join(srcDir, 'target.txt'), 'target')
    await fs.promises.symlink('target.txt', path.join(srcDir, 'link'))

    await copyDir(srcDir, destDir)

    const linkTarget = await fs.promises.readlink(path.join(destDir, 'link'))
    expect(linkTarget).toBe('target.txt')
  })

  test('uses hardlinks when option is set', async () => {
    const srcDir = path.join(tmpDir, 'src')
    const destDir = path.join(tmpDir, 'dest')

    await fs.promises.mkdir(srcDir)
    await fs.promises.writeFile(path.join(srcDir, 'file.txt'), 'content')

    await copyDir(srcDir, destDir, { useHardlinks: true })

    const srcStat = await fs.promises.stat(path.join(srcDir, 'file.txt'))
    const destStat = await fs.promises.stat(path.join(destDir, 'file.txt'))
    expect(srcStat.ino).toBe(destStat.ino)
  })

  test('handles empty directories', async () => {
    const srcDir = path.join(tmpDir, 'src')
    const destDir = path.join(tmpDir, 'dest')

    await fs.promises.mkdir(srcDir)
    await fs.promises.mkdir(path.join(srcDir, 'empty'))

    await copyDir(srcDir, destDir)

    const stats = await fs.promises.stat(path.join(destDir, 'empty'))
    expect(stats.isDirectory()).toBe(true)
  })
})
