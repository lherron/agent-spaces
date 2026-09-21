import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  type HarnessAdapter,
  type HarnessModelInfo,
  type ProjectManifest,
  type TargetDefinition,
  getAgentRootsForProject,
  loadProjectManifest,
} from 'spaces-config'
// Internal legacy seam (EN-15986): the pre-cutover routing catalog, frozen
// for old v1 consumers. T-08702 deletes it with the last v1 consumer.
import {
  DEFAULT_HARNESS,
  type HarnessFrontend,
  type HarnessId,
  getHarnessCatalogEntry,
} from 'spaces-config/internal/legacy-harness'

import { harnessRegistry } from '../harness/index.js'

import {
  type LoadedAgentProfile,
  resolveAgentRunDefaultsFromProfile,
  resolveProfileHarnessForRun,
} from './agent-profile.js'
import { planProjectTargetRuntime } from './placement-plan.js'
import { resolveSpaceCodexConfigModel } from './space-codex-model.js'

export type ModelAuditSourceMode =
  | 'explicit_profile'
  | 'project_target'
  | 'materialized_effective_config'
  | 'space_codex_config'
  | 'adapter_default'
  | 'cli_override'

export type ModelAuditIdentityMode = 'full' | 'alias' | 'unsupported'

export interface ModelAuditRow {
  agentId: string
  profilePath: string
  harnessId: HarnessId
  frontend: HarnessFrontend
  sourceModel?: string | undefined
  resolvedModel: string
  launchModel?: string | undefined
  sourceMode: ModelAuditSourceMode
  identityMode: ModelAuditIdentityMode
  status: 'ok' | 'warning' | 'error'
  detail?: string | undefined
}

export interface AuditProjectModelsOptions {
  projectPath: string
  aspHome: string
  cliModel?: string | undefined
}

interface SelectedModelSource {
  sourceModel?: string | undefined
  sourceMode: ModelAuditSourceMode
}

function findModelInfo(adapter: HarnessAdapter, modelId: string): HarnessModelInfo | undefined {
  return adapter.models.find((model) => model.id === modelId)
}

function classifyModel(
  modelId: string,
  adapter: HarnessAdapter
): Pick<ModelAuditRow, 'resolvedModel' | 'identityMode' | 'status' | 'detail'> {
  const info = findModelInfo(adapter, modelId)
  if (!info) {
    return {
      resolvedModel: modelId,
      identityMode: 'unsupported',
      status: 'error',
      detail: `Model not supported for harness ${adapter.id}: ${modelId}`,
    }
  }

  const identityMode = info.identityKind ?? 'full'
  return {
    resolvedModel: info.canonicalId ?? info.id,
    identityMode,
    status: identityMode === 'alias' ? 'warning' : 'ok',
    ...(identityMode === 'alias'
      ? { detail: `Model alias ${info.id} resolves to ${info.canonicalId ?? info.id}` }
      : {}),
  }
}

function selectTargetModelSource(args: {
  cliModel?: string | undefined
  manifest: ProjectManifest
  target: TargetDefinition | undefined
  agentProfile: LoadedAgentProfile | undefined
  defaultRunOptionsModel?: string | undefined
  spaceCodexConfigModel?: string | undefined
  adapter: HarnessAdapter
}): SelectedModelSource {
  if (args.cliModel !== undefined) {
    return { sourceModel: args.cliModel, sourceMode: 'cli_override' }
  }

  const targetModel =
    args.target?.provisioning?.model ??
    args.target?.provisioning?.claude?.model ??
    args.target?.provisioning?.codex?.model
  if (targetModel !== undefined) {
    return { sourceModel: targetModel, sourceMode: 'project_target' }
  }

  const agentProfileModel =
    args.agentProfile?.profile.provisioning?.model ??
    args.agentProfile?.profile.provisioning?.claude?.model ??
    args.agentProfile?.profile.provisioning?.codex?.model
  if (agentProfileModel !== undefined) {
    return { sourceModel: agentProfileModel, sourceMode: 'explicit_profile' }
  }

  const topLevelProjectModel = args.manifest.claude?.model ?? args.manifest.codex?.model
  if (topLevelProjectModel !== undefined) {
    return { sourceModel: topLevelProjectModel, sourceMode: 'project_target' }
  }

  if (args.defaultRunOptionsModel !== undefined) {
    return { sourceModel: args.defaultRunOptionsModel, sourceMode: 'project_target' }
  }

  if (args.spaceCodexConfigModel !== undefined) {
    return { sourceModel: args.spaceCodexConfigModel, sourceMode: 'space_codex_config' }
  }

  const defaultModel =
    args.adapter.models.find((model) => model.default)?.id ?? args.adapter.models[0]?.id
  return { sourceModel: defaultModel, sourceMode: 'adapter_default' }
}

/** Adapter defaults and space config models are governed by config, not argv. */
function isLaunchedModelSource(sourceMode: ModelAuditSourceMode): boolean {
  return sourceMode !== 'adapter_default' && sourceMode !== 'space_codex_config'
}

function profilePath(agentProfile: LoadedAgentProfile): string {
  return join(agentProfile.agentRoot, 'agent-profile.toml')
}

async function listProjectAgentIds(projectPath: string, aspHome: string): Promise<string[]> {
  const agentIds = new Set<string>()
  const projectRoot = resolve(projectPath)
  for (const root of getAgentRootsForProject(projectPath, { aspHome })) {
    if (!resolve(root).startsWith(`${projectRoot}/`)) {
      continue
    }

    let entries: Dirent<string>[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        agentIds.add(entry.name)
      }
    }
  }
  return [...agentIds].sort()
}

export async function auditProjectModels(
  options: AuditProjectModelsOptions
): Promise<ModelAuditRow[]> {
  const manifest = await loadProjectManifest(options.projectPath, options.aspHome)
  const rows: ModelAuditRow[] = []
  const targetNames = new Set([
    ...Object.keys(manifest.targets),
    ...(await listProjectAgentIds(options.projectPath, options.aspHome)),
  ])

  for (const targetName of targetNames) {
    const runtimePlan = planProjectTargetRuntime(manifest, targetName, {
      aspHome: options.aspHome,
      projectPath: options.projectPath,
    })
    if (!runtimePlan.agentProfile) {
      continue
    }

    const agentDefaults = resolveAgentRunDefaultsFromProfile(
      runtimePlan.target,
      runtimePlan.agentProfile
    )
    const harnessId =
      resolveProfileHarnessForRun(agentDefaults.harness) ??
      resolveProfileHarnessForRun(runtimePlan.target?.provisioning?.harness) ??
      DEFAULT_HARNESS
    const adapter = harnessRegistry.getOrThrow(harnessId)
    const frontend = getHarnessCatalogEntry(harnessId).frontend
    if (!frontend) {
      continue
    }

    const selected = selectTargetModelSource({
      cliModel: options.cliModel,
      manifest,
      target: runtimePlan.target,
      agentProfile: runtimePlan.agentProfile,
      defaultRunOptionsModel: runtimePlan.defaultRunOptions.model,
      spaceCodexConfigModel:
        harnessId === 'codex'
          ? await resolveSpaceCodexConfigModel({
              compose: runtimePlan.effectiveCompose,
              aspHome: options.aspHome,
              agentRoot: runtimePlan.agentProfile.agentRoot,
              projectRoot: options.projectPath,
            })
          : undefined,
      adapter,
    })
    if (!selected.sourceModel) {
      continue
    }

    rows.push({
      agentId: targetName,
      profilePath: profilePath(runtimePlan.agentProfile),
      harnessId,
      frontend,
      sourceModel: selected.sourceModel,
      launchModel: isLaunchedModelSource(selected.sourceMode) ? selected.sourceModel : undefined,
      sourceMode: selected.sourceMode,
      ...(selected.sourceMode === 'space_codex_config'
        ? {
            resolvedModel: selected.sourceModel,
            identityMode: 'full' as const,
            status: 'ok' as const,
          }
        : classifyModel(selected.sourceModel, adapter)),
    })
  }

  return rows
}
