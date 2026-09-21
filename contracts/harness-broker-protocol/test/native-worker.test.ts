import { describe, expect, test } from 'bun:test'
import { validateInvocationSpec } from '../src/schemas.js'

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

describe('native agent-harness process contract', () => {
  test('accepts the no-child native-worker shape', () => {
    expect(() => validateInvocationSpec(nativeSpec())).not.toThrow()
  })

  test.each([
    ['command', { command: undefined }],
    ['args', { args: undefined }],
    ['child transport', { harnessTransport: { kind: 'pty' } }],
  ])('rejects native worker %s', (_name, process) => {
    expect(() => validateInvocationSpec(nativeSpec({ process }))).toThrow()
  })

  test('rejects native-worker transport for a non-agent driver', () => {
    const invalid = nativeSpec({
      harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
      driver: { kind: 'codex-app-server' },
    })
    expect(() => validateInvocationSpec(invalid)).toThrow()
  })

  test('rejects a private control declaration', () => {
    expect(() =>
      validateInvocationSpec(
        nativeSpec({ driver: { kind: 'agent-harness', controlProtocol: 'private/v1' } })
      )
    ).toThrow()
  })
})
