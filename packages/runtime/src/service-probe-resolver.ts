import type { ContextResolverContext } from './context-resolver.js'
import type { ServiceProbeSectionDef } from './context-template.js'
import {
  displayServiceEndpoint,
  parseServiceEndpoint,
  probeServiceEndpoint,
} from './service-probe.js'
import { interpolateVariables } from './template-vars.js'

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
  context: ContextResolverContext
): Promise<string | undefined> {
  const timeout = section.timeout ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS
  const services = section.services.map((spec) => ({
    name: spec.name,
    endpoint: interpolateVariables(spec.endpoint, context),
  }))
  if (services.length === 0) {
    return undefined
  }
  const invalid = services.find(
    (spec) =>
      context.serviceProbeResponses === undefined &&
      parseServiceEndpoint(spec.endpoint) === undefined
  )
  if (invalid !== undefined) {
    throw new Error(`Unsupported service probe endpoint for ${invalid.name}: ${invalid.endpoint}`)
  }

  const results = await Promise.all(
    services.map(async (spec) => {
      const recorded = context.serviceProbeResponses?.find(
        (response) => response.name === spec.name && response.endpoint === spec.endpoint
      )
      return {
        spec,
        up:
          recorded?.up ??
          (context.serviceProbeResponses === undefined
            ? await probeServiceEndpoint(spec.endpoint, timeout)
            : false),
      }
    })
  )

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
