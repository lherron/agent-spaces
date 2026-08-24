import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AspcCompileHarnessInvocationRequest, AspcProfileSelector } from 'spaces-aspc-protocol'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import type { AspcCompiler } from '../src/service.js'
import { createAspcService } from '../src/service.js'

// These unit tests exercise the failure/diagnostic branches of `AspcService`
// using an injected `compiler` stub, without spawning a subprocess facade
// (harness/aspc-facade/test/facade.test.ts covers the E2E happy path). They
// cover:
//  - compileRuntimePlan `compiler_exception`
//  - compileHarnessInvocation `broker_profile_missing` / `broker_profile_ambiguous`
//    and the single-match (length === 1) happy path (A5 regression guard)
//
// `compileAndStart` coverage moved to harness/aspc-facade/test/ with the start
// plane itself (T-07314 facade split).

const COMPILE_REQUEST = {
  schemaVersion: 'agent-runtime-compile-request/v1',
  placement: {},
} as unknown as RuntimeCompileRequest

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

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('missing package version')
  return manifest.version
}

describe('AspcService.hello', () => {
  test('facadeInfo.version matches package.json version', async () => {
    const service = createAspcService({})
    const response = await service.hello({})
    expect(response.facadeInfo.version).toBe(packageVersion())
  })
})

describe('AspcService.compileRuntimePlan', () => {
  test('wraps a throwing compiler into a compiler_exception diagnostic', async () => {
    const service = createAspcService({
      compiler: async () => {
        throw new Error('boom from compiler')
      },
    })

    const response = await service.compileRuntimePlan({ compileRequest: COMPILE_REQUEST })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.diagnostics).toHaveLength(1)
    const [diagnostic] = response.diagnostics
    expect(diagnostic?.code).toBe('compiler_exception')
    expect(diagnostic?.message).toBe('boom from compiler')
    expect(diagnostic?.plane).toBe('asp-compiler')
  })
})

describe('AspcService.compileHarnessInvocation profile selection', () => {
  test('returns ok for exactly one matched profile (single-match path)', async () => {
    const profile = fakeProfile({ profileId: 'only-one' })
    const service = createAspcService({
      compiler: compilerReturning(okPlanResponse([profile])),
    })

    const response = await service.compileHarnessInvocation(buildRequest())
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.selectedProfile.profileId).toBe('only-one')
    expect(response.startRequest).toEqual(profile.harnessInvocation.startRequest)
  })

  test('single-match path returns ok even with a narrowing selector', async () => {
    const match = fakeProfile({ profileId: 'wanted', brokerDriver: 'codex-app-server' })
    const other = fakeProfile({ profileId: 'unwanted', brokerDriver: 'claude-code-tmux' })
    const service = createAspcService({
      compiler: compilerReturning(okPlanResponse([match, other])),
    })

    const response = await service.compileHarnessInvocation(
      buildRequest({ brokerDriver: 'codex-app-server' })
    )
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.selectedProfile.profileId).toBe('wanted')
  })

  test('reports broker_profile_missing when no profile matches', async () => {
    const service = createAspcService({
      compiler: compilerReturning(
        okPlanResponse([fakeProfile({ brokerDriver: 'codex-app-server' })])
      ),
    })

    const response = await service.compileHarnessInvocation(
      buildRequest({ brokerDriver: 'does-not-exist' })
    )
    expect(response.ok).toBe(false)
    if (response.ok) return
    const codes = response.diagnostics.map((d) => d.code)
    expect(codes).toContain('broker_profile_missing')
  })

  test('reports broker_profile_ambiguous when multiple profiles match', async () => {
    const service = createAspcService({
      compiler: compilerReturning(
        okPlanResponse([
          fakeProfile({ profileId: 'a', brokerDriver: 'codex-app-server' }),
          fakeProfile({ profileId: 'b', brokerDriver: 'codex-app-server' }),
        ])
      ),
    })

    const response = await service.compileHarnessInvocation(
      buildRequest({ brokerDriver: 'codex-app-server' })
    )
    expect(response.ok).toBe(false)
    if (response.ok) return
    const codes = response.diagnostics.map((d) => d.code)
    expect(codes).toContain('broker_profile_ambiguous')
  })

  test('propagates compile failure diagnostics unchanged', async () => {
    const service = createAspcService({
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

    const response = await service.compileHarnessInvocation(buildRequest())
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.diagnostics.map((d) => d.code)).toEqual(['upstream_failure'])
    expect(response.compileResponse.ok).toBe(false)
  })
})
