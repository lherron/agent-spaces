/**
 * Tests for HarnessRegistry
 *
 * WHY: The HarnessRegistry is the central component for managing harness adapters.
 * These tests verify correct registration, lookup, detection, and lifecycle operations
 * that the engine and CLI depend on for multi-harness support.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { HarnessAdapter, HarnessDetection, HarnessId, ProjectManifest } from 'spaces-config'
import { HarnessRegistry } from './registry.js'

/**
 * Create a mock adapter for testing
 */
function createMockAdapter(
  id: HarnessId,
  name: string,
  detection: HarnessDetection
): HarnessAdapter {
  return {
    id,
    name,
    detect: async () => detection,
    validateSpace: () => ({ valid: true, errors: [], warnings: [] }),
    materializeSpace: async () => ({ artifactPath: '/test', files: [], warnings: [] }),
    composeTarget: async () => ({
      bundle: { harnessId: id, targetName: 'test', rootDir: '/test' },
      warnings: [],
    }),
    buildRunArgs: () => [],
    getTargetOutputPath: (dir, target) => `${dir}/${target}/${id}`,
    loadTargetBundle: async () => ({ harnessId: id, targetName: 'test', rootDir: '/test' }),
    getRunEnv: () => ({}),
    getDefaultRunOptions: (_manifest: ProjectManifest, _targetName: string) => ({}),
  }
}

describe('HarnessRegistry', () => {
  let registry: HarnessRegistry

  beforeEach(() => {
    registry = new HarnessRegistry()
  })

  afterEach(() => {
    registry.clear()
  })

  describe('register', () => {
    test('registers a new adapter successfully', () => {
      const adapter = createMockAdapter('claude', 'Claude Code', { available: true })

      registry.register(adapter)

      expect(registry.has('claude')).toBe(true)
      expect(registry.get('claude')).toBe(adapter)
    })

    test('throws when registering duplicate adapter ID', () => {
      const adapter1 = createMockAdapter('claude', 'Claude Code', { available: true })
      const adapter2 = createMockAdapter('claude', 'Claude Code 2', { available: true })

      registry.register(adapter1)

      expect(() => registry.register(adapter2)).toThrow(
        'Harness adapter already registered: claude'
      )
    })

    test('allows registering multiple different adapters', () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', { available: true })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      expect(registry.has('claude')).toBe(true)
      expect(registry.has('pi')).toBe(true)
      expect(registry.getAll()).toHaveLength(2)
    })
  })

  describe('get', () => {
    test('returns registered adapter', () => {
      const adapter = createMockAdapter('claude', 'Claude Code', { available: true })
      registry.register(adapter)

      expect(registry.get('claude')).toBe(adapter)
    })

    test('returns undefined for unregistered adapter', () => {
      expect(registry.get('claude')).toBeUndefined()
    })
  })

  describe('getOrThrow', () => {
    test('returns registered adapter', () => {
      const adapter = createMockAdapter('claude', 'Claude Code', { available: true })
      registry.register(adapter)

      expect(registry.getOrThrow('claude')).toBe(adapter)
    })

    test('throws for unregistered adapter', () => {
      expect(() => registry.getOrThrow('claude')).toThrow('Harness adapter not found: claude')
    })

    test('throws for pi when not registered', () => {
      expect(() => registry.getOrThrow('pi')).toThrow('Harness adapter not found: pi')
    })
  })

  describe('has', () => {
    test('returns true for registered adapter', () => {
      const adapter = createMockAdapter('claude', 'Claude Code', { available: true })
      registry.register(adapter)

      expect(registry.has('claude')).toBe(true)
    })

    test('returns false for unregistered adapter', () => {
      expect(registry.has('claude')).toBe(false)
      expect(registry.has('pi')).toBe(false)
    })
  })

  describe('getAll', () => {
    test('returns empty array when no adapters registered', () => {
      expect(registry.getAll()).toEqual([])
    })

    test('returns all registered adapters', () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', { available: true })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      const all = registry.getAll()
      expect(all).toHaveLength(2)
      expect(all).toContain(claudeAdapter)
      expect(all).toContain(piAdapter)
    })
  })

  describe('getIds', () => {
    test('returns empty array when no adapters registered', () => {
      expect(registry.getIds()).toEqual([])
    })

    test('returns all registered harness IDs', () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', { available: true })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      const ids = registry.getIds()
      expect(ids).toHaveLength(2)
      expect(ids).toContain('claude')
      expect(ids).toContain('pi')
    })
  })

  describe('detectAvailable', () => {
    test('returns detection results for all registered adapters', async () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', {
        available: true,
        version: '1.0.0',
        path: '/usr/local/bin/claude',
      })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', {
        available: false,
        error: 'Pi not found',
      })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      const results = await registry.detectAvailable()

      expect(results.size).toBe(2)
      expect(results.get('claude')?.available).toBe(true)
      expect(results.get('claude')?.version).toBe('1.0.0')
      expect(results.get('pi')?.available).toBe(false)
      expect(results.get('pi')?.error).toBe('Pi not found')
    })

    test('returns empty map when no adapters registered', async () => {
      const results = await registry.detectAvailable()
      expect(results.size).toBe(0)
    })

    test('handles detection errors gracefully', async () => {
      const errorAdapter: HarnessAdapter = {
        id: 'claude',
        name: 'Claude Code',
        detect: async () => {
          throw new Error('Detection failed')
        },
        validateSpace: () => ({ valid: true, errors: [], warnings: [] }),
        materializeSpace: async () => ({ artifactPath: '/test', files: [], warnings: [] }),
        composeTarget: async () => ({
          bundle: { harnessId: 'claude', targetName: 'test', rootDir: '/test' },
          warnings: [],
        }),
        buildRunArgs: () => [],
        getTargetOutputPath: (dir, target) => `${dir}/${target}/claude`,
        loadTargetBundle: async () => ({
          harnessId: 'claude',
          targetName: 'test',
          rootDir: '/test',
        }),
        getRunEnv: () => ({}),
        getDefaultRunOptions: (_manifest: ProjectManifest, _targetName: string) => ({}),
      }

      registry.register(errorAdapter)

      const results = await registry.detectAvailable()

      expect(results.size).toBe(1)
      expect(results.get('claude')?.available).toBe(false)
      expect(results.get('claude')?.error).toBe('Detection failed')
    })

    test('handles non-Error throws in detection', async () => {
      const errorAdapter: HarnessAdapter = {
        id: 'claude',
        name: 'Claude Code',
        detect: async () => {
          throw 'string error'
        },
        validateSpace: () => ({ valid: true, errors: [], warnings: [] }),
        materializeSpace: async () => ({ artifactPath: '/test', files: [], warnings: [] }),
        composeTarget: async () => ({
          bundle: { harnessId: 'claude', targetName: 'test', rootDir: '/test' },
          warnings: [],
        }),
        buildRunArgs: () => [],
        getTargetOutputPath: (dir, target) => `${dir}/${target}/claude`,
        loadTargetBundle: async () => ({
          harnessId: 'claude',
          targetName: 'test',
          rootDir: '/test',
        }),
        getRunEnv: () => ({}),
        getDefaultRunOptions: (_manifest: ProjectManifest, _targetName: string) => ({}),
      }

      registry.register(errorAdapter)

      const results = await registry.detectAvailable()

      expect(results.get('claude')?.available).toBe(false)
      expect(results.get('claude')?.error).toBe('string error')
    })

    test('runs detections concurrently', async () => {
      const detectionOrder: HarnessId[] = []

      const slowClaudeAdapter: HarnessAdapter = {
        id: 'claude',
        name: 'Claude Code',
        detect: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          detectionOrder.push('claude')
          return { available: true }
        },
        validateSpace: () => ({ valid: true, errors: [], warnings: [] }),
        materializeSpace: async () => ({ artifactPath: '/test', files: [], warnings: [] }),
        composeTarget: async () => ({
          bundle: { harnessId: 'claude', targetName: 'test', rootDir: '/test' },
          warnings: [],
        }),
        buildRunArgs: () => [],
        getTargetOutputPath: (dir, target) => `${dir}/${target}/claude`,
        loadTargetBundle: async () => ({
          harnessId: 'claude',
          targetName: 'test',
          rootDir: '/test',
        }),
        getRunEnv: () => ({}),
        getDefaultRunOptions: (_manifest: ProjectManifest, _targetName: string) => ({}),
      }

      const fastPiAdapter: HarnessAdapter = {
        id: 'pi',
        name: 'Pi Agent',
        detect: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          detectionOrder.push('pi')
          return { available: true }
        },
        validateSpace: () => ({ valid: true, errors: [], warnings: [] }),
        materializeSpace: async () => ({ artifactPath: '/test', files: [], warnings: [] }),
        composeTarget: async () => ({
          bundle: { harnessId: 'pi', targetName: 'test', rootDir: '/test' },
          warnings: [],
        }),
        buildRunArgs: () => [],
        getTargetOutputPath: (dir, target) => `${dir}/${target}/pi`,
        loadTargetBundle: async () => ({ harnessId: 'pi', targetName: 'test', rootDir: '/test' }),
        getRunEnv: () => ({}),
        getDefaultRunOptions: (_manifest: ProjectManifest, _targetName: string) => ({}),
      }

      registry.register(slowClaudeAdapter)
      registry.register(fastPiAdapter)

      await registry.detectAvailable()

      // Pi should finish first because it's faster
      expect(detectionOrder).toEqual(['pi', 'claude'])
    })
  })

  describe('getAvailable', () => {
    test('returns only available adapters', async () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', { available: false })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      const available = await registry.getAvailable()

      expect(available).toHaveLength(1)
      expect(available[0]).toBe(claudeAdapter)
    })

    test('returns empty array when no adapters available', async () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: false })

      registry.register(claudeAdapter)

      const available = await registry.getAvailable()
      expect(available).toHaveLength(0)
    })

    test('returns empty array when no adapters registered', async () => {
      const available = await registry.getAvailable()
      expect(available).toHaveLength(0)
    })

    test('returns all adapters when all are available', async () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', { available: true })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      const available = await registry.getAvailable()

      expect(available).toHaveLength(2)
    })
  })

  describe('clear', () => {
    test('removes all registered adapters', () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const piAdapter = createMockAdapter('pi', 'Pi Agent', { available: true })

      registry.register(claudeAdapter)
      registry.register(piAdapter)

      expect(registry.getAll()).toHaveLength(2)

      registry.clear()

      expect(registry.getAll()).toHaveLength(0)
      expect(registry.has('claude')).toBe(false)
      expect(registry.has('pi')).toBe(false)
    })

    test('allows re-registration after clear', () => {
      const adapter1 = createMockAdapter('claude', 'Claude Code', { available: true })
      const adapter2 = createMockAdapter('claude', 'Claude Code v2', { available: true })

      registry.register(adapter1)
      registry.clear()
      registry.register(adapter2)

      expect(registry.get('claude')).toBe(adapter2)
    })
  })
})
