/**
 * Core package test runner.
 *
 * WHY: This file ensures all core package tests are discovered.
 * Individual test files are in their respective module directories.
 *
 * Test files:
 * - types/refs.test.ts - Space reference validation
 * - errors.test.ts - Error classes and type guards
 */

import { describe, expect, test } from 'bun:test'

// Import to ensure these tests are discovered
import './errors.test.js'
import './types/refs.test.js'

describe('core package', () => {
  test('exports are available', async () => {
    // Verify main exports work
    const { isSpaceId, isCommitSha, AspError } = await import('./index.js')
    expect(typeof isSpaceId).toBe('function')
    expect(typeof isCommitSha).toBe('function')
    expect(typeof AspError).toBe('function')
  })
})
