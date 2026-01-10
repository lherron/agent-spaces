/**
 * CLI package tests.
 *
 * WHY: These tests verify the CLI command registration and basic functionality.
 * Integration tests with real git/claude are in a separate package.
 */

import { describe, expect, test } from 'bun:test'
import { findProjectRoot } from './index.js'

describe('findProjectRoot', () => {
  test('returns null when no asp-targets.toml exists', async () => {
    // Use a path that definitely doesn't have asp-targets.toml
    const result = await findProjectRoot('/tmp')
    expect(result).toBeNull()
  })
})
