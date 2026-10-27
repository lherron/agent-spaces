import { afterEach } from 'bun:test'
/**
 * Tests for HarnessRegistry
 *
 * WHY: The HarnessRegistry is the central component for managing harness adapters.
 * These tests verify correct registration, lookup, detection, and lifecycle operations
 * that the engine and CLI depend on for multi-harness support.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
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
    models: [],
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

/**
 * Create a mock adapter whose detect() throws the given value
 */
function createThrowingAdapter(thrown: unknown): HarnessAdapter {
  return {
    ...createMockAdapter('claude', 'Claude Code', { available: true }),
    detect: async () => {
      throw thrown
    },
  }
}

describe('HarnessRegistry', () => {
  let registry: HarnessRegistry

  beforeEach(() => {
    registry = new HarnessRegistry()
  })

  describe('register', () => {
    test('a registered adapter is returned by get, getOrThrow and getAll', () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
      const codexAdapter = createMockAdapter('codex', 'Codex', { available: true })

      registry.register(claudeAdapter)
      registry.register(codexAdapter)

      expect(registry.get('claude')).toBe(claudeAdapter)
      expect(registry.getOrThrow('claude')).toBe(claudeAdapter)
      expect(registry.getOrThrow('codex')).toBe(codexAdapter)
      const all = registry.getAll()
      expect(all).toHaveLength(2)
      expect(all).toContain(claudeAdapter)
      expect(all).toContain(codexAdapter)
    })

    test('throws when registering duplicate adapter ID', () => {
      const adapter1 = createMockAdapter('claude', 'Claude Code', { available: true })
      const adapter2 = createMockAdapter('claude', 'Claude Code 2', { available: true })

      registry.register(adapter1)

      expect(() => registry.register(adapter2)).toThrow(
        'Harness adapter already registered: claude'
      )
    })
  })

  describe('getOrThrow', () => {
    test('throws for unregistered adapter', () => {
      expect(() => registry.getOrThrow('claude')).toThrow('Harness adapter not found: claude')
    })
  })

  describe('detectAvailable', () => {
    test('returns detection results for all registered adapters', async () => {
      const claudeAdapter = createMockAdapter('claude', 'Claude Code', {
        available: true,
        version: '1.0.0',
        path: '/usr/local/bin/claude',
      })
      const codexAdapter = createMockAdapter('codex', 'Codex', {
        available: false,
        error: 'Codex not found',
      })

      registry.register(claudeAdapter)
      registry.register(codexAdapter)

      const results = await registry.detectAvailable()

      expect(results.size).toBe(2)
      expect(results.get('claude')?.available).toBe(true)
      expect(results.get('claude')?.version).toBe('1.0.0')
      expect(results.get('codex')?.available).toBe(false)
      expect(results.get('codex')?.error).toBe('Codex not found')
    })

    test.each([
      { label: 'an Error', thrown: new Error('Detection failed'), error: 'Detection failed' },
      { label: 'a non-Error value', thrown: 'string error', error: 'string error' },
    ])(
      'a throwing detect() reports the harness unavailable with the error text ($label)',
      async ({ thrown, error }) => {
        registry.register(createThrowingAdapter(thrown))

        const results = await registry.detectAvailable()

        expect(results.size).toBe(1)
        expect(results.get('claude')?.available).toBe(false)
        expect(results.get('claude')?.error).toBe(error)
      }
    )

    test.each([
      { label: 'set', aspDebug: '1', debugLogged: true },
      { label: 'unset: nothing is logged', aspDebug: undefined, debugLogged: false },
    ])(
      'logs the full error (preserving cause) under ASP_DEBUG when detection throws (ASP_DEBUG $label)',
      async ({ aspDebug, debugLogged }) => {
        const cause = new Error('underlying boom')
        const thrown = new Error('Detection failed', { cause })
        registry.register(createThrowingAdapter(thrown))

        const previous = process.env['ASP_DEBUG']
        if (aspDebug === undefined) {
          Reflect.deleteProperty(process.env, 'ASP_DEBUG')
        } else {
          process.env['ASP_DEBUG'] = aspDebug
        }
        const originalDebug = console.debug
        const debugCalls: unknown[][] = []
        console.debug = (...args: unknown[]) => {
          debugCalls.push(args)
        }

        try {
          const results = await registry.detectAvailable()
          // Returned detection is still the flat message (behavior preserved).
          expect(results.get('claude')?.available).toBe(false)
          expect(results.get('claude')?.error).toBe('Detection failed')
          if (!debugLogged) {
            expect(debugCalls).toHaveLength(0)
            return
          }
          // The full error object (carrying stack + cause) reaches the debug log.
          expect(debugCalls).toHaveLength(1)
          const logged = debugCalls[0]?.at(-1)
          expect(logged).toBe(thrown)
          expect((logged as Error).cause).toBe(cause)
        } finally {
          console.debug = originalDebug
          if (previous === undefined) {
            Reflect.deleteProperty(process.env, 'ASP_DEBUG')
          } else {
            process.env['ASP_DEBUG'] = previous
          }
        }
      }
    )

    test('runs detections concurrently', async () => {
      const detectionOrder: HarnessId[] = []

      const slowClaudeAdapter: HarnessAdapter = {
        id: 'claude',
        name: 'Claude Code',
        models: [],
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

      const fastCodexAdapter: HarnessAdapter = {
        id: 'codex',
        name: 'Codex',
        models: [],
        detect: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          detectionOrder.push('codex')
          return { available: true }
        },
        validateSpace: () => ({ valid: true, errors: [], warnings: [] }),
        materializeSpace: async () => ({ artifactPath: '/test', files: [], warnings: [] }),
        composeTarget: async () => ({
          bundle: { harnessId: 'codex', targetName: 'test', rootDir: '/test' },
          warnings: [],
        }),
        buildRunArgs: () => [],
        getTargetOutputPath: (dir, target) => `${dir}/${target}/codex`,
        loadTargetBundle: async () => ({
          harnessId: 'codex',
          targetName: 'test',
          rootDir: '/test',
        }),
        getRunEnv: () => ({}),
        getDefaultRunOptions: (_manifest: ProjectManifest, _targetName: string) => ({}),
      }

      registry.register(slowClaudeAdapter)
      registry.register(fastCodexAdapter)

      await registry.detectAvailable()

      // Codex should finish first because it's faster
      expect(detectionOrder).toEqual(['codex', 'claude'])
    })
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for HarnessRegistry
   *
   * WHY: The HarnessRegistry is the central component for managing harness adapters.
   * These tests verify correct registration, lookup, detection, and lifecycle operations
   * that the engine and CLI depend on for multi-harness support.
   */

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
      models: [],
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

    describe('get', () => {
      test('returns undefined for unregistered adapter', () => {
        expect(registry.get('claude')).toBeUndefined()
      })
    })

    describe('has', () => {
      test('returns false for unregistered adapter', () => {
        expect(registry.has('claude')).toBe(false)
        expect(registry.has('codex')).toBe(false)
      })
    })

    describe('getIds', () => {
      test('returns empty array when no adapters registered', () => {
        expect(registry.getIds()).toEqual([])
      })

      test('returns all registered harness IDs', () => {
        const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
        const codexAdapter = createMockAdapter('codex', 'Codex', { available: true })

        registry.register(claudeAdapter)
        registry.register(codexAdapter)

        const ids = registry.getIds()
        expect(ids).toHaveLength(2)
        expect(ids).toContain('claude')
        expect(ids).toContain('codex')
      })
    })

    describe('getAvailable', () => {
      test('returns only available adapters', async () => {
        const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
        const codexAdapter = createMockAdapter('codex', 'Codex', { available: false })

        registry.register(claudeAdapter)
        registry.register(codexAdapter)

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
        const codexAdapter = createMockAdapter('codex', 'Codex', { available: true })

        registry.register(claudeAdapter)
        registry.register(codexAdapter)

        const available = await registry.getAvailable()

        expect(available).toHaveLength(2)
      })
    })

    describe('clear', () => {
      test('removes all registered adapters', () => {
        const claudeAdapter = createMockAdapter('claude', 'Claude Code', { available: true })
        const codexAdapter = createMockAdapter('codex', 'Codex', { available: true })

        registry.register(claudeAdapter)
        registry.register(codexAdapter)

        expect(registry.getAll()).toHaveLength(2)

        registry.clear()

        expect(registry.getAll()).toHaveLength(0)
        expect(registry.has('claude')).toBe(false)
        expect(registry.has('codex')).toBe(false)
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
})
