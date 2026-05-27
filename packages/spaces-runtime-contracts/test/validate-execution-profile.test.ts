import { describe, expect, test } from 'bun:test'
import * as Contracts from '../src/index'
import {
  type BrokerExecutionProfile,
  type CompileDiagnostic,
  type EmbeddedSdkExecutionProfile,
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
type EmbeddedSdkProfileValidator = (profile: EmbeddedSdkExecutionProfile) => CompileDiagnostic[]

function validateBrokerExecutionProfile(profile: BrokerExecutionProfile): CompileDiagnostic[] {
  const validator = (Contracts as typeof Contracts & {
    validateBrokerExecutionProfile?: BrokerProfileValidator | undefined
  }).validateBrokerExecutionProfile

  expect(validator).toBeFunction()
  return validator(profile)
}

function validateEmbeddedSdkExecutionProfile(
  profile: EmbeddedSdkExecutionProfile
): CompileDiagnostic[] {
  const validator = (Contracts as typeof Contracts & {
    validateEmbeddedSdkExecutionProfile?: EmbeddedSdkProfileValidator | undefined
  }).validateEmbeddedSdkExecutionProfile

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

const baseCodexCliTmuxProfile = brokerProfile({
  profileId: 'profile:test-codex-cli-tmux-broker',
  interactionMode: 'interactive',
  brokerDriver: 'codex-cli-tmux',
  brokerTerminal: {
    host: 'tmux',
    startupMethod: 'create-terminal',
    turnDelivery: 'terminal-literal-input',
    operatorAttach: true,
    exposurePolicy: tmuxExposurePolicy,
  },
  harnessInvocation: {
    startRequest: {
      spec: {
        harness: {
          frontend: 'codex-cli',
          provider: 'openai',
          driver: 'codex-cli-tmux',
        },
        process: {
          command: 'codex',
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
          kind: 'codex-cli-tmux',
          terminalHost: 'tmux',
          hookBridge: 'codex-hooks/v1',
        },
      },
    },
  },
  policy: {
    ...baseBrokerProfile.policy,
    exposurePolicy: tmuxExposurePolicy,
  },
})

function codexCliTmuxBrokerProfile(
  overrides: Record<string, unknown> = {}
): BrokerExecutionProfile {
  return brokerProfileFrom(baseCodexCliTmuxProfile, overrides)
}

const baseEmbeddedSdkProfile = {
  schemaVersion: 'agent-runtime-profile/v1',
  profileId: 'profile:test-embedded-sdk',
  profileHash: 'profile-hash',
  compatibilityHash: 'compatibility-hash',
  kind: 'embedded-sdk',
  interactionMode: 'nonInteractive',
  expectedCapabilities: {},
  sdk: {
    runtime: 'pi-sdk',
    startupMethod: 'create-sdk-session',
    turnDelivery: 'sdk-turn',
  },
  session: {
    provider: 'openai',
    modelId: 'gpt-5.5',
    cwd: '/tmp',
    lockedEnv: { ASP_HOME: '/tmp/asp-home' },
    pathPrepend: ['/tmp/asp-home/bin'],
  },
  policy: {
    inputPolicy: {
      readyInput: 'start-turn',
      busy: { whenBusy: 'reject' },
      supportedKinds: ['user'],
      attachmentPolicy: { localImages: true, fileRefs: false },
    },
  },
} as unknown as EmbeddedSdkExecutionProfile

function embeddedSdkProfile(overrides: Record<string, unknown> = {}): EmbeddedSdkExecutionProfile {
  const sdkOverride = overrides.sdk as Partial<EmbeddedSdkExecutionProfile['sdk']> | undefined
  const sessionOverride =
    overrides.session as Partial<EmbeddedSdkExecutionProfile['session']> | undefined
  const policyOverride = overrides.policy as Partial<EmbeddedSdkExecutionProfile['policy']> | undefined

  return {
    ...baseEmbeddedSdkProfile,
    ...overrides,
    sdk: {
      ...baseEmbeddedSdkProfile.sdk,
      ...(sdkOverride ?? {}),
    },
    session: {
      ...baseEmbeddedSdkProfile.session,
      ...(sessionOverride ?? {}),
    },
    policy: {
      ...baseEmbeddedSdkProfile.policy,
      ...(policyOverride ?? {}),
    },
  } as unknown as EmbeddedSdkExecutionProfile
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

  test('allows a valid codex-cli-tmux interactive broker profile', () => {
    expect(validateBrokerExecutionProfile(codexCliTmuxBrokerProfile())).toEqual([])
  })

  test('rejects codex-cli-tmux profiles without pty process transport', () => {
    const diagnostics = validateBrokerExecutionProfile(
      codexCliTmuxBrokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: {
              process: {
                ...baseCodexCliTmuxProfile.harnessInvocation.startRequest.spec.process,
                harnessTransport: { kind: 'jsonrpc-stdio' },
              },
            },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('codex_cli_tmux_requires_pty_transport')
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

describe('validateEmbeddedSdkExecutionProfile', () => {
  test('allows a valid openai pi-sdk nonInteractive embedded profile', () => {
    expect(validateEmbeddedSdkExecutionProfile(embeddedSdkProfile())).toEqual([])
  })

  test('rejects embedded profiles that use headless instead of nonInteractive', () => {
    const diagnostics = validateEmbeddedSdkExecutionProfile(
      embeddedSdkProfile({ interactionMode: 'headless' })
    )

    expect(diagnosticCodes(diagnostics)).toContain('embedded_sdk_requires_non_interactive')
  })

  test('rejects pi-sdk profiles with a non-openai provider', () => {
    const diagnostics = validateEmbeddedSdkExecutionProfile(
      embeddedSdkProfile({
        session: {
          provider: 'anthropic',
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pi_sdk_requires_openai_provider')
  })

  test('rejects PATH in session.lockedEnv while allowing typed session.pathPrepend', () => {
    const diagnostics = validateEmbeddedSdkExecutionProfile(
      embeddedSdkProfile({
        session: {
          lockedEnv: {
            ASP_HOME: '/tmp/asp-home',
            PATH: '/tmp/asp-home/bin:/usr/bin',
          },
          pathPrepend: ['/tmp/asp-home/bin'],
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('embedded_sdk_forbids_path_locked_env')
  })

  test('rejects broker/process/transport/terminal fields on embedded profiles', () => {
    const diagnostics = validateEmbeddedSdkExecutionProfile(
      embeddedSdkProfile({
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        process: {
          command: 'pi',
          args: [],
          cwd: '/tmp',
          lockedEnv: {},
        },
        transport: { kind: 'jsonrpc-stdio' },
        terminal: { host: 'tmux' },
      })
    )

    expect(diagnosticCodes(diagnostics)).toEqual(
      expect.arrayContaining([
        'embedded_sdk_forbids_broker_fields',
        'embedded_sdk_forbids_process_fields',
        'embedded_sdk_forbids_transport_fields',
        'embedded_sdk_forbids_terminal_fields',
      ])
    )
  })

  test('rejects startup and turn-delivery values outside the SDK contract', () => {
    const diagnostics = validateEmbeddedSdkExecutionProfile(
      embeddedSdkProfile({
        sdk: {
          startupMethod: 'create-broker-invocation',
          turnDelivery: 'broker-input',
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toEqual(
      expect.arrayContaining([
        'embedded_sdk_invalid_startup_method',
        'embedded_sdk_invalid_turn_delivery',
      ])
    )
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

  test('selects harness-broker codex-cli-tmux for the pre-HRC openai codex interactive route', () => {
    const selectedRoute = RUNTIME_ROUTE_CATALOG.find(
      (route) =>
        route.modelProvider === 'openai' &&
        route.harnessFamily === 'codex' &&
        route.harnessRuntime === 'codex-cli' &&
        route.interactionMode === 'interactive'
    )

    expect(selectedRoute?.controller).toBe('harness-broker')
    expect(selectedRoute?.broker).toMatchObject({
      driver: 'codex-cli-tmux',
      processTransport: 'pty',
    })
  })

  test('keeps openai codex headless on the codex-app-server broker route', () => {
    const selectedRoute = RUNTIME_ROUTE_CATALOG.find(
      (route) =>
        route.modelProvider === 'openai' &&
        route.harnessFamily === 'codex' &&
        route.harnessRuntime === 'codex-cli' &&
        route.interactionMode === 'headless' &&
        route.controller === 'harness-broker'
    )

    expect(selectedRoute?.broker).toMatchObject({
      driver: 'codex-app-server',
      processTransport: 'jsonrpc-stdio',
    })
  })

  test('selects embedded-sdk for openai pi-sdk nonInteractive route', () => {
    const selectedRoute = RUNTIME_ROUTE_CATALOG.find(
      (route) =>
        route.modelProvider === 'openai' &&
        route.harnessFamily === 'pi' &&
        route.harnessRuntime === 'pi-sdk' &&
        route.interactionMode === 'nonInteractive'
    )

    expect(selectedRoute?.controller).toBe('embedded-sdk')
    expect(selectedRoute?.startupMethods).toEqual(['create-sdk-session', 'reuse-existing'])
    expect(selectedRoute?.turnDeliveries).toEqual(['sdk-turn', 'sdk-inflight-input'])
  })
})
