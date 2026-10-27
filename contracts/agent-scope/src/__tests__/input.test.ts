import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ASP_DEFAULT_TASK_ENV, resolveQualifiedScopeInput, resolveScopeInput } from '../input.js'

let savedDefaultTask: string | undefined

beforeEach(() => {
  savedDefaultTask = process.env[ASP_DEFAULT_TASK_ENV]
  Reflect.deleteProperty(process.env, ASP_DEFAULT_TASK_ENV)
})

afterEach(() => {
  if (savedDefaultTask === undefined) {
    Reflect.deleteProperty(process.env, ASP_DEFAULT_TASK_ENV)
  } else {
    process.env[ASP_DEFAULT_TASK_ENV] = savedDefaultTask
  }
})

describe('resolveScopeInput', () => {
  test('a scope handle with a task resolves to its canonical ScopeRef on the main lane', () => {
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
  test('fills projectId from opts and then defaults task to primary', () => {
    expect(resolveQualifiedScopeInput('cody', { projectId: 'agent-spaces' })).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      laneRef: 'main',
    })
  })

  describe('ASP_DEFAULT_TASK precedence', () => {
    test.each([
      ['scope handle', 'mable@proj:T-1'],
      ['session handle', 'mable@proj:T-1~repair'],
      ['ScopeRef', 'agent:mable:project:proj:task:T-1'],
    ])('explicit task in a %s beats the environment default', (_label, input) => {
      process.env[ASP_DEFAULT_TASK_ENV] = 'minilab'

      expect(resolveQualifiedScopeInput(input)).toMatchObject({
        scopeRef: 'agent:mable:project:proj:task:T-1',
      })
    })

    test('opts.taskId beats the environment default', () => {
      process.env[ASP_DEFAULT_TASK_ENV] = 'minilab'

      expect(resolveQualifiedScopeInput('mable@proj', { taskId: 'caller-session' })).toMatchObject({
        scopeRef: 'agent:mable:project:proj:task:caller-session',
      })
    })

    test('opts.defaultTaskId beats the environment default', () => {
      process.env[ASP_DEFAULT_TASK_ENV] = 'minilab'

      expect(
        resolveQualifiedScopeInput('mable@proj', { defaultTaskId: 'caller-default' })
      ).toMatchObject({
        scopeRef: 'agent:mable:project:proj:task:caller-default',
      })
    })

    test('trimmed environment default beats primary', () => {
      // Set by literal name: the env var name is user-facing and must not drift with the constant.
      process.env['ASP_DEFAULT_TASK'] = '  minilab  '

      expect(resolveQualifiedScopeInput('mable@proj')).toMatchObject({
        scopeRef: 'agent:mable:project:proj:task:minilab',
      })
    })

    test.each([undefined, '', '   \t'])(
      'unset or blank environment value %p falls through to primary',
      (value) => {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, ASP_DEFAULT_TASK_ENV)
        } else {
          process.env[ASP_DEFAULT_TASK_ENV] = value
        }

        expect(resolveQualifiedScopeInput('mable@proj')).toMatchObject({
          scopeRef: 'agent:mable:project:proj:task:primary',
        })
      }
    )

    test('invalid environment default fails loud and names its value', () => {
      process.env[ASP_DEFAULT_TASK_ENV] = 'not valid'

      expect(() => resolveQualifiedScopeInput('mable@proj')).toThrow(
        /Invalid ScopeRef ".*not valid.*": taskId contains invalid characters/
      )
    })
  })

  test('project-deferred shorthand fills projectId from opts', () => {
    expect(resolveQualifiedScopeInput('cody:zed', { projectId: 'hrc-runtime' })).toMatchObject({
      scopeRef: 'agent:cody:project:hrc-runtime:task:zed',
      laneRef: 'main',
    })
  })

  test('project-deferred shorthand throws when no project can be resolved', () => {
    expect(() => resolveQualifiedScopeInput('cody:zed')).toThrow(/requires a project/)
  })

  test('canonical agent ScopeRef wins over deferred-handle reading of agent:<id>', () => {
    expect(resolveQualifiedScopeInput('agent:larry')).toMatchObject({
      scopeRef: 'agent:larry',
    })
  })

  describe('defaultRoleName (T-06355)', () => {
    const defaultRoleName = 'coordinator'

    test.each([
      {
        label: 'does not apply to a project-only handle before task:primary is synthesized',
        input: 'cody@agent-spaces',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:primary',
        expectedLaneRef: 'main',
      },
      {
        label: 'does not apply when opts.defaultTaskId supplies the task',
        input: 'cody@agent-spaces',
        options: { defaultTaskId: 'T-1' },
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1',
        expectedLaneRef: 'main',
      },
      {
        label: 'does not apply when opts.taskId supplies the task',
        input: 'cody@agent-spaces',
        options: { taskId: 'T-1' },
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1',
        expectedLaneRef: 'main',
      },
      {
        label: 'applies to a task carried by a scope handle',
        input: 'cody@agent-spaces:T-1',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1:role:coordinator',
        expectedLaneRef: 'main',
      },
      {
        label: 'preserves an explicit role on a task-bearing scope handle',
        input: 'cody@agent-spaces:T-1/tester',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1:role:tester',
        expectedLaneRef: 'main',
      },
      {
        label: 'applies to a task carried by a canonical ScopeRef',
        input: 'agent:cody:project:agent-spaces:task:T-1',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1:role:coordinator',
        expectedLaneRef: 'main',
      },
      {
        label: 'preserves an explicit role on a canonical ScopeRef',
        input: 'agent:cody:project:agent-spaces:task:T-1:role:tester',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1:role:tester',
        expectedLaneRef: 'main',
      },
      {
        label: 'applies to a task carried by a session handle and preserves its lane',
        input: 'cody@agent-spaces:T-1~repair',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:T-1:role:coordinator',
        expectedLaneRef: 'lane:repair',
      },
      {
        label: 'does not apply to a task synthesized for a project-only session handle',
        input: 'cody@agent-spaces~repair',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:primary',
        expectedLaneRef: 'lane:repair',
      },
      {
        label: 'preserves an explicit role when the input carries no task',
        input: 'cody@agent-spaces/reviewer',
        options: {},
        expectedScopeRef: 'agent:cody:project:agent-spaces:task:primary:role:reviewer',
        expectedLaneRef: 'main',
      },
    ])('$label', ({ input, options, expectedScopeRef, expectedLaneRef }) => {
      const result = resolveQualifiedScopeInput(input, { ...options, defaultRoleName })

      expect(result.scopeRef).toBe(expectedScopeRef)
      expect(result.parsed.roleName).toBe(
        expectedScopeRef.includes(':role:') ? expectedScopeRef.split(':role:')[1] : undefined
      )
      expect(result.laneRef).toBe(expectedLaneRef)
    })
  })
})
