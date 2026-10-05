import { expect } from 'bun:test'
import type { HarnessInvocationSpec, HarnessSdkSpec } from '../src/invocation'
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

type FixturePath = readonly (string | number)[]

const containerAt = (root: unknown, path: FixturePath): object => {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`fixture path ${path.join('.')} does not resolve to an object`)
    }
    node = Reflect.get(node, key)
  }
  if (typeof node !== 'object' || node === null) {
    throw new Error(`fixture path ${path.join('.')} does not resolve to an object`)
  }
  return node
}

/**
 * Clone of a typed fixture with the value at `path` replaced. Used by tests
 * that deliberately corrupt a valid fixture to exercise validator rejection
 * paths, so the result is untyped input.
 */
export const withValueAt = (source: unknown, path: FixturePath, value: unknown): unknown => {
  const copy = structuredClone(source)
  const key = path.at(-1)
  if (key === undefined) throw new Error('fixture path must not be empty')
  Reflect.set(containerAt(copy, path.slice(0, -1)), key, value)
  return copy
}

/** Clone of a typed fixture with the key at `path` removed (deliberately invalid input). */
export const withoutKeyAt = (source: unknown, path: FixturePath): unknown => {
  const copy = structuredClone(source)
  const key = path.at(-1)
  if (key === undefined) throw new Error('fixture path must not be empty')
  Reflect.deleteProperty(containerAt(copy, path.slice(0, -1)), key)
  return copy
}

export const specSection62Example: HarnessInvocationSpec = {
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

export const specSection19InvocationStartSpec: HarnessInvocationSpec = {
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

export const claudeCodeTmuxSpec: HarnessInvocationSpec = {
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

export const piSdkSpecSdk: HarnessSdkSpec = {
  runtime: 'pi-sdk',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  authMode: 'api-key',
  thinkingLevel: 'medium',
}

export const piSdkSpec: HarnessInvocationSpec = {
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
  sdk: piSdkSpecSdk,
}

// Shaped exactly like the profile `createArrisParticipantAdapter().prepare()`
// composes: an in-process driver that opens the Arris control socket itself,
// keeps a real command string (the broker spawns nothing from it) and carries
// no `sdk` block.
export const arrisResidentSpec: HarnessInvocationSpec = {
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
