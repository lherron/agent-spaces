/**
 * Tests for integrity module.
 *
 * WHY: Integrity hashing ensures space content verification.
 * These tests verify the hash computation algorithms.
 */

import { describe, expect, it } from 'bun:test'
import type { Sha256Integrity } from '../core/index.js'
import { computeEnvHash } from './integrity.js'

describe('computeEnvHash', () => {
  it('lock envHash is deterministic and changes with plugin name and load order', () => {
    const a = {
      spaceKey: 'space-a@abc123',
      integrity:
        'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Sha256Integrity,
      pluginName: 'space-a',
    }
    const b = {
      spaceKey: 'space-b@def456',
      integrity:
        'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as Sha256Integrity,
      pluginName: 'space-b',
    }

    const hash = computeEnvHash([a, b])

    // Same input -> same hash, in sha256:<64 hex> form.
    expect(computeEnvHash([a, b])).toBe(hash)
    expect(hash.startsWith('sha256:')).toBe(true)
    expect(hash.length).toBe(7 + 64) // "sha256:" + 64 hex chars

    // Row: a differing plugin name changes the hash.
    expect(computeEnvHash([{ ...a, pluginName: 'space-b' }])).not.toBe(computeEnvHash([a]))

    // Row: swapping load order changes the hash.
    expect(computeEnvHash([b, a])).not.toBe(hash)
  })
})
