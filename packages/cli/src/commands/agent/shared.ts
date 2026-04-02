/**
 * Shared utilities for agent CLI commands.
 */

import type { RuntimeBundleRef, SpaceRefString } from 'spaces-config'

interface BundleRefOptions {
  agentName?: string | undefined
  bundle?: string | undefined
  agentTarget?: string | undefined
  projectTarget?: string | undefined
  projectRoot?: string | undefined
  compose?: string[] | undefined
}

/**
 * Build a RuntimeBundleRef from CLI options.
 * Defaults to agent-default when no explicit selector is provided.
 */
export function buildBundleRef(options: BundleRefOptions): RuntimeBundleRef {
  if (options.agentTarget) {
    return { kind: 'agent-target', target: options.agentTarget }
  }
  if (options.projectTarget) {
    if (!options.projectRoot) {
      throw new Error('--project-root is required with --project-target')
    }
    return {
      kind: 'project-target',
      projectRoot: options.projectRoot,
      target: options.projectTarget,
    }
  }
  if (options.compose && options.compose.length > 0) {
    return { kind: 'compose', compose: options.compose as SpaceRefString[] }
  }
  if (options.agentName) {
    return {
      kind: 'agent-project',
      agentName: options.agentName,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    }
  }
  return { kind: 'agent-default' }
}

/**
 * Parse repeated --env KEY=VALUE flags into a Record.
 */
export function parseEnvFlags(envFlags?: string[]): Record<string, string> | undefined {
  if (!envFlags || envFlags.length === 0) return undefined
  const env: Record<string, string> = {}
  for (const flag of envFlags) {
    const eqIdx = flag.indexOf('=')
    if (eqIdx === -1) {
      throw new Error(`Invalid --env format: "${flag}" (expected KEY=VALUE)`)
    }
    env[flag.slice(0, eqIdx)] = flag.slice(eqIdx + 1)
  }
  return env
}
