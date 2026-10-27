/**
 * Regression tests for buildCorrelationEnvVars.
 *
 * Ensures placement-based SDK/headless runs propagate generic ASP
 * correlation identifiers for child processes and host integrations.
 */
import { describe, expect, it } from 'bun:test'

import type { RuntimePlacement } from 'spaces-config'

import { buildCorrelationEnvVars } from '../placement-api.js'

function makePlacement(correlation?: RuntimePlacement['correlation']): RuntimePlacement {
  return {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'alice' },
    dryRun: true,
    correlation,
  } as RuntimePlacement
}

describe('buildCorrelationEnvVars', () => {
  it('emits generic session and host correlation env vars', () => {
    const placement = makePlacement({
      sessionRef: {
        scopeRef: 'agent:smokey:project:media-ingest',
        laneRef: 'lane:main',
      },
      hostSessionId: 'hsid-test',
    })

    const env = buildCorrelationEnvVars(placement)

    expect(env['AGENT_SCOPE_REF']).toBe('agent:smokey:project:media-ingest')
    expect(env['AGENT_SESSION_REF']).toBe('agent:smokey:project:media-ingest/lane:main')
    expect(env['AGENT_PROJECT']).toBe('media-ingest')
    expect(env['AGENT_LANE_REF']).toBe('lane:main')
    expect(env['AGENT_LANE']).toBe('main')
    expect(env['AGENT_HOST_SESSION_ID']).toBe('hsid-test')
  })

  it('keeps scope identity distinct from lane-aware session identity', () => {
    const scopeRef = 'agent:rex:project:agent-spaces:task:T-01104:role:reviewer'
    const placement = makePlacement({
      sessionRef: {
        scopeRef,
        laneRef: 'lane:repair',
      },
    })

    const env = buildCorrelationEnvVars(placement)

    expect(env['AGENT_SCOPE_REF']).toBe(scopeRef)
    expect(env['AGENT_SESSION_REF']).toBe(`${scopeRef}/lane:repair`)
    expect(env['AGENT_ID']).toBe('rex')
    expect(env['AGENT_PROJECT']).toBe('agent-spaces')
    expect(env['AGENT_TASK']).toBe('T-01104')
    expect(env['AGENT_LANE']).toBe('repair')
  })

  it.each([
    ['no correlation emits no correlation vars', undefined, undefined],
    [
      'a hostSessionId without a sessionRef emits only the host var',
      { hostSessionId: 'hsid-only' },
      'hsid-only',
    ],
  ] as const)('%s', (_name, correlation, hostSessionId) => {
    const env = buildCorrelationEnvVars(makePlacement(correlation))

    expect(env['AGENT_SCOPE_REF']).toBeUndefined()
    expect(env['AGENT_SESSION_REF']).toBeUndefined()
    expect(env['AGENT_LANE_REF']).toBeUndefined()
    expect(env['AGENT_HOST_SESSION_ID']).toBe(hostSessionId)
  })
})
