import { describe, expect, test } from 'bun:test'
import type { ContextResolverContext } from './context-resolver.js'
import type { ServiceProbeSectionDef } from './context-template.js'
import { resolveServiceProbeSection } from './service-probe-resolver.js'

const baseContext: ContextResolverContext = {
  agentRoot: '/tmp/agent',
  agentsRoot: '/tmp/agents',
  runMode: 'interactive',
}

function probeSection(overrides: Partial<ServiceProbeSectionDef>): ServiceProbeSectionDef {
  return {
    name: 'services',
    type: 'service-probe',
    services: [],
    ...overrides,
  }
}

describe('resolveServiceProbeSection', () => {
  test('returns undefined when no services are configured', async () => {
    const result = await resolveServiceProbeSection(probeSection({ services: [] }), baseContext)
    expect(result).toBeUndefined()
  })

  test('renders a down marker for an unreachable endpoint', async () => {
    const section = probeSection({
      timeout: 50,
      services: [{ name: 'broker', endpoint: 'tcp://127.0.0.1:1' }],
    })
    const result = await resolveServiceProbeSection(section, baseContext)
    expect(result).toContain('❌')
    expect(result).toContain('broker')
    expect(result).toContain('tcp://127.0.0.1:1')
  })

  test('includes an interpolated header line above the service rows', async () => {
    const section = probeSection({
      header: 'Services for {{agent_name}}',
      timeout: 50,
      services: [{ name: 'broker', endpoint: 'tcp://127.0.0.1:1' }],
    })
    const result = await resolveServiceProbeSection(section, {
      ...baseContext,
      agentName: 'clod',
    })
    const lines = (result ?? '').split('\n')
    expect(lines[0]).toBe('Services for clod')
    expect(lines[1]).toContain('broker')
  })
})
