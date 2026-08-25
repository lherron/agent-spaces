/**
 * RED acceptance bar for T-07564.
 *
 * `agent-harness-tmux` is SDK-backed but externally hosted in a PTY. These tests
 * deliberately keep the PTY and in-process cases adjacent: accepting the SDK
 * block must not accidentally admit the wrong transport. They also pin the two
 * tmux terminal-surface gates that make the leased pane part of the contract.
 */
import { describe, expect, test } from 'bun:test'
import {
  validateEventEnvelope,
  validateInvocationDispatchRequest,
  validateInvocationSpec,
} from '../src/schemas'

const sdk = {
  runtime: 'pi-sdk',
  provider: 'openai',
  modelId: 'openai-codex/gpt-5.6-sol',
  authMode: 'oauth',
  thinkingLevel: 'medium',
}

const agentHarnessTmuxSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'agent-harness-tui',
    provider: 'openai',
    driver: 'agent-harness-tmux',
  },
  process: {
    command: 'agent-harness',
    args: [],
    cwd: '/workspace/project',
    lockedEnv: {},
    harnessTransport: { kind: 'pty' },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'agent-harness-tmux',
    terminalHost: 'tmux',
    permissionPolicy: { mode: 'deny' },
  },
  sdk,
}

function validationIssues(validate: () => unknown): Array<Record<string, unknown>> {
  try {
    validate()
    return []
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'issues' in error &&
      Array.isArray(error.issues)
    ) {
      return error.issues as Array<Record<string, unknown>>
    }
    throw error
  }
}

function expectIssue(
  validate: () => unknown,
  expectedIssue: { path: string; code?: string }
): void {
  expect(validationIssues(validate)).toEqual(
    expect.arrayContaining([expect.objectContaining(expectedIssue)])
  )
}

function sdkInProcessSpec(driver: 'pi-sdk' | 'agent-harness') {
  return {
    ...structuredClone(agentHarnessTmuxSpec),
    harness: {
      frontend: driver === 'pi-sdk' ? 'pi-sdk' : 'pi',
      provider: 'openai',
      driver,
    },
    process: {
      ...structuredClone(agentHarnessTmuxSpec.process),
      command: 'in-process',
      harnessTransport: { kind: 'in-process' },
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'none',
    },
    driver: { kind: driver },
  }
}

function existingTmuxSpec(driver: 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux') {
  const identities = {
    'claude-code-tmux': {
      frontend: 'claude-code',
      provider: 'anthropic',
      command: 'claude',
    },
    'codex-cli-tmux': { frontend: 'codex-cli', provider: 'openai', command: 'codex' },
    'pi-tui-tmux': { frontend: 'pi-cli', provider: 'openai', command: 'pi' },
  } as const
  const identity = identities[driver]
  return {
    specVersion: 'harness-broker.invocation/v1',
    harness: { frontend: identity.frontend, provider: identity.provider, driver },
    process: {
      command: identity.command,
      args: [],
      cwd: '/workspace/project',
      lockedEnv: {},
      harnessTransport: { kind: 'pty' },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: driver, terminalHost: 'tmux' },
  }
}

describe('T-07564 agent-harness-tmux SDK/PTY contract', () => {
  test('admits an sdk block when the agent-harness-tmux process transport is pty', () => {
    expect(validationIssues(() => validateInvocationSpec(agentHarnessTmuxSpec))).toEqual([])
  })

  test('refuses the same sdk-backed spec when its process transport is in-process', () => {
    const inProcess = structuredClone(agentHarnessTmuxSpec)
    inProcess.process.command = 'in-process'
    inProcess.process.harnessTransport.kind = 'in-process'

    expectIssue(() => validateInvocationSpec(inProcess), {
      path: 'process.harnessTransport.kind',
    })
  })

  test.each([
    ['pi-sdk', sdkInProcessSpec('pi-sdk')],
    ['agent-harness', sdkInProcessSpec('agent-harness')],
    ['claude-code-tmux', existingTmuxSpec('claude-code-tmux')],
    ['codex-cli-tmux', existingTmuxSpec('codex-cli-tmux')],
    ['pi-tui-tmux', existingTmuxSpec('pi-tui-tmux')],
  ])('keeps the existing %s invocation spec admissible', (_driver, spec) => {
    expect(validationIssues(() => validateInvocationSpec(spec))).toEqual([])
  })
})

describe('T-07564 agent-harness-tmux terminal surface contract', () => {
  test('requires a leased terminal surface (or legacy socket shim) at dispatch', () => {
    expectIssue(
      () => validateInvocationDispatchRequest({ startRequest: { spec: agentHarnessTmuxSpec } }),
      { path: 'runtime.terminalSurface', code: 'required' }
    )
  })

  test('requires terminal.surface.reported to identify a tmux pane', () => {
    expectIssue(
      () =>
        validateEventEnvelope({
          invocationId: 'inv_agent_harness_tmux',
          seq: 1,
          time: '2026-08-25T00:00:00.000Z',
          type: 'terminal.surface.reported',
          payload: {
            kind: 'tmux-session',
            socketPath: '/tmp/tmux-501/default',
            sessionName: 'agent-harness',
          },
          driver: { kind: 'agent-harness-tmux' },
        }),
      { path: 'payload.kind', code: 'invalid_literal' }
    )
  })
})
