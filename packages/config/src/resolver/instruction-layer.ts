/**
 * Instruction layering resolution.
 *
 * Implements the normative layering from AGENT_SPACES_PLAN.md section 8.
 *
 * Order:
 * 1. implicit SOUL.md
 * 2. agent-profile.toml -> instructions.additionalBase
 * 3. implicit HEARTBEAT.md when runMode = heartbeat and file exists
 * 4. agent-profile.toml -> instructions.byMode[runMode]
 * 5. host scaffoldPackets in request order
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { isRootRef, resolveRootRelativeRef } from './root-relative-refs.js'

/** Run mode for agent execution */
export type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

/** A resolved instruction slot with content */
export interface ResolvedInstructionSlot {
  slot: string
  content: string
  ref?: string | undefined
}

/** Scaffold packet from the host */
export interface ScaffoldPacket {
  slot: string
  content?: string | undefined
  ref?: string | undefined
}

/** Input for instruction layering */
export interface InstructionLayerInput {
  agentRoot: string
  projectRoot?: string | undefined
  runMode: RunMode
  scaffoldPackets?: ScaffoldPacket[] | undefined
}

/**
 * Resolve the full instruction layer in normative order.
 *
 * Reads agent-profile.toml from disk, resolves root-relative refs,
 * and returns resolved instruction slots with content.
 */
export async function resolveInstructionLayer(
  input: InstructionLayerInput
): Promise<ResolvedInstructionSlot[]> {
  const slots: ResolvedInstructionSlot[] = []
  const profile = loadAgentProfile(input.agentRoot)

  // 1. Implicit SOUL.md (always required)
  const soulPath = join(input.agentRoot, 'SOUL.md')
  if (!existsSync(soulPath)) {
    throw new Error(`SOUL.md is required in agent root: ${input.agentRoot}`)
  }
  slots.push({
    slot: 'soul',
    content: readFileSync(soulPath, 'utf8'),
    ref: 'agent-root:///SOUL.md',
  })

  // 2. agent-profile.toml -> instructions.additionalBase
  const instructions = profile?.['instructions'] as Record<string, unknown> | undefined
  const additionalBase = instructions?.['additionalBase']
  if (additionalBase && Array.isArray(additionalBase)) {
    for (const ref of additionalBase) {
      const content = resolveRefToContent(ref as string, input)
      if (content !== undefined) {
        slots.push({ slot: 'additional-base', content, ref: ref as string })
      }
    }
  }

  // 3. Implicit HEARTBEAT.md when runMode = heartbeat and file exists
  if (input.runMode === 'heartbeat') {
    const heartbeatPath = join(input.agentRoot, 'HEARTBEAT.md')
    if (existsSync(heartbeatPath)) {
      slots.push({
        slot: 'heartbeat',
        content: readFileSync(heartbeatPath, 'utf8'),
        ref: 'agent-root:///HEARTBEAT.md',
      })
    }
  }

  // 4. agent-profile.toml -> instructions.byMode[runMode]
  const byMode = instructions?.['byMode'] as Record<string, unknown> | undefined
  if (byMode) {
    const modeRefs = byMode[input.runMode]
    if (Array.isArray(modeRefs)) {
      for (const ref of modeRefs) {
        const content = resolveRefToContent(ref as string, input)
        if (content !== undefined) {
          slots.push({ slot: 'by-mode', content, ref: ref as string })
        }
      }
    }
  }

  // 5. Host scaffoldPackets in request order
  if (input.scaffoldPackets) {
    for (const packet of input.scaffoldPackets) {
      let content = packet.content
      if (!content && packet.ref) {
        content = resolveRefToContent(packet.ref, input) ?? ''
      }
      if (content !== undefined) {
        slots.push({ slot: packet.slot, content, ref: packet.ref })
      }
    }
  }

  return slots
}

/**
 * Resolve a ref (root-relative or plain path) to its file content.
 */
function resolveRefToContent(ref: string, input: InstructionLayerInput): string | undefined {
  try {
    let filePath: string
    if (isRootRef(ref)) {
      filePath = resolveRootRelativeRef(ref, {
        agentRoot: input.agentRoot,
        projectRoot: input.projectRoot,
      })
    } else {
      // Treat as a path relative to agentRoot
      filePath = join(input.agentRoot, ref)
    }

    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf8')
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Load and parse agent-profile.toml from agentRoot.
 * Returns undefined if the file doesn't exist.
 */
function loadAgentProfile(agentRoot: string): Record<string, unknown> | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return undefined

  const content = readFileSync(profilePath, 'utf8')
  return parseToml(content) as Record<string, unknown>
}
