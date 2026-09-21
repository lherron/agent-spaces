import type { HarnessId } from 'spaces-runtime-contracts'
import { assertCatalogBuilderCoherence } from './builders.js'
import { HARNESS_CATALOG, HARNESS_IDS } from './catalog.js'
import type { ProcessImplementation } from './types.js'

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

export type CatalogProcessImplementation = ProcessImplementation & {
  harness: HarnessId
  defaultModel: string
  supportedModels: readonly string[]
}

/**
 * Read a process implementation from the canonical harness catalog. This is a
 * projection of an already-selected harness, never a fallback route chooser.
 */
export function catalogProcessImplementationForHarness(
  harness: HarnessId
): CatalogProcessImplementation | undefined {
  const definition = definitionFor(harness)
  const implementation = definition.processImplementation
  if (implementation === undefined) return undefined
  const provider = definition.supportedModelProviders.find(
    (candidate) => candidate.id === definition.defaultModelProvider
  )
  if (provider === undefined) {
    throw new Error(`Catalog harness ${harness} has no default model provider`)
  }
  return {
    ...implementation,
    harness,
    defaultModel: provider.defaultModel,
    supportedModels: [...provider.supportedModels],
  }
}

/**
 * Resolve a physical process implementation declared by the catalog. The
 * frontend is not a public harness alias: callers receive the harness selected
 * by the matching catalog entry and must preserve that exact identity.
 */
export function catalogProcessImplementationForFrontend(
  frontend: string
): CatalogProcessImplementation | undefined {
  for (const harness of HARNESS_IDS) {
    const implementation = catalogProcessImplementationForHarness(harness)
    if (implementation?.frontend === frontend) return implementation
  }
  return undefined
}

export function resolveCatalogProcessModel(
  implementation: CatalogProcessImplementation,
  requested: string | undefined
): { ok: true; model: string } | { ok: false; modelId: string } {
  const model = requested ?? implementation.defaultModel
  return implementation.supportedModels.includes(model)
    ? { ok: true, model }
    : { ok: false, modelId: model }
}

export function catalogRecipes() {
  return HARNESS_IDS.flatMap((id: HarnessId) => {
    const variants = definitionFor(id).executionVariants
    return [variants.withoutPresentation, variants.withPresentation].filter(
      (recipe): recipe is typeof variants.withoutPresentation => !('code' in recipe)
    )
  })
}

assertCatalogBuilderCoherence(catalogRecipes())
