/**
 * CLI package tests.
 *
 * WHY: These tests verify the CLI command registration and basic functionality.
 * Integration tests with real git/claude are in a separate package.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot } from './index.js'

describe('findProjectRoot', () => {
  test('returns null when no asp-targets.toml exists', async () => {
    // Create a fresh temp directory that definitely doesn't have asp-targets.toml
    const tempDir = await mkdtemp(join(tmpdir(), 'asp-test-'))
    try {
      const result = await findProjectRoot(tempDir)
      expect(result).toBeNull()
    } finally {
      await rmdir(tempDir)
    }
  })
})
