import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import {
  type AgentLocalComponents,
  type HarnessId,
  type HygieneGateFinding,
  type LintWarning,
  PathResolver,
  type ResolvedPlacementSpec,
  type SpaceRefString,
  asSha256Integrity,
  asSpaceId,
  lintSpaces,
  materializeAgentRuntimeResources,
  readHooksWithPrecedence,
  resolveAgentRuntimeSpecToLock,
} from 'spaces-config'

import { CodedError } from './client-support.js'
import type { AgentSpacesRuntimeDependencies } from './placement-api.js'
import type { SpaceSpec } from './types.js'

export type ValidatedSpec = ResolvedPlacementSpec

export interface MaterializedSpec {
  targetName: string
  materialization: {
    outputPath: string
    pluginDirs: string[]
    mcpConfigPath?: string | undefined
  }
  skills: string[]
  hygieneWarnings?: HygieneGateFinding[] | undefined
}

export function validateSpec(spec: SpaceSpec): ValidatedSpec {
  const hasSpaces = 'spaces' in spec
  const hasTarget = 'target' in spec

  if (hasSpaces === hasTarget) {
    throw new Error('SpaceSpec must include exactly one of "spaces" or "target"')
  }

  if (hasTarget) {
    const target = spec.target
    if (!target?.targetName) {
      throw new Error('SpaceSpec target must include targetName')
    }
    if (!target?.targetDir) {
      throw new Error('SpaceSpec target must include targetDir')
    }
    if (!isAbsolute(target.targetDir)) {
      throw new Error('SpaceSpec targetDir must be an absolute path')
    }
    return { kind: 'target', targetName: target.targetName, targetDir: target.targetDir }
  }

  if (!spec.spaces || spec.spaces.length === 0) {
    throw new Error('SpaceSpec spaces must include at least one space reference')
  }
  return { kind: 'spaces', spaces: spec.spaces as SpaceRefString[] }
}

export async function materializeSpec(
  spec: ValidatedSpec,
  aspHome: string,
  harnessId: HarnessId,
  options: {
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
    runtime: Pick<AgentSpacesRuntimeDependencies, 'getHarnessAdapter'>
  }
): Promise<MaterializedSpec> {
  const materialized = await materializeAgentRuntimeResources(spec, {
    aspHome,
    adapter: options.runtime.getHarnessAdapter(harnessId),
    ...(options.registryPathOverride ? { registryPathOverride: options.registryPathOverride } : {}),
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options.materializationTargetName
      ? { materializationTargetName: options.materializationTargetName }
      : {}),
    ...(options.materializationIdentity
      ? { materializationIdentity: options.materializationIdentity }
      : {}),
    ...(options.agentLocalComponents ? { agentLocalComponents: options.agentLocalComponents } : {}),
  })
  return {
    targetName: materialized.targetName,
    materialization: {
      outputPath: materialized.outputPath,
      pluginDirs: materialized.pluginDirs,
      mcpConfigPath: materialized.mcpConfigPath,
    },
    skills: materialized.skills.map((skill) => skill.name),
    ...(materialized.hygieneWarnings !== undefined
      ? { hygieneWarnings: materialized.hygieneWarnings }
      : {}),
  }
}

export async function resolveSpecToLock(
  spec: ValidatedSpec,
  aspHome: string,
  options?: {
    registryPathOverride?: string | undefined
    agentRoot?: string | undefined
    projectRoot?: string | undefined
  }
) {
  return resolveAgentRuntimeSpecToLock(spec, {
    aspHome,
    ...(options?.registryPathOverride
      ? { registryPathOverride: options.registryPathOverride }
      : {}),
    ...(options?.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options?.projectRoot ? { projectRoot: options.projectRoot } : {}),
  })
}

export async function collectLintWarnings(
  spec: ValidatedSpec,
  aspHome: string,
  registryPathOverride?: string | undefined
): Promise<LintWarning[]> {
  const { targetName, lock, registryPath } = await resolveAgentRuntimeSpecToLock(spec, {
    aspHome,
    ...(registryPathOverride ? { registryPathOverride } : {}),
  })
  const target = lock.targets[targetName]
  if (!target) {
    const available = Object.keys(lock.targets)
    const availableStr =
      available.length > 0 ? `Available: ${available.join(', ')}` : 'No targets in lock'
    throw new Error(`Target "${targetName}" not found in lock file. ${availableStr}`)
  }

  const paths = new PathResolver({ aspHome })
  const lintData = target.loadOrder.map((key) => {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space entry "${key}" not found in lock for target "${targetName}"`)
    }
    const pluginPath =
      entry.commit === 'dev'
        ? join(registryPath, entry.path)
        : paths.snapshot(asSha256Integrity(entry.integrity))
    return {
      key,
      manifest: {
        schema: 1 as const,
        id: asSpaceId(entry.id),
        plugin: { name: entry.plugin.name, version: entry.plugin.version },
      },
      pluginPath,
    }
  })
  return lintSpaces({ spaces: lintData })
}

export async function collectHooks(pluginDirs: string[]): Promise<string[]> {
  const hooks: string[] = []
  for (const dir of pluginDirs) {
    const result = await readHooksWithPrecedence(join(dir, 'hooks'))
    for (const hook of result.hooks) hooks.push(hook.event)
  }
  return hooks
}

export async function collectTools(mcpConfigPath: string | undefined): Promise<string[]> {
  if (!mcpConfigPath) return []
  const raw = await readFile(mcpConfigPath, 'utf-8')
  let parsed: { mcpServers?: Record<string, unknown> } | undefined
  try {
    parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> } | undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CodedError(`Invalid MCP config JSON at ${mcpConfigPath}: ${reason}`, 'resolve_failed')
  }
  return parsed?.mcpServers ? Object.keys(parsed.mcpServers) : []
}
