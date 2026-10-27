import { LOCK_FILES, getStoreLockPath, withStoreLock } from './locks.js'
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
import { acquireLock, isLocked, withLock, withProjectLock } from './locks.js'

describe('acquireLock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lock-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  test('an acquired lock reports locked until released, then can be acquired again', async () => {
    const lockPath = path.join(tmpDir, 'nested', 'deep', 'test.lock')

    const handle = await acquireLock(lockPath)
    expect(handle.path).toBe(lockPath)
    expect(await fs.promises.access(lockPath).then(() => true)).toBe(true)
    expect(await isLocked(lockPath)).toBe(true)

    await handle.release()
    expect(await isLocked(lockPath)).toBe(false)

    const handle2 = await acquireLock(lockPath)
    expect(await isLocked(lockPath)).toBe(true)
    await handle2.release()
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

    const result = await withLock(lockPath, async () => {
      lockHeld = await isLocked(lockPath)
      return { value: 42 }
    })

    expect(lockHeld).toBe(true)
    expect(result).toEqual({ value: 42 })
    expect(await isLocked(lockPath)).toBe(false)
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

  test('concurrent withLock callers run one at a time without interleaving', async () => {
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

    // Operations must not interleave: one caller finishes before the other starts.
    expect([
      [1, 2, 3, 4],
      [3, 4, 1, 2],
    ]).toContainEqual(order)
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

  test('withProjectLock holds <projectRoot>/.asp.lock while the callback runs', async () => {
    let lockHeld = false

    await withProjectLock(tmpDir, async () => {
      lockHeld = await isLocked(path.join(tmpDir, '.asp.lock'))
    })

    expect(lockHeld).toBe(true)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for file locking utilities.
   *
   * WHY: Proper file locking prevents data corruption from concurrent access.
   * These tests verify lock acquisition, release, and timeout behavior.
   */

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
  })

  describe('path helpers', () => {
    test('getStoreLockPath returns correct path', () => {
      const lockPath = getStoreLockPath('/home/user/.asp')
      expect(lockPath).toBe(`/home/user/.asp/${LOCK_FILES.STORE}`)
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

  describe('published lock and serialization behavior', () => {
    test('has correct file names', () => {
      expect(LOCK_FILES.PROJECT).toBe('.asp.lock')
      expect(LOCK_FILES.STORE).toBe('store.lock')
    })
  })
})
