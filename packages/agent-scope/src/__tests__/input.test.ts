import { describe, expect, test } from 'bun:test'

import { resolveScopeInput } from '../input.js'

describe('resolveScopeInput', () => {
  test('canonicalizes scope handles with default main lane', () => {
    expect(resolveScopeInput('larry@agent-spaces:T-00123')).toEqual({
      parsed: expect.objectContaining({
        agentId: 'larry',
        projectId: 'agent-spaces',
        taskId: 'T-00123',
        scopeRef: 'agent:larry:project:agent-spaces:task:T-00123',
      }),
      scopeRef: 'agent:larry:project:agent-spaces:task:T-00123',
      laneId: 'main',
      laneRef: 'main',
    })
  })

  test('preserves session-handle lanes', () => {
    expect(resolveScopeInput('larry@agent-spaces~repair')).toEqual({
      parsed: expect.objectContaining({
        agentId: 'larry',
        projectId: 'agent-spaces',
        scopeRef: 'agent:larry:project:agent-spaces',
      }),
      scopeRef: 'agent:larry:project:agent-spaces',
      laneId: 'repair',
      laneRef: 'lane:repair',
    })
  })

  test('normalizes explicit default lanes from plain ids and lane refs', () => {
    expect(resolveScopeInput('agent:larry', 'deploy')).toMatchObject({
      scopeRef: 'agent:larry',
      laneId: 'deploy',
      laneRef: 'lane:deploy',
    })

    expect(resolveScopeInput('agent:larry', 'lane:deploy')).toMatchObject({
      scopeRef: 'agent:larry',
      laneId: 'deploy',
      laneRef: 'lane:deploy',
    })
  })

  test('rejects invalid input', () => {
    expect(() => resolveScopeInput('@demo')).toThrow(/Invalid scope input/)
  })
})
