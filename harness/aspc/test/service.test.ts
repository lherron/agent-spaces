import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AspcCompileHarnessInvocationRequest } from 'spaces-aspc-protocol'
import type {
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import type { AspcCompiler } from '../src/service.js'
import { createAspcService } from '../src/service.js'

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

const PLAN = {
  schemaVersion: 'agent-runtime-plan/v2',
  execution: {
    driver: 'codex-app-server',
    protocol: 'harness-broker/0.2',
    profile: {
      profileId: 'profile-1',
      profileHash: 'profile-hash-1',
      compatibilityHash: 'compatibility-hash-1',
      startRequestHash: 'start-hash-1',
    },
    dispatchRequest: {
      startRequest: { spec: { invocationId: 'inv-1', driver: { kind: 'codex-app-server' } } },
      dispatchEnv: {},
      runtime: {},
      lifecyclePolicy: {},
    },
  },
} as unknown as CompiledRuntimePlan

const OK_RESPONSE: Extract<RuntimeCompileResponse, { ok: true }> = {
  schemaVersion: 'agent-runtime-compile-response/v2',
  ok: true,
  plan: PLAN,
  diagnostics: [],
}

function compilerReturning(response: RuntimeCompileResponse): AspcCompiler {
  return async () => response
}

function buildRequest(): AspcCompileHarnessInvocationRequest {
  return { compileRequest: COMPILE_REQUEST }
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('missing package version')
  return manifest.version
}

describe('AspcService', () => {
  test('hello reports the package version and one ordinary compile capability', async () => {
    const response = await createAspcService({}).hello({})
    expect(response.facadeInfo.version).toBe(packageVersion())
    expect(response.capabilities.compileHarnessInvocation).toBe(true)
    expect(response.capabilities).not.toHaveProperty('compileRuntimePlan')
  })

  test('returns the compiler singular plan without selecting or echoing a profile', async () => {
    const response = await createAspcService({
      compiler: compilerReturning(OK_RESPONSE),
    }).compileHarnessInvocation(buildRequest())

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.schemaVersion).toBe('aspc-compile-harness-invocation-response/v2')
    expect(response.plan).toBe(PLAN)
    expect(response.plan.execution.driver).toBe('codex-app-server')
    expect(response).not.toHaveProperty('selectedProfile')
    expect(response).not.toHaveProperty('startRequest')
    expect(response).not.toHaveProperty('dispatchRequest')
  })

  test('threads dispatch overlays into the single compiler call', async () => {
    let observedOptions: Parameters<AspcCompiler>[1]
    const compiler: AspcCompiler = async (_request, options) => {
      observedOptions = options
      return OK_RESPONSE
    }
    const service = createAspcService({ compiler })
    await service.compileHarnessInvocation({
      ...buildRequest(),
      dispatchEnv: { EXTRA: '1' },
      runtime: { runtimeId: 'runtime-1' },
      lifecyclePolicy: { runtimeRetention: 'keep-alive' },
    })
    expect(observedOptions?.dispatch).toEqual({
      dispatchEnv: { EXTRA: '1' },
      runtime: { runtimeId: 'runtime-1' },
      lifecyclePolicy: { runtimeRetention: 'keep-alive' },
    })
  })

  test('wraps a throwing compiler into a compiler_exception diagnostic', async () => {
    const response = await createAspcService({
      compiler: async () => {
        throw new Error('boom from compiler')
      },
    }).compileHarnessInvocation(buildRequest())

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.schemaVersion).toBe('aspc-compile-harness-invocation-response/v2')
    expect(response.diagnostics).toHaveLength(1)
    expect(response.diagnostics[0]).toMatchObject({
      code: 'compiler_exception',
      message: 'boom from compiler',
      plane: 'asp-compiler',
    })
  })

  test('propagates compile failure diagnostics without a nested legacy response', async () => {
    const response = await createAspcService({
      compiler: compilerReturning({
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [
          {
            level: 'error',
            code: 'upstream_failure',
            message: 'compile failed',
            plane: 'asp-compiler',
          },
        ],
      }),
    }).compileHarnessInvocation(buildRequest())

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['upstream_failure'])
    expect(response).not.toHaveProperty('compileResponse')
  })
})
