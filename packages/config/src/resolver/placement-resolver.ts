/**
 * Placement-driven resolution.
 *
 * Resolves a RuntimePlacement into a ResolvedRuntimeBundle.
 *
 * Steps:
 * 1. Validate agent root (SOUL.md required)
 * 2. Load agent profile if present
 * 3. Determine base bundle spaces from RuntimeBundleRef
 * 4. Compute instruction audit metadata
 * 5. Compute space composition (M3 resolveSpaceComposition)
 * 6. Resolve effective cwd (section 9)
 * 7. Build audit metadata (section 11)
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import {
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPrimingPrompt,
} from '../core/index.js'
import type { EffectiveTargetConfig } from '../core/merge/agent-project-merge.js'
import type {
  AgentRuntimeProfile,
  ProjectManifest,
  SpaceRefString,
  TargetDefinition,
} from '../core/types/index.js'
import type {
  ResolvedInstruction,
  ResolvedPlacementContext,
  ResolvedPlacementMaterialization,
  ResolvedRuntimeBundle,
  ResolvedSpace,
  RunScaffoldPacket,
  RuntimePlacement,
} from '../core/types/placement.js'
import { validateAgentRoot } from './agent-root.js'
import { resolveRootRelativeRef } from './root-relative-refs.js'
import { resolveSpaceComposition } from './space-composition.js'

/**
 * Resolve a RuntimePlacement into a ResolvedRuntimeBundle plus
 * materialization context for downstream runtime planning.
 */
export async function resolvePlacementContext(
  placement: RuntimePlacement
): Promise<ResolvedPlacementContext> {
  // 1. Validate agent root (SOUL.md required for actual execution)
  try {
    validateAgentRoot(placement.agentRoot)
  } catch (err) {
    if (!placement.dryRun) {
      throw err
    }
    // dry-run: agentRoot doesn't exist or SOUL.md missing — allow for invocation building
  }

  // 2. Determine base bundle spaces and materialization inputs from RuntimeBundleRef
  const { bundleSpaces, materialization } = resolvePlacementMaterialization(placement)

  // 3. Compute instruction audit metadata
  let instructions: ResolvedInstruction[]
  try {
    instructions = resolvePlacementInstructions(placement)
  } catch (err) {
    if (!placement.dryRun) {
      throw err
    }
    // dry-run: instruction resolution may fail if SOUL.md is missing — return empty
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
  const resolvedSpaces: ResolvedSpace[] = composedSpaces.map((space) => ({
    ref: space.ref,
    resolvedKey: deriveSpaceKey(space.ref),
    integrity: computeSpaceIntegrity(space.ref, placement),
  }))

  // 7. Build bundle identity
  const bundleIdentity = computeBundleIdentity(placement)

  return {
    resolvedBundle: {
      bundleIdentity,
      runMode: placement.runMode,
      cwd,
      instructions,
      spaces: resolvedSpaces,
    },
    materialization,
  }
}

/**
 * Resolve a RuntimePlacement into a ResolvedRuntimeBundle.
 *
 * This preserves the original audit-only API for existing callers.
 */
export async function resolvePlacement(
  placement: RuntimePlacement
): Promise<ResolvedRuntimeBundle> {
  return (await resolvePlacementContext(placement)).resolvedBundle
}

interface PlacementMaterializationResolution {
  bundleSpaces: string[]
  materialization: ResolvedPlacementMaterialization
}

/**
 * Extract materialization inputs and compose-space list from a RuntimeBundleRef.
 */
function resolvePlacementMaterialization(
  placement: RuntimePlacement
): PlacementMaterializationResolution {
  const { bundle } = placement

  switch (bundle.kind) {
    case 'agent-default': {
      const spaces = loadAgentDefaultSpaces(placement.agentRoot, placement.runMode)
      return {
        bundleSpaces: spaces,
        materialization: {
          spec: { kind: 'spaces', spaces },
        },
      }
    }
    case 'agent-target': {
      // Load target from agent-profile.toml
      const profile = loadProfileTargets(placement.agentRoot)
      const target = profile?.[bundle.target]
      if (!target) {
        throw new Error(`Agent target "${bundle.target}" not found in agent-profile.toml`)
      }
      const spaces = target.compose ?? []
      return {
        bundleSpaces: spaces,
        materialization: {
          spec: { kind: 'spaces', spaces },
        },
      }
    }
    case 'project-target': {
      if (!bundle.target) {
        throw new Error('Empty target: project-target requires a target name')
      }
      const manifest = loadProjectManifest(bundle.projectRoot)
      const target = manifest.targets[bundle.target]
      if (!target) {
        throw new Error(
          `Project target "${bundle.target}" not found in ${join(bundle.projectRoot, 'asp-targets.toml')}`
        )
      }
      return {
        bundleSpaces: target.compose ?? [],
        materialization: {
          spec: {
            kind: 'target',
            targetName: bundle.target,
            targetDir: bundle.projectRoot,
          },
          manifest,
        },
      }
    }
    case 'agent-project': {
      const profile = loadAgentProfile(placement.agentRoot)
      const projectTarget = loadProjectTargetOptional(bundle.projectRoot, bundle.agentName)
      const primingPrompt = resolveAgentPrimingPrompt(profile, placement.agentRoot)
      const effective = mergeAgentWithProjectTarget(
        {
          ...profile,
          ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
        },
        projectTarget,
        placement.runMode
      )
      return {
        bundleSpaces: effective.compose,
        materialization: {
          spec: { kind: 'spaces', spaces: effective.compose },
          effectiveConfig: effective,
          manifest: buildSyntheticAgentProjectManifest(bundle.agentName, effective),
        },
      }
    }
    case 'compose': {
      const spaces = bundle.compose as SpaceRefString[]
      return {
        bundleSpaces: spaces,
        materialization: {
          spec: { kind: 'spaces', spaces },
        },
      }
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

interface PlacementInstructionSlot {
  slot: string
  content: string
  ref?: string | undefined
}

function resolvePlacementInstructions(placement: RuntimePlacement): ResolvedInstruction[] {
  const soulPath = join(placement.agentRoot, 'SOUL.md')
  if (!existsSync(soulPath)) {
    if (placement.dryRun) {
      return []
    }
    throw new Error(`SOUL.md is required in agent root: ${placement.agentRoot}`)
  }

  const slots: PlacementInstructionSlot[] = [
    {
      slot: 'soul',
      content: readFileSync(soulPath, 'utf8'),
      ref: 'agent-root:///SOUL.md',
    },
  ]
  const instructions = loadAgentProfile(placement.agentRoot).instructions

  for (const ref of instructions?.additionalBase ?? []) {
    const content = resolveInstructionRef(ref, placement)
    if (content !== undefined) {
      slots.push({ slot: 'additional-base', content, ref })
    }
  }

  if (placement.runMode === 'heartbeat') {
    const heartbeatPath = join(placement.agentRoot, 'HEARTBEAT.md')
    if (existsSync(heartbeatPath)) {
      slots.push({
        slot: 'heartbeat',
        content: readFileSync(heartbeatPath, 'utf8'),
        ref: 'agent-root:///HEARTBEAT.md',
      })
    }
  }

  for (const ref of instructions?.byMode?.[placement.runMode] ?? []) {
    const content = resolveInstructionRef(ref, placement)
    if (content !== undefined) {
      slots.push({ slot: 'by-mode', content, ref })
    }
  }

  for (const packet of placement.scaffoldPackets ?? []) {
    slots.push(...resolveScaffoldPacket(packet, placement))
  }

  return slots.map((slot) => ({
    slot: slot.slot,
    ref: slot.ref ?? '',
    contentHash: computeContentHash(slot.content),
  }))
}

function resolveScaffoldPacket(
  packet: RunScaffoldPacket,
  placement: RuntimePlacement
): PlacementInstructionSlot[] {
  let content = packet.content
  if (!content && packet.ref) {
    content = resolveInstructionRef(packet.ref, placement) ?? ''
  }

  if (content === undefined) {
    return []
  }

  return [
    {
      slot: packet.slot,
      content,
      ref: packet.ref,
    },
  ]
}

function resolveInstructionRef(ref: string, placement: RuntimePlacement): string | undefined {
  try {
    const filePath =
      ref.startsWith('agent-root:///') || ref.startsWith('project-root:///')
        ? resolveRootRelativeRef(ref, {
            agentRoot: placement.agentRoot,
            projectRoot: placement.projectRoot,
          })
        : join(placement.agentRoot, ref)

    if (!existsSync(filePath)) {
      return undefined
    }

    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Load target definitions from agent-profile.toml.
 */
function loadProfileTargets(
  agentRoot: string
): Record<string, { compose: SpaceRefString[] }> | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return undefined

  const { parse } = require('@iarna/toml') as { parse: (s: string) => Record<string, unknown> }
  const content = readFileSync(profilePath, 'utf8')
  const parsed = parse(content) as Record<string, unknown>
  const targets = parsed['targets'] as Record<string, Record<string, unknown>> | undefined
  if (!targets) return undefined

  const result: Record<string, { compose: SpaceRefString[] }> = {}
  for (const [name, def] of Object.entries(targets)) {
    result[name] = { compose: (def['compose'] as SpaceRefString[] | undefined) ?? [] }
  }
  return result
}

function loadAgentDefaultSpaces(
  agentRoot: string,
  runMode: RuntimePlacement['runMode']
): SpaceRefString[] {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return []
  }

  const content = readFileSync(profilePath, 'utf8')
  const parsed = parseToml(content) as Record<string, unknown>
  const spacesConfig = parsed['spaces'] as Record<string, unknown> | undefined
  if (!spacesConfig) {
    return []
  }

  const spaces: SpaceRefString[] = []
  const base = spacesConfig['base']
  if (Array.isArray(base)) {
    spaces.push(...(base as SpaceRefString[]))
  }

  const byMode = spacesConfig['byMode'] as Record<string, Record<string, unknown>> | undefined
  const modeConfig = byMode?.[runMode]
  const modeBase = modeConfig?.['base']
  if (Array.isArray(modeBase)) {
    for (const ref of modeBase as SpaceRefString[]) {
      if (!spaces.includes(ref)) {
        spaces.push(ref)
      }
    }
  }

  return spaces
}

function loadAgentProfile(agentRoot: string): AgentRuntimeProfile {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return { schemaVersion: 1 }
  }
  return parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
}

function loadProjectManifest(projectRoot: string): ProjectManifest {
  const targetsPath = join(projectRoot, 'asp-targets.toml')
  if (!existsSync(targetsPath)) {
    throw new Error(`Project target manifest not found: ${targetsPath}`)
  }

  return parseTargetsToml(readFileSync(targetsPath, 'utf8'), targetsPath)
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

function buildSyntheticAgentProjectManifest(
  targetName: string,
  effectiveConfig: EffectiveTargetConfig
): ProjectManifest {
  return {
    schema: 1,
    ...(Object.keys(effectiveConfig.claude).length > 0 ? { claude: effectiveConfig.claude } : {}),
    ...(Object.keys(effectiveConfig.codex).length > 0 ? { codex: effectiveConfig.codex } : {}),
    targets: {
      [targetName]: {
        compose: effectiveConfig.compose,
        ...(effectiveConfig.description !== undefined
          ? { description: effectiveConfig.description }
          : {}),
        ...(effectiveConfig.priming_prompt !== undefined
          ? { priming_prompt: effectiveConfig.priming_prompt }
          : {}),
        ...(effectiveConfig.yolo ? { yolo: effectiveConfig.yolo } : {}),
        ...(Object.keys(effectiveConfig.claude).length > 0
          ? { claude: effectiveConfig.claude }
          : {}),
        ...(Object.keys(effectiveConfig.codex).length > 0 ? { codex: effectiveConfig.codex } : {}),
        ...(effectiveConfig.harness ? { harness: effectiveConfig.harness } : {}),
      },
    },
  }
}
