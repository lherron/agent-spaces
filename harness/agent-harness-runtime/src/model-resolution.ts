import { type PiSdkModelCatalogEntry, findPiSdkModelCatalogEntry } from 'spaces-runtime-contracts'

import type { LoadAgentOptions } from './types.js'

export function resolveAgentHarnessModel(
  explicitProvider: LoadAgentOptions['provider'],
  requestedModel: string
): PiSdkModelCatalogEntry {
  const qualified = requestedModel.includes('/')
    ? requestedModel
    : requestedModel.startsWith('claude-')
      ? `anthropic-max/${requestedModel}`
      : `openai-codex/${requestedModel}`
  const provider = explicitProvider ?? (qualified.startsWith('anthropic') ? 'anthropic' : 'openai')
  const model = findPiSdkModelCatalogEntry(provider, qualified)
  if (model === undefined) throw new Error(`Unsupported direct-harness model: ${qualified}`)
  return model
}

export function providerCredential(
  provider: string,
  environment: NodeJS.ProcessEnv
): string | undefined {
  if (provider === 'anthropic') return environment['ANTHROPIC_API_KEY']
  if (provider === 'openai' || provider === 'openai-codex') return environment['OPENAI_API_KEY']
  return environment[`${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`]
}
