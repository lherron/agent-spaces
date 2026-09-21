import type { HarnessSdkSpec } from 'spaces-harness-broker-protocol'

/**
 * Provider-qualified Pi model metadata shared by Pi materialization paths.
 *
 * This is deliberately not a harness-selection catalog: it contains no
 * harness identity, driver, lifecycle, presentation, or transport choice.
 */
export type PiProviderModelCatalogEntry = {
  /** Registry-qualified model reference accepted by Pi. */
  alias: string
  /** Provider domain that owns the requested model alias. */
  modelProvider: string
  /** Provider identifier supplied to Pi's ModelRuntime. */
  piProvider: string
  /** Provider-qualified model identifier supplied to Pi's ModelRuntime. */
  piModelId: string
  /** Credential universe explicitly selected by the model alias. */
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

const OPENAI_PI_PROVIDER_MODELS: readonly PiProviderModelCatalogEntry[] =
  OPENAI_PI_MODEL_IDS.flatMap((piModelId) => [
    {
      alias: `openai/${piModelId}`,
      modelProvider: 'openai',
      piProvider: 'openai',
      piModelId: `openai/${piModelId}`,
      authMode: 'api-key',
    },
    {
      alias: `openai-codex/${piModelId}`,
      modelProvider: 'openai',
      piProvider: 'openai-codex',
      piModelId: `openai-codex/${piModelId}`,
      authMode: 'oauth',
    },
  ])

const ANTHROPIC_PI_PROVIDER_MODELS: readonly PiProviderModelCatalogEntry[] =
  ANTHROPIC_PI_MODEL_IDS.flatMap((piModelId) => [
    {
      alias: `anthropic/${piModelId}`,
      modelProvider: 'anthropic',
      piProvider: 'anthropic',
      piModelId: `anthropic/${piModelId}`,
      authMode: 'api-key',
    },
    {
      alias: `anthropic-max/${piModelId}`,
      modelProvider: 'anthropic',
      piProvider: 'anthropic',
      piModelId: `anthropic/${piModelId}`,
      authMode: 'oauth',
    },
  ])

export const PI_PROVIDER_MODEL_CATALOG: readonly PiProviderModelCatalogEntry[] = [
  ...OPENAI_PI_PROVIDER_MODELS,
  ...ANTHROPIC_PI_PROVIDER_MODELS,
]

export function findPiProviderModelCatalogEntry(
  modelProvider: string,
  alias: string
): PiProviderModelCatalogEntry | undefined {
  return PI_PROVIDER_MODEL_CATALOG.find(
    (model) => model.modelProvider === modelProvider && model.alias === alias
  )
}
