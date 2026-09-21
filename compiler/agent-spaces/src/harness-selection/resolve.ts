import type {
  HarnessId,
  HarnessSelectionRequest,
  ReasoningEffort,
  SelectionProvenanceLayer,
} from 'spaces-runtime-contracts'
import { HARNESS_CATALOG } from './catalog.js'
import type {
  CompileRefusal,
  ExecutionRecipe,
  HarnessResolution,
  ProvisioningLayer,
  ResolveHarnessExecutionInput,
  ResolvedScalar,
} from './types.js'

const layers: readonly [
  SelectionProvenanceLayer,
  (input: ResolveHarnessExecutionInput) => ProvisioningLayer | undefined,
][] = [
  ['compile-request', (input) => input.requested],
  ['summon-directive', (input) => input.provisioningLayers?.summonDirectives],
  ['project-target', (input) => input.provisioningLayers?.projectTarget],
  ['agent-profile', (input) => input.provisioningLayers?.agentProfile],
]

function refusal(
  code: CompileRefusal['code'],
  message: string,
  details?: Record<string, unknown>
): CompileRefusal {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) }
}

function resolveScalar<T extends keyof HarnessSelectionRequest>(
  input: ResolveHarnessExecutionInput,
  key: T
): ResolvedScalar<NonNullable<HarnessSelectionRequest[T]>> | undefined {
  for (const [source, layer] of layers) {
    const candidate = layer(input)
    if (candidate !== undefined && Object.hasOwn(candidate, key) && candidate[key] !== undefined) {
      return { value: candidate[key] as NonNullable<HarnessSelectionRequest[T]>, source }
    }
  }
  return undefined
}

function resolvePresentation(
  input: ResolveHarnessExecutionInput,
  fallback: boolean
): ResolvedScalar<boolean> {
  for (const [source, layer] of layers) {
    const candidate = layer(input)
    if (candidate !== undefined && Object.hasOwn(candidate, 'presentation')) {
      if (typeof candidate.presentation === 'boolean')
        return { value: candidate.presentation, source }
    }
  }
  return { value: fallback, source: 'catalog-default' }
}

function validateAgentConsistency(input: ResolveHarnessExecutionInput): CompileRefusal | undefined {
  const identities = input.consistency?.agentIds ?? []
  const mismatch = identities.find((id) => id !== input.agent.id)
  return mismatch === undefined
    ? undefined
    : refusal(
        'configured_context_mismatch',
        `Compilation agent ${input.agent.id} disagrees with explicit context identity ${mismatch}`,
        { agentId: input.agent.id, conflictingAgentId: mismatch }
      )
}

/** Pure selection resolution: no environment, filesystem, or driver probing. */
export function resolveHarnessExecution(input: ResolveHarnessExecutionInput): HarnessResolution {
  const consistencyFailure = validateAgentConsistency(input)
  if (consistencyFailure !== undefined) return consistencyFailure

  const harnessResolved = resolveScalar(input, 'harness')
  const harness = (harnessResolved?.value ?? 'agent-harness') as HarnessId
  const definition = HARNESS_CATALOG[harness]
  if (definition === undefined)
    return refusal('unsupported_harness', `Unsupported harness ${String(harness)}`, { harness })

  const providerResolved = resolveScalar(input, 'modelProvider')
  const provider = providerResolved?.value ?? definition.defaultModelProvider
  const providerDefinition = definition.supportedModelProviders.find(
    (candidate) => candidate.id === provider
  )
  if (providerDefinition === undefined) {
    return refusal(
      'unsupported_model_provider',
      `Harness ${harness} does not support model provider ${provider}`,
      { harness, modelProvider: provider }
    )
  }

  const modelResolved = resolveScalar(input, 'model')
  const model = modelResolved?.value ?? providerDefinition.defaultModel
  if (!providerDefinition.supportedModels.includes(model)) {
    return refusal(
      'unsupported_model',
      `Harness ${harness} does not support model ${model} from ${provider}`,
      { harness, modelProvider: provider, model }
    )
  }

  const presentation = resolvePresentation(input, definition.presentationDefault)
  const recipe = presentation.value
    ? definition.executionVariants.withPresentation
    : definition.executionVariants.withoutPresentation
  if ('code' in recipe) return refusal(recipe.code, recipe.message, { harness, presentation: true })

  const reasoning = resolveScalar(input, 'reasoningEffort') as
    | ResolvedScalar<ReasoningEffort>
    | undefined
  return {
    ok: true,
    selection: {
      harness,
      modelProvider: provider,
      model,
      ...(reasoning === undefined ? {} : { reasoningEffort: reasoning.value }),
      presentation: presentation.value,
      provenance: {
        harness: harnessResolved?.source ?? 'catalog-default',
        modelProvider: providerResolved?.source ?? 'catalog-default',
        model: modelResolved?.source ?? 'catalog-default',
        ...(reasoning === undefined ? {} : { reasoningEffort: reasoning.source }),
        presentation: presentation.source,
      },
    },
    recipe: recipe as ExecutionRecipe,
  }
}
