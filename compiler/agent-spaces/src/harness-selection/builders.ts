import { compileBrokerPlan } from '../compile-broker-plan.js'
import { compileNativeAgentHarnessPlan } from '../compile-native-agent-harness-plan.js'
import type { ResolvedRecipeBuilder } from '../compile-plan-types.js'
import { compileClaudeTmuxPlan, compileMuseTmuxPlan } from '../compile-tmux-broker-plan.js'
import { catalogRecipes } from './catalog-projections.js'
import type { BuilderId, ExecutionRecipe } from './types.js'

/**
 * Callable materializer registry. Selection has already happened before this
 * table is indexed; entries never reinterpret harness or presentation intent.
 */
export const BUILDER_REGISTRY: Readonly<Record<BuilderId, ResolvedRecipeBuilder>> = {
  'agent-harness': (...args) => compileNativeAgentHarnessPlan(...args),
  'agent-harness-tmux': (...args) => compileNativeAgentHarnessPlan(...args),
  'claude-code-tmux': (...args) => compileClaudeTmuxPlan(...args),
  'codex-app-server': (...args) => compileBrokerPlan(...args),
  'muse-serve': (...args) => compileBrokerPlan(...args),
  'muse-cli-tmux': (...args) => compileMuseTmuxPlan(...args),
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

// Load-time guard: every catalog recipe must name a registered builder. It lives
// here, not in catalog-projections, so the catalog never imports the registry
// (the builders import prepare-cli-runtime, which reads the catalog).
assertCatalogBuilderCoherence(catalogRecipes())
