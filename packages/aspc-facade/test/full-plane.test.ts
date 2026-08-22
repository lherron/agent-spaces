/**
 * T-07318 RED (AC-7): the cohosted composition facade serves the FULL plane.
 *
 * Drives the real `packages/aspc-facade/bin/aspc-facade.js` over stdio: the five
 * compile methods, `aspc.compileAndStart`, the two `broker.*` routes and the six
 * `invocation.*` routes must all be served, the server must emit
 * `invocation.event` notifications, and it must issue
 * `invocation.permission.request` requests back to the client (ask-client
 * policy, permission-request fake-codex fixture).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { JsonRpcNotification, JsonRpcRequest } from 'spaces-harness-broker-protocol'
import {
  ASK_CLIENT_PERMISSION_POLICY,
  type Fixture,
  buildCompileRequest,
  createFixture,
  probeServed,
  removeFixture,
  startFacadeClient,
} from './helpers'

let fixture: Fixture

beforeEach(() => {
  fixture = createFixture('permission-request.ts')
})

afterEach(() => {
  removeFixture(fixture)
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  throw new Error('timed out waiting for facade traffic')
}

describe('cohosted facade full plane', () => {
  test('AC-7: serves compile + start + broker + invocation routes, emits events and permission requests', async () => {
    const events: JsonRpcNotification[] = []
    const permissionRequests: JsonRpcRequest[] = []

    const client = await startFacadeClient(fixture)
    client.onNotification((notification) => {
      if (notification.method === 'invocation.event') events.push(notification)
    })
    client.onRequest(async (request) => {
      permissionRequests.push(request)
      return { decision: 'allow' }
    })

    try {
      const brokerHello = await client.request<{ protocolVersion: string }>('broker.hello', {
        clientInfo: { name: 'aspc-facade-full-plane-test' },
        protocolVersions: ['harness-broker/0.2'],
        capabilities: { eventReplay: true, permissionRequests: true },
      })
      expect(brokerHello.protocolVersion).toBe('harness-broker/0.2')

      // --- the five compile methods ---
      const hello = await client.hello()
      expect(hello.facadeInfo.name).toBe('aspc-facade')
      const compiled = await client.compileRuntimePlan({
        compileRequest: buildCompileRequest(fixture, 'full_plane_compile'),
        aspHome: fixture.aspHome,
      })
      expect(compiled.ok).toBe(true)
      const invocationCompile = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest(fixture, 'full_plane_invocation'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
      })
      expect(invocationCompile.ok).toBe(true)
      expect(await probeServed(client, 'aspc.catalogAgents', {})).toBe(true)
      expect(await probeServed(client, 'aspc.inspectAgent', {})).toBe(true)

      // --- aspc.compileAndStart through the co-hosted broker ---
      const started = await client.compileAndStart({
        compileRequest: buildCompileRequest(
          fixture,
          'full_plane_start',
          ASK_CLIENT_PERMISSION_POLICY
        ),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
      })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const invocationId = started.startResponse.invocationId

      // --- broker.* and invocation.* ---
      const health = await client.request<{ status: string }>('broker.health', {})
      expect(health.status).toBe('ok')
      const status = await client.request<{ invocationId: string }>('invocation.status', {
        invocationId,
      })
      expect(status.invocationId).toBe(invocationId)
      expect(await probeServed(client, 'invocation.start', {})).toBe(true)

      const input = await client.request<{ accepted: boolean }>('invocation.input', {
        invocationId,
        input: {
          inputId: `${invocationId}_input_2`,
          kind: 'user',
          content: [{ type: 'text', text: 'second turn' }],
        },
      })
      expect(input.accepted).toBe(true)

      const interrupt = await client.request<{ accepted: boolean }>('invocation.interrupt', {
        invocationId,
        scope: 'turn',
        reason: 'full-plane test',
      })
      expect(typeof interrupt.accepted).toBe('boolean')

      // --- server -> client planes ---
      await waitFor(() => permissionRequests.length > 0 && events.length > 0)
      expect(permissionRequests.map((request) => request.method)).toContain(
        'invocation.permission.request'
      )
      const eventTypes = new Set(
        events.map((event) => (event.params as { type?: string } | undefined)?.type)
      )
      expect(eventTypes.has('turn.started')).toBe(true)
      expect(eventTypes.has('permission.requested')).toBe(true)

      const stop = await client.request<{ accepted: boolean }>('invocation.stop', {
        invocationId,
        reason: 'full-plane test cleanup',
        graceMs: 100,
      })
      expect(stop.accepted).toBe(true)
      const dispose = await client.request<{ disposed: boolean }>('invocation.dispose', {
        invocationId,
      })
      expect(dispose.disposed).toBe(true)
    } finally {
      await client.close()
    }
  }, 30_000)
})
