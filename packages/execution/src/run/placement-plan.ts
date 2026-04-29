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
  getAgentsRoot,
  getHarnessCatalogEntryByFrontend,
} from 'spaces-config'

import { harnessRegistry } from '../harness/index.js'

import {
  type LoadedAgentProfile,
  loadAgentProfileForRun,
  resolveAgentPrimingPromptForRun,
  type resolveAgentRunDefaults,
  resolveAgentRunDefaultsFromProfile,
  resolveProfileHarnessForRun,
} from './agent-profile.js'
import { resolveInteractive } from './util.js'

interface PlacementRuntimeModelInfo {
  effectiveModel: string
  provider: string
  model: string
}

export type PlacementRuntimeModelResolution =
  | { ok: true; info: PlacementRuntimeModelInfo }
  | { ok: false; modelId: string }

export interface PlacementRuntimePlan {
  frontend: HarnessFrontend
  harnessId: HarnessId
  provider: HarnessProvider
  cwd: string
  defaultRunOptions: Partial<HarnessRunOptions>
  prompt?: string | undefined
  yolo?: boolean | undefined
  model: PlacementRuntimeModelResolution
  runOptions: Partial<HarnessRunOptions>
}

export interface PlanPlacementRuntimeOptions {
  placement: RuntimePlacement
  placementContext: ResolvedPlacementContext
  frontend: HarnessFrontend
  aspHome: string
  model?: string | undefined
  prompt?: string | undefined
  promptOverrideMode?: 'nullish' | 'truthy' | undefined
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

function parsePlacementRuntimeModelId(modelId: string): PlacementRuntimeModelInfo | null {
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
  const candidateModel =
    requestedModel ??
    defaultRunOptions.model ??
    (effectiveModel && supportedModels.has(effectiveModel) ? effectiveModel : undefined) ??
    defaultModelId

  if (!candidateModel || !supportedModels.has(candidateModel)) {
    return { ok: false, modelId: candidateModel ?? 'unknown' }
  }

  const info = parsePlacementRuntimeModelId(candidateModel)
  if (!info) {
    return { ok: false, modelId: candidateModel }
  }

  return { ok: true, info }
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

  if (
    (harnessId === 'claude' || harnessId === 'claude-agent-sdk') &&
    defaults.model !== undefined &&
    claude.model === undefined
  ) {
    claude.model = defaults.model
  }

  return {
    schema: 1,
    ...(manifest.claude ? { claude: manifest.claude } : {}),
    ...(manifest.codex ? { codex: manifest.codex } : {}),
    targets: {
      [targetName]: {
        compose: defaults.compose ?? [],
        ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
        ...(defaults.yolo ? { yolo: true } : {}),
        ...(defaults.remoteControl ? { remote_control: true } : {}),
        ...(Object.keys(claude).length > 0 ? { claude } : {}),
        ...(Object.keys(codex).length > 0 ? { codex } : {}),
      },
    },
  }
}

export function planProjectTargetRuntime(
  manifest: ProjectManifest,
  targetName: string,
  options: {
    aspHome: string
    harness?: HarnessId | undefined
  }
): ProjectTargetRuntimePlan {
  const target = manifest.targets[targetName]
  const agentProfile = loadAgentProfileForRun(targetName, {
    agentsRoot: getAgentsRoot({ aspHome: options.aspHome }),
  })
  const agentDefaults = agentProfile
    ? resolveAgentRunDefaultsFromProfile(target, agentProfile)
    : undefined
  const harnessId =
    options.harness ??
    resolveProfileHarnessForRun(agentDefaults?.harness) ??
    resolveProfileHarnessForRun(target?.harness) ??
    DEFAULT_HARNESS
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
      : placement.bundle.kind === 'project-target'
        ? planProjectTargetRuntime(
            placementContext.materialization.manifest,
            placement.bundle.target,
            {
              aspHome,
              harness: frontendEntry.id,
            }
          ).defaultRunOptions
        : {}
  const model = resolvePlacementRuntimeModel(
    adapter,
    options.model,
    defaultRunOptions,
    placementContext.materialization.effectiveConfig
  )
  const defaultPrompt =
    defaultRunOptions.prompt ?? placementContext.materialization.effectiveConfig?.priming_prompt
  const prompt =
    options.promptOverrideMode === 'truthy'
      ? options.prompt || defaultPrompt
      : (options.prompt ?? defaultPrompt)
  const yolo =
    options.yolo ?? defaultRunOptions.yolo ?? placementContext.materialization.effectiveConfig?.yolo
  const cwd = placementContext.resolvedBundle.cwd
  const runOptions: Partial<HarnessRunOptions> = {
    ...defaultRunOptions,
    aspHome,
    interactive: resolveInteractive(options.interactive),
    projectPath: cwd,
    cwd,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(yolo !== undefined ? { yolo } : {}),
    ...(options.continuationKey !== undefined ? { continuationKey: options.continuationKey } : {}),
    ...(placement.bundle.kind === 'agent-project'
      ? { codexRuntimeTargetName: placement.bundle.agentName }
      : {}),
  }

  if (model.ok) {
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
