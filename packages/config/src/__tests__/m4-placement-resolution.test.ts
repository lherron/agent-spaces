/**
 * Tests for M4: Placement-driven resolution and audit metadata.
 *
 * Tests for RuntimePlacement types, placement resolver, ResolvedRuntimeBundle
 * audit output, and projectRoot-never-implies-target guard.
 *
 * Updated by T-01564: collapsed RuntimeBundleRef union to {agent-project, compose}.
 *
 * wrkq tasks: T-00856 (types), T-00857 (placement resolver),
 *             T-00858 (audit metadata), T-00859 (projectRoot guard)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTempFixtureRoots } from '../test-support/v2-fixtures.js'

// ===================================================================
// T-00856: Placement types exist and are correctly shaped
// ===================================================================
describe('placement types (T-00856)', () => {
  test('RuntimePlacement type is importable', async () => {
    const mod = await import('../core/types/placement.js')
    // Type-only imports don't produce runtime values, but we verify
    // the module exists and exports expected runtime helpers/guards
    expect(mod).toBeDefined()
  })

  test('RunMode type includes all four modes', async () => {
    const { isValidRunMode } = await import('../core/types/placement.js')
    expect(isValidRunMode('query')).toBe(true)
    expect(isValidRunMode('heartbeat')).toBe(true)
    expect(isValidRunMode('task')).toBe(true)
    expect(isValidRunMode('maintenance')).toBe(true)
    expect(isValidRunMode('invalid')).toBe(false)
  })

  test('RuntimeBundleRef kinds are valid (collapsed union)', async () => {
    const { isValidBundleRefKind } = await import('../core/types/placement.js')
    expect(isValidBundleRefKind('agent-project')).toBe(true)
    expect(isValidBundleRefKind('compose')).toBe(true)
    // Removed kinds
    expect(isValidBundleRefKind('agent-default')).toBe(false)
    expect(isValidBundleRefKind('agent-target')).toBe(false)
    expect(isValidBundleRefKind('project-target')).toBe(false)
    expect(isValidBundleRefKind('nonexistent')).toBe(false)
  })

  test('createRuntimePlacement builds a valid placement object', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    const placement = createRuntimePlacement({
      agentRoot: '/srv/agents/alice',
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(placement.agentRoot).toBe('/srv/agents/alice')
    expect(placement.runMode).toBe('query')
    expect(placement.bundle.kind).toBe('agent-project')
    expect(placement.projectRoot).toBeUndefined()
  })

  test('RuntimePlacement accepts all bundle ref kinds', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    // agent-project
    const p1 = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })
    expect(p1.bundle.kind).toBe('agent-project')

    // compose
    const p2 = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'query',
      bundle: { kind: 'compose', compose: ['space:my-space@stable'] },
    })
    expect(p2.bundle.kind).toBe('compose')
  })

  test('RuntimePlacement accepts scaffoldPackets and correlation', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    const placement = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
      scaffoldPackets: [{ slot: 'prompt', content: 'Hello', contentType: 'text' }],
      correlation: {
        hostSessionId: 'hs-123',
        runId: 'run-456',
      },
    })

    expect(placement.scaffoldPackets).toHaveLength(1)
    expect(placement.scaffoldPackets![0]!.slot).toBe('prompt')
    expect(placement.correlation!.hostSessionId).toBe('hs-123')
  })
})

// ===================================================================
// T-00857: Placement resolver
// ===================================================================
describe('placement resolver (T-00857)', () => {
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

  test('resolvePlacement returns a ResolvedRuntimeBundle', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(result).toBeDefined()
    expect(result.runMode).toBe('query')
    expect(result.cwd).toBeDefined()
    expect(result.instructions).toBeInstanceOf(Array)
    expect(result.spaces).toBeInstanceOf(Array)
    expect(result.bundleIdentity).toBeDefined()
  })

  test('agent-project bundle includes SOUL.md in instructions', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    const hasSoul = result.instructions.some((i: any) => i.slot === 'soul')
    expect(hasSoul).toBe(true)
  })

  test('compose bundle uses explicit space list', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: {
        kind: 'compose',
        compose: ['space:agent:private-ops@dev'] as any[],
      },
    })

    const spaceRefs = result.spaces.map((s: any) => s.ref)
    expect(spaceRefs).toEqual(expect.arrayContaining([expect.stringContaining('private-ops')]))
  })

  test('mode-aware overlays are applied', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'heartbeat',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    const hasHeartbeat = result.instructions.some((i: any) => i.slot === 'heartbeat')
    expect(hasHeartbeat).toBe(true)
  })

  test('scaffold packets are included in result', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
      scaffoldPackets: [{ slot: 'user-prompt', content: 'Hello world' }],
    })

    const hasScaffold = result.instructions.some((i: any) => i.slot === 'user-prompt')
    expect(hasScaffold).toBe(true)
  })

  test('different runModes against same placement produce different bundles', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const queryResult = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    const heartbeatResult = await resolvePlacement({
      agentRoot,
      runMode: 'heartbeat',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    // Heartbeat should have more instructions (HEARTBEAT.md)
    expect(heartbeatResult.instructions.length).toBeGreaterThan(queryResult.instructions.length)
  })
})

// ===================================================================
// T-00857 continued: CWD rules (plan section 9)
// ===================================================================
describe('CWD resolution rules (T-00857)', () => {
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

  test('explicit cwd wins over defaults', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      cwd: '/custom/working/dir',
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(result.cwd).toBe('/custom/working/dir')
  })

  test('agent-project with projectRoot defaults cwd to projectRoot', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice', projectRoot },
    })

    expect(result.cwd).toBe(projectRoot)
  })

  test('agent-project without projectRoot defaults cwd to agentRoot', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(result.cwd).toBe(agentRoot)
  })

  test('cwd values are absolute', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(result.cwd.startsWith('/')).toBe(true)
  })
})

// ===================================================================
// T-00858: ResolvedRuntimeBundle audit metadata
// ===================================================================
describe('ResolvedRuntimeBundle audit metadata (T-00858)', () => {
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

  test('bundleIdentity is a non-empty string', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(typeof result.bundleIdentity).toBe('string')
    expect(result.bundleIdentity.length).toBeGreaterThan(0)
  })

  test('instructions have slot, ref, and contentHash', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(result.instructions.length).toBeGreaterThan(0)
    for (const inst of result.instructions) {
      expect(inst).toHaveProperty('slot')
      expect(inst).toHaveProperty('ref')
      expect(inst).toHaveProperty('contentHash')
      expect(typeof inst.slot).toBe('string')
      expect(typeof inst.ref).toBe('string')
      expect(inst.contentHash).toMatch(/^sha256:/)
    }
  })

  test('spaces have ref, resolvedKey, and integrity', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    if (result.spaces.length > 0) {
      for (const space of result.spaces) {
        expect(space).toHaveProperty('ref')
        expect(space).toHaveProperty('resolvedKey')
        expect(space).toHaveProperty('integrity')
        expect(typeof space.ref).toBe('string')
        expect(typeof space.resolvedKey).toBe('string')
        expect(space.integrity).toMatch(/^sha256:/)
      }
    }
  })

  test('same placement produces deterministic bundleIdentity', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const placement = {
      agentRoot,
      runMode: 'query' as const,
      bundle: { kind: 'agent-project' as const, agentName: 'alice' },
    }

    const result1 = await resolvePlacement(placement)
    const result2 = await resolvePlacement(placement)

    expect(result1.bundleIdentity).toBe(result2.bundleIdentity)
  })

  test('runMode is included in audit output', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'maintenance',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    expect(result.runMode).toBe('maintenance')
  })
})

// ===================================================================
// T-00859: projectRoot alone never selects a project target
// ===================================================================
describe('projectRoot never implies project target (T-00859)', () => {
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

  test('compose with projectRoot does not auto-include project targets', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: {
        kind: 'compose',
        compose: ['space:agent:private-ops@dev'] as any[],
      },
    })

    const projectSpaceRefs = result.spaces.filter((s: any) => s.ref?.includes('project:'))
    expect(projectSpaceRefs.length).toBe(0)
  })
})

// ===================================================================
// T-00889: resolvePlacement must enforce SOUL.md contract
// ===================================================================
describe('SOUL.md enforcement (T-00889)', () => {
  let noSoulDir: string

  beforeEach(() => {
    noSoulDir = mkdtempSync(join(tmpdir(), 'no-soul-'))
    const agentRoot = join(noSoulDir, 'agent-root')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'schemaVersion = 2\n\n[spaces]\nbase = []\n')
  })

  afterEach(() => {
    rmSync(noSoulDir, { recursive: true, force: true })
  })

  test('resolvePlacement throws when SOUL.md is missing (non-dry-run)', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')
    const agentRoot = join(noSoulDir, 'agent-root')

    await expect(
      resolvePlacement({
        agentRoot,
        runMode: 'query',
        bundle: { kind: 'agent-project', agentName: 'alice' },
      })
    ).rejects.toThrow(/SOUL\.md/i)
  })

  test('resolvePlacement succeeds in dry-run when SOUL.md is missing', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')
    const agentRoot = join(noSoulDir, 'agent-root')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
      dryRun: true,
    })

    expect(result).toBeDefined()
    expect(result.instructions).toBeInstanceOf(Array)
  })
})

// ===================================================================
// T-01094: richer placement materialization context
// ===================================================================
describe('resolvePlacementContext materialization (T-01094)', () => {
  test('agent-project returns effective config and synthetic manifest for downstream planning', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'placement-context-'))

    try {
      const agentRoot = join(tempDir, 'agent-root')
      const projectRoot = join(tempDir, 'project-root')

      mkdirSync(agentRoot, { recursive: true })
      mkdirSync(projectRoot, { recursive: true })

      writeFileSync(join(agentRoot, 'SOUL.md'), '# Test Agent\n')
      writeFileSync(
        join(agentRoot, 'agent-profile.toml'),
        `
schemaVersion = 2
priming_prompt = "Agent prompt"

[identity]
harness = "codex"

[spaces]
base = ["space:agent-base@dev"]

[harnessDefaults]
model = "gpt-5.5"
`
      )

      writeFileSync(
        join(projectRoot, 'asp-targets.toml'),
        `
schema = 1

[targets.smokey]
compose_mode = "merge"
compose = ["space:project-extra@dev"]
priming_prompt_append = "Project append"
yolo = true
harness = "codex"

[targets.smokey.codex]
model = "gpt-5.3-codex"
`
      )

      const { resolvePlacementContext } = await import('../resolver/placement-resolver.js')
      const context = await resolvePlacementContext({
        agentRoot,
        projectRoot,
        runMode: 'query',
        bundle: {
          kind: 'agent-project',
          agentName: 'smokey',
          projectRoot,
        },
      })

      expect(context.materialization.spec).toEqual({
        kind: 'spaces',
        spaces: ['space:agent-base@dev', 'space:project-extra@dev'],
      })
      expect(context.materialization.effectiveConfig).toMatchObject({
        priming_prompt: 'Agent prompt\nProject append',
        yolo: true,
        harness: 'codex',
        model: 'gpt-5.3-codex',
      })
      expect(context.materialization.manifest?.targets.smokey).toMatchObject({
        compose: ['space:agent-base@dev', 'space:project-extra@dev'],
        priming_prompt: 'Agent prompt\nProject append',
        yolo: true,
        harness: 'codex',
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
