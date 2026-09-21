import type { HarnessId } from 'spaces-runtime-contracts'
import { HARNESS_CATALOG, HARNESS_IDS } from './catalog.js'

function definitionFor(id: HarnessId) {
  const definition = HARNESS_CATALOG[id]
  if (definition === undefined) throw new Error(`Missing catalog definition for ${id}`)
  return definition
}

/** Read-only projections; consumers inspect these and never build route tables. */
export function catalogHarnessIds(): readonly string[] {
  return HARNESS_IDS
}

export function catalogCapabilities() {
  return HARNESS_IDS.map((id: HarnessId) => {
    const definition = definitionFor(id)
    return {
      id,
      defaultModelProvider: definition.defaultModelProvider,
      modelProviders: definition.supportedModelProviders.map(
        ({ id: provider, defaultModel, supportedModels }) => ({
          id: provider,
          defaultModel,
          supportedModels: [...supportedModels],
        })
      ),
      presentationDefault: definition.presentationDefault,
    }
  })
}

export function catalogRecipes() {
  return HARNESS_IDS.flatMap((id: HarnessId) => {
    const variants = definitionFor(id).executionVariants
    return [variants.withoutPresentation, variants.withPresentation].filter(
      (recipe) => !('code' in recipe)
    )
  })
}
