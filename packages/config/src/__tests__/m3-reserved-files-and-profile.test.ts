/**
 * RED tests for M3: Reserved files and runtime profile resolution.
 *
 * Tests for SOUL.md/HEARTBEAT.md contract, agent-profile.toml parsing,
 * root-relative refs, and instruction/space layering precedence.
 *
 * wrkq tasks: T-00852 (reserved files), T-00853 (profile parser),
 *             T-00854 (root-relative refs), T-00855 (instruction layering)
 *
 * PASS CONDITIONS:
 * 1. Missing SOUL.md causes resolution failure. Missing HEARTBEAT.md is allowed.
 * 2. agent-profile.toml parser validates schema and returns AgentRuntimeProfile.
 * 3. agent-root:/// and project-root:/// refs resolve safely against declared roots.
 * 4. Instruction layering follows normative order; space composition deduplicates.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { createTempFixtureRoots, resolveAgentRoot } from '../test-support/v2-fixtures.js'

// ===================================================================
// T-00852: Reserved files — SOUL.md required, HEARTBEAT.md optional
// ===================================================================
describe('reserved files contract (T-00852)', () => {
  let tempDir: string
  let agentRoot: string
  let _projectRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
    _projectRoot = roots.projectRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('resolution succeeds when SOUL.md exists', async () => {
    // SOUL.md exists in fixture — resolution should succeed
    expect(existsSync(join(agentRoot, 'SOUL.md'))).toBe(true)

    // Import the resolution function that validates reserved files
    // This module doesn't exist yet (RED)
    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    const result = validateAgentRoot(agentRoot)
    expect(result.valid).toBe(true)
    expect(result.soulMd).toBeDefined()
    expect(result.soulMd.length).toBeGreaterThan(0)
  })

  test('resolution fails when SOUL.md is missing', async () => {
    // Remove SOUL.md
    unlinkSync(join(agentRoot, 'SOUL.md'))
    expect(existsSync(join(agentRoot, 'SOUL.md'))).toBe(false)

    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    expect(() => validateAgentRoot(agentRoot)).toThrow(/SOUL\.md.*required|missing.*SOUL/i)
  })

  test('resolution succeeds when HEARTBEAT.md is missing', async () => {
    // Remove HEARTBEAT.md — should still be fine
    unlinkSync(join(agentRoot, 'HEARTBEAT.md'))
    expect(existsSync(join(agentRoot, 'HEARTBEAT.md'))).toBe(false)

    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    const result = validateAgentRoot(agentRoot)
    expect(result.valid).toBe(true)
    expect(result.heartbeatMd).toBeUndefined()
  })

  test('resolution includes HEARTBEAT.md content when present', async () => {
    expect(existsSync(join(agentRoot, 'HEARTBEAT.md'))).toBe(true)

    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    const result = validateAgentRoot(agentRoot)
    expect(result.valid).toBe(true)
    expect(result.heartbeatMd).toBeDefined()
    expect(result.heartbeatMd!.length).toBeGreaterThan(0)
  })

  test('resolution includes agent-profile.toml when present', async () => {
    expect(existsSync(join(agentRoot, 'agent-profile.toml'))).toBe(true)

    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    const result = validateAgentRoot(agentRoot)
    expect(result.profile).toBeDefined()
  })

  test('resolution succeeds when agent-profile.toml is missing', async () => {
    unlinkSync(join(agentRoot, 'agent-profile.toml'))

    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    const result = validateAgentRoot(agentRoot)
    expect(result.valid).toBe(true)
    expect(result.profile).toBeUndefined()
  })
})

// ===================================================================
// T-00853: agent-profile.toml parser
// ===================================================================
describe('agent-profile.toml parser (T-00853)', () => {
  test('parseAgentProfile parses valid fixture profile', async () => {
    // This module doesn't exist yet (RED)
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    const content = readFileSync(join(resolveAgentRoot(), 'agent-profile.toml'), 'utf8')
    const profile = parseAgentProfile(content)

    expect(profile.schemaVersion).toBe(1)
  })

  test('parses instructions.additionalBase', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')
    const content = readFileSync(join(resolveAgentRoot(), 'agent-profile.toml'), 'utf8')
    const profile = parseAgentProfile(content)

    expect(profile.instructions).toBeDefined()
    expect(profile.instructions!.additionalBase).toEqual(['agent-root:///SOUL.md'])
  })

  test('parses spaces.base and spaces.byMode', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')
    const content = readFileSync(join(resolveAgentRoot(), 'agent-profile.toml'), 'utf8')
    const profile = parseAgentProfile(content)

    expect(profile.spaces).toBeDefined()
    expect(profile.spaces!.base).toEqual(['space:agent:private-ops'])
    expect(profile.spaces!.byMode?.heartbeat).toBeDefined()
  })

  test('parses targets with compose lists', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')
    const content = readFileSync(join(resolveAgentRoot(), 'agent-profile.toml'), 'utf8')
    const profile = parseAgentProfile(content)

    expect(profile.targets).toBeDefined()
    expect(profile.targets!['review']).toBeDefined()
    expect(profile.targets!['review']!.compose).toEqual([
      'space:agent:private-ops',
      'space:project:repo-defaults',
    ])
    expect(profile.targets!['delivery']!.compose).toEqual([
      'space:agent:task-worker',
      'space:project:task-scaffolds',
    ])
  })

  test('parses harnessDefaults', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')
    const content = readFileSync(join(resolveAgentRoot(), 'agent-profile.toml'), 'utf8')
    const profile = parseAgentProfile(content)

    expect(profile.harnessDefaults).toBeDefined()
    expect(profile.harnessDefaults!.model).toBe('claude/sonnet')
    expect(profile.harnessDefaults!.sandboxMode).toBe('workspace-write')
    expect(profile.harnessDefaults!.approvalPolicy).toBe('on-request')
  })

  test('rejects invalid schemaVersion', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    expect(() => parseAgentProfile('schemaVersion = 99\n')).toThrow(
      /schema.*version|unsupported.*version/i
    )
  })

  test('rejects malformed TOML', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    expect(() => parseAgentProfile('this is not valid toml {{{{')).toThrow()
  })

  test('parses minimal valid profile (schemaVersion only)', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    const profile = parseAgentProfile('schemaVersion = 1\n')
    expect(profile.schemaVersion).toBe(1)
    expect(profile.instructions).toBeUndefined()
    expect(profile.spaces).toBeUndefined()
    expect(profile.targets).toBeUndefined()
    expect(profile.harnessDefaults).toBeUndefined()
  })

  test('parses harnessByMode', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    const profile = parseAgentProfile(`
schemaVersion = 1

[harnessByMode.heartbeat]
model = "claude/haiku"
sandboxMode = "read-only"
`)
    expect(profile.harnessByMode).toBeDefined()
    expect(profile.harnessByMode!['heartbeat']).toBeDefined()
    expect(profile.harnessByMode!['heartbeat']!.model).toBe('claude/haiku')
  })
})

// ===================================================================
// T-00854: Root-relative refs
// ===================================================================
describe('root-relative refs (T-00854)', () => {
  let tempDir: string
  let agentRoot: string
  let projectRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
    projectRoot = roots.projectRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('agent-root:///SOUL.md resolves to agentRoot/SOUL.md', async () => {
    // This module doesn't exist yet (RED)
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    const result = resolveRootRelativeRef('agent-root:///SOUL.md', {
      agentRoot,
      projectRoot,
    })
    expect(result).toBe(join(agentRoot, 'SOUL.md'))
  })

  test('project-root:///asp-targets.toml resolves to projectRoot/asp-targets.toml', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    const result = resolveRootRelativeRef('project-root:///asp-targets.toml', {
      agentRoot,
      projectRoot,
    })
    expect(result).toBe(join(projectRoot, 'asp-targets.toml'))
  })

  test('agent-root:///spaces/private-ops/AGENTS.md resolves nested path', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    const result = resolveRootRelativeRef('agent-root:///spaces/private-ops/AGENTS.md', {
      agentRoot,
      projectRoot,
    })
    expect(result).toBe(join(agentRoot, 'spaces', 'private-ops', 'AGENTS.md'))
  })

  test('rejects ".." escape in agent-root ref', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    expect(() =>
      resolveRootRelativeRef('agent-root:///../../etc/passwd', {
        agentRoot,
        projectRoot,
      })
    ).toThrow(/escape|traversal|outside|rejected/i)
  })

  test('rejects ".." escape in project-root ref', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    expect(() =>
      resolveRootRelativeRef('project-root:///../../etc/passwd', {
        agentRoot,
        projectRoot,
      })
    ).toThrow(/escape|traversal|outside|rejected/i)
  })

  test('rejects agent-root ref when agentRoot is not provided', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    expect(() =>
      resolveRootRelativeRef('agent-root:///SOUL.md', {
        projectRoot,
      })
    ).toThrow(/agentRoot.*required|no.*agent.*root/i)
  })

  test('rejects project-root ref when projectRoot is not provided', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    expect(() =>
      resolveRootRelativeRef('project-root:///file.md', {
        agentRoot,
      })
    ).toThrow(/projectRoot.*required|no.*project.*root/i)
  })

  test('normalizes path before resolution', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    // Path with redundant slashes or ./ should normalize
    const result = resolveRootRelativeRef('agent-root:///./SOUL.md', {
      agentRoot,
      projectRoot,
    })
    expect(result).toBe(join(agentRoot, 'SOUL.md'))
  })

  test('rejects unknown root-relative scheme', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    expect(() =>
      resolveRootRelativeRef('unknown-root:///file.md', {
        agentRoot,
        projectRoot,
      })
    ).toThrow(/unknown|unsupported|invalid.*scheme/i)
  })
})

// ===================================================================
// T-00855: Instruction layering and space composition precedence
// ===================================================================
describe('instruction layering order (T-00855)', () => {
  /**
   * Normative instruction order from AGENT_SPACES_PLAN.md section 8:
   *   1. implicit SOUL.md
   *   2. agent-profile.toml -> instructions.additionalBase
   *   3. implicit HEARTBEAT.md when runMode = heartbeat and file exists
   *   4. agent-profile.toml -> instructions.byMode[runMode]
   *   5. host scaffoldPackets in request order
   */

  let tempDir: string
  let agentRoot: string
  let _projectRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
    _projectRoot = roots.projectRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('instructions include SOUL.md first', async () => {
    // This module doesn't exist yet (RED)
    const { resolveInstructionLayer } = await import('../resolver/instruction-layer.js')

    const instructions = await resolveInstructionLayer({
      agentRoot,
      runMode: 'query',
    })

    expect(instructions.length).toBeGreaterThanOrEqual(1)
    // First instruction slot should be SOUL.md
    expect(instructions[0]!.slot).toBe('soul')
    expect(instructions[0]!.content).toContain('Agent Root Fixture')
  })

  test('additionalBase instructions come after SOUL.md', async () => {
    const { resolveInstructionLayer } = await import('../resolver/instruction-layer.js')

    const instructions = await resolveInstructionLayer({
      agentRoot,
      runMode: 'query',
    })

    // Find the additionalBase entries (from agent-profile.toml)
    const soulIdx = instructions.findIndex((i: any) => i.slot === 'soul')
    const additionalIdx = instructions.findIndex((i: any) => i.slot === 'additional-base')

    expect(soulIdx).toBeGreaterThanOrEqual(0)
    if (additionalIdx >= 0) {
      expect(additionalIdx).toBeGreaterThan(soulIdx)
    }
  })

  test('HEARTBEAT.md included only in heartbeat mode', async () => {
    const { resolveInstructionLayer } = await import('../resolver/instruction-layer.js')

    // heartbeat mode should include HEARTBEAT.md
    const heartbeatInstructions = await resolveInstructionLayer({
      agentRoot,
      runMode: 'heartbeat',
    })
    const hasHeartbeat = heartbeatInstructions.some((i: any) => i.slot === 'heartbeat')
    expect(hasHeartbeat).toBe(true)

    // query mode should NOT include HEARTBEAT.md
    const queryInstructions = await resolveInstructionLayer({
      agentRoot,
      runMode: 'query',
    })
    const hasHeartbeatInQuery = queryInstructions.some((i: any) => i.slot === 'heartbeat')
    expect(hasHeartbeatInQuery).toBe(false)
  })

  test('HEARTBEAT.md comes after additionalBase and before byMode', async () => {
    const { resolveInstructionLayer } = await import('../resolver/instruction-layer.js')

    const instructions = await resolveInstructionLayer({
      agentRoot,
      runMode: 'heartbeat',
    })

    const soulIdx = instructions.findIndex((i: any) => i.slot === 'soul')
    const heartbeatIdx = instructions.findIndex((i: any) => i.slot === 'heartbeat')
    const byModeIdx = instructions.findIndex((i: any) => i.slot === 'by-mode')

    expect(heartbeatIdx).toBeGreaterThan(soulIdx)
    if (byModeIdx >= 0) {
      expect(heartbeatIdx).toBeLessThan(byModeIdx)
    }
  })

  test('scaffoldPackets appear last in instruction order', async () => {
    const { resolveInstructionLayer } = await import('../resolver/instruction-layer.js')

    const scaffoldPackets = [{ slot: 'scaffold-1', content: 'test scaffold' }]

    const instructions = await resolveInstructionLayer({
      agentRoot,
      runMode: 'query',
      scaffoldPackets,
    })

    const lastInstruction = instructions[instructions.length - 1]
    expect(lastInstruction!.slot).toBe('scaffold-1')
    expect(lastInstruction!.content).toBe('test scaffold')
  })
})

describe('space composition precedence (T-00855)', () => {
  /**
   * Normative space composition order from AGENT_SPACES_PLAN.md section 8:
   *   1. agent-profile.toml -> spaces.base
   *   2. agent-profile.toml -> spaces.byMode[runMode]
   *   3. spaces from the selected RuntimeBundleRef
   *
   * Deduplicate by resolved space key.
   */

  let tempDir: string
  let agentRoot: string
  let projectRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
    projectRoot = roots.projectRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('spaces.base comes first in composition', async () => {
    // This module doesn't exist yet (RED)
    const { resolveSpaceComposition } = await import('../resolver/space-composition.js')

    const spaces = await resolveSpaceComposition({
      agentRoot,
      runMode: 'query',
      bundleSpaces: [],
    })

    // spaces.base from fixture profile = ["space:agent:private-ops"]
    expect(spaces.length).toBeGreaterThanOrEqual(1)
    expect(spaces[0]!.ref).toContain('private-ops')
  })

  test('spaces.byMode spaces come after base', async () => {
    const { resolveSpaceComposition } = await import('../resolver/space-composition.js')

    // heartbeat mode adds space:agent:task-worker via byMode
    const spaces = await resolveSpaceComposition({
      agentRoot,
      runMode: 'heartbeat',
      bundleSpaces: [],
    })

    const baseIdx = spaces.findIndex((s: any) => s.ref?.includes('private-ops'))
    const byModeIdx = spaces.findIndex((s: any) => s.ref?.includes('task-worker'))

    expect(baseIdx).toBeGreaterThanOrEqual(0)
    expect(byModeIdx).toBeGreaterThan(baseIdx)
  })

  test('bundle spaces come after profile spaces', async () => {
    const { resolveSpaceComposition } = await import('../resolver/space-composition.js')

    const spaces = await resolveSpaceComposition({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundleSpaces: ['space:project:repo-defaults@dev'],
    })

    const baseIdx = spaces.findIndex((s: any) => s.ref?.includes('private-ops'))
    const bundleIdx = spaces.findIndex((s: any) => s.ref?.includes('repo-defaults'))

    expect(baseIdx).toBeGreaterThanOrEqual(0)
    expect(bundleIdx).toBeGreaterThan(baseIdx)
  })

  test('deduplicates by resolved space key', async () => {
    const { resolveSpaceComposition } = await import('../resolver/space-composition.js')

    // Compose the same space from both base and bundle — should appear only once
    const spaces = await resolveSpaceComposition({
      agentRoot,
      runMode: 'query',
      bundleSpaces: ['space:agent:private-ops@dev'], // duplicate of base
    })

    const privateOpsCount = spaces.filter((s: any) => s.ref?.includes('private-ops')).length
    expect(privateOpsCount).toBe(1)
  })

  test('query mode does not include heartbeat-only spaces', async () => {
    const { resolveSpaceComposition } = await import('../resolver/space-composition.js')

    const spaces = await resolveSpaceComposition({
      agentRoot,
      runMode: 'query',
      bundleSpaces: [],
    })

    // task-worker is only in byMode.heartbeat, should not appear in query
    const hasTaskWorker = spaces.some((s: any) => s.ref?.includes('task-worker'))
    expect(hasTaskWorker).toBe(false)
  })
})
