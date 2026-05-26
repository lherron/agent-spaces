import { describe, expect, test } from 'bun:test'
import * as Contracts from '../src/index'
import {
  type BrokerExecutionProfile,
  type CompileDiagnostic,
  type TerminalExecutionProfile,
  RUNTIME_ROUTE_CATALOG,
  validateTerminalExecutionProfile,
} from '../src/index'

const baseProfile = {
  schemaVersion: 'agent-runtime-profile/v1',
  profileId: 'profile:test-terminal',
  profileHash: 'profile-hash',
  compatibilityHash: 'compatibility-hash',
  kind: 'terminal',
  interactionMode: 'interactive',
  terminal: {
    host: 'foreground',
    startupMethod: 'inherit-current-terminal',
    turnDelivery: 'terminal-launch-input',
  },
  process: {
    command: 'codex',
    args: [],
    cwd: '/tmp',
    lockedEnv: {},
    io: { kind: 'inherit' },
  },
  expectedCapabilities: {},
  policy: {
    exposurePolicy: {
      channel: 'agentchat',
    },
  },
} as unknown as TerminalExecutionProfile

function profile(
  override: Partial<{
    terminal: Partial<TerminalExecutionProfile['terminal']>
    process: Partial<TerminalExecutionProfile['process']>
  }> = {}
): TerminalExecutionProfile {
  return {
    ...baseProfile,
    terminal: {
      ...baseProfile.terminal,
      ...override.terminal,
    },
    process: {
      ...baseProfile.process,
      ...override.process,
    },
  } as TerminalExecutionProfile
}

function diagnosticCodes(diagnostics: CompileDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code)
}

type BrokerProfileValidator = (profile: BrokerExecutionProfile) => CompileDiagnostic[]

function validateBrokerExecutionProfile(profile: BrokerExecutionProfile): CompileDiagnostic[] {
  const validator = (Contracts as typeof Contracts & {
    validateBrokerExecutionProfile?: BrokerProfileValidator | undefined
  }).validateBrokerExecutionProfile

  expect(validator).toBeFunction()
  return validator(profile)
}

const noneExposurePolicy = {
  mode: 'none',
}

const tmuxExposurePolicy = {
  mode: 'broker-reports-target',
  targetKind: 'tmux-session',
}

const baseBrokerProfile = {
  schemaVersion: 'agent-runtime-profile/v1',
  profileId: 'profile:test-broker',
  profileHash: 'profile-hash',
  compatibilityHash: 'compatibility-hash',
  kind: 'harness-broker',
  interactionMode: 'interactive',
  brokerProtocol: 'harness-broker/0.1',
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
        harness: {
          frontend: 'claude-code',
          provider: 'anthropic',
          driver: 'claude-code-tmux',
        },
        process: {
          command: 'claude',
          args: [],
          cwd: '/tmp',
          lockedEnv: {},
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

function brokerProfileFrom(
  base: BrokerExecutionProfile,
  overrides: Record<string, unknown> = {}
): BrokerExecutionProfile {
  const harnessInvocationOverride = overrides.harnessInvocation as Record<string, unknown> | undefined
  const startRequestOverride = harnessInvocationOverride?.startRequest as
    | Record<string, unknown>
    | undefined
  const specOverride = startRequestOverride?.spec as Record<string, unknown> | undefined

  return {
    ...base,
    ...overrides,
    harnessInvocation: {
      ...base.harnessInvocation,
      ...(harnessInvocationOverride ?? {}),
      startRequest: {
        ...base.harnessInvocation.startRequest,
        ...(startRequestOverride ?? {}),
        spec: {
          ...base.harnessInvocation.startRequest.spec,
          ...(specOverride ?? {}),
          harness: {
            ...base.harnessInvocation.startRequest.spec.harness,
            ...((specOverride?.harness as Record<string, unknown> | undefined) ?? {}),
          },
          process: {
            ...base.harnessInvocation.startRequest.spec.process,
            ...((specOverride?.process as Record<string, unknown> | undefined) ?? {}),
          },
          driver: {
            ...base.harnessInvocation.startRequest.spec.driver,
            ...((specOverride?.driver as Record<string, unknown> | undefined) ?? {}),
          },
        },
      },
    },
  } as unknown as BrokerExecutionProfile
}

function brokerProfile(overrides: Record<string, unknown> = {}): BrokerExecutionProfile {
  return brokerProfileFrom(baseBrokerProfile, overrides)
}

const baseHeadlessCodexProfile = brokerProfile({
  profileId: 'profile:test-codex-broker',
  interactionMode: 'headless',
  brokerDriver: 'codex-app-server',
  brokerTerminal: undefined,
  harnessInvocation: {
    startRequest: {
      spec: {
        harness: {
          frontend: 'codex',
          provider: 'openai',
          driver: 'codex-app-server',
        },
        process: {
          command: 'codex',
          args: ['app-server'],
          cwd: '/tmp',
          lockedEnv: {},
          harnessTransport: { kind: 'jsonrpc-stdio' },
        },
        interaction: {
          mode: 'headless',
          turnConcurrency: 'single',
          inputQueue: 'fifo',
        },
        driver: {
          kind: 'codex-app-server',
        },
      },
    },
  },
  policy: {
    ...baseBrokerProfile.policy,
    exposurePolicy: noneExposurePolicy,
  },
})

function codexBrokerProfile(overrides: Record<string, unknown> = {}): BrokerExecutionProfile {
  return brokerProfileFrom(baseHeadlessCodexProfile, overrides)
}

describe('validateTerminalExecutionProfile', () => {
  test('allows a foreground profile with inherited terminal IO and launch input', () => {
    expect(validateTerminalExecutionProfile(profile())).toEqual([])
  })

  test('rejects foreground profiles that request pty IO', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        process: {
          io: { kind: 'pty' },
        } as unknown as TerminalExecutionProfile['process'],
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('foreground_requires_inherit_io')
  })

  test('rejects foreground profiles that use literal terminal input', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          turnDelivery: 'terminal-literal-input',
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('foreground_forbids_literal_input')
  })

  test('rejects tmux profiles that inherit host terminal IO', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          host: 'tmux',
          startupMethod: 'create-terminal',
        },
        process: {
          io: { kind: 'inherit' },
        } as unknown as TerminalExecutionProfile['process'],
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pty_host_requires_pty_io')
  })

  test('rejects inherit-current-terminal startup outside foreground host', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          host: 'tmux',
          startupMethod: 'inherit-current-terminal',
        },
        process: {
          io: { kind: 'pty' },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('inherit_method_requires_foreground')
  })

  test('rejects adopt-terminal startup for foreground host', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          startupMethod: 'adopt-terminal',
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('adopt_method_requires_pty_host')
  })
})

describe('validateBrokerExecutionProfile', () => {
  test('allows a valid claude-code-tmux interactive broker profile', () => {
    expect(validateBrokerExecutionProfile(brokerProfile())).toEqual([])
  })

  test('allows a valid codex-app-server headless broker profile', () => {
    expect(validateBrokerExecutionProfile(codexBrokerProfile())).toEqual([])
  })

  test('rejects claude-code-tmux profiles without pty process transport', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: {
              process: {
                ...baseBrokerProfile.harnessInvocation.startRequest.spec.process,
                harnessTransport: { kind: 'pipes' },
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('claude_code_tmux_requires_pty_transport')
  })

  test('rejects interactive broker profiles without a tmux brokerTerminal host', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        brokerTerminal: undefined,
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('interactive_broker_requires_tmux_terminal')
  })

  test('rejects codex-app-server profiles that request interactive mode', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        brokerDriver: 'codex-app-server',
        harnessInvocation: {
          startRequest: {
            spec: {
              harness: {
                frontend: 'codex',
                provider: 'openai',
                driver: 'codex-app-server',
              },
              driver: {
                kind: 'codex-app-server',
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('codex_app_server_requires_headless')
  })

  test('rejects codex-app-server profiles without jsonrpc stdio process transport', () => {
    const diagnostics = validateBrokerExecutionProfile(
      codexBrokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: {
              process: {
                harnessTransport: { kind: 'pipes' },
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('codex_app_server_requires_jsonrpc_stdio')
  })

  test('rejects codex-app-server profiles that carry a tmux brokerTerminal', () => {
    const diagnostics = validateBrokerExecutionProfile(
      codexBrokerProfile({
        brokerTerminal: baseBrokerProfile.brokerTerminal,
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('codex_app_server_forbids_tmux_terminal')
  })

  test('rejects headless broker profiles that expose an agentchat target', () => {
    const diagnostics = validateBrokerExecutionProfile(
      codexBrokerProfile({
        policy: {
          ...baseHeadlessCodexProfile.policy,
          exposurePolicy: tmuxExposurePolicy,
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('headless_requires_none_exposure')
  })

  test('rejects claude-code-tmux profiles without the hashed driver kind', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: {
              driver: {
                kind: 'claude-code',
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('claude_code_tmux_requires_driver_kind')
  })

  test('rejects claude-code-tmux profiles without the hashed tmux terminal host', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: {
              driver: {
                terminalHost: 'ghostty',
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('claude_code_tmux_requires_terminal_host')
  })

  test('rejects interactive broker profiles without an interactive startRequest spec', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: {
              interaction: {
                mode: 'headless',
                turnConcurrency: 'single',
                inputQueue: 'fifo',
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('interactive_profile_requires_interactive_spec')
  })

  test('rejects brokerTerminal exposure policy mismatches', () => {
    const diagnostics = validateBrokerExecutionProfile(
      brokerProfile({
        brokerTerminal: {
          ...baseBrokerProfile.brokerTerminal,
          exposurePolicy: {
            mode: 'none',
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('broker_exposure_policy_mismatch')
  })
})

describe('runtime route selection', () => {
  test('selects harness-broker for the pre-HRC anthropic claude-code interactive route', () => {
    const selectedRoute = RUNTIME_ROUTE_CATALOG.find(
      (route) =>
        route.modelProvider === 'anthropic' &&
        route.harnessFamily === 'claude-code' &&
        route.harnessRuntime === 'claude-code-cli' &&
        route.interactionMode === 'interactive'
    )

    expect(selectedRoute?.controller).toBe('harness-broker')
    expect(selectedRoute?.broker).toMatchObject({
      driver: 'claude-code-tmux',
      processTransport: 'pty',
    })
  })
})
