/**
 * Tests for validator module.
 *
 * WHY: Validation catches configuration issues early.
 * These tests verify various error conditions are detected.
 */

import { describe, expect, it } from 'bun:test'
import {
  type LockFile,
  type ProjectManifest,
  type SpaceKey,
  type SpaceManifest,
  type SpaceRefString,
  asCommitSha,
  asSha256Integrity,
  asSpaceId,
  asSpaceKey,
} from 'spaces-core'
import {
  validateClosure,
  validateLockFile,
  validateProjectManifest,
  validateSpaceManifest,
} from './validator.js'

describe('validateSpaceManifest', () => {
  it('should pass for valid manifest', () => {
    const manifest: SpaceManifest = {
      schema: 1,
      id: asSpaceId('my-space'),
      version: '1.0.0',
    }
    const result = validateSpaceManifest(manifest)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should fail for missing id', () => {
    const manifest = {
      schema: 1,
    } as SpaceManifest
    const result = validateSpaceManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'E001')).toBe(true)
  })

  it('should fail for invalid space ref in deps', () => {
    const manifest: SpaceManifest = {
      schema: 1,
      id: asSpaceId('my-space'),
      deps: {
        spaces: ['invalid-ref' as any],
      },
    }
    const result = validateSpaceManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'E002')).toBe(true)
  })
})

describe('validateProjectManifest', () => {
  it('should pass for valid manifest', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      targets: {
        default: {
          compose: ['space:my-space@stable' as SpaceRefString],
        },
      },
    }
    const result = validateProjectManifest(manifest)
    expect(result.valid).toBe(true)
  })

  it('should fail for empty targets', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      targets: {},
    }
    const result = validateProjectManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'E010')).toBe(true)
  })

  it('should fail for empty compose', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      targets: {
        default: {
          compose: [],
        },
      },
    }
    const result = validateProjectManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'E011')).toBe(true)
  })
})

describe('validateClosure', () => {
  it('should pass for valid closure', () => {
    const commit = asCommitSha('abc123abc123abc123abc123abc123abc123abc1')
    const id = asSpaceId('my-space')
    const key = asSpaceKey(id, commit)
    const result = validateClosure({
      spaces: new Map([
        [
          key,
          {
            key,
            id,
            commit,
            path: 'spaces/my-space',
            manifest: { schema: 1, id },
            resolvedFrom: {
              commit,
              selector: { kind: 'dist-tag', tag: 'stable' },
            },
            deps: [],
          },
        ],
      ]),
      loadOrder: [key],
      roots: [key],
    })
    expect(result.valid).toBe(true)
  })

  it('should fail when load order references missing space', () => {
    const result = validateClosure({
      spaces: new Map(),
      loadOrder: ['missing@abc123' as SpaceKey],
      roots: [],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'E021')).toBe(true)
  })
})

describe('validateLockFile', () => {
  it('should pass for valid lock file', () => {
    const commit = asCommitSha('abc123abc123abc123abc123abc123abc123abc1')
    const id = asSpaceId('my-space')
    const key = asSpaceKey(id, commit)
    const integrity = asSha256Integrity(
      'sha256:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1'
    )
    const envHash = asSha256Integrity(
      'sha256:def456def456def456def456def456def456def456def456def456def456def4'
    )
    const lock: LockFile = {
      lockfileVersion: 1,
      resolverVersion: 1,
      generatedAt: new Date().toISOString(),
      registry: { type: 'git', url: 'https://example.com/repo' },
      spaces: {
        [key]: {
          id,
          commit,
          path: 'spaces/my-space',
          integrity,
          plugin: { name: 'my-space' },
          deps: { spaces: [] },
        },
      },
      targets: {
        default: {
          compose: ['space:my-space@stable' as SpaceRefString],
          roots: [key],
          loadOrder: [key],
          envHash,
        },
      },
    }
    const result = validateLockFile(lock)
    expect(result.valid).toBe(true)
  })

  it('should fail for unsupported version', () => {
    const lock = {
      lockfileVersion: 2,
      resolverVersion: 1,
      generatedAt: new Date().toISOString(),
      registry: { type: 'git', url: 'https://example.com/repo' },
      spaces: {},
      targets: {},
    } as unknown as LockFile
    const result = validateLockFile(lock)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'E030')).toBe(true)
  })
})
