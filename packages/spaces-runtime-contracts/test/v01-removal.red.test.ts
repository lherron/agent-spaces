/**
 * Ph6 RED tests: spaces-runtime-contracts v0.1 rejection (T-01867)
 *
 * Asserts the TARGET end state where:
 *   - validateBrokerExecutionProfile REJECTS a profile carrying brokerProtocol
 *     'harness-broker/0.1' (emits a diagnostic instead of returning []).
 *
 * Tests FAIL today because the validator does not inspect brokerProtocol values.
 * They pass after Ph6 adds a BROKER_RULES gate that rejects v0.1.
 *
 * The profile fixtures below are structurally identical to the ones in
 * validate-execution-profile.test.ts (which currently assert v0.1 is VALID).
 * These red tests flip that assertion: v0.1 profiles must produce diagnostics.
 */
import { describe, expect, test } from 'bun:test'
import type { BrokerExecutionProfile, CompileDiagnostic } from '../src/index'
import { validateBrokerExecutionProfile } from '../src/validate-execution-profile'

// Shared exposure policies
const tmuxExposurePolicy = {
  mode: 'broker-reports-target',
  targetKind: 'tmux-session',
} as const

const noneExposurePolicy = {
  mode: 'none',
} as const

/**
 * A structurally-valid interactive claude-code-tmux broker profile whose only
 * "fault" after Ph6 will be carrying brokerProtocol: 'harness-broker/0.1'.
 * Today this passes validateBrokerExecutionProfile with no diagnostics.
 */
const interactiveV01Profile = {
  schemaVersion: 'agent-runtime-profile/v1',
  profileId: 'profile:test-v01-removal-interactive',
  profileHash: 'ph6-red-hash',
  compatibilityHash: 'ph6-red-compat',
  kind: 'harness-broker',
  interactionMode: 'interactive',
  brokerProtocol: 'harness-broker/0.1', // TARGET: must be rejected after Ph6
  brokerDriver: 'claude-code-tmux',
  brokerOwnership: 'hrc-owned-process',
  brokerTerminal: {
    host: 'tmux',
    startupMethod: 'create-terminal',
    turnDelivery: 'terminal-literal-input',
    operatorAttach: true,
    exposurePolicy: tmuxExposurePolicy,
  },
  harnessInvocation: {
    specHash: 'spec-hash',
    startRequestHash: 'start-request-hash',
    startRequest: {
      spec: {
        specVersion: 'harness-broker.invocation/v1',
        harness: { frontend: 'claude-code', provider: 'anthropic', driver: 'claude-code-tmux' },
        process: {
          command: 'claude',
          args: [],
          cwd: '/tmp',
          lockedEnv: {},
          harnessTransport: { kind: 'pty' },
        },
        interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
        driver: { kind: 'claude-code-tmux', terminalHost: 'tmux' },
      },
    },
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
    exposurePolicy: tmuxExposurePolicy,
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

/**
 * A structurally-valid headless codex-app-server broker profile with
 * brokerProtocol: 'harness-broker/0.1'.  Today this passes with no diagnostics.
 */
const headlessV01Profile = {
  schemaVersion: 'agent-runtime-profile/v1',
  profileId: 'profile:test-v01-removal-headless',
  profileHash: 'ph6-red-hash-headless',
  compatibilityHash: 'ph6-red-compat-headless',
  kind: 'harness-broker',
  interactionMode: 'headless',
  brokerProtocol: 'harness-broker/0.1', // TARGET: must be rejected after Ph6
  brokerDriver: 'codex-app-server',
  brokerOwnership: 'hrc-owned-process',
  harnessInvocation: {
    specHash: 'spec-hash-headless',
    startRequestHash: 'start-request-hash-headless',
    startRequest: {
      spec: {
        specVersion: 'harness-broker.invocation/v1',
        harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
        process: {
          command: 'codex',
          args: ['app-server'],
          cwd: '/tmp',
          lockedEnv: {},
          harnessTransport: { kind: 'jsonrpc-stdio' },
        },
        interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
        driver: { kind: 'codex-app-server' },
      },
    },
  },
  expectedCapabilities: {},
  policy: {
    permissionPolicy: { mode: 'deny', audit: false },
    inputPolicy: {
      readyInput: 'start-turn',
      busy: { whenBusy: 'queue', maxDepth: 1 },
      supportedKinds: ['user'],
      attachmentPolicy: { localImages: false, fileRefs: false },
    },
    exposurePolicy: noneExposurePolicy,
  },
  observability: {
    correlation: {
      requestId: 'request:test-headless',
      operationId: 'operation:test-headless',
      hostSessionId: 'host-session:test-headless',
      generation: 1,
      runtimeId: 'runtime:test-headless',
      invocationId: 'invocation:test-headless',
    },
  },
} as unknown as BrokerExecutionProfile

function diagnosticCodes(diagnostics: CompileDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code)
}

describe('Ph6 red: validateBrokerExecutionProfile rejects harness-broker/0.1 (T-01867)', () => {
  test('interactive claude-code-tmux v0.1 profile produces diagnostics', () => {
    // RED today: validator returns [] for v0.1 profile (no protocol-version gate)
    const diagnostics = validateBrokerExecutionProfile(interactiveV01Profile)
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  test('interactive claude-code-tmux v0.1 diagnostic code identifies the protocol violation', () => {
    // RED today: no such diagnostic is produced; validator ignores brokerProtocol value
    const diagnostics = validateBrokerExecutionProfile(interactiveV01Profile)
    const codes = diagnosticCodes(diagnostics)
    expect(
      codes.some(
        (c) =>
          c.includes('protocol') ||
          c.includes('v0_1') ||
          c.includes('broker_protocol') ||
          c.includes('legacy')
      )
    ).toBe(true)
  })

  test('headless codex-app-server v0.1 profile produces diagnostics', () => {
    // RED today: validator returns [] for headless v0.1 profile too
    const diagnostics = validateBrokerExecutionProfile(headlessV01Profile)
    expect(diagnostics.length).toBeGreaterThan(0)
  })
})
