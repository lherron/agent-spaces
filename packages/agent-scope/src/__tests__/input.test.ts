import { describe, expect, test } from 'bun:test'

import { DEFAULT_PRIMARY_TASK_ID, resolveQualifiedScopeInput, resolveScopeInput } from '../input.js'

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

  test('preserves session-handle lanes and fills primary task', () => {
    expect(resolveScopeInput('larry@agent-spaces~repair')).toEqual({
      parsed: expect.objectContaining({
        agentId: 'larry',
        projectId: 'agent-spaces',
        taskId: 'primary',
        scopeRef: 'agent:larry:project:agent-spaces:task:primary',
      }),
      scopeRef: 'agent:larry:project:agent-spaces:task:primary',
      laneId: 'repair',
      laneRef: 'lane:repair',
    })
  })

  test('canonical project-only ScopeRef is qualified to task:primary', () => {
    expect(resolveScopeInput('agent:cody:project:agent-spaces')).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      laneRef: 'main',
      laneId: 'main',
    })
  })

  test('bare agent handle remains agent-only with no project to qualify', () => {
    expect(resolveScopeInput('cody')).toMatchObject({
      scopeRef: 'agent:cody',
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

describe('resolveQualifiedScopeInput', () => {
  test('exposes the canonical primary task id', () => {
    expect(DEFAULT_PRIMARY_TASK_ID).toBe('primary')
  })

  test('fills missing taskId with primary when project is present', () => {
    expect(resolveQualifiedScopeInput('cody@agent-spaces')).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      laneRef: 'main',
      laneId: 'main',
    })
  })

  test('fills projectId from opts and then defaults task to primary', () => {
    expect(resolveQualifiedScopeInput('cody', { projectId: 'agent-spaces' })).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      laneRef: 'main',
    })
  })

  test('preserves explicit taskId', () => {
    expect(resolveQualifiedScopeInput('cody@agent-spaces:T-00123')).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-00123',
    })
  })

  test('preserves session-handle lane and still fills primary', () => {
    expect(resolveQualifiedScopeInput('cody@agent-spaces~repair')).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      laneId: 'repair',
      laneRef: 'lane:repair',
    })
  })

  test('role without task collapses to task:primary:role', () => {
    expect(resolveQualifiedScopeInput('cody@agent-spaces/reviewer')).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:primary:role:reviewer',
    })
  })

  test('leaves bare agent unchanged when no projectId is supplied', () => {
    expect(resolveQualifiedScopeInput('cody')).toMatchObject({
      scopeRef: 'agent:cody',
    })
  })

  test('explicit opts.taskId overrides the primary default', () => {
    expect(
      resolveQualifiedScopeInput('cody', { projectId: 'agent-spaces', taskId: 'T-99999' })
    ).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-99999',
    })
  })

  test('opts.defaultTaskId is used when neither input nor opts.taskId is set', () => {
    expect(
      resolveQualifiedScopeInput('cody@agent-spaces', { defaultTaskId: 'default' })
    ).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:default',
    })
  })

  test('canonical input is preserved end-to-end', () => {
    expect(
      resolveQualifiedScopeInput('agent:cody:project:agent-spaces:task:T-1:role:tester')
    ).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-1:role:tester',
    })
  })
})
