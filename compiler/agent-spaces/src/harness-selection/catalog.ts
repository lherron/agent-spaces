import type { HarnessId } from 'spaces-runtime-contracts'
import type { HarnessDefinition } from './types.js'

const broker = 'harness-broker/0.2' as const

/**
 * The sole selection authority. Do not add harness/presentation-to-driver
 * mappings outside this table; projections and resolver output derive from it.
 */
export const HARNESS_CATALOG: Readonly<Record<HarnessId, HarnessDefinition>> = {
  'agent-harness': {
    id: 'agent-harness',
    defaultModelProvider: 'openai-codex',
    supportedModelProviders: [
      {
        id: 'openai-codex',
        defaultModel: 'gpt-5.5',
        supportedModels: [
          'gpt-6-astra',
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.3-codex',
          'gpt-5.3',
          'gpt-5.2-codex',
          'gpt-5.2',
        ],
      },
      {
        id: 'openai',
        defaultModel: 'gpt-5.5',
        supportedModels: [
          'gpt-6-astra',
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.3-codex',
          'gpt-5.3',
          'gpt-5.2-codex',
          'gpt-5.2',
        ],
      },
      {
        id: 'anthropic',
        defaultModel: 'claude-sonnet-4-5',
        supportedModels: ['claude-sonnet-4-5'],
      },
      {
        id: 'anthropic-max',
        defaultModel: 'claude-sonnet-4-5',
        supportedModels: ['claude-sonnet-4-5'],
      },
    ],
    presentationDefault: false,
    executionVariants: {
      withoutPresentation: {
        recipeId: 'agent-harness-headless',
        builder: 'agent-harness',
        driver: 'agent-harness',
        protocol: broker,
        hosting: {
          executionTransport: 'native-worker',
          terminalRequired: false,
          processExecution: 'native-worker',
        },
        presentationFulfillment: 'birth-variant',
      },
      withPresentation: {
        recipeId: 'agent-harness-tui',
        builder: 'agent-harness-tmux',
        driver: 'agent-harness-tmux',
        protocol: broker,
        hosting: {
          executionTransport: 'native-worker',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'native-worker',
        },
        presentationFulfillment: 'birth-variant',
      },
    },
  },
  claude: {
    id: 'claude',
    defaultModelProvider: 'anthropic',
    supportedModelProviders: [
      {
        id: 'anthropic',
        defaultModel: 'opus[1m]',
        supportedModels: ['opus[1m]', 'claude-sonnet-4-5'],
      },
    ],
    presentationDefault: false,
    executionVariants: {
      withoutPresentation: {
        recipeId: 'claude-code',
        builder: 'claude-code-tmux',
        driver: 'claude-code-tmux',
        protocol: broker,
        hosting: {
          executionTransport: 'pty',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'intrinsic',
      },
      withPresentation: {
        recipeId: 'claude-code',
        builder: 'claude-code-tmux',
        driver: 'claude-code-tmux',
        protocol: broker,
        hosting: {
          executionTransport: 'pty',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'intrinsic',
      },
    },
  },
  codex: {
    id: 'codex',
    defaultModelProvider: 'openai-codex',
    supportedModelProviders: [
      {
        id: 'openai-codex',
        defaultModel: 'gpt-5.6-terra',
        supportedModels: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'],
      },
    ],
    presentationDefault: false,
    executionVariants: {
      withoutPresentation: {
        recipeId: 'codex-app-server',
        builder: 'codex-app-server',
        driver: 'codex-app-server',
        protocol: broker,
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: false,
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'attachable',
      },
      withPresentation: {
        recipeId: 'codex-app-server',
        builder: 'codex-app-server',
        driver: 'codex-app-server',
        protocol: broker,
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'attachable',
        presentationSurface: { transport: 'websocket-unix', terminalHost: 'tmux' },
      },
    },
  },
  muse: {
    id: 'muse',
    defaultModelProvider: 'meta',
    supportedModelProviders: [
      {
        id: 'meta',
        defaultModel: 'muse-spark-1.3-contributor',
        supportedModels: ['muse-spark-1.3-contributor'],
      },
    ],
    presentationDefault: false,
    executionVariants: {
      withoutPresentation: {
        recipeId: 'muse-serve',
        builder: 'muse-serve',
        driver: 'muse-serve',
        protocol: broker,
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: false,
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'birth-variant',
      },
      withPresentation: {
        recipeId: 'muse-tui',
        builder: 'muse-cli-tmux',
        driver: 'muse-cli-tmux',
        protocol: broker,
        hosting: {
          executionTransport: 'pty',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'birth-variant',
      },
    },
  },
}

export const HARNESS_IDS = Object.freeze(Object.keys(HARNESS_CATALOG) as HarnessId[])
