import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { BrokerHelloResponse, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import {
  brokerArgs,
  brokerCommand,
  codexSpec,
  collectUntil,
  helloRequest,
  repoRoot,
  userInput,
} from './helpers'

describe('BrokerClient integration', () => {
  test('spawns the real broker binary and drives a full Codex fake turn', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
    })

    try {
      const hello: BrokerHelloResponse = await client.hello(helloRequest())
      expect(hello.protocolVersion).toBe('harness-broker/0.1')
      expect(hello.capabilities).toMatchObject({
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
      })
      expect(hello.drivers).toContainEqual(
        expect.objectContaining({ kind: 'codex-app-server', available: true })
      )

      const { invocationId, events } = await client.startInvocation(codexSpec('start-fresh-turn'))
      expect(invocationId).toBe('inv_client_start_fresh_turn')

      const startupEvents = await collectUntil(events, 'invocation.ready')
      expect(startupEvents.map((event) => event.type)).toEqual([
        'invocation.started',
        'continuation.updated',
        'invocation.ready',
      ])

      const input = await client.input({
        invocationId,
        input: userInput('Complete the client integration turn.'),
      })
      expect(input).toMatchObject({ accepted: true, disposition: 'started' })
      expect(input.turnId).toBeDefined()

      const turnEvents = await collectUntil(events, 'turn.completed')
      expect(turnEvents.map((event: InvocationEventEnvelope) => event.type)).toEqual(
        expect.arrayContaining([
          'input.accepted',
          'turn.started',
          'assistant.message.started',
          'assistant.message.delta',
          'assistant.message.completed',
          'turn.completed',
        ])
      )
      expect(
        turnEvents.find((event) => event.type === 'assistant.message.delta')?.payload
      ).toMatchObject({
        text: 'Fresh turn complete.',
      })

      await expect(
        client.stop({ invocationId, reason: 'test complete', graceMs: 50 })
      ).resolves.toMatchObject({
        accepted: true,
      })
      await expect(client.dispose({ invocationId })).resolves.toBeUndefined()
    } finally {
      await client.close()
    }
  })
})
