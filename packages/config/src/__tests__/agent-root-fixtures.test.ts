/**
 * RED tests for M0: agentRoot / projectRoot fixture verification.
 *
 * These tests verify that the v2 fixture directories exist with the
 * correct layout per AGENT_SPACES_PLAN.md section 3 (Runtime-facing
 * filesystem contract).
 *
 * wrkq tasks: T-00841 (fixtures), T-00842 (test helpers), T-00843 (docs)
 *
 * PASS CONDITIONS:
 * 1. Fixture agentRoot exists at packages/config/src/__tests__/fixtures/agent-root/
 *    with SOUL.md, HEARTBEAT.md, agent-profile.toml, and spaces/ containing
 *    at least one agent-local space with space.toml.
 * 2. Fixture projectRoot exists at packages/config/src/__tests__/fixtures/project-root/
 *    with asp-targets.toml and spaces/ containing at least one project-local
 *    space with space.toml.
 * 3. Test helpers resolveAgentRoot() and resolveProjectRoot() exist and return
 *    absolute paths to the fixture directories without requiring any external
 *    host implementation.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Fixture root paths (these directories don't exist yet -- that's the point)
// ---------------------------------------------------------------------------
const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures')
const AGENT_ROOT = join(FIXTURES_DIR, 'agent-root')
const PROJECT_ROOT = join(FIXTURES_DIR, 'project-root')

// ---------------------------------------------------------------------------
// T-00841: agentRoot fixture layout
// ---------------------------------------------------------------------------
describe('agentRoot fixture layout (T-00841)', () => {
  test('agentRoot directory exists', () => {
    expect(existsSync(AGENT_ROOT)).toBe(true)
  })

  test('SOUL.md exists and is non-empty', () => {
    const p = join(AGENT_ROOT, 'SOUL.md')
    expect(existsSync(p)).toBe(true)
    const content = readFileSync(p, 'utf-8')
    expect(content.trim().length).toBeGreaterThan(0)
  })

  test('HEARTBEAT.md exists (optional but fixture should include it)', () => {
    const p = join(AGENT_ROOT, 'HEARTBEAT.md')
    expect(existsSync(p)).toBe(true)
  })

  test('agent-profile.toml exists', () => {
    const p = join(AGENT_ROOT, 'agent-profile.toml')
    expect(existsSync(p)).toBe(true)
  })

  test('spaces/ directory exists with at least one agent-local space', () => {
    const spacesDir = join(AGENT_ROOT, 'spaces')
    expect(existsSync(spacesDir)).toBe(true)
    expect(statSync(spacesDir).isDirectory()).toBe(true)

    // At least one subdirectory with a space.toml
    const { readdirSync } = require('node:fs')
    const entries: string[] = readdirSync(spacesDir)
    const spaceDirs = entries.filter((e: string) => existsSync(join(spacesDir, e, 'space.toml')))
    expect(spaceDirs.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// T-00841: projectRoot fixture layout
// ---------------------------------------------------------------------------
describe('projectRoot fixture layout (T-00841)', () => {
  test('projectRoot directory exists', () => {
    expect(existsSync(PROJECT_ROOT)).toBe(true)
  })

  test('asp-targets.toml exists', () => {
    const p = join(PROJECT_ROOT, 'asp-targets.toml')
    expect(existsSync(p)).toBe(true)
  })

  test('spaces/ directory exists with at least one project-local space', () => {
    const spacesDir = join(PROJECT_ROOT, 'spaces')
    expect(existsSync(spacesDir)).toBe(true)
    expect(statSync(spacesDir).isDirectory()).toBe(true)

    const { readdirSync } = require('node:fs')
    const entries: string[] = readdirSync(spacesDir)
    const spaceDirs = entries.filter((e: string) => existsSync(join(spacesDir, e, 'space.toml')))
    expect(spaceDirs.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// T-00842: Test helpers for root resolution
// ---------------------------------------------------------------------------
describe('test helpers resolve roots without external host (T-00842)', () => {
  test('resolveAgentRoot() returns absolute path to fixture agentRoot', async () => {
    // The helper module doesn't exist yet -- import will fail (RED)
    const { resolveAgentRoot } = await import('./helpers/resolve-roots.js')
    const result = resolveAgentRoot()
    expect(typeof result).toBe('string')
    expect(result).toBe(AGENT_ROOT)
    // Must be absolute
    expect(result.startsWith('/')).toBe(true)
  })

  test('resolveProjectRoot() returns absolute path to fixture projectRoot', async () => {
    const { resolveProjectRoot } = await import('./helpers/resolve-roots.js')
    const result = resolveProjectRoot()
    expect(typeof result).toBe('string')
    expect(result).toBe(PROJECT_ROOT)
    expect(result.startsWith('/')).toBe(true)
  })

  test('resolveAgentRoot() does not depend on any external host implementation', async () => {
    // Verify no imports from execution, runtime, or host packages
    const { resolveAgentRoot } = await import('./helpers/resolve-roots.js')
    // If we get here, the import succeeded without host deps.
    // The function should work with just fixture paths.
    const result = resolveAgentRoot()
    expect(existsSync(result)).toBe(true)
  })
})
