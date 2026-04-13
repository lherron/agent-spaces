/**
 * RED tests for M4: Placement-driven resolution and audit metadata.
 *
 * Tests for RuntimePlacement types, placement resolver, ResolvedRuntimeBundle
 * audit output, and projectRoot-never-implies-target guard.
 *
 * wrkq tasks: T-00856 (types), T-00857 (placement resolver),
 *             T-00858 (audit metadata), T-00859 (projectRoot guard)
 *
 * PASS CONDITIONS:
 * 1. RuntimePlacement, RuntimeBundleRef, RunScaffoldPacket, HostCorrelation types exist.
 * 2. resolvePlacement produces a deterministic ResolvedRuntimeBundle from a RuntimePlacement.
 * 3. ResolvedRuntimeBundle contains bundleIdentity, runMode, cwd, instructions[], spaces[].
 * 4. projectRoot alone never selects a project target.
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
    // RunMode already exists in agent-profile.ts, but should also be
    // re-exported from placement types for placement-centric consumers
    const { isValidRunMode } = await import('../core/types/placement.js')
    expect(isValidRunMode('query')).toBe(true)
    expect(isValidRunMode('heartbeat')).toBe(true)
    expect(isValidRunMode('task')).toBe(true)
    expect(isValidRunMode('maintenance')).toBe(true)
    expect(isValidRunMode('invalid')).toBe(false)
  })

  test('RuntimeBundleRef kinds are valid', async () => {
    const { isValidBundleRefKind } = await import('../core/types/placement.js')
    expect(isValidBundleRefKind('agent-default')).toBe(true)
    expect(isValidBundleRefKind('agent-target')).toBe(true)
    expect(isValidBundleRefKind('project-target')).toBe(true)
    expect(isValidBundleRefKind('compose')).toBe(true)
    expect(isValidBundleRefKind('nonexistent')).toBe(false)
  })

  test('createRuntimePlacement builds a valid placement object', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    const placement = createRuntimePlacement({
      agentRoot: '/srv/agents/alice',
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })

    expect(placement.agentRoot).toBe('/srv/agents/alice')
    expect(placement.runMode).toBe('query')
    expect(placement.bundle.kind).toBe('agent-default')
    expect(placement.projectRoot).toBeUndefined()
  })

  test('RuntimePlacement accepts all bundle ref kinds', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    // agent-default
    const p1 = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })
    expect(p1.bundle.kind).toBe('agent-default')

    // agent-target
    const p2 = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'task',
      bundle: { kind: 'agent-target', target: 'review' },
    })
    expect(p2.bundle.kind).toBe('agent-target')

    // project-target
    const p3 = createRuntimePlacement({
      agentRoot: '/a',
      projectRoot: '/p',
      runMode: 'task',
      bundle: { kind: 'project-target', projectRoot: '/p', target: 'dev' },
    })
    expect(p3.bundle.kind).toBe('project-target')

    // compose
    const p4 = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'query',
      bundle: { kind: 'compose', compose: ['space:my-space@stable'] },
    })
    expect(p4.bundle.kind).toBe('compose')
  })

  test('RuntimePlacement accepts scaffoldPackets and correlation', async () => {
    const { createRuntimePlacement } = await import('../core/types/placement.js')

    const placement = createRuntimePlacement({
      agentRoot: '/a',
      runMode: 'query',
      bundle: { kind: 'agent-default' },
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
      bundle: { kind: 'agent-default' },
    })

    expect(result).toBeDefined()
    expect(result.runMode).toBe('query')
    expect(result.cwd).toBeDefined()
    expect(result.instructions).toBeInstanceOf(Array)
    expect(result.spaces).toBeInstanceOf(Array)
    expect(result.bundleIdentity).toBeDefined()
  })

  test('agent-default bundle uses profile defaults', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })

    // Should include SOUL.md in instructions (from reserved files)
    const hasSoul = result.instructions.some((i: any) => i.slot === 'soul')
    expect(hasSoul).toBe(true)
  })

  test('agent-target bundle resolves named target from agent-profile.toml', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: { kind: 'agent-target', target: 'review' },
    })

    // The "review" target composes space:agent:private-ops + space:project:repo-defaults
    const spaceRefs = result.spaces.map((s: any) => s.ref)
    expect(spaceRefs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('private-ops'),
        expect.stringContaining('repo-defaults'),
      ])
    )
  })

  test('project-target bundle requires explicit target name', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: { kind: 'project-target', projectRoot, target: 'default' },
    })

    expect(result).toBeDefined()
    expect(result.spaces.length).toBeGreaterThan(0)
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

    // heartbeat mode should include HEARTBEAT.md and heartbeat-specific spaces
    const result = await resolvePlacement({
      agentRoot,
      runMode: 'heartbeat',
      bundle: { kind: 'agent-default' },
    })

    const hasHeartbeat = result.instructions.some((i: any) => i.slot === 'heartbeat')
    expect(hasHeartbeat).toBe(true)
  })

  test('scaffold packets are included in result', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
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
      bundle: { kind: 'agent-default' },
    })

    const heartbeatResult = await resolvePlacement({
      agentRoot,
      runMode: 'heartbeat',
      bundle: { kind: 'agent-default' },
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
      bundle: { kind: 'agent-default' },
    })

    expect(result.cwd).toBe('/custom/working/dir')
  })

  test('project-target defaults cwd to projectRoot', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: { kind: 'project-target', projectRoot, target: 'default' },
    })

    expect(result.cwd).toBe(projectRoot)
  })

  test('agent-default defaults cwd to agentRoot', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })

    expect(result.cwd).toBe(agentRoot)
  })

  test('cwd values are absolute', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
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
      bundle: { kind: 'agent-default' },
    })

    expect(typeof result.bundleIdentity).toBe('string')
    expect(result.bundleIdentity.length).toBeGreaterThan(0)
  })

  test('instructions have slot, ref, and contentHash', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
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
      bundle: { kind: 'agent-default' },
    })

    // agent-default with profile should include at least the base spaces
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
      bundle: { kind: 'agent-default' as const },
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
      bundle: { kind: 'agent-default' },
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

  test('agent-default with projectRoot does NOT auto-select project target', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    // Even though projectRoot has asp-targets.toml with targets defined,
    // agent-default bundle should NOT auto-resolve to a project target.
    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
    })

    // The spaces should come from agent profile, not project targets
    const _spaceRefs = result.spaces.map((s: any) => s.ref)
    // Should not contain project-target-specific spaces unless the profile
    // explicitly references them in spaces.base
    expect(result.bundleIdentity).not.toContain('project-target')
  })

  test('project-target requires explicit target parameter', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    // project-target without a target name should fail
    await expect(
      resolvePlacement({
        agentRoot,
        projectRoot,
        runMode: 'query',
        bundle: { kind: 'project-target', projectRoot, target: '' },
      })
    ).rejects.toThrow(/target.*required|empty.*target|missing.*target/i)
  })

  test('compose with projectRoot does not auto-include project targets', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    // Explicit compose with only an agent-local space — projectRoot present
    // but should not add any project target spaces
    const result = await resolvePlacement({
      agentRoot,
      projectRoot,
      runMode: 'query',
      bundle: {
        kind: 'compose',
        compose: ['space:agent:private-ops@dev'] as any[],
      },
    })

    // Only the explicitly composed space + profile base should appear
    const projectSpaceRefs = result.spaces.filter((s: any) => s.ref?.includes('project:'))
    // No project spaces unless the profile base explicitly includes them
    // (fixture profile base is ["space:agent:private-ops"], no project spaces)
    expect(projectSpaceRefs.length).toBe(0)
  })
})

// ===================================================================
// T-00889: resolvePlacement must enforce SOUL.md contract
//
// Defect: placement-resolver.ts previously tolerated a missing SOUL.md in
// non-dry-run placements. The contract is that SOUL.md is required for actual
// execution and only dry-run may proceed without it.
//
// PASS CONDITIONS:
// 1. resolvePlacement throws when SOUL.md is missing (non-dry-run).
// 2. resolvePlacement succeeds in dry-run mode when SOUL.md is missing.
// ===================================================================
describe('SOUL.md enforcement (T-00889)', () => {
  let noSoulDir: string

  beforeEach(() => {
    // Create a minimal agent root WITHOUT SOUL.md
    noSoulDir = mkdtempSync(join(tmpdir(), 'no-soul-'))
    const agentRoot = join(noSoulDir, 'agent-root')
    mkdirSync(agentRoot, { recursive: true })
    // Write an agent-profile.toml so it's a valid-looking agent root aside from SOUL.md
    writeFileSync(join(agentRoot, 'agent-profile.toml'), '[spaces]\nbase = []\n')
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
        bundle: { kind: 'agent-default' },
      })
    ).rejects.toThrow(/SOUL\.md/i)
  })

  test('resolvePlacement succeeds in dry-run when SOUL.md is missing', async () => {
    // GREEN (once dryRun plumbing exists): dry-run should tolerate missing SOUL.md.
    // RED initially because the dryRun option doesn't exist yet on RuntimePlacement.
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')
    const agentRoot = join(noSoulDir, 'agent-root')

    // Pass dryRun on the placement — this field doesn't exist yet, so
    // the fix will need to add it to RuntimePlacement and honor it.
    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    } as any)

    expect(result).toBeDefined()
    expect(result.instructions).toBeInstanceOf(Array)
    // In dry-run, soul slot is absent but that's OK
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
model = "gpt-5.4"
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

  test('project-target returns target materialization spec and manifest', async () => {
    const { resolvePlacementContext } = await import('../resolver/placement-resolver.js')
    const roots = createTempFixtureRoots()

    try {
      const context = await resolvePlacementContext({
        agentRoot: roots.agentRoot,
        projectRoot: roots.projectRoot,
        runMode: 'task',
        bundle: {
          kind: 'project-target',
          projectRoot: roots.projectRoot,
          target: 'codex-fast',
        },
      })

      expect(context.materialization.spec).toEqual({
        kind: 'target',
        targetName: 'codex-fast',
        targetDir: roots.projectRoot,
      })
      expect(context.materialization.manifest?.targets['codex-fast']).toBeDefined()
      expect(context.resolvedBundle.cwd).toBe(roots.projectRoot)
    } finally {
      roots.cleanup()
    }
  })
})
