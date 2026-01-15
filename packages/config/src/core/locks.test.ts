/**
 * Tests for file locking utilities.
 *
 * WHY: Proper file locking prevents data corruption from concurrent access.
 * These tests verify lock acquisition, release, and timeout behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { LockTimeoutError } from './errors.js'
import {
  LOCK_FILES,
  acquireLock,
  getProjectLockPath,
  getStoreLockPath,
  isLocked,
  withLock,
  withProjectLock,
  withStoreLock,
} from './locks.js'

describe('acquireLock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lock-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('acquires and releases lock', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    const handle = await acquireLock(lockPath)
    expect(handle.path).toBe(lockPath)

    // Should be locked
    expect(await isLocked(lockPath)).toBe(true)

    // Release
    await handle.release()

    // Should be unlocked
    expect(await isLocked(lockPath)).toBe(false)
  })

  test('creates lock file if it does not exist', async () => {
    const lockPath = path.join(tmpDir, 'new.lock')

    const handle = await acquireLock(lockPath)
    expect(await fs.promises.access(lockPath).then(() => true)).toBe(true)
    await handle.release()
  })

  test('creates parent directories for lock file', async () => {
    const lockPath = path.join(tmpDir, 'nested', 'deep', 'test.lock')

    const handle = await acquireLock(lockPath)
    expect(await fs.promises.access(lockPath).then(() => true)).toBe(true)
    await handle.release()
  })

  test('can release lock multiple times safely', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    const handle = await acquireLock(lockPath)
    await handle.release()
    // Second release should not throw
    await handle.release()
  })

  test('blocks when lock is held by another', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    // Acquire first lock
    const handle1 = await acquireLock(lockPath)

    // Try to acquire second lock with short timeout
    const startTime = Date.now()
    try {
      await acquireLock(lockPath, { timeout: 500, retries: 5 })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LockTimeoutError)
      expect((err as LockTimeoutError).lockPath).toBe(lockPath)
    }
    const elapsed = Date.now() - startTime

    // Should have waited at least some time
    expect(elapsed).toBeGreaterThan(100)

    await handle1.release()
  })

  test('second acquisition succeeds after release', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    const handle1 = await acquireLock(lockPath)
    await handle1.release()

    // Should succeed now
    const handle2 = await acquireLock(lockPath)
    expect(handle2.path).toBe(lockPath)
    await handle2.release()
  })
})

describe('isLocked', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'islock-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('returns false for non-existent file', async () => {
    const lockPath = path.join(tmpDir, 'nonexistent.lock')
    expect(await isLocked(lockPath)).toBe(false)
  })

  test('returns false for unlocked file', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')
    await fs.promises.writeFile(lockPath, '')
    expect(await isLocked(lockPath)).toBe(false)
  })

  test('returns true for locked file', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    const handle = await acquireLock(lockPath)
    expect(await isLocked(lockPath)).toBe(true)
    await handle.release()
  })
})

describe('withLock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'withlock-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('executes function with lock held', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')
    let lockHeld = false

    await withLock(lockPath, async () => {
      lockHeld = await isLocked(lockPath)
    })

    expect(lockHeld).toBe(true)
    expect(await isLocked(lockPath)).toBe(false)
  })

  test('returns function result', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    const result = await withLock(lockPath, async () => {
      return { value: 42 }
    })

    expect(result).toEqual({ value: 42 })
  })

  test('releases lock on error', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')

    try {
      await withLock(lockPath, async () => {
        throw new Error('test error')
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('test error')
    }

    // Lock should be released
    expect(await isLocked(lockPath)).toBe(false)
  })

  test('serializes concurrent operations', async () => {
    const lockPath = path.join(tmpDir, 'test.lock')
    const order: number[] = []

    // Start two concurrent operations
    const p1 = withLock(lockPath, async () => {
      order.push(1)
      await new Promise((r) => setTimeout(r, 50))
      order.push(2)
    })

    const p2 = withLock(lockPath, async () => {
      order.push(3)
      await new Promise((r) => setTimeout(r, 50))
      order.push(4)
    })

    await Promise.all([p1, p2])

    // Operations should not interleave
    // Either [1,2,3,4] or [3,4,1,2]
    expect(order[0]).toBeLessThan(order[1] ?? 0)
    expect(order[2] ?? 0).toBeLessThan(order[3] ?? 0)
  })
})

describe('path helpers', () => {
  test('getProjectLockPath returns correct path', () => {
    const lockPath = getProjectLockPath('/home/user/project')
    expect(lockPath).toBe(`/home/user/project/${LOCK_FILES.PROJECT}`)
  })

  test('getStoreLockPath returns correct path', () => {
    const lockPath = getStoreLockPath('/home/user/.asp')
    expect(lockPath).toBe(`/home/user/.asp/${LOCK_FILES.STORE}`)
  })
})

describe('withProjectLock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projlock-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('locks project with correct lock file', async () => {
    let lockHeld = false

    await withProjectLock(tmpDir, async () => {
      lockHeld = await isLocked(path.join(tmpDir, LOCK_FILES.PROJECT))
    })

    expect(lockHeld).toBe(true)
  })
})

describe('withStoreLock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storelock-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('locks store with correct lock file', async () => {
    let lockHeld = false

    await withStoreLock(tmpDir, async () => {
      lockHeld = await isLocked(path.join(tmpDir, LOCK_FILES.STORE))
    })

    expect(lockHeld).toBe(true)
  })
})

describe('LOCK_FILES', () => {
  test('has correct file names', () => {
    expect(LOCK_FILES.PROJECT).toBe('.asp.lock')
    expect(LOCK_FILES.STORE).toBe('store.lock')
  })
})
