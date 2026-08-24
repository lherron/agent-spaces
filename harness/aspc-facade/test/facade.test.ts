/**
 * Moved from compiler/aspc/test/facade.test.ts by the T-07314 facade split: the
 * cohosted cases now drive the `spaces-aspc-facade` composition bin, which is
 * where the `aspc-facade` executable lives. These are RE-PINS of existing
 * behavior, plus AC-8 (cohosted capability flags, the `true` direction of the
 * flags compiler/aspc/test/compile-only-registration.test.ts pins `false`) and
 * AC-9's success case (compileAndStart starts through the co-hosted broker).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createAgentSpacesClient } from 'agent-spaces'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import { conservativeDefaultLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'
import {
  type Fixture,
  buildCompileRequest,
  createFixture,
  removeFixture,
  startFacadeClient,
} from './helpers'

const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

let fixture: Fixture

beforeEach(() => {
  fixture = createFixture()
  process.env['ASP_CODEX_PATH'] = fixture.codexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
})

afterEach(() => {
  process.env['ASP_CODEX_PATH'] = originalCodexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
  removeFixture(fixture)
})

describe('ASPC cohosted composition facade', () => {
  test('AC-8: co-hosts ASPC and broker and reports cohosted capabilities honestly', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const aspcHello = await client.hello()
      expect(aspcHello.protocolVersion).toBe(ASPC_PROTOCOL_VERSION)
      expect(aspcHello.capabilities.cohostedBroker).toBe(true)
      expect(aspcHello.capabilities.compileAndStart).toBe(true)
      expect(aspcHello.brokerProtocol).toBeDefined()

      const brokerHello = await client.request<BrokerHelloResponse>('broker.hello', {
        clientInfo: { name: 'aspc-facade-test' },
        protocolVersions: ['harness-broker/0.2'],
      })
      expect(brokerHello.protocolVersion).toBe('harness-broker/0.2')
      expect(brokerHello.drivers.length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  })

  test('ASPC compileRuntimePlan is equivalent to SDK compileRuntimePlan', async () => {
    const compileRequest = buildCompileRequest(fixture, 'equivalence')
    const sdk = createAgentSpacesClient({ aspHome: fixture.aspHome })
    const sdkResponse = await sdk.compileRuntimePlan(compileRequest)
    expect(sdkResponse.ok).toBe(true)

    const client = await startFacadeClient(fixture)
    try {
      const rpcResponse = await client.compileRuntimePlan({
        compileRequest,
        aspHome: fixture.aspHome,
      })
      expect(rpcResponse.ok).toBe(true)
      if (!sdkResponse.ok || !rpcResponse.ok) return

      const sdkProfile = sdkResponse.plan.executionProfiles[0] as BrokerExecutionProfile
      const rpcProfile = rpcResponse.plan.executionProfiles[0] as BrokerExecutionProfile
      expect(rpcResponse.plan.compileId).toBe(sdkResponse.plan.compileId)
      expect(rpcResponse.plan.planHash).toBe(sdkResponse.plan.planHash)
      expect(rpcProfile.profileHash).toBe(sdkProfile.profileHash)
      expect(rpcProfile.harnessInvocation.startRequestHash).toBe(
        sdkProfile.harnessInvocation.startRequestHash
      )
      expect(rpcProfile.harnessInvocation.startRequest).toEqual(
        sdkProfile.harnessInvocation.startRequest
      )
    } finally {
      await client.close()
    }
  })

  test('compileHarnessInvocation returns selected profile and exact dispatch start request', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const response = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest(fixture, 'harness_invocation'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
        dispatchEnv: { EXTRA_FLAG: 'aspc' },
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.selectedProfile.brokerDriver).toBe('codex-app-server')
      expect(response.startRequest).toEqual(response.selectedProfile.harnessInvocation.startRequest)
      expect(response.dispatchRequest.startRequest).toEqual(response.startRequest)
      expect(response.dispatchRequest.dispatchEnv).toEqual({ EXTRA_FLAG: 'aspc' })
    } finally {
      await client.close()
    }
  })

  test('compileHarnessInvocation carries lifecycle policy only on dispatch envelope', async () => {
    const client = await startFacadeClient(fixture)
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_aspc_default')
    try {
      const response = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest(fixture, 'harness_invocation_lifecycle'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
        lifecyclePolicy,
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.dispatchRequest.lifecyclePolicy).toEqual(lifecyclePolicy)
      expect(response.dispatchRequest.startRequest).toEqual(response.startRequest)
      expect(JSON.stringify(response.startRequest)).not.toContain('lifecyclePolicy')
    } finally {
      await client.close()
    }
  })

  test('client onRequest/onNotification reject double registration (single-writer contract)', async () => {
    const client = await startFacadeClient(fixture)
    try {
      client.onRequest(async () => undefined)
      expect(() => client.onRequest(async () => undefined)).toThrow(
        'onRequest handler already registered'
      )

      client.onNotification(() => {})
      expect(() => client.onNotification(() => {})).toThrow(
        'onNotification handler already registered'
      )
    } finally {
      await client.close()
    }
  })

  test('AC-9: compileAndStart compiles through ASPC and starts through the co-hosted broker', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const response = await client.compileAndStart({
        compileRequest: buildCompileRequest(fixture, 'compile_and_start'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.compile.dispatchRequest.startRequest).toEqual(response.compile.startRequest)
      expect(response.startResponse.invocationId).toBe(
        response.compile.startRequest.spec.invocationId
      )

      await client.request('invocation.stop', {
        invocationId: response.startResponse.invocationId,
        reason: 'test cleanup',
        graceMs: 100,
      })
      await client.request('invocation.dispose', {
        invocationId: response.startResponse.invocationId,
      })
    } finally {
      await client.close()
    }
  })
})
