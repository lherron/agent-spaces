/**
 * Regression tests for buildCorrelationEnvVars (T-01212)
 *
 * Ensures placement-based SDK/headless runs propagate HRC_SESSION_REF so that
 * hrcchat tool subprocesses can resolve caller identity instead of falling back
 * to entity:human.
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
    bundle: { kind: 'agent-default' },
    dryRun: true,
    correlation,
  } as RuntimePlacement
}

describe('buildCorrelationEnvVars', () => {
  it('emits HRC_SESSION_REF alongside AGENT_SCOPE_REF and AGENT_LANE_REF', () => {
    const placement = makePlacement({
      sessionRef: {
        scopeRef: 'agent:smokey:project:media-ingest',
        laneRef: 'lane:main',
      },
      hostSessionId: 'hsid-test',
    })

    const env = buildCorrelationEnvVars(placement)

    expect(env['AGENT_SCOPE_REF']).toBe('agent:smokey:project:media-ingest')
    expect(env['AGENT_LANE_REF']).toBe('lane:main')
    expect(env['HRC_SESSION_REF']).toBe('agent:smokey:project:media-ingest/lane:main')
    expect(env['AGENT_HOST_SESSION_ID']).toBe('hsid-test')
  })

  it('formats HRC_SESSION_REF as scopeRef/laneRef matching cli-adapter convention', () => {
    const placement = makePlacement({
      sessionRef: {
        scopeRef: 'agent:rex:project:agent-spaces:task:T-01104',
        laneRef: 'lane:repair',
      },
    })

    const env = buildCorrelationEnvVars(placement)

    expect(env['HRC_SESSION_REF']).toBe('agent:rex:project:agent-spaces:task:T-01104/lane:repair')
  })

  it('omits all correlation vars when correlation is absent', () => {
    const placement = makePlacement(undefined)

    const env = buildCorrelationEnvVars(placement)

    expect(env['AGENT_SCOPE_REF']).toBeUndefined()
    expect(env['AGENT_LANE_REF']).toBeUndefined()
    expect(env['HRC_SESSION_REF']).toBeUndefined()
    expect(env['AGENT_HOST_SESSION_ID']).toBeUndefined()
  })

  it('omits session vars when sessionRef is absent but hostSessionId is present', () => {
    const placement = makePlacement({
      hostSessionId: 'hsid-only',
    })

    const env = buildCorrelationEnvVars(placement)

    expect(env['AGENT_SCOPE_REF']).toBeUndefined()
    expect(env['AGENT_LANE_REF']).toBeUndefined()
    expect(env['HRC_SESSION_REF']).toBeUndefined()
    expect(env['AGENT_HOST_SESSION_ID']).toBe('hsid-only')
  })
})
