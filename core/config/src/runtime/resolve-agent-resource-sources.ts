import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { readSpaceToml } from '../core/config/space-toml.js'
import type { AgentLocalComponents } from '../core/types/agent-local.js'
import { isHarnessSupported } from '../core/types/harness.js'
import type { LockFile, LockSpaceEntry, LockWarning } from '../core/types/lock.js'
import { getLoadOrderEntries } from '../core/types/lock.js'
import type { ResolvedPlacementContext, RuntimePlacement } from '../core/types/placement.js'
import type { SpaceKey, SpaceRefString } from '../core/types/refs.js'
import { populateSnapshotsFromLock } from '../orchestration/install.js'
import { ensureImmutableRegistry } from '../orchestration/resolve.js'
import { resolvePlacementContext } from '../resolver/placement-resolver.js'
import { type SpaceEntryKind, classifySpaceEntry } from '../resolver/space-classification.js'
import { PathResolver } from '../store/paths.js'
import { type AgentToolRuntimePreparer, composeAgentRuntimeEnv } from './compose-agent-env.js'
import { resolveAgentRuntimeSpecToLock } from './materialize-agent-runtime.js'

export type AgentResourceSpaceSource = 'mutable' | 'immutable-snapshot'

export interface ResolvedAgentResourceSpace {
  ref: SpaceRefString
  spaceKey: SpaceKey
  root: string
  source: AgentResourceSpaceSource
  /** Higher values have higher ASP precedence. */
  precedence: number
}

export type AgentResourceRootOwner =
  | {
      kind: 'space'
      ref: SpaceRefString
      spaceKey: SpaceKey
      source: AgentResourceSpaceSource
    }
  | {
      kind: 'agent-local'
      agentRoot: string
      source: 'mutable'
    }

export interface AgentResourceRoot {
  root: string
  owner: AgentResourceRootOwner
  /** Higher values have higher ASP precedence. */
  precedence: number
}

export interface ResolveAgentResourceSourcesOptions {
  /** Authoritative semantic placement; this operation does not choose placement. */
  placement: RuntimePlacement
  aspHome: string
  registryPathOverride?: string | undefined
  agentLocalComponents?: AgentLocalComponents | undefined
  baseEnvironment?: NodeJS.ProcessEnv | undefined
  reqLockedEnv?: Record<string, string> | undefined
  reqDispatchEnv?: Record<string, string> | undefined
  adapterEnv?: Record<string, string> | undefined
  agentchatEnv?: Record<string, string> | undefined
  warnings?: readonly string[] | undefined
  runtime: AgentToolRuntimePreparer
}

export interface ResolvedAgentResourceSources {
  placement: RuntimePlacement
  placementContext: ResolvedPlacementContext
  targetName: string
  lock: LockFile
  agentRoot: string
  projectRoot?: string | undefined
  cwd: string
  aspHome: string
  effectiveConfig: {
    model?: string | undefined
    reasoning?: string | undefined
  }
  orderedSpaces: ResolvedAgentResourceSpace[]
  skillRoots: AgentResourceRoot[]
  extensionRoots: AgentResourceRoot[]
  promptTemplateRoots: AgentResourceRoot[]
  environment: NodeJS.ProcessEnv
  pathPrepend: string[]
  warnings: string[]
}

function sourceRef(kind: SpaceEntryKind, entry: LockSpaceEntry): SpaceRefString {
  if (kind === 'agent') return `space:agent:${entry.id}` as SpaceRefString
  if (kind === 'project') return `space:project:${entry.id}` as SpaceRefString
  if (kind === 'dev') return `space:${entry.id}@dev` as SpaceRefString
  return `space:${entry.id}@git:${entry.commit}` as SpaceRefString
}

function sourceRoot(
  kind: SpaceEntryKind,
  entry: LockSpaceEntry,
  options: {
    agentRoot: string
    projectRoot?: string | undefined
    registryPath: string
    paths: PathResolver
  }
): string {
  if (kind === 'registry') return options.paths.snapshot(entry.integrity)
  if (kind === 'agent') return join(options.agentRoot, entry.path)
  if (kind === 'project') {
    if (!options.projectRoot) {
      throw new Error(`Project root is required for project-local space ${entry.id}`)
    }
    return join(options.projectRoot, entry.path)
  }
  return join(options.registryPath, entry.path)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function formatLockWarning(warning: LockWarning): string {
  return `${warning.code}: ${warning.message}`
}

async function appendResourceRoot(
  roots: AgentResourceRoot[],
  root: string,
  owner: AgentResourceRootOwner,
  precedence: number
): Promise<void> {
  if (await isDirectory(root)) {
    roots.push({ root, owner, precedence })
  }
}

/**
 * Resolve ASP-authored agent resources directly to their live or immutable
 * source roots. Immutable snapshot acquisition is allowed; compiler and harness
 * materialization are deliberately absent from this operation.
 */
export async function resolveAgentResourceSources(
  options: ResolveAgentResourceSourcesOptions
): Promise<ResolvedAgentResourceSources> {
  const placementContext = await resolvePlacementContext(options.placement)
  const { targetName, lock, registryPath } = await resolveAgentRuntimeSpecToLock(
    placementContext.materialization.spec,
    {
      aspHome: options.aspHome,
      ...(options.registryPathOverride
        ? { registryPathOverride: options.registryPathOverride }
        : {}),
      agentRoot: options.placement.agentRoot,
      ...(options.placement.projectRoot ? { projectRoot: options.placement.projectRoot } : {}),
      ...(options.placement.bundle.kind === 'agent-project'
        ? { materializationTargetName: options.placement.bundle.agentName }
        : {}),
    }
  )

  const projectPath =
    options.placement.projectRoot ?? options.placement.cwd ?? placementContext.resolvedBundle.cwd
  const immutableRegistryPath = await ensureImmutableRegistry(
    {
      projectPath,
      aspHome: options.aspHome,
      ...(options.registryPathOverride ? { registryPath: options.registryPathOverride } : {}),
      agentPath: options.placement.agentRoot,
    },
    { fetch: false }
  )
  await populateSnapshotsFromLock(lock, immutableRegistryPath, options.aspHome)

  const target = lock.targets[targetName]
  if (!target) {
    throw new Error(`Resolved target "${targetName}" is missing from its generated lock`)
  }

  const paths = new PathResolver({ aspHome: options.aspHome })
  const entries = getLoadOrderEntries(lock, targetName)
  const orderedSpaces: ResolvedAgentResourceSpace[] = []
  const skillRoots: AgentResourceRoot[] = []
  const extensionRoots: AgentResourceRoot[] = []
  const promptTemplateRoots: AgentResourceRoot[] = []

  for (const [precedence, entry] of entries.entries()) {
    const kind = classifySpaceEntry(entry)
    const ref = sourceRef(kind, entry)
    const root = sourceRoot(kind, entry, {
      agentRoot: options.placement.agentRoot,
      projectRoot: options.placement.projectRoot,
      registryPath,
      paths,
    })
    const manifest = await readSpaceToml(join(root, 'space.toml'))
    if (!isHarnessSupported(manifest.harness?.supports, 'agent-harness')) {
      throw new Error(
        `Space ${entry.id} (${ref}) does not support harness agent-harness; source root: ${root}`
      )
    }

    const source: AgentResourceSpaceSource = kind === 'registry' ? 'immutable-snapshot' : 'mutable'
    const resolvedSpace: ResolvedAgentResourceSpace = {
      ref,
      spaceKey: target.loadOrder[precedence] as SpaceKey,
      root,
      source,
      precedence,
    }
    orderedSpaces.push(resolvedSpace)
    const owner: AgentResourceRootOwner = {
      kind: 'space',
      ref,
      spaceKey: resolvedSpace.spaceKey,
      source,
    }
    await appendResourceRoot(skillRoots, join(root, 'skills'), owner, precedence)
    await appendResourceRoot(extensionRoots, join(root, 'extensions'), owner, precedence)
    await appendResourceRoot(promptTemplateRoots, join(root, 'commands'), owner, precedence)
  }

  const agentLocalPrecedence = orderedSpaces.length
  const local = options.agentLocalComponents
  if (local) {
    const owner: AgentResourceRootOwner = {
      kind: 'agent-local',
      agentRoot: local.agentRoot,
      source: 'mutable',
    }
    if (local.hasSkills) {
      await appendResourceRoot(skillRoots, local.skillsDir, owner, agentLocalPrecedence)
    }
    if (local.hasCommands) {
      await appendResourceRoot(promptTemplateRoots, local.commandsDir, owner, agentLocalPrecedence)
    }
  }

  const composedEnvironment = await composeAgentRuntimeEnv(
    {
      placement: options.placement,
      agentLocalComponents: local,
      aspHome: options.aspHome,
      ...(options.reqLockedEnv ? { reqLockedEnv: options.reqLockedEnv } : {}),
      ...(options.reqDispatchEnv ? { reqDispatchEnv: options.reqDispatchEnv } : {}),
      ...(options.adapterEnv ? { adapterEnv: options.adapterEnv } : {}),
      ...(options.agentchatEnv ? { agentchatEnv: options.agentchatEnv } : {}),
    },
    options.runtime
  )
  const effective = placementContext.materialization.effectiveConfig
  const warnings = [
    ...(options.warnings ?? []),
    ...(target.warnings ?? []).map(formatLockWarning),
    ...composedEnvironment.warnings,
  ]

  return {
    placement: options.placement,
    placementContext,
    targetName,
    lock,
    agentRoot: options.placement.agentRoot,
    ...(options.placement.projectRoot ? { projectRoot: options.placement.projectRoot } : {}),
    cwd: placementContext.resolvedBundle.cwd,
    aspHome: options.aspHome,
    effectiveConfig: {
      ...(effective?.model !== undefined ? { model: effective.model } : {}),
      ...(effective?.reasoning !== undefined ? { reasoning: effective.reasoning } : {}),
    },
    orderedSpaces,
    skillRoots,
    extensionRoots,
    promptTemplateRoots,
    environment: { ...(options.baseEnvironment ?? process.env), ...composedEnvironment.env },
    pathPrepend: composedEnvironment.pathPrepend,
    warnings,
  }
}
