/**
 * Correlation env on the `asp agent` dry-run invocation spec.
 *
 * T-00892: the positional ScopeRef is the correlation baseline, so a dry run
 * always carries AGENT_SCOPE_REF and AGENT_LANE_REF (default lane `main`);
 * --lane-ref overrides the lane.
 * T-00872: --host-session-id reaches AGENT_HOST_SESSION_ID (the CLI once
 * passed cpSessionId: '' and legacy shim fields instead).
 */

import { describe, expect } from 'bun:test'

import { type AgentInvocation, agentDryRunSpec, cliTest } from './asp-cli'

const cases: Array<{
  name: string
  invocation?: AgentInvocation
  /** Expected env values; `undefined` asserts the key is absent. */
  env: Record<string, string | undefined>
  timeout?: number
}> = [
  {
    name: 'baseline dry-run auto-populates AGENT_SCOPE_REF and AGENT_LANE_REF',
    env: { AGENT_SCOPE_REF: 'agent:alice', AGENT_LANE_REF: 'main' },
    timeout: 10_000,
  },
  {
    name: 'no AGENT_HOST_SESSION_ID when --host-session-id omitted',
    env: { AGENT_HOST_SESSION_ID: undefined },
  },
  {
    name: '--host-session-id propagates as AGENT_HOST_SESSION_ID in env',
    invocation: { flags: ['--host-session-id', 'regression-hsid-42'] },
    env: { AGENT_HOST_SESSION_ID: 'regression-hsid-42' },
  },
  {
    name: '--lane-ref overrides default lane',
    invocation: { flags: ['--lane-ref', 'deploy'] },
    env: { AGENT_SCOPE_REF: 'agent:alice', AGENT_LANE_REF: 'deploy' },
  },
  {
    name: '--host-session-id sets AGENT_HOST_SESSION_ID alongside scope/lane',
    invocation: { flags: ['--host-session-id', 'hs-corr-test'] },
    env: {
      AGENT_HOST_SESSION_ID: 'hs-corr-test',
      AGENT_SCOPE_REF: 'agent:alice',
      AGENT_LANE_REF: 'main',
    },
  },
  {
    name: 'compound ScopeRef propagates full ref',
    invocation: { scopeRef: 'agent:alice:project:demo', withProjectRoot: true },
    env: {
      AGENT_SCOPE_REF: 'agent:alice:project:demo:task:primary',
      AGENT_LANE_REF: 'main',
    },
  },
]

describe('agent dry-run correlation env (T-00872, T-00892)', () => {
  for (const { name, invocation, env, timeout } of cases) {
    cliTest(
      name,
      () => {
        const { result, spec } = agentDryRunSpec({ prompt: 'Hello', ...invocation })

        expect(result.exitCode).toBe(0)
        for (const [key, value] of Object.entries(env)) {
          expect(spec.env[key]).toBe(value)
        }
      },
      timeout
    )
  }
})
