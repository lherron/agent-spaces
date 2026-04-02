/**
 * Placement-driven resolution.
 *
 * Resolves a RuntimePlacement into a ResolvedRuntimeBundle.
 *
 * Steps:
 * 1. Validate agent root (SOUL.md required)
 * 2. Load agent profile if present
 * 3. Determine base bundle spaces from RuntimeBundleRef
 * 4. Compute instruction layering (M3 resolveInstructionLayer)
 * 5. Compute space composition (M3 resolveSpaceComposition)
 * 6. Resolve effective cwd (section 9)
 * 7. Build audit metadata (section 11)
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { mergeAgentWithProjectTarget, parseAgentProfile, parseTargetsToml } from '../core/index.js'
import type { AgentRuntimeProfile, TargetDefinition } from '../core/types/index.js'
import type {
  ResolvedInstruction,
  ResolvedRuntimeBundle,
  ResolvedSpace,
  RuntimePlacement,
} from '../core/types/placement.js'
import { validateAgentRoot } from './agent-root.js'
import { resolveInstructionLayer } from './instruction-layer.js'
import { resolveSpaceComposition } from './space-composition.js'

/**
 * Resolve a RuntimePlacement into a ResolvedRuntimeBundle.
 *
 * This is the main entry point for placement-driven resolution.
 */
export async function resolvePlacement(
  placement: RuntimePlacement
): Promise<ResolvedRuntimeBundle> {
  // 1. Validate agent root (SOUL.md required for actual execution)
  try {
    validateAgentRoot(placement.agentRoot)
  } catch (err) {
    if (!placement.dryRun) {
      throw err
    }
    // dry-run: agentRoot doesn't exist or SOUL.md missing — allow for invocation building
  }

  // 2. Determine base bundle spaces from RuntimeBundleRef
  const bundleSpaces = resolveBundleSpaces(placement)

  // 3. Compute instruction layering
  const scaffoldPackets = placement.scaffoldPackets?.map((p) => ({
    slot: p.slot,
    content: p.content,
    ref: p.ref,
  }))

  let instructions: Awaited<ReturnType<typeof resolveInstructionLayer>>
  try {
    instructions = await resolveInstructionLayer({
      agentRoot: placement.agentRoot,
      projectRoot: placement.projectRoot,
      runMode: placement.runMode,
      scaffoldPackets,
    })
  } catch (err) {
    if (!placement.dryRun) {
      throw err
    }
    // dry-run: instruction layer may fail if SOUL.md missing — return empty
    instructions = []
  }

  // 4. Compute space composition
  const composedSpaces = await resolveSpaceComposition({
    agentRoot: placement.agentRoot,
    projectRoot: placement.projectRoot,
    runMode: placement.runMode,
    bundleSpaces,
    includeProfileSpaces: placement.bundle.kind !== 'agent-project',
  })

  // 5. Resolve effective cwd (section 9)
  const cwd = resolveEffectiveCwd(placement)

  // 6. Build audit metadata
  const resolvedInstructions: ResolvedInstruction[] = instructions.map((inst) => ({
    slot: inst.slot,
    ref: inst.ref ?? '',
    contentHash: computeContentHash(inst.content),
  }))

  const resolvedSpaces: ResolvedSpace[] = composedSpaces.map((space) => ({
    ref: space.ref,
    resolvedKey: deriveSpaceKey(space.ref),
    integrity: computeSpaceIntegrity(space.ref, placement),
  }))

  // 7. Build bundle identity
  const bundleIdentity = computeBundleIdentity(placement)

  return {
    bundleIdentity,
    runMode: placement.runMode,
    cwd,
    instructions: resolvedInstructions,
    spaces: resolvedSpaces,
  }
}

/**
 * Extract the compose space list from a RuntimeBundleRef.
 */
function resolveBundleSpaces(placement: RuntimePlacement): string[] {
  const { bundle } = placement

  switch (bundle.kind) {
    case 'agent-default': {
      // Use profile's default target if defined, otherwise empty
      return []
    }
    case 'agent-target': {
      // Load target from agent-profile.toml
      const profile = loadProfileTargets(placement.agentRoot)
      const target = profile?.[bundle.target]
      if (!target) {
        throw new Error(`Agent target "${bundle.target}" not found in agent-profile.toml`)
      }
      return target.compose ?? []
    }
    case 'project-target': {
      if (!bundle.target) {
        throw new Error('Empty target: project-target requires a target name')
      }
      // Load target from project's asp-targets.toml
      const targetsPath = join(bundle.projectRoot, 'asp-targets.toml')
      if (!existsSync(targetsPath)) {
        throw new Error(`Project target manifest not found: ${targetsPath}`)
      }
      // For now, load the target manifest minimally
      // Full integration with existing target loading will come in M5
      const { parse } = require('@iarna/toml') as { parse: (s: string) => Record<string, unknown> }
      const content = readFileSync(targetsPath, 'utf8')
      const manifest = parse(content) as Record<string, unknown>
      const targets = manifest['targets'] as Record<string, unknown> | undefined
      const target = targets?.[bundle.target] as Record<string, unknown> | undefined
      if (!target) {
        throw new Error(`Project target "${bundle.target}" not found in ${targetsPath}`)
      }
      return (target['compose'] as string[] | undefined) ?? []
    }
    case 'agent-project': {
      const profile = loadAgentProfile(placement.agentRoot)
      const projectTarget = loadProjectTargetOptional(bundle.projectRoot, bundle.agentName)
      return mergeAgentWithProjectTarget(profile, projectTarget, placement.runMode).compose
    }
    case 'compose': {
      return bundle.compose as string[]
    }
  }
}

/**
 * Resolve effective cwd per section 9 rules.
 */
function resolveEffectiveCwd(placement: RuntimePlacement): string {
  // 1. placement.cwd wins
  if (placement.cwd) {
    if (!isAbsolute(placement.cwd)) {
      throw new Error(`cwd must be absolute, got: "${placement.cwd}"`)
    }
    return placement.cwd
  }

  // 2. project-target defaults to projectRoot
  if (placement.bundle.kind === 'project-target') {
    return placement.bundle.projectRoot
  }

  if (placement.bundle.kind === 'agent-project' && placement.bundle.projectRoot) {
    return placement.bundle.projectRoot
  }

  // 3. otherwise agentRoot
  return placement.agentRoot
}

/**
 * Compute SHA256 content hash for an instruction.
 */
function computeContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/**
 * Derive a space key from a space ref string.
 */
function deriveSpaceKey(ref: string): string {
  // For agent/project spaces, key is id@agent or id@project
  const agentMatch = /^space:agent:([^@]+)/.exec(ref)
  if (agentMatch?.[1]) return `${agentMatch[1]}@agent`

  const projectMatch = /^space:project:([^@]+)/.exec(ref)
  if (projectMatch?.[1]) return `${projectMatch[1]}@project`

  // For registry spaces, key is id@selector
  const registryMatch = /^space:([^@:]+)(?:@(.+))?$/.exec(ref)
  if (registryMatch?.[1]) return `${registryMatch[1]}@${registryMatch[2] ?? 'dev'}`

  return ref
}

/**
 * Compute integrity for a resolved space.
 * For filesystem-based spaces (agent/project), use a marker.
 * For registry spaces, use a placeholder (full integrity computed during install).
 */
function computeSpaceIntegrity(ref: string, placement: RuntimePlacement): string {
  if (ref.includes('agent:')) {
    const id = ref.replace(/^space:agent:/, '').replace(/@.*$/, '')
    const spacePath = join(placement.agentRoot, 'spaces', id)
    if (existsSync(spacePath)) {
      return computeDirectoryHash(spacePath)
    }
    return 'sha256:agent'
  }
  if (ref.includes('project:') && placement.projectRoot) {
    const id = ref.replace(/^space:project:/, '').replace(/@.*$/, '')
    const spacePath = join(placement.projectRoot, 'spaces', id)
    if (existsSync(spacePath)) {
      return computeDirectoryHash(spacePath)
    }
    return 'sha256:project'
  }
  return 'sha256:pending'
}

/**
 * Compute a simple directory hash for audit purposes.
 */
function computeDirectoryHash(dirPath: string): string {
  // Use a lightweight hash of the directory path + mtime for audit
  // Full content-addressed integrity is computed by the install pipeline
  const hash = createHash('sha256')
  hash.update(`dir:${dirPath}`)
  return `sha256:${hash.digest('hex')}`
}

/**
 * Compute a bundle identity string for audit.
 */
function computeBundleIdentity(placement: RuntimePlacement): string {
  const parts: string[] = [placement.agentRoot]
  const { bundle } = placement

  switch (bundle.kind) {
    case 'agent-default':
      parts.push('agent-default')
      break
    case 'agent-target':
      parts.push(`agent-target:${bundle.target}`)
      break
    case 'project-target':
      parts.push(`project-target:${bundle.projectRoot}:${bundle.target}`)
      break
    case 'compose':
      parts.push(`compose:${bundle.compose.join(',')}`)
      break
    case 'agent-project':
      parts.push(`agent-project:${bundle.agentName}:${bundle.projectRoot ?? ''}`)
      break
  }

  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
  return `bundle:${hash}`
}

/**
 * Load target definitions from agent-profile.toml.
 */
function loadProfileTargets(agentRoot: string): Record<string, { compose: string[] }> | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return undefined

  const { parse } = require('@iarna/toml') as { parse: (s: string) => Record<string, unknown> }
  const content = readFileSync(profilePath, 'utf8')
  const parsed = parse(content) as Record<string, unknown>
  const targets = parsed['targets'] as Record<string, Record<string, unknown>> | undefined
  if (!targets) return undefined

  const result: Record<string, { compose: string[] }> = {}
  for (const [name, def] of Object.entries(targets)) {
    result[name] = { compose: (def['compose'] as string[] | undefined) ?? [] }
  }
  return result
}

function loadAgentProfile(agentRoot: string): AgentRuntimeProfile {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return { schemaVersion: 1 }
  }
  return parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
}

function loadProjectTargetOptional(
  projectRoot: string | undefined,
  targetName: string
): TargetDefinition | undefined {
  if (!projectRoot) {
    return undefined
  }

  const targetsPath = join(projectRoot, 'asp-targets.toml')
  if (!existsSync(targetsPath)) {
    return undefined
  }

  const content = readFileSync(targetsPath, 'utf8')
  const parsed = parseToml(content) as Record<string, unknown>
  const rawTargets = parsed['targets'] as Record<string, unknown> | undefined
  if (!rawTargets?.[targetName]) {
    return undefined
  }

  const manifest = parseTargetsToml(content, targetsPath)
  return manifest.targets[targetName]
}
