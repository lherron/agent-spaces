import { describe, expect, test } from 'bun:test'

import { dispatchAgentHarness, parseForegroundInvocation } from './cli'

function dependencies() {
  const calls: string[] = []
  let printed: unknown
  return {
    calls,
    get printed() {
      return printed
    },
    values: {
      async runBrokerCli() {
        calls.push('broker')
      },
      async runTui(invocation: unknown) {
        calls.push(`tui:${JSON.stringify(invocation)}`)
      },
      async runPrint(invocation: unknown) {
        calls.push(`print:${JSON.stringify(invocation)}`)
        return 7
      },
      isInteractiveTerminal: () => true,
      setExitCode(code: number) {
        printed = code
      },
    },
  }
}

describe('agent-harness CLI dispatch', () => {
  test('dispatches foreground TUI with semantic inputs and an optional prompt', async () => {
    const testDependencies = dependencies()
    await dispatchAgentHarness(
      [
        'tui',
        '--agent-id',
        'cody',
        '--project-id',
        'agent-spaces',
        '--scope-ref',
        'agent:cody',
        'hello',
      ],
      testDependencies.values
    )
    expect(testDependencies.calls).toEqual([
      'tui:{"agentId":"cody","projectId":"agent-spaces","scopeRef":"agent:cody","prompt":"hello"}',
    ])
  })

  test('dispatches print and retains its exit status', async () => {
    const testDependencies = dependencies()
    await dispatchAgentHarness(
      ['print', '--agent-id', 'cody', 'answer briefly'],
      testDependencies.values
    )
    expect(testDependencies.calls).toEqual(['print:{"agentId":"cody","prompt":"answer briefly"}'])
    expect(testDependencies.printed).toBe(7)
  })

  test('forwards run and broker utility commands unchanged to the broker facade', async () => {
    const testDependencies = dependencies()
    await dispatchAgentHarness(['run', '--transport', 'stdio'], testDependencies.values)
    await dispatchAgentHarness(['drivers', '--json'], testDependencies.values)
    expect(testDependencies.calls).toEqual(['broker', 'broker'])
  })

  test('requires a TTY for foreground interactive execution', async () => {
    const testDependencies = dependencies()
    testDependencies.values.isInteractiveTerminal = () => false
    await expect(
      dispatchAgentHarness(['tui', '--agent-id', 'cody'], testDependencies.values)
    ).rejects.toThrow('requires an interactive terminal')
  })

  test('parses correlation and rejects invalid foreground input visibly', () => {
    expect(parseForegroundInvocation(['--agent-id', 'cody', '--generation', '2'])).toMatchObject({
      agentId: 'cody',
      generation: 2,
    })
    expect(() => parseForegroundInvocation(['--agent-id', 'cody', '--generation', '-1'])).toThrow(
      'non-negative integer'
    )
    expect(() => parseForegroundInvocation(['--agent-id', 'cody', '--unknown'])).toThrow('Unknown')
  })
})
