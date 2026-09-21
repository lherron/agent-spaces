/**
 * Moved from harness/aspc/test/facade.test.ts by the T-07314 facade split: the
 * cohosted cases now drive the `spaces-aspc-facade` composition bin, which is
 * where the `aspc-facade` executable lives. These are RE-PINS of existing
 * behavior, plus the selector-free cutover: the cohosted transport advertises
 * the broker separately, while ordinary compilation is one
 * `aspc.compileHarnessInvocation` request whose dispatch result is passed to
 * `invocation.start` without a second ASPC operation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import { conservativeDefaultLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import {
  type Fixture,
  buildCompileRequest,
  createFixture,
  probeServed,
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
  test('co-hosts a broker but exposes one ordinary ASPC compile operation', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const aspcHello = await client.hello()
      expect(aspcHello.protocolVersion).toBe(ASPC_PROTOCOL_VERSION)
      expect(aspcHello.capabilities.cohostedBroker).toBe(true)
      expect(aspcHello.capabilities).not.toHaveProperty('compileAndStart')
      expect(aspcHello.brokerProtocol).toBeDefined()
      expect(await probeServed(client, 'aspc.compileAndStart', {})).toBe(false)
      expect(await probeServed(client, 'aspc.compileRuntimePlan', {})).toBe(false)

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

  test('compileHarnessInvocation returns one execution and one canonical dispatch request', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const response = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest(fixture, 'harness_invocation'),
        aspHome: fixture.aspHome,
        dispatchEnv: { EXTRA_FLAG: 'aspc' },
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.plan.execution.driver).toBe('codex-app-server')
      expect(response.plan.execution.dispatchRequest.dispatchEnv).toEqual({ EXTRA_FLAG: 'aspc' })
      expect(response).not.toHaveProperty('selectedProfile')
      expect(response).not.toHaveProperty('startRequest')
      expect(response).not.toHaveProperty('dispatchRequest')
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
        lifecyclePolicy,
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.plan.execution.dispatchRequest.lifecyclePolicy).toEqual(lifecyclePolicy)
      expect(JSON.stringify(response.plan.execution.dispatchRequest.startRequest)).not.toContain(
        'lifecyclePolicy'
      )
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

  test('starts the compiled canonical dispatch through the separate broker route', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const compile = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest(fixture, 'compile_and_start'),
        aspHome: fixture.aspHome,
      })
      expect(compile.ok).toBe(true)
      if (!compile.ok) return

      const startResponse = await client.request<{ invocationId: string }>('invocation.start', {
        ...compile.plan.execution.dispatchRequest,
      })

      expect(startResponse.invocationId).toBe(
        compile.plan.execution.dispatchRequest.startRequest.spec.invocationId
      )

      await client.request('invocation.stop', {
        invocationId: startResponse.invocationId,
        reason: 'test cleanup',
        graceMs: 100,
      })
      await client.request('invocation.dispose', {
        invocationId: startResponse.invocationId,
      })
    } finally {
      await client.close()
    }
  })
})
