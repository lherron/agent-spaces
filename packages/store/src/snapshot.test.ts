/**
 * Tests for snapshot storage.
 *
 * WHY: Snapshots are critical for reproducible builds. These tests verify
 * that snapshot creation, verification, and cleanup work correctly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asCommitSha, asSha256Integrity, asSpaceId } from 'spaces-core'
import { PathResolver } from './paths.js'
import {
  type SnapshotMetadata,
  deleteSnapshot,
  getSnapshotMetadata,
  getSnapshotSize,
  listSnapshots,
  snapshotExists,
  verifySnapshot,
} from './snapshot.js'

describe('snapshot storage', () => {
  let tmpDir: string
  let paths: PathResolver

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `snapshot-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    paths = new PathResolver({ aspHome: tmpDir })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('snapshotExists', () => {
    test('returns false when snapshot does not exist', async () => {
      const integrity = asSha256Integrity(
        'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      )
      const exists = await snapshotExists(integrity, { paths, cwd: tmpDir })
      expect(exists).toBe(false)
    })

    test('returns true when snapshot exists', async () => {
      // Create a snapshot directory
      const hash = '1111111111111111111111111111111111111111111111111111111111111111'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })

      const exists = await snapshotExists(integrity, { paths, cwd: tmpDir })
      expect(exists).toBe(true)
    })

    test('returns false when path is a file not a directory', async () => {
      const hash = '2222222222222222222222222222222222222222222222222222222222222222'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      await mkdir(join(tmpDir, 'snapshots'), { recursive: true })
      await writeFile(join(tmpDir, 'snapshots', hash), 'not a directory')

      const exists = await snapshotExists(integrity, { paths, cwd: tmpDir })
      expect(exists).toBe(false)
    })
  })

  describe('getSnapshotMetadata', () => {
    test('returns null when snapshot does not exist', async () => {
      const integrity = asSha256Integrity(
        'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      )
      const metadata = await getSnapshotMetadata(integrity, { paths, cwd: tmpDir })
      expect(metadata).toBe(null)
    })

    test('returns null when metadata file is missing', async () => {
      const hash = '3333333333333333333333333333333333333333333333333333333333333333'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })

      const metadata = await getSnapshotMetadata(integrity, { paths, cwd: tmpDir })
      expect(metadata).toBe(null)
    })

    test('returns metadata when present', async () => {
      const hash = '4444444444444444444444444444444444444444444444444444444444444444'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })

      const expectedMetadata: SnapshotMetadata = {
        spaceId: asSpaceId('test-space'),
        commit: asCommitSha('abc1234567890123456789012345678901234567'),
        integrity,
        createdAt: '2024-01-01T00:00:00.000Z',
        sourcePath: 'spaces/test-space',
      }
      await writeFile(join(snapshotPath, '.asp-snapshot.json'), JSON.stringify(expectedMetadata))

      const metadata = await getSnapshotMetadata(integrity, { paths, cwd: tmpDir })
      expect(metadata).toEqual(expectedMetadata)
    })

    test('returns null when metadata is invalid JSON', async () => {
      const hash = '5555555555555555555555555555555555555555555555555555555555555555'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })
      await writeFile(join(snapshotPath, '.asp-snapshot.json'), 'invalid json {')

      const metadata = await getSnapshotMetadata(integrity, { paths, cwd: tmpDir })
      expect(metadata).toBe(null)
    })
  })

  describe('deleteSnapshot', () => {
    test('deletes existing snapshot', async () => {
      const hash = '6666666666666666666666666666666666666666666666666666666666666666'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })
      await writeFile(join(snapshotPath, 'file.txt'), 'content')

      await deleteSnapshot(integrity, { paths, cwd: tmpDir })

      const exists = await snapshotExists(integrity, { paths, cwd: tmpDir })
      expect(exists).toBe(false)
    })

    test('succeeds silently when snapshot does not exist', async () => {
      const integrity = asSha256Integrity(
        'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      )
      // Should not throw
      await deleteSnapshot(integrity, { paths, cwd: tmpDir })
    })
  })

  describe('listSnapshots', () => {
    test('returns empty array when store is empty', async () => {
      const snapshots = await listSnapshots({ paths, cwd: tmpDir })
      expect(snapshots).toEqual([])
    })

    test('returns empty array when store does not exist', async () => {
      const nonExistentPaths = new PathResolver({ aspHome: join(tmpDir, 'nonexistent') })
      const snapshots = await listSnapshots({ paths: nonExistentPaths, cwd: tmpDir })
      expect(snapshots).toEqual([])
    })

    test('lists snapshot hashes', async () => {
      const hash1 = '7777777777777777777777777777777777777777777777777777777777777777'
      const hash2 = '8888888888888888888888888888888888888888888888888888888888888888'
      await mkdir(join(tmpDir, 'snapshots', hash1), { recursive: true })
      await mkdir(join(tmpDir, 'snapshots', hash2), { recursive: true })

      const snapshots = await listSnapshots({ paths, cwd: tmpDir })
      expect(snapshots.sort()).toEqual(
        [asSha256Integrity(`sha256:${hash1}`), asSha256Integrity(`sha256:${hash2}`)].sort()
      )
    })

    test('ignores non-hash directories', async () => {
      const hash = '9999999999999999999999999999999999999999999999999999999999999999'
      await mkdir(join(tmpDir, 'snapshots', hash), { recursive: true })
      await mkdir(join(tmpDir, 'snapshots', 'not-a-hash'), { recursive: true })
      await writeFile(join(tmpDir, 'snapshots', 'file.txt'), 'content')

      const snapshots = await listSnapshots({ paths, cwd: tmpDir })
      expect(snapshots).toEqual([asSha256Integrity(`sha256:${hash}`)])
    })
  })

  describe('getSnapshotSize', () => {
    test('returns size of snapshot contents', async () => {
      const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })

      // Write files with known sizes
      await writeFile(join(snapshotPath, 'file1.txt'), 'hello') // 5 bytes
      await writeFile(join(snapshotPath, 'file2.txt'), 'world!') // 6 bytes

      const size = await getSnapshotSize(integrity, { paths, cwd: tmpDir })
      expect(size).toBe(11)
    })

    test('includes nested directory sizes', async () => {
      const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      const integrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(join(snapshotPath, 'nested'), { recursive: true })

      await writeFile(join(snapshotPath, 'root.txt'), 'root') // 4 bytes
      await writeFile(join(snapshotPath, 'nested', 'child.txt'), 'child') // 5 bytes

      const size = await getSnapshotSize(integrity, { paths, cwd: tmpDir })
      expect(size).toBe(9)
    })
  })

  describe('verifySnapshot', () => {
    test('returns false for non-existent snapshot', async () => {
      const integrity = asSha256Integrity(
        'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      )
      const valid = await verifySnapshot(integrity, { paths, cwd: tmpDir })
      expect(valid).toBe(false)
    })

    test('returns false for corrupted snapshot', async () => {
      // Create a snapshot with one integrity but different content
      const hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      const wrongIntegrity = asSha256Integrity(`sha256:${hash}`)
      const snapshotPath = join(tmpDir, 'snapshots', hash)
      await mkdir(snapshotPath, { recursive: true })
      await writeFile(join(snapshotPath, 'file.txt'), 'content that does not match hash')

      const valid = await verifySnapshot(wrongIntegrity, { paths, cwd: tmpDir })
      expect(valid).toBe(false)
    })

    test('returns true for valid snapshot with matching integrity', async () => {
      // Create a simple snapshot and compute its actual integrity
      const snapshotPath = join(tmpDir, 'temp-snapshot')
      await mkdir(snapshotPath, { recursive: true })
      await writeFile(join(snapshotPath, 'hello.txt'), 'hello')

      // Read and compute hash manually using git-style blob OIDs
      // Algorithm: sha256("v1\0" + for each file sorted: "path\0blob\0gitBlobOid\0mode\n")
      // Git blob OID: SHA-1("blob <size>\0<content>")
      const { createHash } = await import('node:crypto')
      const { stat } = await import('node:fs/promises')

      const content = await readFile(join(snapshotPath, 'hello.txt'))
      // Compute git-style blob OID: SHA-1("blob <size>\0<content>")
      const blobHeader = `blob ${content.length}\0`
      const blobOid = createHash('sha1').update(blobHeader).update(content).digest('hex')
      const stats = await stat(join(snapshotPath, 'hello.txt'))
      const mode = stats.mode & 0o111 ? '100755' : '100644'

      const finalHash = createHash('sha256')
      finalHash.update('v1\0')
      finalHash.update(`hello.txt\0blob\0${blobOid}\0${mode}\n`)
      const computedIntegrity = asSha256Integrity(`sha256:${finalHash.digest('hex')}`)

      // Move snapshot to correct location
      const finalPath = paths.snapshot(computedIntegrity)
      await mkdir(join(tmpDir, 'snapshots'), { recursive: true })
      const { rename } = await import('node:fs/promises')
      await rename(snapshotPath, finalPath)

      const valid = await verifySnapshot(computedIntegrity, { paths, cwd: tmpDir })
      expect(valid).toBe(true)
    })
  })
})
