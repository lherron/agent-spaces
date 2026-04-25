import {
  AGENT_SDK_MODELS,
  CLAUDE_CODE_MODELS,
  DEFAULT_AGENT_SDK_MODEL,
  DEFAULT_CLAUDE_CODE_MODEL,
  type HarnessId,
  getHarnessCatalogEntryByFrontend,
} from 'spaces-config'

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

const PI_SDK_MODELS = [
  'openai-codex/gpt-5.5',
  'openai-codex/gpt-5.3-codex',
  'openai-codex/gpt-5.3',
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.2',
  'api/gpt-5.5',
  'api/gpt-5.3-codex',
  'api/gpt-5.3',
  'api/gpt-5.2-codex',
  'api/gpt-5.2',
]

const CODEX_CLI_MODELS = [
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.3',
  'gpt-5.2-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5-codex',
  'gpt-5-codex-mini',
  'gpt-5',
]

const DEFAULT_PI_SDK_MODEL = 'openai-codex/gpt-5.5'
const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.5'

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

function createFrontendDef(
  frontend: HarnessFrontend,
  models: string[],
  defaultModel: string
): FrontendDef {
  const catalogEntry = getHarnessCatalogEntryByFrontend(frontend)
  if (!catalogEntry) {
    throw new Error(`Unknown harness frontend "${frontend}"`)
  }
  return {
    provider: catalogEntry.provider,
    internalId: catalogEntry.id,
    frontend,
    models,
    defaultModel,
  }
}

export const FRONTEND_DEFS = new Map<HarnessFrontend, FrontendDef>([
  [
    AGENT_SDK_FRONTEND,
    createFrontendDef(AGENT_SDK_FRONTEND, AGENT_SDK_MODELS, DEFAULT_AGENT_SDK_MODEL),
  ],
  [PI_SDK_FRONTEND, createFrontendDef(PI_SDK_FRONTEND, PI_SDK_MODELS, DEFAULT_PI_SDK_MODEL)],
  [
    CLAUDE_CODE_FRONTEND,
    createFrontendDef(CLAUDE_CODE_FRONTEND, CLAUDE_CODE_MODELS, DEFAULT_CLAUDE_CODE_MODEL),
  ],
  [
    CODEX_CLI_FRONTEND,
    createFrontendDef(CODEX_CLI_FRONTEND, CODEX_CLI_MODELS, DEFAULT_CODEX_CLI_MODEL),
  ],
  [PI_CLI_FRONTEND, createFrontendDef(PI_CLI_FRONTEND, CODEX_CLI_MODELS, DEFAULT_CODEX_CLI_MODEL)],
])

export function resolveFrontend(
  frontend: HarnessFrontend
): FrontendDef & { frontend: HarnessFrontend } {
  const def = FRONTEND_DEFS.get(frontend)
  if (!def) {
    throw new CodedError(`Unsupported frontend: ${frontend}`, 'unsupported_frontend')
  }
  return { ...def, frontend }
}

export function validateProviderMatch(
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

function parseModelId(modelId: string): ModelInfo | null {
  const separatorIndex = modelId.indexOf('/')
  if (separatorIndex === -1) {
    return { effectiveModel: modelId, provider: 'codex', model: modelId }
  }
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
    return null
  }
  const provider = modelId.slice(0, separatorIndex)
  const model = modelId.slice(separatorIndex + 1)
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
