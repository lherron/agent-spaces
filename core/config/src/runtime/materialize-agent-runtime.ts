import { createHash } from 'node:crypto'

import type { HygieneGateFinding } from '../core/errors.js'
import type { AgentLocalComponents } from '../core/types/agent-local.js'
import type { HarnessAdapter } from '../core/types/harness.js'
import type { LockFile } from '../core/types/lock.js'
import { PORTABLE_SPACES_REGISTRY } from '../core/types/lock.js'
import type { ResolvedPlacementSpec } from '../core/types/placement.js'
import type { SpaceRefString } from '../core/types/refs.js'
import { type InstallOptions, materializeTarget } from '../orchestration/install.js'
import {
  type MaterializeFromRefsOptions,
  type SkillMetadata,
  discoverSkills,
  materializeFromRefs,
} from '../orchestration/materialize-refs.js'
import {
  ensureImmutableRegistry,
  getRegistryPath,
  resolveTarget,
} from '../orchestration/resolve.js'
import { computeClosure } from '../resolver/closure.js'
import { generateLockFileForTarget } from '../resolver/lock-generator.js'
import { PathResolver } from '../store/paths.js'

export interface MaterializedAgentRuntimeResources {
  targetName: string
  outputPath: string
  pluginDirs: string[]
  mcpConfigPath?: string | undefined
  skills: SkillMetadata[]
  hygieneWarnings?: HygieneGateFinding[] | undefined
}

export interface MaterializeAgentRuntimeOptions {
  aspHome: string
  adapter?: HarnessAdapter | undefined
  registryPathOverride?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  materializationTargetName?: string | undefined
  materializationIdentity?:
    | {
        agentId: string
        projectId: string
        frontend?: string | undefined
      }
    | undefined
  agentLocalComponents?: AgentLocalComponents | undefined
}

function computeSpacesTargetName(spaces: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(spaces))
  return `spaces-${hash.digest('hex').slice(0, 12)}`
}

function resolveSharedSpacesRoot(options: MaterializeAgentRuntimeOptions): string {
  return getRegistryPath({
    aspHome: options.aspHome,
    projectPath: options.projectRoot ?? process.cwd(),
    ...(options.registryPathOverride ? { registryPath: options.registryPathOverride } : {}),
  })
}

async function resolveImmutableSpacesRoot(
  refs: readonly string[],
  options: MaterializeAgentRuntimeOptions
): Promise<string> {
  if (refs.length === 0) {
    return resolveSharedSpacesRoot(options)
  }
  return await ensureImmutableRegistry(
    {
      aspHome: options.aspHome,
      projectPath: options.projectRoot ?? process.cwd(),
      ...(options.registryPathOverride ? { registryPath: options.registryPathOverride } : {}),
    },
    { fetch: false }
  )
}

export async function resolveAgentRuntimeSpecToLock(
  spec: ResolvedPlacementSpec,
  options: MaterializeAgentRuntimeOptions
): Promise<{ targetName: string; lock: LockFile; registryPath: string }> {
  if (spec.kind === 'target') {
    const result = await resolveTarget(spec.targetName, {
      projectPath: spec.targetDir,
      aspHome: options.aspHome,
      ...(options.registryPathOverride ? { registryPath: options.registryPathOverride } : {}),
      ...(options.agentRoot ? { agentPath: options.agentRoot } : {}),
    })
    const registryPath = getRegistryPath({
      projectPath: spec.targetDir,
      aspHome: options.aspHome,
      ...(options.registryPathOverride ? { registryPath: options.registryPathOverride } : {}),
    })
    return { targetName: spec.targetName, lock: result.lock, registryPath }
  }

  const refs = spec.spaces
  const targetName = options.materializationTargetName ?? computeSpacesTargetName(refs)
  const registryPath = resolveSharedSpacesRoot(options)
  const immutableRegistryPath = await resolveImmutableSpacesRoot(refs, options)
  const closure = await computeClosure(refs, {
    cwd: registryPath,
    immutableCwd: immutableRegistryPath,
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  })
  const lock = await generateLockFileForTarget(targetName, refs, closure, {
    cwd: registryPath,
    immutableCwd: immutableRegistryPath,
    registry: PORTABLE_SPACES_REGISTRY,
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  })
  return { targetName, lock, registryPath }
}

export async function materializeAgentRuntimeResources(
  spec: ResolvedPlacementSpec,
  options: MaterializeAgentRuntimeOptions
): Promise<MaterializedAgentRuntimeResources> {
  const adapter = options.adapter
  if (adapter === undefined) {
    throw new Error('materializeAgentRuntimeResources requires a harness adapter')
  }
  if (spec.kind === 'target') {
    const { targetName, lock, registryPath } = await resolveAgentRuntimeSpecToLock(spec, options)
    const materializationOptions: InstallOptions = {
      projectPath: spec.targetDir,
      aspHome: options.aspHome,
      registryPath,
      adapter,
      ...(options.agentRoot ? { agentPath: options.agentRoot } : {}),
      ...(options.agentLocalComponents
        ? { agentLocalComponents: options.agentLocalComponents }
        : {}),
      ...(options.materializationIdentity
        ? { materializationIdentity: options.materializationIdentity }
        : {}),
    }
    const materialization = await materializeTarget(targetName, lock, materializationOptions)
    return {
      targetName,
      outputPath: materialization.outputPath,
      pluginDirs: materialization.pluginDirs,
      mcpConfigPath: materialization.mcpConfigPath,
      skills: await discoverSkills(materialization.pluginDirs),
      ...(materialization.hygieneWarnings !== undefined
        ? { hygieneWarnings: materialization.hygieneWarnings }
        : {}),
    }
  }

  const targetName = options.materializationTargetName ?? computeSpacesTargetName(spec.spaces)
  const paths = new PathResolver({ aspHome: options.aspHome })
  const registryPath = resolveSharedSpacesRoot(options)
  const immutableRegistryPath = await resolveImmutableSpacesRoot(spec.spaces, options)
  const materializeOptions: MaterializeFromRefsOptions = {
    targetName,
    refs: spec.spaces as SpaceRefString[],
    registryPath,
    immutableRegistryPath,
    aspHome: options.aspHome,
    lockPath: paths.globalLock,
    adapter,
    ...(options.projectRoot ? { projectPath: options.projectRoot } : {}),
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options.agentLocalComponents ? { agentLocalComponents: options.agentLocalComponents } : {}),
    ...(options.materializationIdentity
      ? { materializationIdentity: options.materializationIdentity }
      : {}),
  }
  const materialized = await materializeFromRefs(materializeOptions)
  return {
    targetName,
    outputPath: materialized.materialization.outputPath,
    pluginDirs: materialized.materialization.pluginDirs,
    mcpConfigPath: materialized.materialization.mcpConfigPath,
    skills: materialized.skills,
    ...(materialized.materialization.hygieneWarnings !== undefined
      ? { hygieneWarnings: materialized.materialization.hygieneWarnings }
      : {}),
  }
}
