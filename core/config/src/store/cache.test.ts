/**
 * Tests for cache module.
 *
 * WHY: Plugin cache management is critical for performance.
 * These tests verify cache key computation and operations.
 */

import { describe, expect, it } from 'bun:test'
import type { Sha256Integrity } from '../core/index.js'
import { computePluginCacheKey } from './cache.js'

describe('computePluginCacheKey', () => {
  it('the plugin cache key is stable for the same integrity, name and version and changes with each', () => {
    const integrity = 'sha256:abc' as Sha256Integrity
    const key = computePluginCacheKey(integrity, 'plugin', '1.0.0')

    expect(computePluginCacheKey(integrity, 'plugin', '1.0.0')).toBe(key)
    // Row: different integrity.
    expect(computePluginCacheKey('sha256:bbb' as Sha256Integrity, 'plugin', '1.0.0')).not.toBe(key)
    // Row: different plugin name.
    expect(computePluginCacheKey(integrity, 'plugin-b', '1.0.0')).not.toBe(key)
    // Row: different version.
    expect(computePluginCacheKey(integrity, 'plugin', '1.0.1')).not.toBe(key)
  })
})
