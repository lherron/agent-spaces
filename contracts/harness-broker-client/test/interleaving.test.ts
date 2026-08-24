import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  brokerArgs,
  brokerCommand,
  brokerEnvOverrides,
  codexSpec,
  collectUntil,
  helloRequest,
  repoRoot,
  userInput,
} from './helpers'

describe('BrokerClient response and event interleaving', () => {
  test('routes interleaved responses to callers and notifications to the event iterator once', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const { invocationId, events } = await client.startInvocation(codexSpec('start-fresh-turn'))
      await collectUntil(events, 'invocation.ready')

      const inputPromise = client.input({
        invocationId,
        input: userInput('Create interleaved turn events before the response resolves.'),
      })
      const turnEventsPromise = collectUntil(events, 'turn.completed')

      const [input, turnEvents] = await Promise.all([inputPromise, turnEventsPromise])
      expect(input).toMatchObject({ accepted: true, disposition: 'started' })

      const seqs = turnEvents.map((event) => event.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
      expect(turnEvents.some((event) => event.type === 'assistant.message.delta')).toBe(true)
      expect(turnEvents.at(-1)?.type).toBe('turn.completed')

      const status = await client.status({ invocationId })
      expect(status).toMatchObject({ invocationId, state: 'ready' })

      await client.stop({ invocationId, reason: 'interleaving test complete', graceMs: 50 })
      await client.dispose({ invocationId })
    } finally {
      await client.close()
    }
  })
})
