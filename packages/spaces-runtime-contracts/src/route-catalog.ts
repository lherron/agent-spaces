import type {
  HarnessFamily,
  HarnessRuntime,
  InteractionMode,
  ProviderDomain,
  RuntimeControllerKind,
} from './primitives'

export type RuntimeRouteCatalogEntry = {
  controller: RuntimeControllerKind
  terminalHost?: 'tmux' | 'ghostty' | undefined
  migrationOnly?: boolean | undefined
  modelProvider: ProviderDomain
  harnessFamily: HarnessFamily
  harnessRuntime: HarnessRuntime
  interactionMode: InteractionMode
  startupMethods: string[]
  turnDeliveries: string[]
  broker?:
    | {
        protocolVersion: 'harness-broker/0.1'
        driver: 'codex-app-server' | string
        processTransport: 'jsonrpc-stdio'
      }
    | undefined
  removalGate?: string | undefined
}

export const RUNTIME_ROUTE_CATALOG: RuntimeRouteCatalogEntry[] = [
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-terminal', 'reuse-existing', 'adopt-terminal'],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
  },
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-terminal', 'reuse-existing', 'adopt-terminal'],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
  },
  {
    controller: 'embedded-sdk',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-agent-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['create-sdk-session', 'reuse-existing'],
    turnDeliveries: ['sdk-turn', 'sdk-inflight-input'],
  },
  {
    controller: 'embedded-sdk',
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['create-sdk-session', 'reuse-existing'],
    turnDeliveries: ['sdk-turn', 'sdk-inflight-input'],
  },
  {
    controller: 'harness-broker',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'headless',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input'],
    broker: {
      protocolVersion: 'harness-broker/0.1',
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
    removalGate: 'delete-after-broker-codex-cutover',
  },
]
