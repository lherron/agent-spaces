import { describe, expect, test } from 'bun:test'
import type { AspcCompiler } from 'spaces-aspc'
import type { AspcCompileHarnessInvocationRequest } from 'spaces-aspc-protocol'
import type { Broker } from 'spaces-harness-broker'
import type {
  CompileDiagnostic,
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { createCohostedAspcService } from '../src/index.js'

const COMPILE_REQUEST = {
  schemaVersion: 'agent-runtime-compile-request/v2',
  agent: { id: 'cody' },
  identity: {},
  placement: {},
  requested: { harness: 'codex', presentation: false },
  materialization: {},
  hrcPolicy: {},
  correlation: {},
} as unknown as RuntimeCompileRequest

const DISPATCH = {
  startRequest: {
    spec: { invocationId: 'inv-1', driver: { kind: 'codex-app-server' } },
  },
  dispatchEnv: { EXTRA: '1' },
  runtime: { runtimeId: 'runtime-1' },
  lifecyclePolicy: { runtimeRetention: 'keep-alive' },
}

const PLAN = {
  schemaVersion: 'agent-runtime-plan/v2',
  execution: {
    driver: 'codex-app-server',
    protocol: 'harness-broker/0.2',
    dispatchRequest: DISPATCH,
  },
} as unknown as CompiledRuntimePlan

const HYGIENE_DIAGNOSTIC: CompileDiagnostic = {
  level: 'error',
  code: 'materialization_hygiene_error',
  message: 'broken pointer to ./does-not-exist.md',
  plane: 'asp-compiler',
}

function compilerReturning(response: RuntimeCompileResponse): AspcCompiler {
  return async () => response
}

function buildRequest(): AspcCompileHarnessInvocationRequest {
  return { compileRequest: COMPILE_REQUEST }
}

function recordingBroker(): {
  broker: Broker
  calls: unknown[][]
} {
  const calls: unknown[][] = []
  const broker = {
    start: async (...args: unknown[]) => {
      calls.push(args)
      return { invocationId: 'inv-1' }
    },
  } as unknown as Broker
  return { broker, calls }
}

describe('cohosted compileAndStart', () => {
  test('starts exactly the canonical dispatch request from the singular execution', async () => {
    const { broker, calls } = recordingBroker()
    const service = createCohostedAspcService({
      broker,
      compiler: compilerReturning({
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: true,
        plan: PLAN,
        diagnostics: [],
      }),
    })

    const response = await service.compileAndStart(buildRequest())
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.compile.plan.execution.dispatchRequest).toBe(DISPATCH)
    expect(response.startResponse.invocationId).toBe('inv-1')
    expect(calls).toEqual([
      [DISPATCH.startRequest, DISPATCH.dispatchEnv, DISPATCH.runtime, DISPATCH.lifecyclePolicy],
    ])
  })

  test('compile failure short-circuits without calling broker.start', async () => {
    const { broker, calls } = recordingBroker()
    const service = createCohostedAspcService({
      broker,
      compiler: compilerReturning({
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [HYGIENE_DIAGNOSTIC],
      }),
    })

    const response = await service.compileAndStart(buildRequest())
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.compile.ok).toBe(false)
    expect(response.diagnostics).toEqual([HYGIENE_DIAGNOSTIC])
    expect(calls).toEqual([])
  })
})
