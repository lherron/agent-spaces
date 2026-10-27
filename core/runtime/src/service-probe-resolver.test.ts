/**
 * Live service-probe sections: a context-template.toml `service-probe` section
 * probes each configured endpoint and renders one status row per service,
 * resolved through inspectAgentSystemPrompt. The endpoint is tcp://127.0.0.1:1,
 * which refuses locally, so no network is needed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type ResolverRoots,
  createResolverRoots,
  inspectTemplate,
  removeResolverRoots,
} from './test-support/context-resolver-fixture.js'

function probeTemplate(fields: string): string {
  return `
schema_version = 2

[[prompt]]
name = "services"
type = "service-probe"
${fields}
`
}

describe('resolveServiceProbeSection', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test.each([
    {
      label: 'an unreachable endpoint renders a down marker row',
      services: '[{ name = "broker", endpoint = "tcp://127.0.0.1:1" }]',
      rendered: true,
    },
    {
      label: 'no configured services renders no section, even with a header',
      services: '[]',
      rendered: false,
    },
  ])('$label', async ({ services, rendered }) => {
    const inspection = await inspectTemplate(
      roots,
      probeTemplate(`header = "Services"\ntimeout = 50\nservices = ${services}`)
    )

    if (rendered) {
      expect(inspection.prompt.content).toContain('❌')
      expect(inspection.prompt.content).toContain('broker')
      expect(inspection.prompt.content).toContain('tcp://127.0.0.1:1')
    } else {
      expect(inspection.prompt.content).toBe('')
      expect(inspection.prompt.sections[0]).toMatchObject({ name: 'services', included: false })
    }
  })

  test('an interpolated header line renders above the service rows', async () => {
    const inspection = await inspectTemplate(
      roots,
      probeTemplate(
        'header = "Services for {{agent_name}}"\ntimeout = 50\nservices = [{ name = "broker", endpoint = "tcp://127.0.0.1:1" }]'
      )
    )

    const lines = inspection.prompt.content.split('\n')
    expect(lines[0]).toBe('Services for smokey')
    expect(lines[1]).toContain('broker')
  })
})
