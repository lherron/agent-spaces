import {
  type ResolvedRecipeBuilder,
  compileBrokerPlan,
  compileClaudeTmuxPlan,
  compileMuseTmuxPlan,
  compileNativeAgentHarnessPlan,
} from '../compile-runtime-plan.js'
import type { BuilderId, ExecutionRecipe } from './types.js'

/**
 * Callable materializer registry. Selection has already happened before this
 * table is indexed; entries never reinterpret harness or presentation intent.
 */
export const BUILDER_REGISTRY: Readonly<Record<BuilderId, ResolvedRecipeBuilder>> = {
  'agent-harness': compileNativeAgentHarnessPlan,
  'agent-harness-tmux': compileNativeAgentHarnessPlan,
  'claude-code-tmux': compileClaudeTmuxPlan,
  'codex-app-server': compileBrokerPlan,
  'muse-serve': compileBrokerPlan,
  'muse-cli-tmux': compileMuseTmuxPlan,
}

export const BUILDER_REGISTRY_IDS: ReadonlySet<BuilderId> = new Set(
  Object.keys(BUILDER_REGISTRY) as BuilderId[]
)

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
