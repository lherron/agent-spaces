import {
  type ClaudeOptions,
  type CodexOptions,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessFrontend,
  type HarnessId,
  type HarnessProvider,
  type HarnessRunOptions,
  type ProjectManifest,
  type ResolvedPlacementContext,
  type RuntimePlacement,
  type SpaceRefString,
  type TargetDefinition,
  getHarnessCatalogEntry,
  getHarnessCatalogEntryByFrontend,
} from 'spaces-config'
import type {
  PlacementRuntimeModelResolution as ContractPlacementRuntimeModelResolution,
  PlacementRuntimePlan as ContractPlacementRuntimePlan,
} from 'spaces-runtime-contracts'

import { harnessRegistry } from '../harness/index.js'

import {
  type LoadedAgentProfile,
  loadAgentProfileForRun,
  resolveAgentPrimingPromptForRun,
  type resolveAgentRunDefaults,
  resolveAgentRunDefaultsFromProfile,
  resolveProfileHarnessForRun,
} from './agent-profile.js'

export type PlacementRuntimeModelResolution = ContractPlacementRuntimeModelResolution
type PlacementRuntimeModelInfo = Extract<PlacementRuntimeModelResolution, { ok: true }>['info']

export type PlacementRuntimePlan = ContractPlacementRuntimePlan<
  HarnessFrontend,
  HarnessId,
  HarnessProvider,
  Partial<HarnessRunOptions>
>

export interface PlanPlacementRuntimeOptions {
  placement: RuntimePlacement
  placementContext: ResolvedPlacementContext
  frontend: HarnessFrontend
  aspHome: string
  model?: string | undefined
  prompt?: string | undefined
  promptOverrideMode?: 'nullish' | 'truthy' | 'exact' | undefined
  yolo?: boolean | undefined
  interactive?: boolean | undefined
  continuationKey?: string | boolean | undefined
}

export interface ProjectTargetRuntimePlan {
  target: TargetDefinition | undefined
  agentProfile: LoadedAgentProfile | undefined
  harnessId: HarnessId
  adapter: HarnessAdapter
  defaultPrompt?: string | undefined
  effectiveCompose?: SpaceRefString[] | undefined
  defaultRunOptions: Partial<HarnessRunOptions>
}

export function assertHarnessAvailableForRun(harnessId: HarnessId): void {
  if (harnessId === 'claude-agent-sdk' || harnessId === 'pi-sdk') {
    throw new Error(
      `Harness "${harnessId}" is retired from asp run; use hrc to spawn non-foreground runtimes.`
    )
  }
}

function parsePlacementRuntimeModelId(
  modelId: string
): Omit<PlacementRuntimeModelInfo, 'explicit'> | null {
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

function resolvePlacementRuntimeModel(
  adapter: HarnessAdapter,
  requestedModel: string | undefined,
  defaultRunOptions: Partial<HarnessRunOptions>,
  effectiveConfig: ResolvedPlacementContext['materialization']['effectiveConfig']
): PlacementRuntimeModelResolution {
  const defaultModelId =
    adapter.models.find((model) => model.default)?.id ?? adapter.models[0]?.id ?? requestedModel
  const supportedModels = new Set(adapter.models.map((model) => model.id))
  const effectiveModel = effectiveConfig?.model
  const explicitModel =
    requestedModel ??
    defaultRunOptions.model ??
    (effectiveModel !== undefined ? effectiveModel : undefined)
  const candidateModel = explicitModel ?? defaultModelId

  if (!candidateModel || !supportedModels.has(candidateModel)) {
    return { ok: false, modelId: candidateModel ?? 'unknown' }
  }

  const info = parsePlacementRuntimeModelId(candidateModel)
  if (!info) {
    return { ok: false, modelId: candidateModel }
  }

  return { ok: true, info: { ...info, explicit: explicitModel !== undefined } }
}

export function buildSyntheticRunManifest(
  manifest: ProjectManifest,
  targetName: string,
  defaults: NonNullable<ReturnType<typeof resolveAgentRunDefaults>>,
  harnessId: HarnessId,
  primingPrompt: string | undefined
): ProjectManifest {
  const claude: ClaudeOptions = { ...(defaults.claude ?? {}) }
  const codex: CodexOptions = { ...(defaults.codex ?? {}) }

  // Source the claude-family check from the catalog provider (anthropic) instead
  // of a hardcoded harness-id list so new claude variants are covered for free.
  const isClaudeFamily = getHarnessCatalogEntry(harnessId).provider === 'anthropic'
  if (isClaudeFamily && defaults.model !== undefined && claude.model === undefined) {
    claude.model = defaults.model
  }

  return {
    schema: 1,
    ...(manifest.claude ? { claude: manifest.claude } : {}),
    ...(manifest.codex ? { codex: manifest.codex } : {}),
    targets: {
      [targetName]: {
        compose: defaults.compose ?? [],
        ...(primingPrompt !== undefined ? { priming: primingPrompt } : {}),
        provisioning: {
          ...(defaults.model !== undefined ? { model: defaults.model } : {}),
          ...(defaults.yolo ? { yolo: true } : {}),
          ...(defaults.remoteControl ? { remote: true } : {}),
          ...(Object.keys(claude).length > 0 ? { claude } : {}),
          ...(Object.keys(codex).length > 0 ? { codex } : {}),
        },
      },
    },
  }
}

export function planProjectTargetRuntime(
  manifest: ProjectManifest,
  targetName: string,
  options: {
    aspHome: string
    projectPath: string
    harness?: HarnessId | undefined
  }
): ProjectTargetRuntimePlan {
  const target = manifest.targets[targetName]
  const agentProfile = loadAgentProfileForRun(targetName, {
    projectRoot: options.projectPath,
    aspHome: options.aspHome,
  })
  const agentDefaults = agentProfile
    ? resolveAgentRunDefaultsFromProfile(target, agentProfile)
    : undefined
  const harnessId =
    options.harness ??
    resolveProfileHarnessForRun(agentDefaults?.harness) ??
    resolveProfileHarnessForRun(target?.provisioning?.harness) ??
    DEFAULT_HARNESS
  assertHarnessAvailableForRun(harnessId)
  const adapter = harnessRegistry.getOrThrow(harnessId)
  const primingPrompt = resolveAgentPrimingPromptForRun(target, agentProfile)
  const effectiveManifest =
    agentDefaults !== undefined
      ? buildSyntheticRunManifest(manifest, targetName, agentDefaults, harnessId, primingPrompt)
      : manifest
  const defaultRunOptions = adapter.getDefaultRunOptions(effectiveManifest, targetName)
  const defaultPrompt = defaultRunOptions.prompt ?? primingPrompt

  return {
    target,
    agentProfile,
    harnessId,
    adapter,
    ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
    ...(agentDefaults?.compose !== undefined ? { effectiveCompose: agentDefaults.compose } : {}),
    defaultRunOptions,
  }
}

export async function planPlacementRuntime(
  options: PlanPlacementRuntimeOptions
): Promise<PlacementRuntimePlan> {
  const { placement, placementContext, frontend, aspHome } = options
  const frontendEntry = getHarnessCatalogEntryByFrontend(frontend)
  if (!frontendEntry) {
    throw new Error(`Unknown harness frontend "${frontend}"`)
  }

  const adapter = harnessRegistry.getOrThrow(frontendEntry.id)
  const defaultRunOptions = !placementContext.materialization.manifest
    ? {}
    : placement.bundle.kind === 'agent-project'
      ? adapter.getDefaultRunOptions(
          placementContext.materialization.manifest,
          placement.bundle.agentName
        )
      : {}
  const model = resolvePlacementRuntimeModel(
    adapter,
    options.model,
    defaultRunOptions,
    placementContext.materialization.effectiveConfig
  )
  // Profile/default prompts prime a new conversation. A continuation already
  // owns its conversation context, so applying this fallback would append the
  // priming text as a fresh user turn (for interactive CLIs, directly on argv).
  // Explicit caller prompts still win through `options.prompt` below.
  const defaultPrompt =
    options.continuationKey === undefined
      ? (defaultRunOptions.prompt ?? placementContext.materialization.effectiveConfig?.priming)
      : undefined
  const prompt =
    options.promptOverrideMode === 'exact'
      ? options.prompt
      : options.promptOverrideMode === 'truthy'
        ? options.prompt || defaultPrompt
        : (options.prompt ?? defaultPrompt)
  const yolo =
    options.yolo ?? defaultRunOptions.yolo ?? placementContext.materialization.effectiveConfig?.yolo
  const cwd = placementContext.resolvedBundle.cwd
  // Re-add only the resolved prompt below. Leaving the adapter's raw default in
  // this spread would bypass the continuation gate (and template expansion).
  const resolvedDefaultRunOptions = { ...defaultRunOptions }
  resolvedDefaultRunOptions.prompt = undefined
  const runOptions: Partial<HarnessRunOptions> = {
    ...resolvedDefaultRunOptions,
    aspHome,
    interactive: options.interactive,
    projectPath: cwd,
    cwd,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(yolo !== undefined ? { yolo } : {}),
    ...(options.continuationKey !== undefined ? { continuationKey: options.continuationKey } : {}),
    ...(placement.bundle.kind === 'agent-project'
      ? { codexRuntimeTargetName: placement.bundle.agentName }
      : {}),
  }

  // Only push --model onto the launch argv when the model came from an explicit
  // source. Falling back to the adapter default for plan metadata must NOT inject
  // --model into argv — legacy `asp run` omits it (e.g. codex, governed by
  // CODEX_HOME/config.toml).
  if (model.ok && model.info.explicit) {
    runOptions.model = model.info.model
  }

  return {
    frontend,
    harnessId: frontendEntry.id,
    provider: frontendEntry.provider,
    cwd,
    defaultRunOptions,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(yolo !== undefined ? { yolo } : {}),
    model,
    runOptions,
  }
}
