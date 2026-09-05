import type {
  HarnessSdkSpec,
  InvocationLifecycleCapabilities,
} from 'spaces-harness-broker-protocol'
import type { TerminalHost } from './execution-profile'
import type {
  HarnessFamily,
  HarnessRuntime,
  InteractionMode,
  ProviderDomain,
  RuntimeControllerKind,
} from './primitives'

export type RuntimeRouteCatalogEntry = {
  controller: RuntimeControllerKind
  terminalHost?: TerminalHost | undefined
  migrationOnly?: boolean | undefined
  modelProvider: ProviderDomain
  harnessFamily: HarnessFamily
  harnessRuntime: HarnessRuntime
  interactionMode: InteractionMode
  startupMethods: string[]
  turnDeliveries: string[]
  lifecycle: InvocationLifecycleCapabilities
  broker?:
    | {
        protocolVersion: 'harness-broker/0.2'
        driver: 'codex-app-server' | string
        processTransport: 'jsonrpc-stdio' | 'pty' | 'in-process'
      }
    | undefined
  piSdkModels?: readonly PiSdkModelCatalogEntry[] | undefined
  removalGate?: string | undefined
}

export type PiSdkModelCatalogEntry = {
  /** Registry-qualified selection identity carried by requested.model. */
  alias: string
  /** Provider identifier passed to pi's ModelRuntime. */
  piProvider: string
  /** Registry-qualified Pi model identifier passed to the driver. */
  piModelId: string
  /** Credential universe selected by this alias. Never inferred from provider capability. */
  authMode: HarnessSdkSpec['authMode']
}

const OPENAI_PI_MODEL_IDS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.3',
  'gpt-5.2-codex',
  'gpt-5.2',
] as const

const ANTHROPIC_PI_MODEL_IDS = ['claude-sonnet-4-5'] as const

const OPENAI_PI_SDK_MODELS: readonly PiSdkModelCatalogEntry[] = OPENAI_PI_MODEL_IDS.flatMap(
  (piModelId) => [
    {
      alias: `openai/${piModelId}`,
      piProvider: 'openai',
      piModelId: `openai/${piModelId}`,
      authMode: 'api-key',
    },
    {
      alias: `openai-codex/${piModelId}`,
      piProvider: 'openai-codex',
      piModelId: `openai-codex/${piModelId}`,
      authMode: 'oauth',
    },
  ]
)

const ANTHROPIC_PI_SDK_MODELS: readonly PiSdkModelCatalogEntry[] = ANTHROPIC_PI_MODEL_IDS.flatMap(
  (piModelId) => [
    {
      alias: `anthropic/${piModelId}`,
      piProvider: 'anthropic',
      piModelId: `anthropic/${piModelId}`,
      authMode: 'api-key',
    },
    {
      alias: `anthropic-max/${piModelId}`,
      piProvider: 'anthropic',
      piModelId: `anthropic/${piModelId}`,
      authMode: 'oauth',
    },
  ]
)

/**
 * Build the runtime route catalog and fail immediately when two pi-sdk rows
 * claim the same selection alias. This keeps alias -> authMode resolution
 * deterministic even when multiple aliases share a pi provider id.
 */
export function defineRuntimeRouteCatalog(
  entries: readonly RuntimeRouteCatalogEntry[]
): RuntimeRouteCatalogEntry[] {
  const seenAliases = new Set<string>()
  for (const route of entries) {
    for (const model of route.piSdkModels ?? []) {
      if (seenAliases.has(model.alias)) {
        throw new Error(`Duplicate pi-sdk model alias in runtime route catalog: ${model.alias}`)
      }
      seenAliases.add(model.alias)
    }
  }
  return [...entries]
}

const BROKER_LIFECYCLE_BASELINE: InvocationLifecycleCapabilities = {
  runtimeRetention: ['keep-alive'],
  harnessRecovery: ['none'],
  turnRetry: ['none'],
  generationFencing: false,
  permissionCancellation: false,
}

const UNMANAGED_LIFECYCLE_BASELINE: InvocationLifecycleCapabilities = {
  runtimeRetention: ['unmanaged'],
  harnessRecovery: ['none'],
  turnRetry: ['none'],
  generationFencing: false,
  permissionCancellation: false,
}

export const RUNTIME_ROUTE_CATALOG: RuntimeRouteCatalogEntry[] = defineRuntimeRouteCatalog([
  {
    controller: 'harness-broker',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input', 'terminal-literal-input'],
    lifecycle: BROKER_LIFECYCLE_BASELINE,
    broker: {
      protocolVersion: 'harness-broker/0.2',
      driver: 'claude-code-tmux',
      processTransport: 'pty',
    },
  },
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
    startupMethods: [
      'create-terminal',
      'reuse-existing',
      'adopt-terminal',
      'inherit-current-terminal',
    ],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
    lifecycle: UNMANAGED_LIFECYCLE_BASELINE,
  },
  {
    controller: 'harness-broker',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input', 'terminal-literal-input'],
    lifecycle: BROKER_LIFECYCLE_BASELINE,
    broker: {
      protocolVersion: 'harness-broker/0.2',
      driver: 'codex-cli-tmux',
      processTransport: 'pty',
    },
  },
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
    startupMethods: [
      'create-terminal',
      'reuse-existing',
      'adopt-terminal',
      'inherit-current-terminal',
    ],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
    lifecycle: UNMANAGED_LIFECYCLE_BASELINE,
  },
  ...(
    [
      ['anthropic', ANTHROPIC_PI_SDK_MODELS],
      ['openai', OPENAI_PI_SDK_MODELS],
    ] as const
  ).map(
    ([modelProvider, piSdkModels]): RuntimeRouteCatalogEntry => ({
      controller: 'harness-broker',
      modelProvider,
      harnessFamily: 'pi',
      harnessRuntime: 'pi-sdk',
      interactionMode: 'nonInteractive',
      startupMethods: ['create-broker-invocation', 'reuse-existing'],
      turnDeliveries: ['broker-input'],
      lifecycle: BROKER_LIFECYCLE_BASELINE,
      broker: {
        protocolVersion: 'harness-broker/0.2',
        driver: 'pi-sdk',
        processTransport: 'in-process',
      },
      piSdkModels,
    })
  ),
  {
    controller: 'harness-broker',
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-sdk',
    interactionMode: 'interactive',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input', 'terminal-literal-input'],
    lifecycle: BROKER_LIFECYCLE_BASELINE,
    broker: {
      protocolVersion: 'harness-broker/0.2',
      driver: 'agent-harness-tmux',
      processTransport: 'pty',
    },
  },
  {
    controller: 'harness-broker',
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input', 'terminal-literal-input'],
    lifecycle: BROKER_LIFECYCLE_BASELINE,
    broker: {
      protocolVersion: 'harness-broker/0.2',
      driver: 'pi-tui-tmux',
      processTransport: 'pty',
    },
  },
  {
    controller: 'harness-broker',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'headless',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input'],
    lifecycle: BROKER_LIFECYCLE_BASELINE,
    broker: {
      protocolVersion: 'harness-broker/0.2',
      driver: 'codex-app-server',
      processTransport: 'jsonrpc-stdio',
    },
  },
  {
    controller: 'legacy-exec',
    migrationOnly: true,
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'headless',
    startupMethods: ['legacy-launch-artifact'],
    turnDeliveries: ['legacy-launch-input'],
    lifecycle: UNMANAGED_LIFECYCLE_BASELINE,
    removalGate: 'delete-after-broker-codex-cutover',
  },
])

export const PI_SDK_MODEL_CATALOG: readonly PiSdkModelCatalogEntry[] =
  RUNTIME_ROUTE_CATALOG.flatMap((route) => route.piSdkModels ?? [])

export function findPiSdkModelCatalogEntry(
  modelProvider: ProviderDomain,
  alias: string
): PiSdkModelCatalogEntry | undefined {
  return RUNTIME_ROUTE_CATALOG.find(
    (route) =>
      route.modelProvider === modelProvider &&
      route.harnessFamily === 'pi' &&
      route.harnessRuntime === 'pi-sdk' &&
      route.interactionMode === 'nonInteractive'
  )?.piSdkModels?.find((model) => model.alias === alias)
}
