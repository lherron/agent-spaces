/**
 * T-07314 RED (AC-10): durable record of the hrc-server consumer contract.
 *
 * The task description's premise that hrc-server is a compile-plane-only
 * consumer is FALSIFIED by source: `hrc-runtime/packages/hrc-server/src/
 * agent-spaces-adapter/aspc-facade-client.ts` spawns `node_modules/.bin/
 * aspc-facade` and speaks the FULL cohosted plane enumerated below (the
 * `invocation.event` notification and the `invocation.permission.request`
 * server->client callback included).
 *
 * This test pins that exact set against the COMPOSITION facade. It is the
 * durable record that hrc-server must be repointed at `spaces-aspc-facade`, not
 * `spaces-aspc`, when the canonical set advances (owned by T-07318 / the
 * supervisor's set advance, not by this room).
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

type ConsumerEntry =
  | { kind: 'request'; method: string }
  | { kind: 'notification'; method: string }
  | { kind: 'server-to-client-request'; method: string }

/** Exactly what aspc-facade-client.ts speaks, in source order. */
const HRC_SERVER_CONSUMER_SURFACE: ConsumerEntry[] = [
  { kind: 'request', method: 'aspc.hello' },
  { kind: 'request', method: 'aspc.compileHarnessInvocation' },
  { kind: 'request', method: 'broker.hello' },
  { kind: 'request', method: 'broker.health' },
  { kind: 'request', method: 'invocation.start' },
  { kind: 'request', method: 'invocation.input' },
  { kind: 'request', method: 'invocation.interrupt' },
  { kind: 'request', method: 'invocation.stop' },
  { kind: 'request', method: 'invocation.status' },
  { kind: 'request', method: 'invocation.dispose' },
  { kind: 'notification', method: 'invocation.event' },
  { kind: 'server-to-client-request', method: 'invocation.permission.request' },
]

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

describe('hrc-server consumer contract', () => {
  test('AC-10: the composition facade serves every entry hrc-server speaks', async () => {
    const notifications: JsonRpcNotification[] = []
    const serverRequests: JsonRpcRequest[] = []

    const client = await startFacadeClient(fixture)
    client.onNotification((notification) => notifications.push(notification))
    client.onRequest(async (request) => {
      serverRequests.push(request)
      return { decision: 'allow' }
    })

    try {
      await client.request('broker.hello', {
        clientInfo: { name: 'hrc-server-consumer-pin' },
        protocolVersions: ['harness-broker/0.2'],
        capabilities: { eventReplay: true, permissionRequests: true },
      })
      const started = await client.compileAndStart({
        compileRequest: buildCompileRequest(fixture, 'consumer_pin', ASK_CLIENT_PERMISSION_POLICY),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
      })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      await waitFor(() => notifications.length > 0 && serverRequests.length > 0)

      const notified = new Set(notifications.map((notification) => notification.method))
      const requested = new Set(serverRequests.map((request) => request.method))
      const unserved: string[] = []
      for (const entry of HRC_SERVER_CONSUMER_SURFACE) {
        if (entry.kind === 'request') {
          if (!(await probeServed(client, entry.method, {}))) unserved.push(entry.method)
          continue
        }
        if (entry.kind === 'notification' && !notified.has(entry.method)) {
          unserved.push(entry.method)
          continue
        }
        if (entry.kind === 'server-to-client-request' && !requested.has(entry.method)) {
          unserved.push(entry.method)
        }
      }
      expect(unserved).toEqual([])

      await client.request('invocation.stop', {
        invocationId: started.startResponse.invocationId,
        reason: 'consumer pin cleanup',
        graceMs: 100,
      })
      await client.request('invocation.dispose', {
        invocationId: started.startResponse.invocationId,
      })
    } finally {
      await client.close()
    }
  }, 30_000)
})
