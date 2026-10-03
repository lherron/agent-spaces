import { expect } from 'bun:test'
import {
  validateCommand,
  validateEventEnvelope,
  validateInvocationDispatchRequest,
  validateInvocationInput,
  validateInvocationSpec,
  validateInvocationStartRequest,
  validatePermissionRequestParams,
} from '../src/schemas'

export const expectInvalidCommand = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateCommand(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_COMMAND',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

export const specSection62Example = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: 'codex',
    args: ['--enable', 'goals', 'app-server'],
    cwd: '/workspace/project',
    lockedEnv: {
      CODEX_HOME: '/workspace/.codex-home',
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: {
      startupTimeoutMs: 20000,
      turnTimeoutMs: 900000,
      stopGraceMs: 5000,
    },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'codex-app-server',
    model: 'gpt-5.5-codex',
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
}

export const specSection19InvocationStartSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: 'codex',
    args: ['--enable', 'goals', 'app-server'],
    cwd: '/workspace/project',
    lockedEnv: {
      CODEX_HOME: '/workspace/.codex-home',
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'codex-app-server',
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
}

export const claudeCodeTmuxSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'claude-code',
    provider: 'anthropic',
    driver: 'claude-code-tmux',
  },
  process: {
    command: 'claude',
    args: ['--model', 'sonnet'],
    cwd: '/workspace/project',
    harnessTransport: { kind: 'pty' },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'claude-code-tmux',
    terminalHost: 'tmux',
  },
}

export const piSdkSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'pi',
    provider: 'anthropic',
    driver: 'pi-sdk',
  },
  process: {
    command: 'in-process',
    args: [],
    cwd: '/workspace/project',
    harnessTransport: { kind: 'in-process' },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'pi-sdk',
  },
  sdk: {
    runtime: 'pi-sdk',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    authMode: 'api-key',
    thinkingLevel: 'medium',
  },
}

// Shaped exactly like the profile `createArrisParticipantAdapter().prepare()`
// composes: an in-process driver that opens the Arris control socket itself,
// keeps a real command string (the broker spawns nothing from it) and carries
// no `sdk` block.
export const arrisResidentSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'arris',
    provider: 'openai',
    driver: 'arris-resident',
  },
  process: {
    command: 'arris-resident-external',
    args: [],
    cwd: '/workspace/project',
    lockedEnv: {},
    harnessTransport: { kind: 'in-process' },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'arris-resident',
    descriptorPath: '/private/tmp/arris/run/federation/host-descriptor.json',
    hostIncarnationId: 'host-incarnation:0fff54f7-f6f7-473b-8776-1ba07803f87d',
    hostLifecycleOwner: 'external',
    launchId: null,
  },
}

export const expectInvalidSpec = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateInvocationSpec(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_SPEC',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

export const expectInvalidInput = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateInvocationInput(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_INPUT',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

export const expectInvalidInputPath = (value: unknown, path: string) => {
  expect(() => validateInvocationInput(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_INPUT',
      issues: expect.arrayContaining([expect.objectContaining({ path })]),
    })
  )
}

export const expectInvalidStartRequest = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateInvocationStartRequest(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_START_REQUEST',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

export const expectInvalidDispatchRequest = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateInvocationDispatchRequest(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_DISPATCH_REQUEST',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

export const expectInvalidEventEnvelope = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateEventEnvelope(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_EVENT_ENVELOPE',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

export const expectInvalidPermissionRequestParams = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validatePermissionRequestParams(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_PERMISSION_REQUEST_PARAMS',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}
