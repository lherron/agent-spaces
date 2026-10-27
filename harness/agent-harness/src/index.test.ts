import { expect, test } from 'bun:test'
import { createBroker } from 'spaces-harness-broker'

import { createAgentHarnessDriver } from './index'

test('broker hello advertises the first-party driver and its input capabilities', async () => {
  const broker = createBroker({ drivers: [createAgentHarnessDriver()] })
  const hello = await broker.hello({
    clientInfo: { name: 'agent-harness-identity-test' },
    protocolVersions: ['harness-broker/0.2'],
  })
  expect(hello.drivers).toMatchObject([
    {
      kind: 'agent-harness',
      capabilities: { input: { steer: true }, turns: { interrupt: 'protocol' } },
    },
  ])
})
