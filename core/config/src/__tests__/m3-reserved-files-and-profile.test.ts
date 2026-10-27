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
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

  test('resolution succeeds when HEARTBEAT.md is missing', async () => {
    // Remove HEARTBEAT.md — should still be fine
    unlinkSync(join(agentRoot, 'HEARTBEAT.md'))
    expect(existsSync(join(agentRoot, 'HEARTBEAT.md'))).toBe(false)

    const { validateAgentRoot } = await import('../resolver/agent-root.js')
    const result = validateAgentRoot(agentRoot)
    expect(result.valid).toBe(true)
    expect(result.heartbeatMd).toBeUndefined()
  })
})

// ===================================================================
// T-00853: agent-profile.toml parser
// ===================================================================
describe('agent-profile.toml parser (T-00853)', () => {
  test('parses targets with compose lists', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')
    const content = readFileSync(join(resolveAgentRoot(), 'agent-profile.toml'), 'utf8')
    const profile = parseAgentProfile(content)

    expect(profile.targets).toBeDefined()
    expect(profile.targets!['review']).toBeDefined()
    expect<string[] | undefined>(profile.targets!['review']!.compose).toEqual([
      'space:agent:private-ops',
      'space:project:repo-defaults',
    ])
    expect<string[] | undefined>(profile.targets!['delivery']!.compose).toEqual([
      'space:agent:task-worker',
      'space:project:task-scaffolds',
    ])
  })

  test('rejects malformed TOML', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    expect(() => parseAgentProfile('this is not valid toml {{{{')).toThrow(/Failed to parse TOML/)
  })

  test('parses minimal valid profile (version only)', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    const profile = parseAgentProfile('version = 4\n')
    expect(profile.version).toBe(4)
    expect(profile.instructions).toBeUndefined()
    expect(profile.spaces).toBeUndefined()
    expect(profile.targets).toBeUndefined()
    expect(profile.provisioning).toBeUndefined()
  })

  test('parses schemaVersion 2 session reminder config', async () => {
    const { parseAgentProfile } = await import('../core/config/agent-profile-toml.js')

    const profile = parseAgentProfile(`
version = 4

[session]
additionalContext = ["agent-root:///session-banner.md"]
additionalExec = ["printf 'queue context'"]
`)

    expect(profile.session).toEqual({
      additionalContext: ['agent-root:///session-banner.md'],
      additionalExec: ["printf 'queue context'"],
    })
  })
})

// ===================================================================
// T-00854: Root-relative refs
// ===================================================================
describe('root-relative refs (T-00854)', () => {
  let tempDir: string
  let agentRoot: string
  let projectRoot: string
  let localAgentsRoot: string
  let canonicalAgentsRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
    projectRoot = roots.projectRoot
    localAgentsRoot = join(tempDir, 'project-agents')
    canonicalAgentsRoot = join(tempDir, 'canonical-agents')
    mkdirSync(localAgentsRoot, { recursive: true })
    mkdirSync(canonicalAgentsRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test.each<{ ref: string; root: 'agent' | 'project'; file: string }>([
    { ref: 'agent-root:///SOUL.md', root: 'agent', file: 'SOUL.md' },
    { ref: 'project-root:///asp-targets.toml', root: 'project', file: 'asp-targets.toml' },
  ])(
    'agent-root:/// and project-root:/// refs resolve under their declared roots: $ref',
    async ({ ref, root, file }) => {
      const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

      const result = resolveRootRelativeRef(ref, { agentRoot, projectRoot })
      expect(result).toBe(join(root === 'agent' ? agentRoot : projectRoot, file))
    }
  )

  test.each<{
    row: string
    local?: string
    canonical?: string
    file: string
    expected: 'local' | 'canonical'
  }>([
    {
      row: 'file in the project-local overlay and canonical root -> overlay',
      local: 'local',
      canonical: 'canonical',
      file: 'AGENT_MOTD.md',
      expected: 'local',
    },
    {
      row: 'file only in the canonical root -> canonical',
      canonical: 'canonical',
      file: 'AGENT_MOTD.md',
      expected: 'canonical',
    },
    {
      row: 'file in no root -> first search root',
      file: 'missing.md',
      expected: 'local',
    },
  ])(
    'agents-root:/// refs resolve to the first search root holding the file, else the first root: $row',
    async ({ local, canonical, file, expected }) => {
      const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')
      if (local !== undefined) writeFileSync(join(localAgentsRoot, file), local)
      if (canonical !== undefined) writeFileSync(join(canonicalAgentsRoot, file), canonical)

      const result = resolveRootRelativeRef(`agents-root:///${file}`, {
        agentRoot,
        agentsRoot: canonicalAgentsRoot,
        agentRootSearchPath: [localAgentsRoot, canonicalAgentsRoot],
        projectRoot,
      })

      expect(result).toBe(join(expected === 'local' ? localAgentsRoot : canonicalAgentsRoot, file))
    }
  )

  test('rejects ".." escape in agent-root ref', async () => {
    const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

    expect(() =>
      resolveRootRelativeRef('agent-root:///../../etc/passwd', {
        agentRoot,
        projectRoot,
      })
    ).toThrow(/escapes the root via "\.\." traversal/)
  })

  test.each<{ ref: string; provided: 'agentRoot' | 'projectRoot'; required: string }>([
    { ref: 'agent-root:///SOUL.md', provided: 'projectRoot', required: 'agentRoot' },
    { ref: 'project-root:///file.md', provided: 'agentRoot', required: 'projectRoot' },
  ])(
    'a root-relative ref without its root is rejected naming the missing root: $required',
    async ({ ref, provided, required }) => {
      const { resolveRootRelativeRef } = await import('../resolver/root-relative-refs.js')

      const options = provided === 'agentRoot' ? { agentRoot } : { projectRoot }
      expect(() => resolveRootRelativeRef(ref, options)).toThrow(
        `${required} is required to resolve ref: "${ref}"`
      )
    }
  )

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

  test('composition orders spaces as profile base, then run-mode spaces, then bundle spaces', async () => {
    const { resolveSpaceComposition } = await import('../resolver/space-composition.js')

    // Fixture profile: spaces.base = [private-ops], spaces.modes.heartbeat adds task-worker.
    const spaces = await resolveSpaceComposition({
      agentRoot,
      projectRoot,
      runMode: 'heartbeat',
      bundleSpaces: ['space:project:repo-defaults@dev'],
    })

    expect(spaces.map((s) => s.ref)).toEqual([
      'space:agent:private-ops',
      'space:agent:task-worker',
      'space:project:repo-defaults@dev',
    ])
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
