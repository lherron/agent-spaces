/**
 * RED acceptance bar for T-04150: placement model pin integrity.
 *
 * PASS CONDITIONS:
 * 1. A materialized effective config model is treated as an explicit
 *    launch-affecting model source.
 * 2. If that explicit model is unsupported, placement planning returns the
 *    rejected model string instead of silently falling back to the adapter
 *    default.
 * 3. The negative guard proves supported effective config models still resolve
 *    and are passed through as explicit launch models.
 */

import { describe, expect, test } from 'bun:test'
import type { ResolvedPlacementContext, RuntimePlacement } from 'spaces-config'
import { planPlacementRuntime } from './run/placement-plan.js'

function makePlacementContext(model: string): ResolvedPlacementContext {
  return {
    resolvedBundle: {
      cwd: '/tmp/t04150-project',
      env: {},
    },
    materialization: {
      effectiveConfig: {
        model,
      },
    },
  } as ResolvedPlacementContext
}

const placement = {
  bundle: {
    kind: 'space',
  },
} as RuntimePlacement

describe('placement runtime model validation (T-04150)', () => {
  test('unsupported materialized effective config model is not replaced by adapter default', async () => {
    const plan = await planPlacementRuntime({
      placement,
      placementContext: makePlacementContext('claude/not-real'),
      frontend: 'claude-code',
      aspHome: '/tmp/t04150-asp-home',
    })

    expect(plan.model).toEqual({ ok: false, modelId: 'claude/not-real' })
  })

  test('supported materialized effective config model remains an explicit launch model', async () => {
    const plan = await planPlacementRuntime({
      placement,
      placementContext: makePlacementContext('claude-opus-4-6'),
      frontend: 'claude-code',
      aspHome: '/tmp/t04150-asp-home',
    })

    expect(plan.model).toEqual(
      expect.objectContaining({
        ok: true,
        info: expect.objectContaining({
          effectiveModel: 'claude-opus-4-6',
          model: 'claude-opus-4-6',
          explicit: true,
        }),
      })
    )
    expect(plan.runOptions.model).toBe('claude-opus-4-6')
  })
})
