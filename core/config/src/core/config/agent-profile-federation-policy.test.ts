import { describe, expect, test } from 'bun:test'
import { ConfigValidationError } from '../errors.js'
import { parseAgentProfile } from './agent-profile-toml.js'

describe('agent-profile federation policy (T-06604)', () => {
  test('parses placement and claims_task in version 3', () => {
    const profile = parseAgentProfile(`
version = 3
claims_task = true

[placement.pins]
"agent-spaces:T-06604" = "lab.node-1"
"hrc-runtime:primary" = "svc_1"

[placement.homes]
primary = "max3"
minisvc = "svc_1"
`)

    expect(profile.claims_task).toBe(true)
    expect(profile.placement).toEqual({
      pins: {
        'agent-spaces:T-06604': 'lab.node-1',
        'hrc-runtime:primary': 'svc_1',
      },
      homes: {
        primary: 'max3',
        minisvc: 'svc_1',
      },
    })
  })

  test('defaults claims_task to false and leaves absent placement undeclared', () => {
    const profile = parseAgentProfile('version = 3\n')

    expect(profile.claims_task ?? false).toBe(false)
    expect(profile.placement).toBeUndefined()
  })

  test('accepts an empty placement table as a declared policy with no pins', () => {
    const profile = parseAgentProfile('version = 3\n\n[placement]\n')

    expect(profile.placement).toEqual({ pins: {}, homes: {} })
  })

  test.each(['lab', 'node.example', 'node_1', 'node-1', 'A9'])(
    'accepts nodeId-shaped default and pin value %j',
    (nodeId) => {
      const profile = parseAgentProfile(`
version = 3

[provisioning]
node = "${nodeId}"
[placement.pins]
"project:task" = "${nodeId}"
`)

      expect(profile.provisioning?.node).toBe(nodeId)
      expect(profile.placement).toEqual({
        pins: { 'project:task': nodeId },
        homes: {},
      })
    }
  )

  test.each(['', 'bad/node', 'bad node', '*', 'a'.repeat(65)])(
    'rejects invalid provisioning.node %j',
    (nodeId) => {
      expect(() =>
        parseAgentProfile(`
version = 3

[provisioning]
node = "${nodeId}"
`)
      ).toThrow(ConfigValidationError)
    }
  )

  test.each(['local', '', 'bad/node', 'bad node', '*', 'a'.repeat(65)])(
    'rejects invalid pin node %j',
    (nodeId) => {
      expect(() =>
        parseAgentProfile(`
version = 3

[placement.pins]
"project:task" = "${nodeId}"
`)
      ).toThrow(ConfigValidationError)
    }
  )

  test.each([
    'project',
    ':task',
    'project:',
    'project:task:extra',
    'project:*',
    'project/task:task',
    `${'a'.repeat(65)}:task`,
    `project:${'a'.repeat(65)}`,
  ])('rejects non-exact project:task pin key %j', (scopeKey) => {
    expect(() =>
      parseAgentProfile(`
version = 3

[placement.pins]
"${scopeKey}" = "lab"
`)
    ).toThrow(ConfigValidationError)
  })

  test.each(['', 'bad/task', 'bad task', '*', 'a'.repeat(65)])(
    'rejects invalid task-default key %j',
    (taskKey) => {
      expect(() =>
        parseAgentProfile(`
version = 3

[placement.homes]
"${taskKey}" = "lab"
`)
      ).toThrow(ConfigValidationError)
    }
  )

  test.each(['local', '', 'bad/node', 'bad node', '*', 'a'.repeat(65)])(
    'rejects invalid task-default node %j',
    (nodeId) => {
      expect(() =>
        parseAgentProfile(`
version = 3

[placement.homes]
labprimary = "${nodeId}"
`)
      ).toThrow(ConfigValidationError)
    }
  )

  test.each(['"yes"', '1', '[]'])('rejects non-boolean claims_task source %s', (rawValue) => {
    expect(() =>
      parseAgentProfile(`
version = 3
claims_task = ${rawValue}
`)
    ).toThrow(ConfigValidationError)
  })

  test('reports the offending placement key path', () => {
    try {
      parseAgentProfile(
        `
version = 3

[placement.pins]
"missing-colon" = "lab"
`,
        '/tmp/agent-profile.toml'
      )
      throw new Error('expected parseAgentProfile to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).validationErrors).toEqual([
        expect.objectContaining({ path: '/placement/pins/missing-colon', keyword: 'pattern' }),
      ])
    }
  })
})

describe('agent-profile job execution ownership (T-06804)', () => {
  test.each([
    ['"svc"', ['svc']],
    ['["svc", "max3", "svc"]', ['max3', 'svc']],
    ['"all"', ['all']],
    ['["all", "all"]', ['all']],
  ])('normalizes jobs.default_node from %s', (authored, expected) => {
    const profile = parseAgentProfile(`
version = 3

[jobs]
default_node = ${authored}
`)

    expect(profile.jobs).toEqual({ default_node: expected })
  })

  test.each(['[]', '"local"', '["local"]', '["svc", "local"]', '["all", "svc"]'])(
    'rejects invalid jobs.default_node %s',
    (authored) => {
      expect(() =>
        parseAgentProfile(`
version = 3

[jobs]
default_node = ${authored}
`)
      ).toThrow(ConfigValidationError)
    }
  )
})
