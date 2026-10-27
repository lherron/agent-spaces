/**
 * RED tests for M2: Path safety and local-space completion.
 *
 * Tests for space:agent:<id> resolution, space:project:<id> explicit compose,
 * dependency edge enforcement, and path containment.
 *
 * wrkq tasks: T-00848 (agent-local), T-00849 (project explicit compose),
 *             T-00850 (dependency edges), T-00851 (path containment)
 *
 * PASS CONDITIONS:
 * 1. space:agent:<id> parses with agentSpace flag, resolves to <agentRoot>/spaces/<id>/,
 *    works through closure, integrity, and materialization.
 * 2. space:project:<id> resolves when composed directly (not only from target manifests).
 * 3. Dependency edges: allowed edges succeed, disallowed cross-root edges throw.
 * 4. Path containment: ".." escapes rejected, symlink escapes rejected, normal paths pass.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatSpaceRef, parseSpaceRef } from '../resolver/ref-parser.js'
import {
  assertPathContained,
  createTempFixtureRoots,
  resolveAgentRoot,
  resolveLocalSpacePath,
} from '../test-support/v2-fixtures.js'

// ===================================================================
// T-00848: space:agent:<id> resolution
// ===================================================================
describe('space:agent:<id> ref formatting (T-00848)', () => {
  test('an agent-local ref formats back to space:agent:<id>@<selector>', () => {
    expect(formatSpaceRef(parseSpaceRef('space:agent:private-ops'))).toBe(
      'space:agent:private-ops@dev'
    )
  })
})

describe('space:agent:<id> resolves to agentRoot/spaces/<id>/ (T-00848)', () => {
  test('resolveLocalSpacePath for agent scope returns correct path', () => {
    const agentRoot = resolveAgentRoot()
    const result = resolveLocalSpacePath('agent', 'private-ops', { agentRoot })
    expect(result).toBe(join(agentRoot, 'spaces', 'private-ops'))
  })

  test('resolveLocalSpacePath for agent scope with task-worker', () => {
    const agentRoot = resolveAgentRoot()
    const result = resolveLocalSpacePath('agent', 'task-worker', { agentRoot })
    expect(result).toBe(join(agentRoot, 'spaces', 'task-worker'))
  })
})

describe('space:agent:<id> in integrity hashing (T-00848)', () => {
  test('computeFilesystemIntegrity works on agent-local space directory', async () => {
    const { computeFilesystemIntegrity } = await import('../resolver/integrity.js')
    const agentRoot = resolveAgentRoot()
    const spacePath = join(agentRoot, 'spaces', 'private-ops')

    const integrity = await computeFilesystemIntegrity(spacePath)
    expect(integrity).toMatch(/^sha256:/)
    // Should be a real hash, not a marker
    expect(integrity).not.toBe('sha256:dev')
    expect(integrity).not.toBe('sha256:project')
  })
})

// ===================================================================
// T-00850: Dependency edge enforcement
// ===================================================================
describe('dependency edge enforcement (T-00850)', () => {
  /**
   * These tests verify the allowed/disallowed dependency rules from
   * AGENT_SPACES_PLAN.md section 7.
   *
   * Allowed:
   *   - registry -> registry
   *   - agent-local -> registry
   *   - agent-local -> agent-local (same agentRoot)
   *   - project-local -> registry
   *   - project-local -> project-local (same projectRoot)
   *
   * Disallowed:
   *   - registry -> agent-local
   *   - registry -> project-local
   *   - agent-local -> project-local
   *   - project-local -> agent-local
   *
   * Implementation requires a dependency edge validator that runs during
   * closure computation. This doesn't exist yet — tests should fail.
   */

  let tempDir: string
  let agentRoot: string
  let projectRoot: string

  beforeEach(() => {
    // Create temp fixture with cross-referencing manifests
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
    projectRoot = roots.projectRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // --- Allowed edges ---

  test('agent-local -> agent-local (same root): allowed', async () => {
    // Modify private-ops to depend on task-worker (both agent-local)
    const manifest = readFileSync(join(agentRoot, 'spaces', 'private-ops', 'space.toml'), 'utf8')
    writeFileSync(
      join(agentRoot, 'spaces', 'private-ops', 'space.toml'),
      `${manifest}\n[deps]\nspaces = ["space:agent:task-worker"]\n`
    )

    const { computeClosure } = await import('../resolver/closure.js')
    const closure = await computeClosure(['space:agent:private-ops@dev' as any], {
      cwd: agentRoot,
      agentRoot,
    } as any)

    // Should resolve both spaces without error
    expect(closure.spaces.size).toBe(2)
  })

  test('project-local -> project-local (same root): allowed', async () => {
    // Modify repo-defaults to depend on task-scaffolds (both project-local)
    const manifest = readFileSync(
      join(projectRoot, 'spaces', 'repo-defaults', 'space.toml'),
      'utf8'
    )
    writeFileSync(
      join(projectRoot, 'spaces', 'repo-defaults', 'space.toml'),
      `${manifest}\n[deps]\nspaces = ["space:project:task-scaffolds"]\n`
    )

    const { computeClosure } = await import('../resolver/closure.js')
    const closure = await computeClosure(['space:project:repo-defaults@dev' as any], {
      cwd: projectRoot,
      projectRoot,
    } as any)

    expect(closure.spaces.size).toBe(2)
  })

  // --- Disallowed edges ---

  test.each<{
    edge: string
    root: 'agent' | 'project'
    space: string
    dep: string
    compose: string
    withAgentRoot: boolean
    withProjectRoot: boolean
  }>([
    {
      edge: 'registry -> agent',
      root: 'agent',
      space: 'fake-registry',
      dep: 'space:agent:private-ops',
      compose: 'space:fake-registry@dev',
      withAgentRoot: true,
      withProjectRoot: false,
    },
    {
      edge: 'registry -> project',
      root: 'project',
      space: 'fake-registry',
      dep: 'space:project:repo-defaults',
      compose: 'space:fake-registry@dev',
      withAgentRoot: false,
      withProjectRoot: true,
    },
    {
      edge: 'agent -> project',
      root: 'agent',
      space: 'private-ops',
      dep: 'space:project:repo-defaults',
      compose: 'space:agent:private-ops@dev',
      withAgentRoot: true,
      withProjectRoot: true,
    },
    {
      edge: 'project -> agent',
      root: 'project',
      space: 'repo-defaults',
      dep: 'space:agent:private-ops',
      compose: 'space:project:repo-defaults@dev',
      withAgentRoot: true,
      withProjectRoot: true,
    },
  ])(
    'a cross-root dependency edge $edge is rejected naming that edge',
    async ({ edge, root, space, dep, compose, withAgentRoot, withProjectRoot }) => {
      // A space without an agent/project prefix is a registry space; the fake-registry
      // rows create one inside a local root so the closure can read its manifest.
      const spaceDir = join(root === 'agent' ? agentRoot : projectRoot, 'spaces', space)
      const manifestPath = join(spaceDir, 'space.toml')
      mkdirSync(spaceDir, { recursive: true })
      const manifest =
        space === 'fake-registry'
          ? 'schema = 1\nid = "fake-registry"\ndescription = "test"\n'
          : readFileSync(manifestPath, 'utf8')
      writeFileSync(manifestPath, `${manifest}\n[deps]\nspaces = ["${dep}"]\n`)

      const { computeClosure } = await import('../resolver/closure.js')

      await expect(
        computeClosure([compose as any], {
          cwd: root === 'agent' ? agentRoot : projectRoot,
          ...(withAgentRoot ? { agentRoot } : {}),
          ...(withProjectRoot ? { projectRoot } : {}),
        } as any)
      ).rejects.toThrow(`Disallowed dependency edge: ${edge}.`)
    }
  )
})

// ===================================================================
// T-00851: Path containment and escape rejection
// ===================================================================
describe('path containment (T-00851)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'path-safety-'))
    // Create a simple root structure
    mkdirSync(join(tempDir, 'root', 'spaces', 'good-space'), { recursive: true })
    writeFileSync(
      join(tempDir, 'root', 'spaces', 'good-space', 'space.toml'),
      'schema = 1\nid = "good-space"\n'
    )
    // Create an outside directory
    mkdirSync(join(tempDir, 'outside'), { recursive: true })
    writeFileSync(join(tempDir, 'outside', 'secret.txt'), 'sensitive data')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('normal contained path passes', () => {
    const root = join(tempDir, 'root')
    const candidate = join(root, 'spaces', 'good-space')
    const result = assertPathContained(root, candidate)
    expect(result).toBe(realpathSync(candidate))
  })

  test('root itself passes (edge case)', () => {
    const root = join(tempDir, 'root')
    const result = assertPathContained(root, root)
    expect(result).toBe(realpathSync(root))
  })

  test('".." escape is rejected', () => {
    const root = join(tempDir, 'root')
    const escapePath = join(root, 'spaces', '..', '..', 'outside')
    // assertPathContained uses realpath, so ".." resolves to actual path
    expect(() => assertPathContained(root, escapePath)).toThrow(/escapes the root/)
  })

  test('symlink escape outside root is rejected', () => {
    const root = join(tempDir, 'root')
    const outsideTarget = join(tempDir, 'outside')
    const symlinkPath = join(root, 'spaces', 'evil-link')

    symlinkSync(outsideTarget, symlinkPath)

    // realpath resolves the symlink, revealing it points outside root
    expect(() => assertPathContained(root, symlinkPath)).toThrow(/escapes the root/)
  })

  test('symlink within root is allowed', () => {
    const root = join(tempDir, 'root')
    const target = join(root, 'spaces', 'good-space')
    const symlinkPath = join(root, 'spaces', 'alias-space')

    symlinkSync(target, symlinkPath)

    const result = assertPathContained(root, symlinkPath)
    expect(result).toBe(realpathSync(target))
  })
})

describe('resolveLocalSpacePath containment (T-00851)', () => {
  test('rejects space id with ".." traversal', () => {
    const agentRoot = resolveAgentRoot()
    // A malicious space id trying to escape
    expect(() => resolveLocalSpacePath('agent', '../../etc', { agentRoot })).toThrow(
      /escapes the root|invalid/i
    )
  })

  test('rejects space id with absolute path injection', () => {
    const agentRoot = resolveAgentRoot()
    expect(() => resolveLocalSpacePath('agent', '/tmp/evil', { agentRoot })).toThrow(
      /escapes the root|invalid|space ID/i
    )
  })

  test('accepts valid space ids', () => {
    const agentRoot = resolveAgentRoot()
    const result = resolveLocalSpacePath('agent', 'private-ops', { agentRoot })
    expect(result).toBe(join(agentRoot, 'spaces', 'private-ops'))
  })
})
