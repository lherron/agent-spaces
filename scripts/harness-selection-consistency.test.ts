import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_HARNESS_ID,
  catalogCapabilities,
  catalogHarnessIds,
  resolveHarnessExecution,
} from 'agent-spaces'
import { validateAspcCompileHarnessInvocationRequest } from 'spaces-aspc-protocol'
import {
  DEFAULT_HARNESS as CONFIG_DEFAULT_HARNESS,
  HARNESS_IDS as CONFIG_HARNESS_IDS,
  parseAgentProfile,
  parseTargetsToml,
} from 'spaces-config'

const EXPECTED_IDS = ['agent-harness', 'claude', 'codex', 'muse'] as const

function wireRequest(harness: (typeof EXPECTED_IDS)[number]) {
  return {
    compileRequest: {
      schemaVersion: 'agent-runtime-compile-request/v2',
      agent: { id: 'consistency-agent' },
      identity: {
        requestId: 'request_consistency',
        operationId: 'operation_consistency',
        hostSessionId: 'host_consistency',
        generation: 1,
        runtimeId: 'runtime_consistency',
      },
      placement: {
        agentRoot: '/tmp/consistency-agent',
        projectRoot: '/tmp/consistency-project',
        cwd: '/tmp/consistency-project',
        runMode: 'task',
      },
      requested: { harness, presentation: false },
      materialization: {},
      hrcPolicy: {},
      correlation: {
        requestId: 'request_consistency',
        operationId: 'operation_consistency',
        hostSessionId: 'host_consistency',
        generation: 1,
        runtimeId: 'runtime_consistency',
      },
    },
  }
}

describe('repository harness-selection projections', () => {
  test('protocol, config, profile, target, and catalog expose the same four IDs', () => {
    expect([...catalogHarnessIds()]).toEqual(EXPECTED_IDS)
    expect([...CONFIG_HARNESS_IDS]).toEqual(EXPECTED_IDS)
    expect(catalogCapabilities().map(({ id }) => id)).toEqual(EXPECTED_IDS)

    for (const harness of EXPECTED_IDS) {
      expect(validateAspcCompileHarnessInvocationRequest(wireRequest(harness))).toBeTruthy()
      expect(
        parseAgentProfile(
          `version = 4\n[provisioning]\nharness = "${harness}"\npresentation = false\n`
        ).provisioning?.harness
      ).toBe(harness)
      expect(
        parseTargetsToml(
          `schema = 2\n[targets.agent]\ncompose = []\n[targets.agent.provisioning]\nharness = "${harness}"\npresentation = false\n`
        ).targets.agent?.provisioning?.harness
      ).toBe(harness)
    }
  })

  test('catalog projections preserve the single default and presentation matrix', () => {
    expect(DEFAULT_HARNESS_ID).toBe('agent-harness')
    expect(CONFIG_DEFAULT_HARNESS).toBe(DEFAULT_HARNESS_ID)
    const resolved = resolveHarnessExecution({ agent: { id: 'consistency-agent' } })
    expect(resolved).toMatchObject({
      ok: true,
      selection: { harness: 'agent-harness', presentation: false },
      recipe: { driver: 'agent-harness' },
    })
    expect(catalogCapabilities().map(({ presentationDefault }) => presentationDefault)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  test('generated schema and canonical documentation carry the closed vocabulary', () => {
    const root = join(import.meta.dirname, '..')
    const schema = JSON.parse(
      readFileSync(join(root, 'core/config/src/core/schemas/space.schema.json'), 'utf8')
    ) as {
      properties: { harness: { properties: { supports: { items: { enum: string[] } } } } }
    }
    expect(schema.properties.harness.properties.supports.items.enum).toEqual(EXPECTED_IDS)

    for (const relative of [
      'docs/proposals/producer-owned-harness-selection.md',
      'docs/harness-architecture.md',
      'docs/aspd.md',
    ]) {
      const text = readFileSync(join(root, relative), 'utf8')
      for (const harness of EXPECTED_IDS) expect(text).toContain(`\`${harness}\``)
    }
  })
})
