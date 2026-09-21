import { AGENT_SDK_MODELS, DEFAULT_AGENT_SDK_MODEL, type HarnessId } from 'spaces-config'
import { PI_SDK_MODEL_CATALOG } from 'spaces-runtime-contracts'

import { HARNESS_CATALOG } from './harness-selection/catalog.js'
import type {
  AgentSpacesError,
  HarnessContinuationRef,
  HarnessFrontend,
  ProviderDomain,
} from './types.js'

export const AGENT_SDK_FRONTEND: HarnessFrontend = 'agent-sdk'
export const PI_SDK_FRONTEND: HarnessFrontend = 'pi-sdk'
export const CLAUDE_CODE_FRONTEND: HarnessFrontend = 'claude-code'
export const CODEX_CLI_FRONTEND: HarnessFrontend = 'codex-cli'
export const PI_CLI_FRONTEND: HarnessFrontend = 'pi-cli'
export const MUSE_CLI_FRONTEND: HarnessFrontend = 'muse-cli'

export class CodedError extends Error {
  readonly code: NonNullable<AgentSpacesError['code']>
  constructor(message: string, code: NonNullable<AgentSpacesError['code']>) {
    super(message)
    this.code = code
  }
}

export interface FrontendDef {
  provider: ProviderDomain
  internalId: HarnessId
  frontend: HarnessFrontend
  models: string[]
  defaultModel: string
}

export interface ModelInfo {
  effectiveModel: string
  provider: string
  model: string
}

function createAdapterDef(
  internalId: HarnessId,
  provider: ProviderDomain,
  frontend: HarnessFrontend,
  models: readonly string[],
  defaultModel: string
): FrontendDef {
  return {
    provider,
    internalId,
    frontend,
    models: [...models],
    defaultModel,
  }
}

function providerFor(harness: HarnessId) {
  return HARNESS_CATALOG[harness].supportedModelProviders[0]!
}

export const ADAPTER_DEFS = new Map<HarnessFrontend, FrontendDef>([
  [
    AGENT_SDK_FRONTEND,
    createAdapterDef(
      'claude',
      'anthropic',
      AGENT_SDK_FRONTEND,
      AGENT_SDK_MODELS,
      DEFAULT_AGENT_SDK_MODEL
    ),
  ],
  [
    PI_SDK_FRONTEND,
    createAdapterDef(
      'agent-harness',
      'openai',
      PI_SDK_FRONTEND,
      PI_SDK_MODEL_CATALOG.map((model) => model.alias),
      'openai-codex/gpt-5.5'
    ),
  ],
  [
    CLAUDE_CODE_FRONTEND,
    createAdapterDef(
      'claude',
      'anthropic',
      CLAUDE_CODE_FRONTEND,
      providerFor('claude').supportedModels,
      providerFor('claude').defaultModel
    ),
  ],
  [
    CODEX_CLI_FRONTEND,
    createAdapterDef(
      'codex',
      'openai',
      CODEX_CLI_FRONTEND,
      providerFor('codex').supportedModels,
      providerFor('codex').defaultModel
    ),
  ],
  [
    MUSE_CLI_FRONTEND,
    createAdapterDef(
      'muse',
      'meta',
      MUSE_CLI_FRONTEND,
      providerFor('muse').supportedModels,
      providerFor('muse').defaultModel
    ),
  ],
  [
    PI_CLI_FRONTEND,
    createAdapterDef(
      'agent-harness',
      'openai',
      PI_CLI_FRONTEND,
      providerFor('agent-harness').supportedModels,
      providerFor('agent-harness').defaultModel
    ),
  ],
])

export function resolveFrontend(
  frontend: HarnessFrontend
): FrontendDef & { frontend: HarnessFrontend } {
  const def = ADAPTER_DEFS.get(frontend)
  if (!def) {
    throw new CodedError(`Unsupported frontend: ${frontend}`, 'unsupported_frontend')
  }
  return { ...def, frontend }
}

export function assertProviderMatch(
  frontendDef: FrontendDef & { frontend: HarnessFrontend },
  continuation: HarnessContinuationRef | undefined
): void {
  if (continuation && continuation.provider !== frontendDef.provider) {
    throw new CodedError(
      `Provider mismatch: frontend "${frontendDef.frontend}" is provider "${frontendDef.provider}" but continuation is provider "${continuation.provider}"`,
      'provider_mismatch'
    )
  }
}

/**
 * Split a possibly-namespaced model id (e.g. `openai-codex/gpt-5.5`) into its
 * `(provider, model)` parts. A bare id (no `/`) yields the supplied
 * `fallbackProvider` and the id as the model. The split point is the FIRST `/`
 * and is only honored when it is not the leading character (`slash > 0`),
 * matching the pi model registry's namespacing rules.
 */
export function splitNamespacedModel(
  modelId: string,
  fallbackProvider: string
): { provider: string; model: string } {
  const slash = modelId.indexOf('/')
  if (slash > 0) {
    return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) }
  }
  return { provider: fallbackProvider, model: modelId }
}

function parseModelId(modelId: string): ModelInfo | null {
  const separatorIndex = modelId.indexOf('/')
  if (separatorIndex === -1) {
    return { effectiveModel: modelId, provider: 'codex', model: modelId }
  }
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
    return null
  }
  const { provider, model } = splitNamespacedModel(modelId, 'codex')
  if (!provider || !model) {
    return null
  }
  return { effectiveModel: modelId, provider, model }
}

export function resolveModel(
  frontendDef: { models: string[]; defaultModel: string },
  requested: string | undefined
): { ok: true; info: ModelInfo } | { ok: false; modelId: string } {
  const modelId = requested ?? frontendDef.defaultModel
  if (!frontendDef.models.includes(modelId)) {
    return { ok: false, modelId }
  }
  const info = parseModelId(modelId)
  if (!info) {
    return { ok: false, modelId }
  }
  return { ok: true, info }
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function formatDisplayCommand(
  commandPath: string,
  args: string[],
  env: Record<string, string>
): string {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
  const command = [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
  return envPrefix ? `${envPrefix} ${command}` : command
}
