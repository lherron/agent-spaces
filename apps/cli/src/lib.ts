/**
 * @lherron/agent-spaces - Library exports for Agent Spaces v2 CLI.
 *
 * WHY: Separates library exports from CLI execution to allow
 * testing without running the CLI.
 */

import { findProjectMarker, getAgentsRoot } from 'spaces-config'

/**
 * Find project root by walking up from `startDir`.
 *
 * Delegates to `findProjectMarker`, which honors the per-repo project model:
 * the first `asp-targets.toml` wins, but the walk is bounded by the containing
 * git repo, and a git repo without an explicit marker is itself a project root.
 * This is what keeps `asp run` from a sibling repo (e.g. `hrc-runtime`) from
 * escaping its own repo and binding to the parent's `asp-targets.toml`.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  const agentsRoot = getAgentsRoot()
  const marker = findProjectMarker(startDir, { agentsRoot })
  return marker?.dir ?? null
}
