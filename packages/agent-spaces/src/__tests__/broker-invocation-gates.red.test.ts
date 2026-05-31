import { describe, expect, test } from 'bun:test'
import type { RuntimePlacement } from 'spaces-config'
import { toHarnessBrokerStartRequest, validateBrokerInvocationRequest } from '../broker-invocation'
import type { BuildHarnessBrokerInvocationRequest } from '../types'

const placement = {
  agentRoot: '/tmp/agents/cody',
  projectRoot: '/tmp/projects/agent-spaces',
  cwd: '/tmp/projects/agent-spaces',
  runMode: 'task',
  bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: '/tmp/projects/agent-spaces' },
} as RuntimePlacement

function brokerReq(
  overrides: Partial<BuildHarnessBrokerInvocationRequest> & Record<string, unknown> = {}
): BuildHarnessBrokerInvocationRequest {
  return {
    placement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    ...overrides,
  } as BuildHarnessBrokerInvocationRequest
}

describe('broker invocation driver gate lift RED', () => {
  test('accepts the interactive claude-code-tmux broker route without weakening codex gates', () => {
    expect(() =>
      validateBrokerInvocationRequest(
        brokerReq({
          provider: 'anthropic',
          frontend: 'claude-code',
          interactionMode: 'interactive',
          brokerDriver: 'claude-code-tmux',
          harnessTransport: { kind: 'pty' },
        })
      )
    ).not.toThrow()
  })

  test('still rejects codex app-server when interaction mode is interactive', () => {
    expect(() =>
      validateBrokerInvocationRequest(
        brokerReq({
          frontend: 'codex-cli',
          interactionMode: 'interactive',
          brokerDriver: 'codex-app-server',
        })
      )
    ).toThrow(/headless interaction mode/)
  })

  test('still rejects codex app-server when pty transport is requested', () => {
    expect(() =>
      validateBrokerInvocationRequest(
        brokerReq({
          frontend: 'codex-cli',
          interactionMode: 'headless',
          brokerDriver: 'codex-app-server',
          harnessTransport: { kind: 'pty' },
        })
      )
    ).toThrow(/jsonrpc-stdio|pty|transport/)
  })

  test('maps claude-code-tmux continuation into an Anthropic session HarnessInvocationSpec', () => {
    const prepared = {
      runOptions: {},
      commandPath: '/usr/local/bin/claude',
      args: ['--model', 'opus[1m]', '--resume', 'claude-session-01769'],
      cwd: '/tmp/projects/agent-spaces',
      lockedEnv: {},
      pathPrepend: [],
      placement,
      imageAttachmentPaths: [],
      runtimePlan: { defaultRunOptions: {} },
      placementContext: { materialization: {} },
      resolvedBundle: { bundleIdentity: 'test-bundle' },
      warnings: [],
    }

    const { spec, startRequest } = toHarnessBrokerStartRequest(
      prepared as any,
      brokerReq({
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'interactive',
        brokerDriver: 'claude-code-tmux',
        harnessTransport: { kind: 'pty' },
        continuation: { provider: 'anthropic', key: 'claude-session-01769' },
      })
    )

    expect(spec.harness).toEqual({
      frontend: 'claude-code',
      provider: 'anthropic',
      driver: 'claude-code-tmux',
    })
    expect(spec.process.harnessTransport).toEqual({ kind: 'pty' })
    expect(spec.interaction).toEqual({
      mode: 'interactive',
      turnConcurrency: 'single',
      inputQueue: 'none',
    })
    expect(spec.continuation).toEqual({
      provider: 'anthropic',
      kind: 'session',
      key: 'claude-session-01769',
    })
    expect(spec.driver).toEqual({ kind: 'claude-code-tmux', terminalHost: 'tmux' })
    expect(startRequest.initialInput).toBeUndefined()
  })
})
