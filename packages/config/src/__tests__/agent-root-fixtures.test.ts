/**
 * M0 fixture verification for the v2 agentRoot / projectRoot contract.
 *
 * wrkq tasks: T-00841 (fixtures), T-00842 (test helpers), T-00843 (docs)
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseSpaceToml } from '../core/config/space-toml.js'
import { parseTargetsToml } from '../core/config/targets-toml.js'
import {
  assertPathContained,
  createTempFixtureRoots,
  resolveAgentRoot,
  resolveLocalSpacePath,
  resolveProjectRoot,
} from '../test-support/v2-fixtures.js'

const AGENT_ROOT = resolveAgentRoot()
const PROJECT_ROOT = resolveProjectRoot()
const AGENT_SPACE_IDS = ['private-ops', 'task-worker'] as const
const PROJECT_SPACE_IDS = ['repo-defaults', 'task-scaffolds'] as const

describe('agentRoot fixture layout (T-00841)', () => {
  test('agentRoot directory exists', () => {
    expect(existsSync(AGENT_ROOT)).toBe(true)
  })

  test('SOUL.md exists and is non-empty', () => {
    const path = join(AGENT_ROOT, 'SOUL.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(0)
  })

  test('HEARTBEAT.md exists (optional in runtime, present in fixture)', () => {
    expect(existsSync(join(AGENT_ROOT, 'HEARTBEAT.md'))).toBe(true)
  })

  test('agent-profile.toml exists', () => {
    expect(existsSync(join(AGENT_ROOT, 'agent-profile.toml'))).toBe(true)
  })

  test('spaces/ directory exists with at least one agent-local space', () => {
    const spacesDir = join(AGENT_ROOT, 'spaces')
    expect(existsSync(spacesDir)).toBe(true)
    expect(statSync(spacesDir).isDirectory()).toBe(true)

    const entries = readdirSync(spacesDir)
    const spaceDirs = entries.filter((entry) => existsSync(join(spacesDir, entry, 'space.toml')))
    expect(spaceDirs.length).toBeGreaterThanOrEqual(1)
  })

  test('required agent-local spaces include AGENTS.md and valid manifests', () => {
    for (const spaceId of AGENT_SPACE_IDS) {
      const spaceDir = join(AGENT_ROOT, 'spaces', spaceId)
      expect(existsSync(join(spaceDir, 'AGENTS.md'))).toBe(true)
      const manifest = parseSpaceToml(readFileSync(join(spaceDir, 'space.toml'), 'utf8'))
      expect(manifest.id).toBe(spaceId)
    }
  })
})

describe('projectRoot fixture layout (T-00841)', () => {
  test('projectRoot directory exists', () => {
    expect(existsSync(PROJECT_ROOT)).toBe(true)
  })

  test('asp-targets.toml exists', () => {
    expect(existsSync(join(PROJECT_ROOT, 'asp-targets.toml'))).toBe(true)
  })

  test('spaces/ directory exists with at least one project-local space', () => {
    const spacesDir = join(PROJECT_ROOT, 'spaces')
    expect(existsSync(spacesDir)).toBe(true)
    expect(statSync(spacesDir).isDirectory()).toBe(true)

    const entries = readdirSync(spacesDir)
    const spaceDirs = entries.filter((entry) => existsSync(join(spacesDir, entry, 'space.toml')))
    expect(spaceDirs.length).toBeGreaterThanOrEqual(1)
  })

  test('required project-local spaces include AGENTS.md and valid manifests', () => {
    for (const spaceId of PROJECT_SPACE_IDS) {
      const spaceDir = join(PROJECT_ROOT, 'spaces', spaceId)
      expect(existsSync(join(spaceDir, 'AGENTS.md'))).toBe(true)
      const manifest = parseSpaceToml(readFileSync(join(spaceDir, 'space.toml'), 'utf8'))
      expect(manifest.id).toBe(spaceId)
    }
  })

  test('asp-targets.toml defines named targets', () => {
    const manifest = parseTargetsToml(readFileSync(join(PROJECT_ROOT, 'asp-targets.toml'), 'utf8'))
    expect(Object.keys(manifest.targets)).toEqual(
      expect.arrayContaining(['default', 'claude-review', 'codex-fast'])
    )
  })

  test('fixture manifests cover all four harness frontends', () => {
    const supports = new Set<string>()
    for (const [root, ids] of [
      [AGENT_ROOT, AGENT_SPACE_IDS],
      [PROJECT_ROOT, PROJECT_SPACE_IDS],
    ] as const) {
      for (const spaceId of ids) {
        const manifest = parseSpaceToml(
          readFileSync(join(root, 'spaces', spaceId, 'space.toml'), 'utf8')
        )
        for (const harnessId of manifest.harness?.supports ?? []) {
          supports.add(harnessId)
        }
      }
    }

    expect([...supports]).toEqual(
      expect.arrayContaining(['claude', 'claude-agent-sdk', 'pi-sdk', 'codex'])
    )
  })
})

describe('test helpers resolve roots without external host (T-00842)', () => {
  test('resolveAgentRoot() returns absolute path to fixture agentRoot', () => {
    const result = resolveAgentRoot()
    expect(typeof result).toBe('string')
    expect(result).toBe(AGENT_ROOT)
    expect(result.startsWith('/')).toBe(true)
  })

  test('resolveProjectRoot() returns absolute path to fixture projectRoot', () => {
    const result = resolveProjectRoot()
    expect(typeof result).toBe('string')
    expect(result).toBe(PROJECT_ROOT)
    expect(result.startsWith('/')).toBe(true)
  })

  test('resolveAgentRoot() does not depend on any external host implementation', () => {
    const result = resolveAgentRoot()
    expect(existsSync(result)).toBe(true)
  })

  test('resolveLocalSpacePath() resolves agent-local and project-local spaces', () => {
    expect(resolveLocalSpacePath('agent', 'private-ops')).toBe(
      join(AGENT_ROOT, 'spaces', 'private-ops')
    )
    expect(resolveLocalSpacePath('project', 'repo-defaults')).toBe(
      join(PROJECT_ROOT, 'spaces', 'repo-defaults')
    )
  })

  test('assertPathContained() accepts contained paths and rejects escapes', () => {
    expect(assertPathContained(AGENT_ROOT, join(AGENT_ROOT, 'spaces', 'private-ops'))).toBe(
      join(AGENT_ROOT, 'spaces', 'private-ops')
    )

    expect(() => assertPathContained(AGENT_ROOT, PROJECT_ROOT)).toThrow(/escapes the root/)
  })

  test('createTempFixtureRoots() copies fixture roots into a temporary workspace', () => {
    const tempRoots = createTempFixtureRoots()

    try {
      expect(tempRoots.tempDir.startsWith('/')).toBe(true)
      expect(tempRoots.agentRoot).toBe(join(tempRoots.tempDir, 'agent-root'))
      expect(tempRoots.projectRoot).toBe(join(tempRoots.tempDir, 'project-root'))
      expect(existsSync(join(tempRoots.agentRoot, 'SOUL.md'))).toBe(true)
      expect(existsSync(join(tempRoots.projectRoot, 'asp-targets.toml'))).toBe(true)
    } finally {
      tempRoots.cleanup()
    }
  })
})
