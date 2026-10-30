import { describe, expect, test } from 'bun:test'
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
  parseSpaceToml,
  parseTargetsToml,
} from 'spaces-config'

const EXPECTED_IDS = [
  'agent-harness',
  'claude',
  'claude-hrcpty',
  'codex',
  'codex-hrcpty',
  'muse',
] as const

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
  test('protocol, config, profile, target, and catalog expose the same six IDs', () => {
    expect([...catalogHarnessIds()]).toEqual(EXPECTED_IDS)
    expect([...CONFIG_HARNESS_IDS]).toEqual(EXPECTED_IDS)
    expect(catalogCapabilities().map(({ id }) => id)).toEqual(EXPECTED_IDS)

    for (const harness of EXPECTED_IDS) {
      expect(
        parseSpaceToml(`schema = 1\nid = "test-space"\n[harness]\nsupports = ["${harness}"]\n`)
          .harness?.supports
      ).toEqual([harness])
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
      selection: { harness: 'agent-harness', presentation: true },
      recipe: { driver: 'agent-harness-tmux' },
    })
    expect(catalogCapabilities().map(({ presentationDefault }) => presentationDefault)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
  })
})
