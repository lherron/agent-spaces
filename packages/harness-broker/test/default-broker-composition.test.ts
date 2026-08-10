import { describe, expect, test } from 'bun:test'
import { createDefaultBroker, runBrokerCli } from '../src'
import { createNoopDriver } from '../src/drivers/noop-driver'

describe('composable broker CLI', () => {
  test('exports runBrokerCli without executing it on import', () => {
    expect(runBrokerCli).toBeFunction()
  })

  test('adds driver factories after the four built-in drivers', async () => {
    let factoryCalls = 0
    const broker = createDefaultBroker(undefined, undefined, {
      additionalDrivers: [
        () => {
          factoryCalls += 1
          return createNoopDriver()
        },
      ],
    })

    const hello = await broker.hello({
      clientInfo: { name: 'composition-test' },
      protocolVersions: ['harness-broker/0.2'],
    })

    expect(factoryCalls).toBe(1)
    expect(hello.drivers.map((driver) => driver.kind)).toEqual([
      'codex-app-server',
      'claude-code-tmux',
      'codex-cli-tmux',
      'pi-tui-tmux',
      'noop-driver',
    ])
  })
})
