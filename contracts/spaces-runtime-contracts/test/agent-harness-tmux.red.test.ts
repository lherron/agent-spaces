/**
 * RED acceptance bar for T-07564.
 *
 * This exercises the exported profile validator and route catalog as consumers
 * do. The PTY acceptance and in-process refusal are separate tests so both
 * directions execute on every run, even while the acceptance direction is red.
 */
import { describe, expect, test } from 'bun:test'
import {
  type BrokerExecutionProfile,
  RUNTIME_ROUTE_CATALOG,
  validateBrokerExecutionProfile,
} from '../src'

const tmuxExposurePolicy = {
  mode: 'broker-reports-target',
  targetKind: 'tmux-session',
}

const sdk = {
  runtime: 'pi-sdk',
  provider: 'openai',
  modelId: 'openai-codex/gpt-5.6-sol',
  authMode: 'oauth',
  thinkingLevel: 'medium',
}

function brokerProfile(
  brokerDriver: string,
  spec: Record<string, any>,
  interactionMode: 'interactive' | 'nonInteractive'
): BrokerExecutionProfile {
  const interactive = interactionMode === 'interactive'
  return {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: `profile:test-${brokerDriver}`,
    profileHash: 'profile-hash',
    compatibilityHash: 'compatibility-hash',
    kind: 'harness-broker',
    interactionMode,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver,
    brokerOwnership: 'hrc-owned-process',
    brokerTerminal: interactive
      ? {
          host: 'tmux',
          startupMethod: 'create-terminal',
          turnDelivery: 'terminal-literal-input',
          operatorAttach: true,
          exposurePolicy: tmuxExposurePolicy,
        }
      : undefined,
    harnessInvocation: {
      specHash: 'spec-hash',
      startRequestHash: 'start-request-hash',
      startRequest: { spec },
    },
    expectedCapabilities: {},
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'queue', maxDepth: 1 },
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: true, fileRefs: false },
      },
      exposurePolicy: interactive ? tmuxExposurePolicy : { mode: 'none' },
    },
    observability: {
      correlation: {
        requestId: 'request:test',
        operationId: 'operation:test',
        hostSessionId: 'host-session:test',
        generation: 1,
        runtimeId: 'runtime:test',
        invocationId: 'invocation:test',
      },
    },
  } as unknown as BrokerExecutionProfile
}

function sdkInProcessProfile(driver: 'pi-sdk' | 'agent-harness'): BrokerExecutionProfile {
  return brokerProfile(
    driver,
    {
      specVersion: 'harness-broker.invocation/v1',
      harness: { frontend: driver === 'pi-sdk' ? 'pi-sdk' : 'pi', provider: 'openai', driver },
      process: {
        command: 'in-process',
        args: [],
        cwd: '/workspace/project',
        lockedEnv: {},
        harnessTransport: { kind: 'in-process' },
      },
      interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
      driver: { kind: driver },
      sdk,
    },
    'nonInteractive'
  )
}

function tmuxProfile(
  driver: 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux' | 'agent-harness-tmux'
): BrokerExecutionProfile {
  const identities = {
    'claude-code-tmux': {
      frontend: 'claude-code',
      provider: 'anthropic',
      command: 'claude',
      hookBridge: undefined,
    },
    'codex-cli-tmux': {
      frontend: 'codex-cli',
      provider: 'openai',
      command: 'codex',
      hookBridge: 'codex-hooks/v1',
    },
    'pi-tui-tmux': {
      frontend: 'pi-cli',
      provider: 'openai',
      command: 'pi',
      hookBridge: 'pi-hrc-events/v1',
    },
    'agent-harness-tmux': {
      frontend: 'agent-harness-tui',
      provider: 'openai',
      command: 'agent-harness',
      hookBridge: undefined,
    },
  } as const
  const identity = identities[driver]
  return brokerProfile(
    driver,
    {
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
      driver: {
        kind: driver,
        terminalHost: 'tmux',
        ...(identity.hookBridge === undefined ? {} : { hookBridge: identity.hookBridge }),
        permissionPolicy: { mode: 'deny' },
      },
      ...(driver === 'agent-harness-tmux' ? { sdk } : {}),
    },
    'interactive'
  )
}

function diagnosticCodes(profile: BrokerExecutionProfile): string[] {
  return validateBrokerExecutionProfile(profile).map((diagnostic) => diagnostic.code)
}

describe('T-07564 agent-harness-tmux execution-profile admissibility', () => {
  test('admits an interactive sdk-backed agent-harness-tmux profile using pty', () => {
    expect(validateBrokerExecutionProfile(tmuxProfile('agent-harness-tmux'))).toEqual([])
  })

  test('refuses the same sdk-backed profile using in-process transport', () => {
    const profile = tmuxProfile('agent-harness-tmux')
    profile.harnessInvocation.startRequest.spec.process.command = 'in-process'
    profile.harnessInvocation.startRequest.spec.process.harnessTransport.kind = 'in-process'

    expect(diagnosticCodes(profile)).toContain('agent_harness_tmux_requires_pty_transport')
  })

  test('refuses ask-client instead of silently downgrading the permission policy', () => {
    const profile = tmuxProfile('agent-harness-tmux')
    profile.harnessInvocation.startRequest.spec.driver.permissionPolicy = { mode: 'ask-client' }

    expect(diagnosticCodes(profile)).toContain('agent_harness_tmux_forbids_ask_client')
  })

  test('requires terminalHost tmux', () => {
    const profile = tmuxProfile('agent-harness-tmux')
    Reflect.deleteProperty(profile.harnessInvocation.startRequest.spec.driver, 'terminalHost')

    expect(diagnosticCodes(profile)).toContain('agent_harness_tmux_requires_terminal_host')
  })

  test('requires an sdk block', () => {
    const profile = tmuxProfile('agent-harness-tmux')
    Reflect.deleteProperty(profile.harnessInvocation.startRequest.spec, 'sdk')

    expect(diagnosticCodes(profile)).toContain('agent_harness_tmux_requires_sdk_block')
  })

  test('forbids a hookBridge', () => {
    const profile = tmuxProfile('agent-harness-tmux')
    profile.harnessInvocation.startRequest.spec.driver.hookBridge = 'pi-hrc-events/v1'

    expect(diagnosticCodes(profile)).toContain('agent_harness_tmux_forbids_hook_bridge')
  })

  test.each([
    ['pi-sdk', sdkInProcessProfile('pi-sdk')],
    ['agent-harness', sdkInProcessProfile('agent-harness')],
    ['claude-code-tmux', tmuxProfile('claude-code-tmux')],
    ['codex-cli-tmux', tmuxProfile('codex-cli-tmux')],
    ['pi-tui-tmux', tmuxProfile('pi-tui-tmux')],
  ])('keeps the existing %s execution profile admissible', (_driver, profile) => {
    expect(validateBrokerExecutionProfile(profile)).toEqual([])
  })
})

describe('T-07564 agent-harness-tmux runtime route', () => {
  test('catalogs the interactive OpenAI agent-harness PTY route', () => {
    const route = RUNTIME_ROUTE_CATALOG.find(
      (candidate) =>
        candidate.controller === 'harness-broker' &&
        candidate.modelProvider === 'openai' &&
        candidate.harnessFamily === 'pi' &&
        candidate.harnessRuntime === 'agent-harness' &&
        candidate.interactionMode === 'interactive'
    )

    expect(route?.broker).toEqual({
      protocolVersion: 'harness-broker/0.2',
      driver: 'agent-harness-tmux',
      processTransport: 'pty',
    })
  })
})
