import { describe, expect, test } from 'bun:test'

import type { PlacementRuntimeModelResolution, PlacementRuntimePlan } from './index.js'

describe('compile/run bridge contracts', () => {
  test('the generic placement plan preserves successful and failed model resolution', () => {
    type Plan = PlacementRuntimePlan<'codex-cli', 'codex', 'openai', { yolo?: boolean }>
    const success: PlacementRuntimeModelResolution = {
      ok: true,
      info: {
        effectiveModel: 'openai/gpt-5',
        provider: 'openai',
        model: 'gpt-5',
        explicit: true,
      },
    }
    const failure: PlacementRuntimeModelResolution = { ok: false, modelId: 'missing' }
    const plan: Plan = {
      frontend: 'codex-cli',
      harnessId: 'codex',
      provider: 'openai',
      cwd: '/workspace',
      defaultRunOptions: {},
      model: success,
      runOptions: { yolo: true },
    }

    expect(plan.model).toEqual(success)
    expect(failure).toEqual({ ok: false, modelId: 'missing' })
  })
})
