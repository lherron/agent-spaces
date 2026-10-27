/**
 * Tests for paths module.
 *
 * WHY: Path management is foundational for storage operations.
 * These tests verify path building and resolution.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Sha256Integrity } from '../core/index.js'
import {
  PathResolver,
  getAspHome,
  getProjectAgentScopeId,
  getProjectAgentScopePath,
  getProjectDataPath,
  getProjectHarnessOutputPath,
  getProjectStorageId,
  getProjectTargetsPath,
} from './paths.js'

describe('getAspHome', () => {
  const originalEnv = process.env['ASP_HOME']

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_HOME'] = originalEnv
    } else {
      Reflect.deleteProperty(process.env, 'ASP_HOME')
    }
  })

  it('should return default when ASP_HOME not set', () => {
    Reflect.deleteProperty(process.env, 'ASP_HOME')
    expect(getAspHome()).toBe(join(homedir(), '.asp'))
  })
})

describe('PathResolver', () => {
  it('ASP_HOME keeps its on-disk layout of repo, snapshots, cache, projects and tmp', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    expect(resolver.aspHome).toBe('/custom/home')
    expect(resolver.repo).toBe('/custom/home/repo')
    expect(resolver.snapshots).toBe('/custom/home/snapshots')
    expect(resolver.cache).toBe('/custom/home/cache')
    expect(resolver.projects).toBe('/custom/home/projects')
    expect(resolver.temp).toBe('/custom/home/tmp')
    expect(resolver.globalLock).toBe('/custom/home/global-lock.json')
    // Row: a snapshot path strips the sha256: prefix.
    expect(resolver.snapshot('sha256:def456' as Sha256Integrity)).toBe(
      '/custom/home/snapshots/def456'
    )
    // Row: a plugin cache entry lives under cache/<key>.
    expect(resolver.pluginCache('my-cache')).toBe('/custom/home/cache/my-cache')
    // Row: a space source lives under repo/spaces/<id>.
    expect(resolver.spaceSource('my-space')).toBe('/custom/home/repo/spaces/my-space')
  })

  it('project bundles land in codex-homes/<project>_<target>/bundles/<target>/<harness>', () => {
    const resolver = new PathResolver({ aspHome: '/custom/home' })
    const outputPath = resolver.projectHarnessOutput('/work/Control Plane', 'Code Review', 'codex')
    expect(outputPath).toBe(
      '/custom/home/codex-homes/control-plane_code-review/bundles/Code Review/codex'
    )

    // Row: env ASP_HOME drives the module-level project path functions.
    const originalEnv = process.env['ASP_HOME']
    process.env['ASP_HOME'] = '/test/asp'
    try {
      const projectDataPath = getProjectDataPath('/work/My Project')
      const projectStorageId = getProjectStorageId('/work/My Project', 'Code Review')
      expect(projectStorageId).toBe('my-project_code-review')
      expect(getProjectAgentScopeId('/other/path/My Project', 'Code Review')).toBe(projectStorageId)
      expect(getProjectAgentScopePath('/test/asp', '/work/My Project', 'Code Review')).toBe(
        '/test/asp/codex-homes/my-project_code-review'
      )
      expect(projectDataPath).toBe('/test/asp/codex-homes/my-project')
      expect(getProjectTargetsPath('/work/My Project')).toBe(`${projectDataPath}/bundles`)
      expect(getProjectHarnessOutputPath('/work/My Project', 'dev', 'claude')).toBe(
        '/test/asp/codex-homes/my-project_dev/bundles/dev/claude'
      )
    } finally {
      if (originalEnv !== undefined) {
        process.env['ASP_HOME'] = originalEnv
      } else {
        Reflect.deleteProperty(process.env, 'ASP_HOME')
      }
    }
  })
})
