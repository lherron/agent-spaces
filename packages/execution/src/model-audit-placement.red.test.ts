import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planPlacementRuntime } from './run/placement-plan.js'

describe('T-04150 placement model pin integrity', () => {
  test('unsupported materialized effective config model is rejected instead of falling back to adapter default', async () => {
    const aspHome = await mkdtemp(join(tmpdir(), 'asp-placement-model-audit-'))
    try {
      const placement = {
        bundle: { kind: 'agent-project' as const, agentName: 'bench-opus' },
      } as Parameters<typeof planPlacementRuntime>[0]['placement']
      const placementContext = {
        resolvedBundle: {
          bundleIdentity: 'bench-opus',
          runMode: 'query',
          cwd: aspHome,
          instructions: [],
          spaces: [],
        },
        materialization: {
          spec: { kind: 'target', targetName: 'bench-opus', targetDir: aspHome },
          effectiveConfig: { model: 'claude/not-real' },
          manifest: undefined,
        },
      } as Parameters<typeof planPlacementRuntime>[0]['placementContext']

      const plan = await planPlacementRuntime({
        placement,
        placementContext,
        frontend: 'claude-code',
        aspHome,
      })

      // Acceptance bar: explicit materialized config is launch-affecting.
      // Green requires this to stay unsupported and name the rejected string;
      // falling back to the adapter default would hide a bad benchmark pin.
      expect(plan.model).toEqual({ ok: false, modelId: 'claude/not-real' })
      expect(plan.runOptions.model).toBeUndefined()
    } finally {
      await rm(aspHome, { recursive: true, force: true })
    }
  })
})
