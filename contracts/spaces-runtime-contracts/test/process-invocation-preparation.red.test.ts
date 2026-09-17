/**
 * T-08577 behavior reds for the canonical direct-process preparation shape.
 *
 * These tests deliberately drive the existing `toProcessInvocationSpec` adapter
 * rather than importing a future contract module. The first test is the passing
 * legacy control; the remaining assertions pin the additive structured prompt
 * behavior required by T-08574 B2. A collected assertion failure here means the
 * adapter returned the old optional prompt shape, not that a module failed to
 * load.
 */
import { describe, expect, test } from 'bun:test'
import {
  type PreparedPlacementCliRuntime,
  toProcessInvocationSpec,
} from '../../../compiler/agent-spaces/src/prepare-cli-runtime.js'
import type { BuildProcessInvocationSpecRequest } from '../../../compiler/agent-spaces/src/types.js'

function request(): BuildProcessInvocationSpecRequest {
  return {
    aspHome: '/tmp/t08577-asp-home',
    spec: { spaces: [] },
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    ioMode: 'pipes',
    cwd: '/tmp/t08577-project',
  }
}

function prepared(input: {
  systemPrompt?: { content: string; mode: 'append' | 'replace'; path: string }
  expandedPrompt?: string
}): PreparedPlacementCliRuntime {
  return {
    placement: {} as PreparedPlacementCliRuntime['placement'],
    placementContext: {} as PreparedPlacementCliRuntime['placementContext'],
    resolvedBundle: { bundleIdentity: 'bundle-t08577' } as NonNullable<
      PreparedPlacementCliRuntime['resolvedBundle']
    >,
    runtimePlan: { provider: 'openai' } as PreparedPlacementCliRuntime['runtimePlan'],
    materialized: {} as PreparedPlacementCliRuntime['materialized'],
    ...(input.systemPrompt !== undefined
      ? {
          systemPrompt: {
            ...input.systemPrompt,
            contentHash: 'sha256-system',
          },
        }
      : {}),
    ...(input.expandedPrompt !== undefined ? { expandedPrompt: input.expandedPrompt } : {}),
    omitPriming: false,
    imageAttachmentPaths: [],
    runOptions: {} as PreparedPlacementCliRuntime['runOptions'],
    detection: { available: true, path: '/usr/bin/codex' },
    commandPath: '/usr/bin/codex',
    args: ['app-server'],
    argv: ['/usr/bin/codex', 'app-server'],
    lockedEnv: {},
    dispatchEnv: { CALLER_FLAG: 'kept' },
    env: { CALLER_FLAG: 'kept' },
    pathPrepend: [],
    cwd: '/tmp/t08577-project',
    displayCommand: '/usr/bin/codex app-server',
    warnings: ['control-warning'],
  }
}

describe('canonical ProcessInvocationSpec preparation contract (T-08577)', () => {
  test('control: the existing adapter preserves every non-prompt process field', () => {
    const result = toProcessInvocationSpec(prepared({}), request())

    expect(result).toMatchObject({
      spec: {
        provider: 'openai',
        frontend: 'codex-cli',
        argv: ['/usr/bin/codex', 'app-server'],
        cwd: '/tmp/t08577-project',
        env: { CALLER_FLAG: 'kept' },
        interactionMode: 'headless',
        ioMode: 'pipes',
        displayCommand: '/usr/bin/codex app-server',
      },
      resolvedBundle: { bundleIdentity: 'bundle-t08577' },
      warnings: ['control-warning'],
    })
    expect(Object.hasOwn(result.spec, 'worker')).toBe(false)
  })

  test('B2: every prepared invocation carries authoritative null prompt keys', () => {
    const result = toProcessInvocationSpec(prepared({}), request())

    expect(result.spec.prompts).toEqual({
      system: null,
      priming: null,
    })
  })

  test('B2: system and priming content are both explicit structured launch material', () => {
    const result = toProcessInvocationSpec(
      prepared({
        systemPrompt: {
          content: 'SYSTEM-CONTENT-T08577',
          mode: 'append',
          path: '/tmp/t08577-artifacts/system-prompt.md',
        },
        expandedPrompt: 'PRIMING-CONTENT-T08577',
      }),
      request()
    )

    expect(result.spec.prompts).toEqual({
      system: {
        content: 'SYSTEM-CONTENT-T08577',
        mode: 'append',
        sourcePath: '/tmp/t08577-artifacts/system-prompt.md',
      },
      priming: { content: 'PRIMING-CONTENT-T08577' },
    })
  })
})
