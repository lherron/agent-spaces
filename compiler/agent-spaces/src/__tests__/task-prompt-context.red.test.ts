/**
 * T-09860 (amendment r2, EN-20230): the one preparation execution context
 * accepts an optional producer taskContext as a typed prompt input.
 *
 * - taskContext supplies task facts only; preparation identity is unchanged.
 * - A canonical agent scope that states a task refuses a taskContext for a
 *   different task (configured_context_mismatch).
 * - Absent taskContext leaves effectiveEnvironmentHash material unchanged;
 *   present, it joins that material. dispatchEnv never does.
 */

import { describe, expect, test } from 'bun:test'
import type { HrcTaskContext } from 'spaces-runtime-contracts'
import {
  PreparationContextMismatchError,
  buildPreparationExecutionContext,
  hashPreparationEnvironment,
} from '../preparation-execution-context.js'

const ROLE_CONTEXT: HrcTaskContext = {
  taskId: 'T-00042',
  phase: 'implement',
  role: 'implementer',
  requiredEvidenceKinds: ['test-run'],
  hintsText: 'hint',
}

function placement(scopeRef: string) {
  return {
    agentRoot: '/tmp/agents/clod',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task' as const,
    bundle: { kind: 'agent-project' as const, agentName: 'clod', projectRoot: '/tmp/project' },
    correlation: { sessionRef: { scopeRef, laneRef: 'main' } },
  }
}

function build(scopeRef: string, taskContext?: HrcTaskContext) {
  return buildPreparationExecutionContext(placement(scopeRef), {
    promptSources: { aspHome: '/tmp/asp' },
    ambientEnv: { PATH: '/usr/bin' },
    ...(taskContext !== undefined ? { taskContext } : {}),
  })
}

describe('preparation taskContext', () => {
  test('absent taskContext keeps the environment-only hash material', () => {
    const preparation = build('agent:clod:project:demo:task:T-00042')
    expect(preparation.effectiveEnvironmentHash).toBe(
      hashPreparationEnvironment(preparation.execEnv)
    )
    expect(preparation.promptInput.taskContext).toBeUndefined()
  })

  test('present taskContext joins the hash and reaches the prompt input, not the env', () => {
    const without = build('agent:clod:project:demo:task:T-00042')
    const withContext = build('agent:clod:project:demo:task:T-00042', ROLE_CONTEXT)
    expect(withContext.execEnv).toEqual(without.execEnv)
    expect(withContext.effectiveEnvironmentHash).not.toBe(without.effectiveEnvironmentHash)
    expect(withContext.promptInput.taskContext).toEqual(ROLE_CONTEXT)
    const changedHints = build('agent:clod:project:demo:task:T-00042', {
      ...ROLE_CONTEXT,
      hintsText: 'other',
    })
    expect(changedHints.effectiveEnvironmentHash).not.toBe(withContext.effectiveEnvironmentHash)
    expect(
      build('agent:clod:project:demo:task:T-00042', ROLE_CONTEXT).effectiveEnvironmentHash
    ).toBe(withContext.effectiveEnvironmentHash)
  })

  test('a scope task conflicting with taskContext is refused', () => {
    for (const scope of [
      'agent:clod:project:demo:task:T-00001',
      'agent:clod:project:demo:task:primary',
      'agent:clod:project:demo:task:T-00042-b7p',
      'agent:clod:project:demo:task:T-00001:role:implementer',
    ]) {
      expect(() => build(scope, ROLE_CONTEXT)).toThrow(PreparationContextMismatchError)
    }
  })

  test('a role scope without a task segment keeps its identity and gains facts only', () => {
    const preparation = build('agent:clod:project:demo:role:implementer', ROLE_CONTEXT)
    expect(preparation.identity.taskId).toBeUndefined()
    expect(preparation.promptInput.taskId).toBeUndefined()
    expect(preparation.execEnv['AGENT_TASK']).toBeUndefined()
    expect(preparation.promptInput.taskContext).toEqual(ROLE_CONTEXT)
  })
})
