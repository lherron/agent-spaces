/**
 * RED tests: Phase 2 — agent-project bundle kind + agent-default profile spaces (T-00993)
 *
 * WHY: The placement resolver must handle the new `agent-project` RuntimeBundleRef kind,
 * which merges agent-profile.toml defaults with optional project asp-targets.toml overrides.
 * Additionally, `agent-default` must load agent-profile.toml spaces.base + spaces.byMode
 * instead of returning [].
 *
 * PASS CONDITIONS (all tests green when):
 * 1. RuntimeBundleRef union includes { kind: 'agent-project', agentName, projectRoot? }
 * 2. isValidBundleRefKind('agent-project') returns true
 * 3. resolvePlacement handles agent-project bundle with agent profile only (no project targets)
 *    → compose = agent spaces.base + spaces.byMode for the run mode
 * 4. resolvePlacement handles agent-project bundle with project override (replace compose)
 *    → compose = project compose list only
 * 5. resolvePlacement handles agent-project bundle with project override (merge compose)
 *    → compose = agent spaces + project compose, deduplicated
 * 6. agent-default bundle now loads agent-profile.toml spaces.base when available
 *    (currently returns [])
 * 7. agent-default bundle includes byMode spaces for matching run mode
 *
 * wrkq task: T-00993
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: create temp agent root with v2 profile + optional project root
// ─────────────────────────────────────────────────────────────────────────────

function createAgentRoot(tempDir: string, profileToml: string): string {
  const agentRoot = join(tempDir, 'agent-root')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'SOUL.md'), '# Test Agent\nYou are a test agent.\n')
  writeFileSync(join(agentRoot, 'agent-profile.toml'), profileToml)
  return agentRoot
}

function createProjectRoot(tempDir: string, targetsToml: string): string {
  const projectRoot = join(tempDir, 'project-root')
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'asp-targets.toml'), targetsToml)
  return projectRoot
}

// ===================================================================
// T-00993 Phase 2.1: agent-project bundle kind exists in type system
// ===================================================================
describe('agent-project bundle kind registration (T-00993)', () => {
  test('isValidBundleRefKind recognizes agent-project', async () => {
    const { isValidBundleRefKind } = await import('../core/types/placement.js')
    expect(isValidBundleRefKind('agent-project')).toBe(true)
  })

  test('createRuntimePlacement accepts agent-project bundle', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    const placement = createRuntimePlacement({
      agentRoot: '/srv/agents/larry',
      runMode: 'query',
      bundle: {
        kind: 'agent-project',
        agentName: 'larry',
        projectRoot: '/srv/projects/myproject',
      } as any, // 'as any' until the type is extended — RED gate
    })

    expect(placement.bundle.kind).toBe('agent-project')
    expect((placement.bundle as any).agentName).toBe('larry')
  })
})

// ===================================================================
// T-00993 Phase 2.2: placement resolver handles agent-project bundle
// ===================================================================
describe('placement resolver: agent-project bundle (T-00993)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'phase2-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('agent-project with profile only (no project targets) → agent spaces', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:defaults@dev"]

[spaces.byMode.heartbeat]
base = ["space:heartbeat-extra@dev"]

[harnessDefaults]
model = "claude-opus-4-6"
`
    )

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: {
        kind: 'agent-project',
        agentName: 'testagent',
      } as any,
    })

    const spaceRefs = result.spaces.map((s) => s.ref)
    expect(spaceRefs).toContain('space:defaults@dev')
  })

  test('agent-project with project override (replace) → project compose only', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:agent-base@dev"]
`
    )

    const projectRoot = createProjectRoot(
      tempDir,
      `
schema = 1

[targets.testagent]
compose = ["space:project-only@dev"]
`
    )

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: {
        kind: 'agent-project',
        agentName: 'testagent',
        projectRoot,
      } as any,
    })

    const spaceRefs = result.spaces.map((s) => s.ref)
    // Project replaces agent spaces (compose_mode defaults to 'replace')
    expect(spaceRefs).toContain('space:project-only@dev')
    expect(spaceRefs).not.toContain('space:agent-base@dev')
  })

  test('agent-project with project override (merge) → agent + project deduplicated', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:a@dev", "space:b@dev"]
`
    )

    const projectRoot = createProjectRoot(
      tempDir,
      `
schema = 1

[targets.testagent]
compose_mode = "merge"
compose = ["space:b@dev", "space:c@dev"]
`
    )

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: {
        kind: 'agent-project',
        agentName: 'testagent',
        projectRoot,
      } as any,
    })

    const spaceRefs = result.spaces.map((s) => s.ref)
    // Agent [a, b] + project [b, c] → deduplicated [a, b, c]
    expect(spaceRefs).toContain('space:a@dev')
    expect(spaceRefs).toContain('space:b@dev')
    expect(spaceRefs).toContain('space:c@dev')
    // b should not be duplicated
    const bCount = spaceRefs.filter((r) => r === 'space:b@dev').length
    expect(bCount).toBe(1)
  })

  test('agent-project with no project asp-targets.toml → falls back to agent spaces', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:fallback@dev"]
`
    )
    // projectRoot exists but has no asp-targets.toml
    const projectRoot = join(tempDir, 'bare-project')
    mkdirSync(projectRoot, { recursive: true })

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: {
        kind: 'agent-project',
        agentName: 'testagent',
        projectRoot,
      } as any,
    })

    const spaceRefs = result.spaces.map((s) => s.ref)
    expect(spaceRefs).toContain('space:fallback@dev')
  })

  test('agent-project cwd defaults to projectRoot when present', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:defaults@dev"]
`
    )
    const projectRoot = createProjectRoot(tempDir, 'schema = 1\n[targets]\n')

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: {
        kind: 'agent-project',
        agentName: 'testagent',
        projectRoot,
      } as any,
    })

    expect(result.cwd).toBe(projectRoot)
  })
})

// ===================================================================
// T-00993 Phase 2.3: agent-default now loads agent-profile.toml spaces
// ===================================================================
describe('agent-default uses agent profile spaces (T-00993)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'phase2-agentdefault-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('agent-default loads spaces.base from agent-profile.toml', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:defaults@dev", "space:tools@dev"]
`
    )

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })

    // Currently agent-default returns [] — this test is RED until
    // the resolver loads agent-profile.toml spaces for agent-default
    const spaceRefs = result.spaces.map((s) => s.ref)
    expect(spaceRefs).toContain('space:defaults@dev')
    expect(spaceRefs).toContain('space:tools@dev')
  })

  test('agent-default includes byMode spaces for matching run mode', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = ["space:defaults@dev"]

[spaces.byMode.heartbeat]
base = ["space:heartbeat-ops@dev"]
`
    )

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'heartbeat',
      bundle: { kind: 'agent-default' },
    })

    const spaceRefs = result.spaces.map((s) => s.ref)
    expect(spaceRefs).toContain('space:defaults@dev')
    expect(spaceRefs).toContain('space:heartbeat-ops@dev')
  })

  test('agent-default with v1 profile (no spaces) still returns empty', async () => {
    const agentRoot = createAgentRoot(
      tempDir,
      `
schemaVersion = 1

[targets.review]
compose = ["space:agent:private-ops"]
`
    )

    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })

    // v1 profile with no spaces section → agent-default still returns []
    // This is the backward-compat case — should remain green
    const spaceRefs = result.spaces.map((s) => s.ref)
    // No profile spaces defined, so no spaces from bundle
    expect(spaceRefs.filter((r) => r.startsWith('space:defaults'))).toHaveLength(0)
  })
})
