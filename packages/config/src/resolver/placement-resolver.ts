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
  parseSpaceRef,
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
  ResolvedAgentPolicy,
  ResolvedInstruction,
  ResolvedPlacementContext,
  ResolvedPlacementMaterialization,
  ResolvedRuntimeBundle,
  ResolvedSpace,
  RunScaffoldPacket,
  RuntimePlacement,
} from '../core/types/placement.js'
import { readAgentProfileSource } from './agent-profile-source.js'
import { validateAgentRoot } from './agent-root.js'
import { resolveRootRelativeRef } from './root-relative-refs.js'
import { resolveSpaceComposition } from './space-composition.js'

/** Hex length of the truncated bundle-identity audit hash. */
const BUNDLE_IDENTITY_HASH_LEN = 16

/** Filename of the agent's persona/soul instruction file (required in agent root). */
const SOUL_FILENAME = 'SOUL.md'
/** Filename of the optional heartbeat-mode instruction file. */
const HEARTBEAT_FILENAME = 'HEARTBEAT.md'
/** Filename of the per-project targets manifest. */
const ASP_TARGETS_FILENAME = 'asp-targets.toml'
/** Directory under a root that holds filesystem-based spaces. */
const SPACES_DIRNAME = 'spaces'
/** Ref prefix for files resolved relative to the agent root. */
const AGENT_ROOT_REF_PREFIX = 'agent-root:///'
/** Ref prefix for files resolved relative to the project root. */
const PROJECT_ROOT_REF_PREFIX = 'project-root:///'

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

  const agentProfile = loadAgentProfile(placement.agentRoot)
  const agentPolicy = resolveAgentPolicy(agentProfile)

  // 2. Determine base bundle spaces and materialization inputs from RuntimeBundleRef
  const { bundleSpaces, materialization } = resolvePlacementMaterialization(placement, agentProfile)

  // 3. Compute instruction audit metadata
  let instructions: ResolvedInstruction[]
  try {
    instructions = resolvePlacementInstructions(placement, agentProfile)
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
    ...(agentPolicy !== undefined ? { agentPolicy } : {}),
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
  placement: RuntimePlacement,
  profile: AgentRuntimeProfile
): PlacementMaterializationResolution {
  const { bundle } = placement

  switch (bundle.kind) {
    case 'agent-project': {
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

function resolveAgentPolicy(profile: AgentRuntimeProfile): ResolvedAgentPolicy | undefined {
  const claimsTask = profile.claims_task === true
  if (profile.placement === undefined && !claimsTask) {
    return undefined
  }
  return {
    ...(profile.placement !== undefined
      ? {
          placement: {
            ...(profile.placement.default_home_node !== undefined
              ? { defaultHomeNode: profile.placement.default_home_node }
              : {}),
            pins: { ...profile.placement.pins },
          },
        }
      : {}),
    claimsTask,
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

  // 2. agent-project defaults to projectRoot
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
 * Derive a best-effort, audit-only space key from a space ref string.
 *
 * Delegates ref structure parsing to the canonical parseSpaceRef instead of
 * maintaining a duplicate set of regexes. parseSpaceRef throws on malformed
 * input, so it is wrapped to preserve the original best-effort contract:
 * unparseable refs fall back to returning the raw ref unchanged (NOT throwing).
 * Key shapes are preserved exactly: id@agent / id@project for filesystem
 * spaces, id@selector for registry spaces (selector defaults to dev).
 */
function deriveSpaceKey(ref: string): string {
  try {
    const parsed = parseSpaceRef(ref)
    if (parsed.agentSpace) return `${parsed.id}@agent`
    if (parsed.projectSpace) return `${parsed.id}@project`
    return `${parsed.id}@${parsed.selectorString}`
  } catch {
    return ref
  }
}

/**
 * Compute integrity for a resolved space.
 * For filesystem-based spaces (agent/project), use a marker.
 * For registry spaces, use a placeholder (full integrity computed during install).
 */
function integrityForFilesystemSpace(
  ref: string,
  root: string,
  idPrefix: RegExp,
  marker: string
): string {
  const id = ref.replace(idPrefix, '').replace(/@.*$/, '')
  const spacePath = join(root, SPACES_DIRNAME, id)
  if (existsSync(spacePath)) {
    return computeDirectoryHash(spacePath)
  }
  return marker
}

function computeSpaceIntegrity(ref: string, placement: RuntimePlacement): string {
  if (ref.includes('agent:')) {
    return integrityForFilesystemSpace(ref, placement.agentRoot, /^space:agent:/, 'sha256:agent')
  }
  if (ref.includes('project:') && placement.projectRoot) {
    return integrityForFilesystemSpace(
      ref,
      placement.projectRoot,
      /^space:project:/,
      'sha256:project'
    )
  }
  return 'sha256:pending'
}

/**
 * Read a file's UTF-8 contents, returning undefined when it doesn't exist.
 *
 * Centralizes the repeated "exists? → read : undefined" pattern so the
 * filesystem touch happens in one place (a future IO/test seam can wrap this).
 */
function readFileIfExists(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined
  }
  return readFileSync(filePath, 'utf8')
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
    case 'compose':
      parts.push(`compose:${bundle.compose.join(',')}`)
      break
    case 'agent-project':
      parts.push(`agent-project:${bundle.agentName}:${bundle.projectRoot ?? ''}`)
      break
  }

  const hash = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, BUNDLE_IDENTITY_HASH_LEN)
  return `bundle:${hash}`
}

interface PlacementInstructionSlot {
  slot: string
  content: string
  ref?: string | undefined
}

function resolvePlacementInstructions(
  placement: RuntimePlacement,
  profile: AgentRuntimeProfile
): ResolvedInstruction[] {
  const soulPath = join(placement.agentRoot, SOUL_FILENAME)
  if (!existsSync(soulPath)) {
    if (placement.dryRun) {
      return []
    }
    throw new Error(`${SOUL_FILENAME} is required in agent root: ${placement.agentRoot}`)
  }

  const slots: PlacementInstructionSlot[] = [
    {
      slot: 'soul',
      content: readFileSync(soulPath, 'utf8'),
      ref: `${AGENT_ROOT_REF_PREFIX}${SOUL_FILENAME}`,
    },
  ]
  const instructions = profile.instructions

  for (const ref of instructions?.additionalBase ?? []) {
    const content = resolveInstructionRef(ref, placement)
    if (content !== undefined) {
      slots.push({ slot: 'additional-base', content, ref })
    }
  }

  if (placement.runMode === 'heartbeat') {
    const heartbeatPath = join(placement.agentRoot, HEARTBEAT_FILENAME)
    const heartbeatContent = readFileIfExists(heartbeatPath)
    if (heartbeatContent !== undefined) {
      slots.push({
        slot: 'heartbeat',
        content: heartbeatContent,
        ref: `${AGENT_ROOT_REF_PREFIX}${HEARTBEAT_FILENAME}`,
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
      ref.startsWith(AGENT_ROOT_REF_PREFIX) || ref.startsWith(PROJECT_ROOT_REF_PREFIX)
        ? resolveRootRelativeRef(ref, {
            agentRoot: placement.agentRoot,
            projectRoot: placement.projectRoot,
          })
        : join(placement.agentRoot, ref)

    return readFileIfExists(filePath)
  } catch {
    return undefined
  }
}

/**
 * Typed reader: validates against the agent-profile schema and throws
 * ConfigValidationError on schema-less / unknown-key / wrong-shaped input.
 * This divergence from space-composition's tolerant raw reader is intentional
 * and pinned by t04617-t04618-characterization.test.ts. Only the file-read
 * step is shared (readAgentProfileSource); the parse step stays typed here.
 */
function loadAgentProfile(agentRoot: string): AgentRuntimeProfile {
  const source = readAgentProfileSource(agentRoot)
  if (source === undefined) {
    return { schemaVersion: 1 }
  }
  return parseAgentProfile(source.content, source.path)
}

function loadProjectTargetOptional(
  projectRoot: string | undefined,
  targetName: string
): TargetDefinition | undefined {
  if (!projectRoot) {
    return undefined
  }

  const targetsPath = join(projectRoot, ASP_TARGETS_FILENAME)
  const content = readFileIfExists(targetsPath)
  if (content === undefined) {
    return undefined
  }

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
        ...(effectiveConfig.remoteControl ? { remote_control: effectiveConfig.remoteControl } : {}),
        ...(Object.keys(effectiveConfig.claude).length > 0
          ? { claude: effectiveConfig.claude }
          : {}),
        ...(Object.keys(effectiveConfig.codex).length > 0 ? { codex: effectiveConfig.codex } : {}),
        ...(effectiveConfig.harness ? { harness: effectiveConfig.harness } : {}),
      },
    },
  }
}
