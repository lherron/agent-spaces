/**
 * Tests for paths module.
 *
 * WHY: Path management is foundational for storage operations.
 * These tests verify path building and resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Sha256Integrity } from '../core/index.js'
import {
  PathResolver,
  getAspHome,
  getCachePath,
  getPluginCachePath,
  getProjectDataPath,
  getProjectHarnessOutputPath,
  getProjectTargetsPath,
  getProjectsPath,
  getRepoPath,
  getSnapshotPath,
  getSnapshotsPath,
  getStorePath,
  getTempPath,
} from './paths.js'

describe('getAspHome', () => {
  const originalEnv = process.env['ASP_HOME']

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_HOME'] = originalEnv
    } else {
      process.env['ASP_HOME'] = undefined
    }
  })

  it('should return default when ASP_HOME not set', () => {
    process.env['ASP_HOME'] = undefined
    expect(getAspHome()).toBe(join(homedir(), '.asp'))
  })

  it('should return env var when ASP_HOME is set', () => {
    process.env['ASP_HOME'] = '/custom/path'
    expect(getAspHome()).toBe('/custom/path')
  })
})

describe('path functions', () => {
  const originalEnv = process.env['ASP_HOME']

  beforeEach(() => {
    process.env['ASP_HOME'] = '/test/asp'
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_HOME'] = originalEnv
    } else {
      process.env['ASP_HOME'] = undefined
    }
  })

  it('should build repo path', () => {
    expect(getRepoPath()).toBe('/test/asp/repo')
  })

  it('should build snapshots path', () => {
    expect(getSnapshotsPath()).toBe('/test/asp/snapshots')
  })

  it('should build store path (deprecated)', () => {
    // Deprecated: getStorePath now returns snapshots path
    expect(getStorePath()).toBe('/test/asp/snapshots')
  })

  it('should build cache path', () => {
    expect(getCachePath()).toBe('/test/asp/cache')
  })

  it('should build projects path', () => {
    expect(getProjectsPath()).toBe('/test/asp/projects')
  })

  it('should build temp path', () => {
    expect(getTempPath()).toBe('/test/asp/tmp')
  })

  it('should build snapshot path', () => {
    const integrity = 'sha256:abc123' as Sha256Integrity
    expect(getSnapshotPath(integrity)).toBe('/test/asp/snapshots/abc123')
  })

  it('should build plugin cache path', () => {
    expect(getPluginCachePath('cache-key-123')).toBe('/test/asp/cache/cache-key-123')
  })

  it('should build project-scoped bundle paths', () => {
    const projectDataPath = getProjectDataPath('/work/My Project')
    expect(projectDataPath).toMatch(/^\/test\/asp\/projects\/my-project-[0-9a-f]{8}$/)
    expect(getProjectTargetsPath('/work/My Project')).toBe(`${projectDataPath}/targets`)
    expect(getProjectHarnessOutputPath('/work/My Project', 'dev', 'claude')).toBe(
      `${projectDataPath}/targets/dev/claude`
    )
  })
})

describe('PathResolver', () => {
  it('should use custom aspHome', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    expect(resolver.aspHome).toBe('/custom/home')
    expect(resolver.repo).toBe('/custom/home/repo')
    expect(resolver.snapshots).toBe('/custom/home/snapshots')
    expect(resolver.store).toBe('/custom/home/snapshots') // deprecated alias
    expect(resolver.cache).toBe('/custom/home/cache')
    expect(resolver.temp).toBe('/custom/home/tmp')
  })

  it('should build snapshot path', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    const integrity = 'sha256:def456' as Sha256Integrity
    expect(resolver.snapshot(integrity)).toBe('/custom/home/snapshots/def456')
  })

  it('should build plugin cache path', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    expect(resolver.pluginCache('my-cache')).toBe('/custom/home/cache/my-cache')
  })

  it('should build project harness output path', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    const outputPath = resolver.projectHarnessOutput('/work/Control Plane', 'Code Review', 'codex')
    expect(outputPath).toMatch(
      /^\/custom\/home\/projects\/control-plane-[0-9a-f]{8}\/targets\/Code Review\/codex$/
    )
  })

  it('should build space source path', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    expect(resolver.spaceSource('my-space')).toBe('/custom/home/repo/spaces/my-space')
  })
})
