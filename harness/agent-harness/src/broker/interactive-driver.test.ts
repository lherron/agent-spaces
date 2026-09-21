import { expect, test } from 'bun:test'
import { createBroker } from 'spaces-harness-broker'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'

import {
  AGENT_HARNESS_TMUX_EMBEDDED_LIFECYCLE_REQUIRED,
  createAgentHarnessTmuxDriver,
} from './interactive-driver'

test('advertises the interactive identity as unavailable until Earendil supplies an embedded lifecycle', async () => {
  const broker = createBroker({ drivers: [createAgentHarnessTmuxDriver()] })

  await expect(
    broker.hello({
      clientInfo: { name: 'agent-harness-native-worker-test' },
      protocolVersions: ['harness-broker/0.2'],
    })
  ).resolves.toMatchObject({
    drivers: [
      {
        kind: 'agent-harness-tmux',
        available: false,
        unavailableReason: AGENT_HARNESS_TMUX_EMBEDDED_LIFECYCLE_REQUIRED,
      },
    ],
  })
})

test('refuses an interactive broker start before driver entry with the lifecycle dependency', async () => {
  const broker = createBroker({ drivers: [createAgentHarnessTmuxDriver()] })

  await expect(
    broker.start(
      {
        spec: {
          specVersion: 'harness-broker.invocation/v1',
          invocationId: 'agent-harness-interactive-unavailable',
          harness: {
            frontend: 'agent-harness',
            provider: 'openai',
            driver: 'agent-harness-tmux',
          },
          driver: { kind: 'agent-harness-tmux' },
          sdk: {
            runtime: 'pi-sdk',
            provider: 'openai',
            modelId: 'gpt-5.6-terra',
            authMode: 'api-key',
          },
          agent: { agentId: 'sparky' },
          process: {
            execution: 'native-worker',
            cwd: '/tmp',
            harnessTransport: { kind: 'native-worker' },
          },
        },
      },
      undefined,
      { tmux: { socketPath: '/tmp/agent-harness-test-tmux.sock' } }
    )
  ).rejects.toMatchObject({
    code: BrokerErrorCode.DriverUnavailable,
    message: AGENT_HARNESS_TMUX_EMBEDDED_LIFECYCLE_REQUIRED,
  })
})
