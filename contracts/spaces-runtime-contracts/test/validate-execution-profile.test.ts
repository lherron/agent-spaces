import { describe, expect, test } from 'bun:test'
import * as Contracts from '../src/index'
import {
  type BrokerExecutionProfile,
  type CompileDiagnostic,
  PI_SDK_MODEL_CATALOG,
  type PiSdkModelCatalogEntry,
  RUNTIME_ROUTE_CATALOG,
  type TerminalExecutionProfile,
  defineRuntimeRouteCatalog,
  findPiSdkModelCatalogEntry,
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
  const validator = (
    Contracts as typeof Contracts & {
      validateBrokerExecutionProfile?: BrokerProfileValidator | undefined
    }
  ).validateBrokerExecutionProfile

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
  brokerProtocol: 'harness-broker/0.2',
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
  const harnessInvocationOverride = overrides.harnessInvocation as
    | Record<string, unknown>
    | undefined
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

const basePiSdkBrokerProfile = brokerProfile({
  profileId: 'profile:test-pi-sdk-broker',
  interactionMode: 'nonInteractive',
  brokerDriver: 'pi-sdk',
  brokerTerminal: undefined,
  harnessInvocation: {
    startRequest: {
      spec: {
        harness: {
          frontend: 'pi-sdk',
          provider: 'anthropic',
          driver: 'pi-sdk',
        },
        process: {
          command: 'in-process',
          args: [],
          cwd: '/tmp',
          lockedEnv: {},
          harnessTransport: { kind: 'in-process' },
        },
        interaction: {
          mode: 'headless',
          turnConcurrency: 'single',
          inputQueue: 'fifo',
        },
        driver: {
          kind: 'pi-sdk',
        },
        sdk: {
          runtime: 'pi-sdk',
          provider: 'anthropic',
          modelId: 'anthropic/claude-sonnet-4-5',
          authMode: 'api-key',
          thinkingLevel: 'medium',
        },
      },
    },
  },
  policy: {
    ...baseBrokerProfile.policy,
    exposurePolicy: noneExposurePolicy,
  },
})

function piSdkBrokerProfile(overrides: Record<string, unknown> = {}): BrokerExecutionProfile {
  return brokerProfileFrom(basePiSdkBrokerProfile, overrides)
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

  test('allows a valid pi-sdk in-process broker profile', () => {
    expect(validateBrokerExecutionProfile(piSdkBrokerProfile())).toEqual([])
  })

  test('rejects pi-sdk broker profiles that are not nonInteractive', () => {
    const diagnostics = validateBrokerExecutionProfile(
      piSdkBrokerProfile({ interactionMode: 'headless' })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pi_sdk_requires_non_interactive')
  })

  test('rejects nonInteractive mode for non-pi-sdk broker profiles', () => {
    const diagnostics = validateBrokerExecutionProfile(
      codexBrokerProfile({ interactionMode: 'nonInteractive' })
    )

    expect(diagnosticCodes(diagnostics)).toContain('non_pi_sdk_forbids_non_interactive')
  })

  test('rejects pi-sdk profile/spec driver mismatches in both directions', () => {
    const profileMismatch = validateBrokerExecutionProfile(
      piSdkBrokerProfile({
        harnessInvocation: {
          startRequest: { spec: { driver: { kind: 'other-driver' } } },
        },
      })
    )
    const specMismatch = validateBrokerExecutionProfile(
      piSdkBrokerProfile({ brokerDriver: 'other-driver' })
    )

    expect(diagnosticCodes(profileMismatch)).toContain('pi_sdk_requires_driver_kind')
    expect(diagnosticCodes(specMismatch)).toContain('pi_sdk_spec_requires_profile_driver')
  })

  test('rejects pi-sdk profiles without in-process transport', () => {
    const diagnostics = validateBrokerExecutionProfile(
      piSdkBrokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: { process: { harnessTransport: { kind: 'pipes' } } },
          },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pi_sdk_requires_in_process_transport')
  })

  test('rejects pi-sdk profiles without an sdk block', () => {
    const diagnostics = validateBrokerExecutionProfile(
      piSdkBrokerProfile({
        harnessInvocation: { startRequest: { spec: { sdk: undefined } } },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pi_sdk_requires_sdk_block')
  })

  test('accepts both explicit pi-sdk auth modes', () => {
    expect(validateBrokerExecutionProfile(piSdkBrokerProfile())).toEqual([])
    expect(
      validateBrokerExecutionProfile(
        piSdkBrokerProfile({
          harnessInvocation: {
            startRequest: { spec: { sdk: { authMode: 'oauth' } } },
          },
        })
      )
    ).toEqual([])
  })

  test('rejects pi-sdk profiles without sdk.authMode', () => {
    const diagnostics = validateBrokerExecutionProfile(
      piSdkBrokerProfile({
        harnessInvocation: {
          startRequest: { spec: { sdk: { authMode: undefined } } },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pi_sdk_requires_auth_mode')
  })

  test('rejects pi-sdk profiles with brokerTerminal or hookBridge', () => {
    const withTerminal = validateBrokerExecutionProfile(
      piSdkBrokerProfile({ brokerTerminal: baseBrokerProfile.brokerTerminal })
    )
    const withHookBridge = validateBrokerExecutionProfile(
      piSdkBrokerProfile({
        harnessInvocation: {
          startRequest: {
            spec: { driver: { hookBridge: 'pi-hrc-events/v1' } },
          },
        },
      })
    )

    expect(diagnosticCodes(withTerminal)).toContain('pi_sdk_forbids_broker_terminal')
    expect(diagnosticCodes(withHookBridge)).toContain('pi_sdk_forbids_hook_bridge')
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

  test('keeps broker lifecycle baselines conservative until mechanics are certified', () => {
    const brokerRoutes = RUNTIME_ROUTE_CATALOG.filter(
      (route) => route.controller === 'harness-broker'
    )

    expect(brokerRoutes.length).toBeGreaterThan(0)
    for (const route of brokerRoutes) {
      expect(route.lifecycle).toEqual({
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: false,
        permissionCancellation: false,
      })
      expect(route.lifecycle.runtimeRetention).not.toContain('idle-ttl')
      expect(route.lifecycle.harnessRecovery).not.toContain('recycle-child')
      expect(route.lifecycle.turnRetry).not.toContain('safe-retry')
    }
  })

  test('selects the in-process pi-sdk broker for both providers', () => {
    const selectedProviders: string[] = []
    for (const modelProvider of ['anthropic', 'openai'] as const) {
      const selectedRoute = RUNTIME_ROUTE_CATALOG.find(
        (route) =>
          route.modelProvider === modelProvider &&
          route.harnessFamily === 'pi' &&
          route.harnessRuntime === 'pi-sdk' &&
          route.interactionMode === 'nonInteractive'
      )

      expect(selectedRoute?.controller).toBe('harness-broker')
      expect(selectedRoute?.modelProvider).toBe(modelProvider)
      selectedProviders.push(selectedRoute?.modelProvider ?? '')
      expect(selectedRoute?.startupMethods).toEqual(['create-broker-invocation', 'reuse-existing'])
      expect(selectedRoute?.turnDeliveries).toEqual(['broker-input'])
      expect(selectedRoute?.broker).toEqual({
        protocolVersion: 'harness-broker/0.2',
        driver: 'pi-sdk',
        processTransport: 'in-process',
      })
      expect(selectedRoute?.piSdkModels?.length).toBeGreaterThan(0)
    }
    expect(selectedProviders.sort()).toEqual(['anthropic', 'openai'])
  })

  test('catalogs API-key and OAuth aliases explicitly for both credential universes', () => {
    expect(PI_SDK_MODEL_CATALOG).toEqual(
      expect.arrayContaining([
        {
          alias: 'openai-codex/gpt-5.6-sol',
          piProvider: 'openai-codex',
          piModelId: 'openai-codex/gpt-5.6-sol',
          authMode: 'oauth',
        },
        {
          alias: 'openai/gpt-5.5',
          piProvider: 'openai',
          piModelId: 'openai/gpt-5.5',
          authMode: 'api-key',
        },
        {
          alias: 'openai-codex/gpt-5.5',
          piProvider: 'openai-codex',
          piModelId: 'openai-codex/gpt-5.5',
          authMode: 'oauth',
        },
        {
          alias: 'anthropic/claude-sonnet-4-5',
          piProvider: 'anthropic',
          piModelId: 'anthropic/claude-sonnet-4-5',
          authMode: 'api-key',
        },
        {
          alias: 'anthropic-max/claude-sonnet-4-5',
          piProvider: 'anthropic',
          piModelId: 'anthropic/claude-sonnet-4-5',
          authMode: 'oauth',
        },
      ])
    )
    expect(findPiSdkModelCatalogEntry('anthropic', 'anthropic-max/claude-sonnet-4-5')).toEqual({
      alias: 'anthropic-max/claude-sonnet-4-5',
      piProvider: 'anthropic',
      piModelId: 'anthropic/claude-sonnet-4-5',
      authMode: 'oauth',
    })
  })

  test('rejects duplicate pi-sdk aliases while building the route catalog', () => {
    const piRoute = RUNTIME_ROUTE_CATALOG.find(
      (route) => route.harnessRuntime === 'pi-sdk' && route.modelProvider === 'openai'
    )
    if (piRoute === undefined) throw new Error('missing openai pi-sdk route fixture')
    const duplicate: PiSdkModelCatalogEntry = {
      alias: 'openai/gpt-5.5',
      piProvider: 'openai',
      piModelId: 'openai/gpt-5.5',
      authMode: 'api-key',
    }

    expect(() =>
      defineRuntimeRouteCatalog([
        { ...piRoute, piSdkModels: [duplicate] },
        { ...piRoute, piSdkModels: [duplicate] },
      ])
    ).toThrow('Duplicate pi-sdk model alias in runtime route catalog: openai/gpt-5.5')
  })
})

describe('validateExecutionProfile (kind-dispatching entry point)', () => {
  const validateExecutionProfile = Contracts.validateExecutionProfile

  test('routes a terminal profile to the terminal validator', () => {
    // baseProfile is foreground + inherit-current-terminal => no diagnostics.
    const clean = profile()
    expect(diagnosticCodes(validateExecutionProfile(clean))).toEqual(
      diagnosticCodes(validateTerminalExecutionProfile(clean))
    )

    // A foreground profile that demands pty IO trips the terminal gate; the
    // dispatcher must surface the same diagnostic as the per-kind validator.
    const bad = profile({ process: { io: { kind: 'pty' } } })
    expect(diagnosticCodes(validateExecutionProfile(bad))).toEqual(
      diagnosticCodes(validateTerminalExecutionProfile(bad))
    )
    expect(diagnosticCodes(validateExecutionProfile(bad))).toContain(
      'foreground_requires_inherit_io'
    )
  })

  test('returns no diagnostics for command-process and legacy-exec kinds', () => {
    const commandProfile = {
      schemaVersion: 'agent-runtime-profile/v1',
      profileId: 'profile:test-command',
      profileHash: 'profile-hash',
      compatibilityHash: 'compatibility-hash',
      kind: 'command-process',
      interactionMode: 'headless',
      expectedCapabilities: {},
      command: {
        startupMethod: 'create-command-process',
        turnDelivery: 'none',
        argv: ['echo'],
        cwd: '/tmp',
        lockedEnv: {},
      },
      policy: {},
    } as unknown as Contracts.RuntimeExecutionProfile

    const legacyProfile = {
      schemaVersion: 'agent-runtime-profile/v1',
      profileId: 'profile:test-legacy',
      profileHash: 'profile-hash',
      compatibilityHash: 'compatibility-hash',
      kind: 'legacy-exec',
      interactionMode: 'headless',
      migrationOnly: true,
      removalGate: 'delete-after-broker-codex-cutover',
      expectedCapabilities: {},
      legacy: {
        startupMethod: 'legacy-launch-artifact',
        turnDelivery: 'legacy-launch-input',
        launchArtifactShape: 'hrc-launch-artifact/v1',
      },
    } as unknown as Contracts.RuntimeExecutionProfile

    expect(validateExecutionProfile(commandProfile)).toEqual([])
    expect(validateExecutionProfile(legacyProfile)).toEqual([])
  })
})
