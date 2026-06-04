import { describe, expect, test } from 'bun:test'
import {
  type LegacyTransportAlias,
  type RuntimeControllerKind,
  type RuntimeExecutionView,
  legacyTransportAlias,
  transportAliasFor,
} from '../src/index'

describe('transportAliasFor', () => {
  const cases: Array<{
    controllerKind: RuntimeControllerKind
    brokerTerminalHost?: 'tmux' | undefined
    expected: LegacyTransportAlias
  }> = [
    { controllerKind: 'terminal', expected: 'tmux' },
    { controllerKind: 'embedded-sdk', expected: 'sdk' },
    { controllerKind: 'harness-broker', brokerTerminalHost: 'tmux', expected: 'tmux' },
    { controllerKind: 'harness-broker', expected: 'headless' },
    { controllerKind: 'command-process', expected: 'headless' },
    { controllerKind: 'legacy-exec', expected: 'headless' },
  ]

  for (const { controllerKind, brokerTerminalHost, expected } of cases) {
    test(`${controllerKind}${brokerTerminalHost ? `+${brokerTerminalHost}` : ''} -> ${expected}`, () => {
      expect(transportAliasFor(controllerKind, brokerTerminalHost)).toBe(expected)
    })
  }
})

describe('legacyTransportAlias', () => {
  function view(controller: RuntimeExecutionView['controller']): RuntimeExecutionView {
    return {
      schemaVersion: 'runtime-public-view/v1',
      runtimeId: 'runtime-1' as RuntimeExecutionView['runtimeId'],
      hostSessionId: 'host-session-1' as RuntimeExecutionView['hostSessionId'],
      generation: 1,
      status: 'ready',
      controller,
      interactionMode: 'headless',
      startupMethod: 'create',
      turnDelivery: 'none',
      capabilities: {} as RuntimeExecutionView['capabilities'],
      transport: 'headless',
      supportsInFlightInput: false,
    }
  }

  test('terminal controller maps to tmux', () => {
    expect(legacyTransportAlias(view({ kind: 'terminal', terminalHost: 'tmux' }))).toBe('tmux')
  })

  test('embedded-sdk controller maps to sdk', () => {
    expect(legacyTransportAlias(view({ kind: 'embedded-sdk' }))).toBe('sdk')
  })

  test('harness-broker with tmux terminal maps to tmux', () => {
    expect(
      legacyTransportAlias(
        view({
          kind: 'harness-broker',
          brokerDriver: 'claude-code-tmux',
          brokerProtocol: 'harness-broker/0.2',
          brokerTerminal: { host: 'tmux' },
        })
      )
    ).toBe('tmux')
  })

  test('harness-broker without terminal maps to headless', () => {
    expect(
      legacyTransportAlias(
        view({
          kind: 'harness-broker',
          brokerDriver: 'codex-app-server',
          brokerProtocol: 'harness-broker/0.2',
        })
      )
    ).toBe('headless')
  })

  test('command-process controller maps to headless', () => {
    expect(legacyTransportAlias(view({ kind: 'command-process' }))).toBe('headless')
  })

  test('legacy-exec controller maps to headless', () => {
    expect(legacyTransportAlias(view({ kind: 'legacy-exec', migrationOnly: true }))).toBe(
      'headless'
    )
  })
})
