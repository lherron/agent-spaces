import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import {
  type AgentLocalComponents,
  type HarnessId,
  type LintWarning,
  type LockFile,
  PathResolver,
  type SpaceRefString,
  asSha256Integrity,
  asSpaceId,
  computeClosure,
  discoverSkills,
  generateLockFileForTarget,
  getRegistryPath,
  lintSpaces,
  readHooksWithPrecedence,
  resolveTarget,
} from 'spaces-config'
import { materializeFromRefs, materializeTarget } from 'spaces-execution'

import type { SpaceSpec } from './types.js'

export interface ValidatedSpec {
  kind: 'spaces' | 'target'
  spaces?: string[]
  targetName?: string
  targetDir?: string
}

export interface MaterializedSpec {
  targetName: string
  materialization: {
    outputPath: string
    pluginDirs: string[]
    mcpConfigPath?: string | undefined
  }
  skills: string[]
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
    return {
      kind: 'target',
      targetName: target.targetName,
      targetDir: target.targetDir,
    }
  }

  if (!spec.spaces || spec.spaces.length === 0) {
    throw new Error('SpaceSpec spaces must include at least one space reference')
  }

  return {
    kind: 'spaces',
    spaces: spec.spaces,
  }
}

function computeSpacesTargetName(spaces: string[]): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(spaces))
  return `spaces-${hash.digest('hex').slice(0, 12)}`
}

export async function resolveSpecToLock(
  spec: ValidatedSpec,
  aspHome: string,
  registryPathOverride?: string | undefined
): Promise<{ targetName: string; lock: LockFile; registryPath: string }> {
  if (spec.kind === 'target') {
    const result = await resolveTarget(spec.targetName as string, {
      projectPath: spec.targetDir as string,
      aspHome,
      ...(registryPathOverride ? { registryPath: registryPathOverride } : {}),
    })
    const registryPath = getRegistryPath({
      projectPath: spec.targetDir as string,
      aspHome,
      ...(registryPathOverride ? { registryPath: registryPathOverride } : {}),
    })
    return { targetName: spec.targetName as string, lock: result.lock, registryPath }
  }

  const refs = spec.spaces as string[]
  const targetName = computeSpacesTargetName(refs)
  const paths = new PathResolver({ aspHome })
  const registryPath = registryPathOverride ?? paths.repo
  const closure = await computeClosure(refs as SpaceRefString[], {
    cwd: registryPath,
  })
  const lock = await generateLockFileForTarget(targetName, refs as SpaceRefString[], closure, {
    cwd: registryPath,
    registry: { type: 'git', url: registryPath },
  })

  return { targetName, lock, registryPath }
}

export async function materializeSpec(
  spec: ValidatedSpec,
  aspHome: string,
  harnessId: HarnessId,
  options?: {
    registryPathOverride?: string | undefined
    agentRoot?: string | undefined
    projectRoot?: string | undefined
    agentLocalComponents?: AgentLocalComponents | undefined
  }
): Promise<MaterializedSpec> {
  const registryPathOverride = options?.registryPathOverride
  if (spec.kind === 'target') {
    const { targetName, lock, registryPath } = await resolveSpecToLock(
      spec,
      aspHome,
      registryPathOverride
    )
    const materialization = await materializeTarget(targetName, lock, {
      projectPath: spec.targetDir as string,
      aspHome,
      registryPath,
      harness: harnessId,
    })
    const skillMetadata = await discoverSkills(materialization.pluginDirs)
    return {
      targetName,
      materialization: {
        outputPath: materialization.outputPath,
        pluginDirs: materialization.pluginDirs,
        mcpConfigPath: materialization.mcpConfigPath,
      },
      skills: skillMetadata.map((skill) => skill.name),
    }
  }

  const refs = spec.spaces as string[]
  if (refs.length === 0) {
    const targetName = 'placement-empty'
    const paths = new PathResolver({ aspHome })
    const materialized = await materializeFromRefs({
      targetName,
      refs: [],
      registryPath: registryPathOverride ?? paths.repo,
      aspHome,
      lockPath: paths.globalLock,
      harness: harnessId,
    })
    return {
      targetName,
      materialization: {
        outputPath: materialized.materialization.outputPath,
        pluginDirs: materialized.materialization.pluginDirs,
        mcpConfigPath: materialized.materialization.mcpConfigPath,
      },
      skills: materialized.skills.map((skill) => skill.name),
    }
  }

  const targetName = computeSpacesTargetName(refs)
  const paths = new PathResolver({ aspHome })
  const registryPath = registryPathOverride ?? paths.repo
  const materialized = await materializeFromRefs({
    targetName,
    refs: refs as SpaceRefString[],
    registryPath,
    aspHome,
    lockPath: paths.globalLock,
    harness: harnessId,
    ...(options?.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options?.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options?.agentLocalComponents
      ? { agentLocalComponents: options.agentLocalComponents }
      : {}),
  })

  return {
    targetName,
    materialization: {
      outputPath: materialized.materialization.outputPath,
      pluginDirs: materialized.materialization.pluginDirs,
      mcpConfigPath: materialized.materialization.mcpConfigPath,
    },
    skills: materialized.skills.map((skill) => skill.name),
  }
}

export async function collectLintWarnings(
  spec: ValidatedSpec,
  aspHome: string,
  registryPathOverride?: string | undefined
): Promise<LintWarning[]> {
  const { targetName, lock, registryPath } = await resolveSpecToLock(
    spec,
    aspHome,
    registryPathOverride
  )
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
    const isDev = entry.commit === 'dev'
    const pluginPath = isDev
      ? join(registryPath, entry.path)
      : paths.snapshot(asSha256Integrity(entry.integrity))

    return {
      key,
      manifest: {
        schema: 1 as const,
        id: asSpaceId(entry.id),
        plugin: {
          name: entry.plugin.name,
          version: entry.plugin.version,
        },
      },
      pluginPath,
    }
  })

  return lintSpaces({ spaces: lintData })
}

export async function collectHooks(pluginDirs: string[]): Promise<string[]> {
  const hooks: string[] = []
  for (const dir of pluginDirs) {
    const hooksDir = join(dir, 'hooks')
    const result = await readHooksWithPrecedence(hooksDir)
    for (const hook of result.hooks) {
      hooks.push(hook.event)
    }
  }
  return hooks
}

export async function collectTools(mcpConfigPath: string | undefined): Promise<string[]> {
  if (!mcpConfigPath) return []
  const raw = await readFile(mcpConfigPath, 'utf-8')
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> } | undefined
  if (!parsed?.mcpServers) return []
  return Object.keys(parsed.mcpServers)
}
