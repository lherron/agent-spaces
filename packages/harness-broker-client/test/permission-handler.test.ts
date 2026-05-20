import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { PermissionDecision, PermissionRequestParams } from 'spaces-harness-broker-protocol'
import {
  brokerArgs,
  brokerCommand,
  codexSpec,
  collectUntil,
  helloRequest,
  repoRoot,
  userInput,
} from './helpers'

describe('BrokerClient permission request callback', () => {
  test('invokes onPermissionRequest and returns allow to the broker', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
    })
    const requests: PermissionRequestParams[] = []

    client.onPermissionRequest(
      async (request: PermissionRequestParams): Promise<PermissionDecision> => {
        requests.push(request)
        return { decision: 'allow' }
      }
    )

    try {
      await client.hello(helloRequest({ permissionRequests: true }))
      const spec = codexSpec('permission-request', {
        invocationId: 'inv_client_permission_allow',
        driver: {
          kind: 'codex-app-server',
          resumeFallback: 'start-fresh',
          permissionPolicy: { mode: 'ask-client', timeoutMs: 1000 },
        },
      })
      const { invocationId, events } = await client.startInvocation(spec)
      await collectUntil(events, 'invocation.ready')

      await client.input({
        invocationId,
        input: userInput('Trigger a permission request and allow it.'),
      })
      const turnEvents = await collectUntil(events, 'turn.completed')

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        invocationId,
        kind: 'command',
        defaultDecision: 'deny',
      })
      expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
        finalOutput: 'permission approved',
      })

      await client.stop({ invocationId, reason: 'permission allow test complete', graceMs: 50 })
      await client.dispose({ invocationId })
    } finally {
      await client.close()
    }
  })

  test('handler timeout applies the broker defaultDecision', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
    })
    let called = false

    client.onPermissionRequest(async (): Promise<PermissionDecision> => {
      called = true
      return new Promise<PermissionDecision>(() => {})
    })

    try {
      await client.hello(helloRequest({ permissionRequests: true }))
      const spec = codexSpec('permission-request', {
        invocationId: 'inv_client_permission_timeout_default',
        process: {
          ...codexSpec('permission-request').process,
          limits: { startupTimeoutMs: 1000, turnTimeoutMs: 1500, stopGraceMs: 50 },
        },
        driver: {
          kind: 'codex-app-server',
          resumeFallback: 'start-fresh',
          permissionPolicy: {
            mode: 'ask-client',
            timeoutMs: 25,
            defaultDecision: 'allow',
          },
        },
      })
      const { invocationId, events } = await client.startInvocation(spec)
      await collectUntil(events, 'invocation.ready')

      await client.input({
        invocationId,
        input: userInput('Trigger a permission request and let it time out.'),
      })
      const turnEvents = await collectUntil(events, 'turn.completed')

      expect(called).toBe(true)
      expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
        finalOutput: 'permission approved',
      })

      await client.stop({ invocationId, reason: 'permission timeout test complete', graceMs: 50 })
      await client.dispose({ invocationId })
    } finally {
      await client.close()
    }
  })
})
