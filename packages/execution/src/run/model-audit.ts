import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessFrontend,
  type HarnessId,
  type HarnessModelInfo,
  type ProjectManifest,
  type TargetDefinition,
  getAgentRootsForProject,
  getHarnessCatalogEntry,
  loadProjectManifest,
} from 'spaces-config'

import { harnessRegistry } from '../harness/index.js'

import {
  type LoadedAgentProfile,
  resolveAgentRunDefaultsFromProfile,
  resolveProfileHarnessForRun,
} from './agent-profile.js'
import { planProjectTargetRuntime } from './placement-plan.js'

export type ModelAuditSourceMode =
  | 'explicit_profile'
  | 'project_target'
  | 'materialized_effective_config'
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
  adapter: HarnessAdapter
}): SelectedModelSource {
  if (args.cliModel !== undefined) {
    return { sourceModel: args.cliModel, sourceMode: 'cli_override' }
  }

  const targetModel = args.target?.claude?.model ?? args.target?.codex?.model
  if (targetModel !== undefined) {
    return { sourceModel: targetModel, sourceMode: 'project_target' }
  }

  const agentProfileModel =
    args.agentProfile?.profile.harnessDefaults?.model ??
    args.agentProfile?.profile.harnessDefaults?.claude?.model ??
    args.agentProfile?.profile.harnessDefaults?.codex?.model
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

  const defaultModel =
    args.adapter.models.find((model) => model.default)?.id ?? args.adapter.models[0]?.id
  return { sourceModel: defaultModel, sourceMode: 'adapter_default' }
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
      resolveProfileHarnessForRun(runtimePlan.target?.harness) ??
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
      launchModel: selected.sourceMode === 'adapter_default' ? undefined : selected.sourceModel,
      sourceMode: selected.sourceMode,
      ...classifyModel(selected.sourceModel, adapter),
    })
  }

  return rows
}
