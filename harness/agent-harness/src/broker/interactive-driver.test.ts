import { expect, test } from 'bun:test'
import { createBroker } from 'spaces-harness-broker'

import { AGENT_HARNESS_TMUX_DRIVER_KIND, createAgentHarnessTmuxDriver } from './interactive-driver'
import { createAgentHarnessTmuxLeafDriver } from './interactive-leaf-driver'
import { createResidentLeafDriver } from './resident-leaf-driver'

test('registers the interactive identity as an available external-child driver', async () => {
  const broker = createBroker({ drivers: [createAgentHarnessTmuxDriver()] })
  await expect(
    broker.hello({
      clientInfo: { name: 'agent-harness-native-worker-test' },
      protocolVersions: ['harness-broker/0.2'],
    })
  ).resolves.toMatchObject({
    drivers: [
      {
        kind: AGENT_HARNESS_TMUX_DRIVER_KIND,
        available: true,
        capabilities: {
          bracketMintingMode: 'delivery-acknowledged',
          turns: { interrupt: 'protocol' },
        },
      },
    ],
  })
})

test('requires the HRC-supplied pane lease before launching the TUI child', async () => {
  const driver = createAgentHarnessTmuxDriver()
  await expect(
    driver.start(
      {
        specVersion: 'harness-broker.invocation/v1',
        invocationId: 'agent-harness-interactive-no-lease',
        harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness-tmux' },
        driver: { kind: 'agent-harness-tmux', permissionPolicy: { mode: 'deny' } },
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
      } as never,
      {
        invocationId: 'agent-harness-interactive-no-lease',
        clientCapabilities: {},
        emit: () => ({}) as never,
        emitEvent: () => ({}) as never,
      }
    )
  ).rejects.toThrow('terminalSurface')
})

test('resident leaf builder serves only pane-owning native-worker kinds', () => {
  expect(createResidentLeafDriver({ driverKind: 'foundry-resident' }).kind).toBe('foundry-resident')
  expect(createAgentHarnessTmuxLeafDriver().kind).toBe(AGENT_HARNESS_TMUX_DRIVER_KIND)
  expect(() => createResidentLeafDriver({ driverKind: 'agent-harness' })).toThrow(
    "does not serve driver kind 'agent-harness'"
  )
})
