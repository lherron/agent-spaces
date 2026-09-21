import { AGENT_SDK_MODELS, DEFAULT_AGENT_SDK_MODEL } from 'spaces-config'
import { PI_PROVIDER_MODEL_CATALOG } from 'spaces-runtime-contracts'

import { CodedError } from './client-support.js'
import type { HarnessContinuationRef, ProviderDomain } from './types.js'

export const AGENT_SDK_FRONTEND = 'agent-sdk' as const
export const PI_SDK_FRONTEND = 'pi-sdk' as const

type SessionFrontend = typeof AGENT_SDK_FRONTEND | typeof PI_SDK_FRONTEND

export type SessionRuntimeFacts = {
  frontend: SessionFrontend
  provider: ProviderDomain
  models: readonly string[]
  defaultModel: string
}

const SESSION_RUNTIME_FACTS: Readonly<Record<SessionFrontend, SessionRuntimeFacts>> = {
  [AGENT_SDK_FRONTEND]: {
    frontend: AGENT_SDK_FRONTEND,
    provider: 'anthropic',
    models: AGENT_SDK_MODELS,
    defaultModel: DEFAULT_AGENT_SDK_MODEL,
  },
  [PI_SDK_FRONTEND]: {
    frontend: PI_SDK_FRONTEND,
    provider: 'openai',
    // Pi's provider-qualified model metadata informs materialization only; it
    // carries no harness, driver, lifecycle, or presentation selection.
    models: PI_PROVIDER_MODEL_CATALOG.map((model) => model.alias),
    defaultModel: 'openai-codex/gpt-5.5',
  },
}

export function sessionRuntimeFacts(frontend: SessionFrontend): SessionRuntimeFacts {
  return SESSION_RUNTIME_FACTS[frontend]
}

export function assertSessionContinuationProvider(
  facts: SessionRuntimeFacts,
  continuation: HarnessContinuationRef | undefined
): void {
  if (continuation?.provider !== undefined && continuation.provider !== facts.provider) {
    throw new CodedError(
      `Provider mismatch: session frontend "${facts.frontend}" is provider "${facts.provider}" but continuation is provider "${continuation.provider}"`,
      'provider_mismatch'
    )
  }
}

export function resolveSessionRuntimeModel(
  facts: SessionRuntimeFacts,
  requested: string | undefined
): { ok: true; model: string } | { ok: false; modelId: string } {
  const model = requested ?? facts.defaultModel
  return facts.models.includes(model) ? { ok: true, model } : { ok: false, modelId: model }
}
