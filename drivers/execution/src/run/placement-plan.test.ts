import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import type { ProjectManifest, SpaceRefString } from 'spaces-config'

import { useTempDirs } from '../../test/temp-dirs.js'
import { harnessRegistry } from '../harness/index.js'
import {
  type PlanPlacementRuntimeOptions,
  planPlacementRuntime,
  planProjectTargetRuntime,
} from './placement-plan.js'

const createTempDir = useTempDirs()

const claudeExecution = {
  harnessId: 'claude' as const,
  adapter: harnessRegistry.getOrThrow('claude'),
  frontend: 'claude-code' as const,
  provider: 'anthropic' as const,
}

/** Minimal agent-project placement whose bundle resolves to `cwd`. */
function agentProjectPlacement(
  agentName: string,
  cwd: string
): Pick<PlanPlacementRuntimeOptions, 'placement' | 'placementContext'> {
  return {
    placement: {
      bundle: { kind: 'agent-project', agentName },
    } as unknown as PlanPlacementRuntimeOptions['placement'],
    placementContext: {
      materialization: { manifest: undefined, effectiveConfig: undefined },
      resolvedBundle: { cwd },
    } as unknown as PlanPlacementRuntimeOptions['placementContext'],
  }
}

describe('placement runtime planner (T-01097)', () => {
  test('planPlacementRuntime resolves frontend, harness, model, and runOptions', async () => {
    const aspHome = await createTempDir('placement-plan-')

    const plan = await planPlacementRuntime({
      ...agentProjectPlacement('test-agent', aspHome),
      execution: claudeExecution,
      aspHome,
    })

    expect(plan.frontend).toBe('claude-code')
    expect(plan.harnessId).toBe('claude')
    expect(plan.cwd).toBe(aspHome)
    expect(plan.runOptions.aspHome).toBe(aspHome)
    expect(plan.runOptions.projectPath).toBe(aspHome)
    expect(plan.runOptions.cwd).toBe(aspHome)
    // Model resolution returns the discriminated union shape
    expect(plan.model.ok === true || plan.model.ok === false).toBe(true)
  })

  test('planPlacementRuntime rejects an adapter identity that disagrees with its resolved harness', async () => {
    const aspHome = await createTempDir('placement-plan-bad-')

    await expect(
      planPlacementRuntime({
        ...agentProjectPlacement('x', aspHome),
        execution: {
          ...claudeExecution,
          harnessId: 'codex',
        },
        aspHome,
      })
    ).rejects.toThrow(/Resolved adapter identity mismatch/)
  })
})

describe('project-target runtime planner (T-01099)', () => {
  test('requires a compiler-resolved adapter rather than reading retired SDK declarations', async () => {
    const root = await createTempDir('proj-target-retired-sdk-')
    const manifest: ProjectManifest = {
      schema: 2,
      targets: {
        sdk_target: {
          compose: [],
          // Deliberately invalid declaration: retired ids never parse from
          // TOML, but the planner layer must still refuse them (T-01099).
          provisioning: { harness: 'pi-sdk' as never },
        },
      },
    }

    expect(() =>
      planProjectTargetRuntime(manifest, 'sdk_target', {
        aspHome: join(root, 'asp-home'),
        projectPath: root,
        execution: {
          harnessId: 'claude',
          adapter: harnessRegistry.getOrThrow('codex'),
        },
      })
    ).toThrow(/Resolved adapter identity mismatch/)
  })

  test('continues planning every retained project harness', async () => {
    const root = await createTempDir('proj-target-retained-harness-')
    const manifest: ProjectManifest = {
      schema: 2,
      targets: { retained_target: { compose: [] } },
    }

    for (const harnessId of ['agent-harness', 'claude', 'codex', 'muse'] as const) {
      const plan = planProjectTargetRuntime(manifest, 'retained_target', {
        aspHome: join(root, 'asp-home'),
        projectPath: root,
        execution: { harnessId, adapter: harnessRegistry.getOrThrow(harnessId) },
      })
      expect(plan.harnessId).toBe(harnessId)
      expect(plan.adapter).toBe(harnessRegistry.getOrThrow(harnessId))
    }
  })

  test('planProjectTargetRuntime resolves a project target into a runtime plan', async () => {
    const aspHome = await createTempDir('proj-target-plan-')
    const manifest = {
      schema: 2 as const,
      targets: {
        my_target: {
          compose: ['space:defaults@stable' as SpaceRefString],
          priming: 'hello',
        },
      },
    }

    const plan = planProjectTargetRuntime(manifest, 'my_target', {
      aspHome,
      projectPath: aspHome,
      execution: { harnessId: 'claude', adapter: harnessRegistry.getOrThrow('claude') },
    })

    expect(plan.harnessId).toBe('claude')
    expect(plan.adapter.id).toBe('claude')
    expect(plan.target).toEqual(manifest.targets.my_target)
    expect(plan.defaultPrompt).toBe('hello')
  })
})
