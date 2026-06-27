import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  brokerArgs,
  brokerCommand,
  brokerEnvOverrides,
  codexSpec,
  collectUntil,
  findBrokerChildPid,
  helloRequest,
  nextEvent,
  repoRoot,
  userInput,
  withTimeout,
} from './helpers'

describe('BrokerClient process exit handling', () => {
  test('rejects pending requests with a transport error when the broker child exits externally', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const pendingStart = client.startInvocation(codexSpec('slow-startup'))
      const brokerPid = findBrokerChildPid()
      process.kill(brokerPid, 'SIGTERM')

      await expect(pendingStart).rejects.toMatchObject({
        name: expect.stringMatching(/Transport|BrokerTransport/),
      })
    } finally {
      await client.close().catch(() => {})
    }
  })

  test('terminates event iterators cleanly when close is called during a streaming turn', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    await client.hello(helloRequest())
    const { invocationId, events } = await client.startInvocation(codexSpec('slow-turn'))
    await collectUntil(events, 'invocation.ready')

    const iterator = events[Symbol.asyncIterator]()
    const inputPromise = client.input({
      invocationId,
      input: userInput('Start a slow turn, then close the client.'),
    })

    expect((await nextEvent(iterator)).type).toBe('input.accepted')
    // codex-app-server emits a durable user.message on input apply (so the
    // prompt lands in the transcript) before the upstream turn.started arrives.
    expect((await nextEvent(iterator)).type).toBe('user.message')
    expect((await nextEvent(iterator)).type).toBe('turn.started')

    await client.close()

    await expect(
      withTimeout(iterator.next(), 500, 'event iterator did not terminate')
    ).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(inputPromise).rejects.toMatchObject({
      name: expect.stringMatching(/Transport|BrokerTransport/),
    })
  })
})
