import type { ContextResolverContext } from './context-resolver.js'
import type { ContextTemplate, ServiceProbeSectionDef } from './context-template.js'
import { DynamicReplayLedger, type RecordedServiceProbeResponse } from './dynamic-replay.js'
import {
  displayServiceEndpoint,
  parseServiceEndpoint,
  probeServiceEndpoint,
} from './service-probe.js'
import { interpolateVariables } from './template-vars.js'
import { matchesWhenPredicate } from './when-predicate.js'

const DEFAULT_SERVICE_PROBE_TIMEOUT_MS = 250
const UP_MARK = '✅'
const DOWN_MARK = '❌'

/**
 * Probe each configured service endpoint and render a fixed-width status block
 * (one line per service, optional header). Returns `undefined` when the section
 * declares no services. Endpoints and the header are variable-interpolated
 * against the resolver context before probing/display.
 */
export async function resolveServiceProbeSection(
  section: ServiceProbeSectionDef,
  context: ContextResolverContext,
  replay?: DynamicReplayLedger
): Promise<string | undefined> {
  const timeout = section.timeout ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS
  const services = section.services.map((spec) => ({
    name: spec.name,
    endpoint: interpolateVariables(spec.endpoint, context),
  }))
  if (services.length === 0) {
    return undefined
  }
  const activeReplay = replay ?? new DynamicReplayLedger(undefined, context.serviceProbeResponses)
  const replayingServices = activeReplay.consumesServiceReplay()
  const invalid = services.find(
    (spec) => !replayingServices && parseServiceEndpoint(spec.endpoint) === undefined
  )
  if (invalid !== undefined) {
    throw new Error(`Unsupported service probe endpoint for ${invalid.name}: ${invalid.endpoint}`)
  }

  const results = await Promise.all(
    services.map(async (spec) => {
      return {
        spec,
        up: replayingServices
          ? activeReplay.consumeService(spec.name, spec.endpoint)?.up
          : await probeServiceEndpoint(spec.endpoint, timeout),
      }
    })
  )

  if (replay === undefined) activeReplay.assertFullyConsumed()

  const nameWidth = services.reduce((max, spec) => Math.max(max, spec.name.length), 0)
  const lines: string[] = []
  if (section.header !== undefined && section.header.length > 0) {
    lines.push(interpolateVariables(section.header, context))
  }
  for (const { spec, up } of results) {
    const mark = up ? UP_MARK : DOWN_MARK
    lines.push(`  ${mark} ${spec.name.padEnd(nameWidth)}  ${displayServiceEndpoint(spec.endpoint)}`)
  }
  return lines.join('\n')
}

/**
 * Probe, live, every endpoint the template's included service-probe sections
 * declare, in resolution order, so a caller can pin the results and replay them.
 * Applies the same `when` predicates, interpolation and timeouts as resolution.
 */
export async function recordTemplateServiceProbes(
  template: ContextTemplate,
  context: ContextResolverContext
): Promise<RecordedServiceProbeResponse[]> {
  const probes = [...template.promptSections, ...template.reminderSections].flatMap((section) =>
    section.type === 'service-probe' && matchesWhenPredicate(section, context)
      ? section.services.map((spec) => ({
          name: spec.name,
          endpoint: interpolateVariables(spec.endpoint, context),
          timeout: section.timeout ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS,
        }))
      : []
  )
  const occurrences = new Map<string, number>()
  return Promise.all(
    probes.map(async ({ name, endpoint, timeout }) => {
      const key = `${name}\u0000${endpoint}`
      const occurrence = (occurrences.get(key) ?? 0) + 1
      occurrences.set(key, occurrence)
      const up = await probeServiceEndpoint(endpoint, timeout)
      return occurrence === 1 ? { name, endpoint, up } : { name, endpoint, up, occurrence }
    })
  )
}
