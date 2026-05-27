import { describe, expect, test } from 'bun:test'
import type { RuntimePlacement } from 'spaces-config'
import type { BuildHarnessBrokerInvocationRequest } from '../types'
import { validateBrokerInvocationRequest } from '../broker-invocation'

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
})
