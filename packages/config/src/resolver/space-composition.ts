/**
 * Space composition precedence resolution.
 *
 * Implements the normative composition from AGENT_SPACES_PLAN.md section 8.
 *
 * Order:
 * 1. agent-profile.toml -> spaces.base
 * 2. agent-profile.toml -> spaces.byMode[runMode]
 * 3. spaces from the selected RuntimeBundleRef
 *
 * Deduplicate by resolved space key.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import type { RunMode } from '../core/types/agent-profile.js'

/** A resolved space entry in composition order */
export interface ComposedSpaceEntry {
  ref: string
  source: 'profile-base' | 'profile-by-mode' | 'bundle'
}

/** Input for space composition */
export interface SpaceCompositionInput {
  agentRoot: string
  projectRoot?: string | undefined
  runMode: RunMode
  bundleSpaces: string[]
  includeProfileSpaces?: boolean | undefined
}

/**
 * Resolve the full space composition in normative order, deduplicated.
 *
 * Reads agent-profile.toml from disk and composes spaces from:
 * 1. profile spaces.base
 * 2. profile spaces.byMode[runMode]
 * 3. bundle spaces (from RuntimeBundleRef)
 */
export async function resolveSpaceComposition(
  input: SpaceCompositionInput
): Promise<ComposedSpaceEntry[]> {
  const profile = loadAgentProfile(input.agentRoot)
  const seen = new Set<string>()
  const result: ComposedSpaceEntry[] = []
  const includeProfileSpaces = input.includeProfileSpaces ?? true

  function addUnique(ref: string, source: ComposedSpaceEntry['source']) {
    // Normalize the ref for dedup: strip @dev suffix when comparing
    const key = normalizeRefKey(ref)
    if (!seen.has(key)) {
      seen.add(key)
      result.push({ ref, source })
    }
  }

  if (includeProfileSpaces) {
    // 1. agent-profile.toml -> spaces.base
    const spaces = profile?.['spaces'] as Record<string, unknown> | undefined
    if (spaces) {
      const base = spaces['base']
      if (Array.isArray(base)) {
        for (const ref of base) {
          addUnique(ref as string, 'profile-base')
        }
      }
    }

    // 2. agent-profile.toml -> spaces.byMode[runMode]
    if (spaces) {
      const byMode = spaces['byMode'] as Record<string, unknown> | undefined
      if (byMode) {
        const modeConfig = byMode[input.runMode] as Record<string, unknown> | undefined
        if (modeConfig) {
          const modeBase = modeConfig['base']
          if (Array.isArray(modeBase)) {
            for (const ref of modeBase) {
              addUnique(ref as string, 'profile-by-mode')
            }
          }
        }
      }
    }
  }

  // 3. Spaces from the selected RuntimeBundleRef
  for (const ref of input.bundleSpaces) {
    addUnique(ref, 'bundle')
  }

  return result
}

/**
 * Normalize a space ref for deduplication.
 * Strips the @dev selector suffix since space:agent:foo and space:agent:foo@dev
 * refer to the same space.
 */
function normalizeRefKey(ref: string): string {
  return ref.replace(/@dev$/, '')
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
