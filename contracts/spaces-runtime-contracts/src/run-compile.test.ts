import { describe, expect, test } from 'bun:test'

import type {
  CompileRuntimeFn,
  PlacementRuntimeModelResolution,
  PlacementRuntimePlan,
  RunCompileOutcome,
  RunCompilerDebugContext,
  RunLaunchShape,
} from './index.js'

describe('compile/run bridge contracts', () => {
  test('the runtime compiler capability preserves its context and launch DTOs', async () => {
    const context: RunCompilerDebugContext = {
      aspHome: '/tmp/asp-home',
      placement: { kind: 'agent-project' },
      requested: { modelProvider: 'openai', preferredHarnessRuntime: 'codex-cli' },
      materialization: { initialPrompt: 'hello' },
      hrcPolicy: { yolo: true },
      correlation: { appSessionKey: 'session-1', scopeRef: 'agent:cody' },
    }
    const foreground: RunLaunchShape = {
      command: 'codex',
      args: ['exec'],
      env: { ASP_HOME: context.aspHome },
    }
    const compileRuntime: CompileRuntimeFn = async (received) => {
      const outcome: RunCompileOutcome = {
        ok: true,
        request: received,
        response: { ok: true },
        foreground,
      }
      return outcome
    }

    const result = await compileRuntime(context)
    expect(result.request).toBe(context)
    expect(result.foreground).toEqual(foreground)
  })

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
