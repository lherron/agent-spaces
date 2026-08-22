/**
 * Moved from packages/aspc/test/service.test.ts and
 * packages/aspc/test/hygiene-surfacing.test.ts by the T-07314 facade split:
 * `compileAndStart` is no longer part of `spaces-aspc`'s `AspcService`, so its
 * unit coverage moves to the composition package that owns the start plane.
 *
 * These re-pins carry AC-9's failure clauses: a compile failure and a
 * profile-selection failure must short-circuit to the `ok: false` shape WITHOUT
 * calling `broker.start`. The success clause is pinned end-to-end over the real
 * bin in facade.test.ts.
 *
 * The old "throws when no co-hosted broker is configured" case is deliberately
 * NOT carried over: after the split there is no broker-less compileAndStart to
 * guard — packages/aspc/test/compile-only-contract.test.ts (AC-5) pins that the
 * member is gone from the compile-only service entirely.
 */
import { describe, expect, test } from 'bun:test'
import type { AspcCompiler } from 'spaces-aspc'
import type { AspcCompileHarnessInvocationRequest, AspcProfileSelector } from 'spaces-aspc-protocol'
import type { Broker } from 'spaces-harness-broker'
import type {
  BrokerExecutionProfile,
  CompileDiagnostic,
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { createCohostedAspcService } from '../src/index.js'

const COMPILE_REQUEST = {
  schemaVersion: 'agent-runtime-compile-request/v1',
  placement: {},
} as unknown as RuntimeCompileRequest

const HYGIENE_DIAGNOSTIC: CompileDiagnostic = {
  level: 'error',
  code: 'materialization_hygiene_error',
  message: 'broken pointer to ./does-not-exist.md',
  plane: 'asp-compiler',
  details: {
    spaceKey: 'probe@b1b2b3b',
    pluginPath: '/tmp/staging/probe',
    code: 'W421',
    severity: 'error',
    path: 'skills/probe-skill/SKILL.md',
  },
}

function fakeProfile(overrides: Partial<BrokerExecutionProfile> = {}): BrokerExecutionProfile {
  return {
    kind: 'harness-broker',
    profileId: 'profile-1',
    profileHash: 'hash-1',
    brokerDriver: 'codex-app-server',
    harnessInvocation: {
      startRequest: { spec: { invocationId: 'inv-1' } },
      startRequestHash: 'start-hash-1',
    },
    ...overrides,
  } as unknown as BrokerExecutionProfile
}

function okPlanResponse(
  profiles: BrokerExecutionProfile[]
): Extract<RuntimeCompileResponse, { ok: true }> {
  const plan = {
    schemaVersion: 'agent-runtime-plan/v1',
    executionProfiles: profiles,
  } as unknown as CompiledRuntimePlan
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan,
    diagnostics: [],
  }
}

function compilerReturning(response: RuntimeCompileResponse): AspcCompiler {
  return async () => response
}

function buildRequest(selector?: AspcProfileSelector): AspcCompileHarnessInvocationRequest {
  return {
    compileRequest: COMPILE_REQUEST,
    ...(selector !== undefined ? { profileSelector: selector } : {}),
  }
}

function recordingBroker(): { broker: Broker; startCalled: () => boolean } {
  let startCalled = false
  const broker = {
    start: async () => {
      startCalled = true
      return {} as never
    },
  } as unknown as Broker
  return { broker, startCalled: () => startCalled }
}

describe('cohosted compileAndStart', () => {
  test('AC-9: short-circuits with ok:false when compilation fails (broker.start not called)', async () => {
    const { broker, startCalled } = recordingBroker()
    const service = createCohostedAspcService({
      broker,
      compiler: compilerReturning({
        schemaVersion: 'agent-runtime-compile-response/v1',
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
    })

    const response = await service.compileAndStart(buildRequest())
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.schemaVersion).toBe('aspc-compile-and-start-response/v1')
    expect(response.compile.ok).toBe(false)
    expect(response.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['upstream_failure'])
    expect(startCalled()).toBe(false)
  })

  test('AC-9: short-circuits when profile selection fails (broker.start not called)', async () => {
    const { broker, startCalled } = recordingBroker()
    const service = createCohostedAspcService({
      broker,
      compiler: compilerReturning(
        okPlanResponse([fakeProfile({ brokerDriver: 'codex-app-server' })])
      ),
    })

    const response = await service.compileAndStart(buildRequest({ brokerDriver: 'no-match' }))
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.compile.ok).toBe(false)
    expect(startCalled()).toBe(false)
  })

  test('compileAndStart short-circuits with the typed hygiene diagnostics; broker.start not called', async () => {
    const { broker, startCalled } = recordingBroker()
    const service = createCohostedAspcService({
      broker,
      compiler: compilerReturning({
        schemaVersion: 'agent-runtime-compile-response/v1',
        ok: false,
        diagnostics: [HYGIENE_DIAGNOSTIC],
      }),
    })

    const response = await service.compileAndStart(buildRequest())
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.compile.ok).toBe(false)
    const codes = response.diagnostics.map((diagnostic) => diagnostic.code)
    expect(codes).toContain('materialization_hygiene_error')
    expect(codes).not.toContain('compiler_exception')
    expect(startCalled()).toBe(false)
  })
})
