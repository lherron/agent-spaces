import type { BuilderId, ExecutionRecipe } from './types.js'

/**
 * Bounded registry identity seam. T-08702 replaces these IDs with callable
 * resolved-recipe builders; until then this prevents catalog/builder drift.
 */
export const BUILDER_REGISTRY_IDS: ReadonlySet<BuilderId> = new Set([
  'agent-harness',
  'agent-harness-tmux',
  'claude-code-tmux',
  'codex-app-server',
  'muse-serve',
  'muse-cli-tmux',
])

export function assertCatalogBuilderCoherence(recipes: readonly ExecutionRecipe[]): void {
  for (const recipe of recipes) {
    if (!BUILDER_REGISTRY_IDS.has(recipe.builder)) {
      throw new Error(
        `Catalog recipe ${recipe.recipeId} references unregistered builder ${recipe.builder}`
      )
    }
    if (recipe.hosting.terminalRequired !== (recipe.hosting.terminalHost === 'tmux')) {
      throw new Error(`Catalog recipe ${recipe.recipeId} has incoherent terminal hosting`)
    }
  }
}
