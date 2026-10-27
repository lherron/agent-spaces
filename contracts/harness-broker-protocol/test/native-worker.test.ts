import { describe, test } from 'bun:test'
import { expectInvalidSpec, expectValidCommand, startCommand } from './schema-test-helpers'

function nativeSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { process: processOverride, driver: driverOverride, ...rest } = overrides
  const process = (processOverride as Record<string, unknown> | undefined) ?? {}
  const driver = (driverOverride as Record<string, unknown> | undefined) ?? {}
  return {
    specVersion: 'harness-broker.invocation/v1',
    harness: { frontend: 'agent-harness-tui', provider: 'openai', driver: 'agent-harness' },
    process: {
      execution: 'native-worker',
      cwd: '/workspace/project',
      harnessTransport: { kind: 'native-worker' },
      ...process,
    },
    interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'agent-harness', permissionPolicy: { mode: 'deny' }, ...driver },
    sdk: {
      runtime: 'pi-sdk',
      provider: 'openai-codex',
      modelId: 'openai-codex/gpt-5.6-terra',
      authMode: 'oauth',
    },
    agent: { agentId: 'sparky', agentRoot: '/agents/sparky', runMode: 'task' },
    ...rest,
  }
}

// Specs are driven through `invocation.start` via `validateCommand`; issue paths
// are relative to `params.startRequest.spec.`.
describe('native agent-harness process contract', () => {
  test('accepts the no-child native-worker shape', () => {
    expectValidCommand(startCommand(nativeSpec()))
  })

  test.each([
    ['command', { command: 'agent-harness' }, 'process.command', 'forbidden'],
    ['args', { args: [] }, 'process.args', 'forbidden'],
    [
      'child transport',
      { harnessTransport: { kind: 'pty' } },
      'process.harnessTransport.kind',
      'invalid_literal',
    ],
  ])('rejects native worker %s', (_name, process, path, code) => {
    expectInvalidSpec(nativeSpec({ process }), { path, code })
  })

  test('rejects native-worker transport for a non-agent driver', () => {
    const invalid = nativeSpec({
      harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
      driver: { kind: 'codex-app-server' },
    })
    expectInvalidSpec(invalid, { path: 'process.harnessTransport.kind', code: 'forbidden' })
    expectInvalidSpec(invalid, { path: 'process.execution', code: 'forbidden' })
  })

  test('rejects a private control declaration', () => {
    expectInvalidSpec(
      nativeSpec({ driver: { kind: 'agent-harness', controlProtocol: 'private/v1' } }),
      {
        path: 'driver.controlProtocol',
        code: 'forbidden',
      }
    )
  })
})
