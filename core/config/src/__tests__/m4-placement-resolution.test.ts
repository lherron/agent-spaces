/**
 * Tests for M4: Placement-driven resolution and audit metadata.
 *
 * Tests for the placement resolver, ResolvedRuntimeBundle audit output, and
 * the projectRoot-never-implies-target guard.
 *
 * Updated by T-01564: collapsed RuntimeBundleRef union to {agent-project, compose}.
 *
 * wrkq tasks: T-00856 (types), T-00857 (placement resolver),
 *             T-00858 (audit metadata), T-00859 (projectRoot guard)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTempFixtureRoots } from '../test-support/v2-fixtures.js'

// ===================================================================
// T-00857: Placement resolver
// ===================================================================
describe('placement resolver (T-00857)', () => {
  let tempDir: string
  let agentRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
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

  test.each<{
    row: string
    cwd?: string
    withProjectRoot: boolean
    expected: 'cwd' | 'project' | 'agent'
  }>([
    {
      row: 'explicit cwd -> that cwd',
      cwd: '/custom/working/dir',
      withProjectRoot: true,
      expected: 'cwd',
    },
    { row: 'projectRoot, no cwd -> projectRoot', withProjectRoot: true, expected: 'project' },
    { row: 'no projectRoot, no cwd -> agentRoot', withProjectRoot: false, expected: 'agent' },
  ])(
    'resolved cwd is the explicit cwd, else projectRoot, else agentRoot: $row',
    async ({ cwd, withProjectRoot, expected }) => {
      const { resolvePlacement } = await import('../resolver/placement-resolver.js')

      const result = await resolvePlacement({
        agentRoot,
        ...(withProjectRoot ? { projectRoot } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        runMode: 'query',
        bundle: {
          kind: 'agent-project',
          agentName: 'alice',
          ...(withProjectRoot ? { projectRoot } : {}),
        },
      })

      expect<string | undefined>(result.cwd).toBe(
        expected === 'cwd' ? cwd : expected === 'project' ? projectRoot : agentRoot
      )
    }
  )
})

// ===================================================================
// T-00858: ResolvedRuntimeBundle audit metadata
// ===================================================================
describe('ResolvedRuntimeBundle audit metadata (T-00858)', () => {
  let tempDir: string
  let agentRoot: string

  beforeEach(() => {
    const roots = createTempFixtureRoots()
    tempDir = roots.tempDir
    agentRoot = roots.agentRoot
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('instruction contentHash hashes the instruction file bytes and spaces carry their resolved key and integrity', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const result = await resolvePlacement({
      agentRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'alice' },
    })

    const sha256 = (input: string | Buffer) =>
      `sha256:${createHash('sha256').update(input).digest('hex')}`
    expect(result.instructions.find((i) => i.slot === 'soul')).toEqual({
      slot: 'soul',
      ref: 'agent-root:///SOUL.md',
      contentHash: sha256(readFileSync(join(agentRoot, 'SOUL.md'))),
    })
    // Audit integrity for an agent-local space is derived from its directory path
    // (placement-resolver computeDirectoryHash); full content integrity is install's job.
    expect(result.spaces).toEqual([
      {
        ref: 'space:agent:private-ops',
        resolvedKey: 'private-ops@agent',
        integrity: sha256(`dir:${join(agentRoot, 'spaces', 'private-ops')}`),
      },
    ])
  })

  test('bundleIdentity is stable for the same placement and changes with the bundle', async () => {
    const { resolvePlacement } = await import('../resolver/placement-resolver.js')

    const placement = {
      agentRoot,
      runMode: 'query' as const,
      bundle: { kind: 'agent-project' as const, agentName: 'alice' },
    }

    const result1 = await resolvePlacement(placement)
    const result2 = await resolvePlacement(placement)
    const otherAgent = await resolvePlacement({
      ...placement,
      bundle: { kind: 'agent-project', agentName: 'bob' },
    })
    const compose = await resolvePlacement({
      ...placement,
      bundle: { kind: 'compose', compose: ['space:agent:private-ops@dev'] as any[] },
    })

    expect(result1.bundleIdentity).toBe(result2.bundleIdentity)
    expect(otherAgent.bundleIdentity).not.toBe(result1.bundleIdentity)
    expect(compose.bundleIdentity).not.toBe(result1.bundleIdentity)
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
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 4\n\n[spaces]\nbase = []\n')
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
version = 4
priming = "Agent prompt"

[identity]
role = "worker"

[spaces]
base = ["space:agent-base@dev"]

[provisioning]
harness = "codex"
model = "gpt-5.5"
`
      )

      writeFileSync(
        join(projectRoot, 'asp-targets.toml'),
        `
schema = 2

[targets.smokey]
compose_mode = "merge"
compose = ["space:project-extra@dev"]
priming_append = "Project append"

[targets.smokey.provisioning]
harness = "codex"
yolo = true
model = "gpt-5.3-codex"

[targets.smokey.provisioning.codex]
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
        priming: 'Agent prompt\nProject append',
        yolo: true,
        harness: 'codex',
        model: 'gpt-5.3-codex',
      })
      expect(context.materialization.manifest?.targets['smokey']).toMatchObject({
        compose: ['space:agent-base@dev', 'space:project-extra@dev'],
        priming: 'Agent prompt\nProject append',
        provisioning: expect.objectContaining({ yolo: true, harness: 'codex' }),
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
