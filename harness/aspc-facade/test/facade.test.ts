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

  test('a compiled dispatch carrying dispatchEnv and lifecyclePolicy starts through invocation.start', async () => {
    const client = await startFacadeClient(fixture)
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_aspc_start')
    try {
      const compile = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest(fixture, 'compile_and_start'),
        aspHome: fixture.aspHome,
        dispatchEnv: { EXTRA_FLAG: 'aspc-start' },
        lifecyclePolicy,
      })
      expect(compile.ok).toBe(true)
      if (!compile.ok) return

      // One execution, one canonical dispatch request: nothing rides at the top level.
      expect(compile.plan.execution.driver).toBe('codex-app-server')
      expect(compile).not.toHaveProperty('selectedProfile')
      expect(compile).not.toHaveProperty('startRequest')
      expect(compile).not.toHaveProperty('dispatchRequest')

      const dispatch = compile.plan.execution.dispatchRequest
      expect(dispatch.dispatchEnv).toEqual({ EXTRA_FLAG: 'aspc-start' })
      // lifecyclePolicy rides the dispatch envelope only, never the start request.
      expect(dispatch.lifecyclePolicy).toEqual(lifecyclePolicy)
      expect(JSON.stringify(dispatch.startRequest)).not.toContain('lifecyclePolicy')

      const startResponse = await client.request<{ invocationId: string }>('invocation.start', {
        ...dispatch,
      })

      const expectedInvocationId = dispatch.startRequest.spec.invocationId
      if (expectedInvocationId === undefined) throw new Error('compiled spec has no invocationId')
      expect(startResponse.invocationId).toBe(expectedInvocationId)

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
