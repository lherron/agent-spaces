import { describe, expect, test } from 'bun:test'
import { ConfigValidationError } from '../errors.js'
import { parseAgentProfile } from './agent-profile-toml.js'

describe('agent-profile federation policy (T-06604)', () => {
  test.each([1, 2] as const)('parses placement and claims_task in schemaVersion %i', (version) => {
    const profile = parseAgentProfile(`
schemaVersion = ${version}
claims_task = true

[placement]
default_home_node = "local"
"agent-spaces:T-06604" = "lab.node-1"
"hrc-runtime:primary" = "svc_1"
`)

    expect(profile.claims_task).toBe(true)
    expect(profile.placement).toEqual({
      default_home_node: 'local',
      pins: {
        'agent-spaces:T-06604': 'lab.node-1',
        'hrc-runtime:primary': 'svc_1',
      },
    })
  })

  test('defaults claims_task to false and leaves absent placement undeclared', () => {
    const profile = parseAgentProfile('schemaVersion = 2\n')

    expect(profile.claims_task ?? false).toBe(false)
    expect(profile.placement).toBeUndefined()
  })

  test('accepts an empty placement table as a declared policy with no pins', () => {
    const profile = parseAgentProfile('schemaVersion = 2\n\n[placement]\n')

    expect(profile.placement).toEqual({ pins: {} })
  })

  test.each(['lab', 'node.example', 'node_1', 'node-1', 'A9'])(
    'accepts nodeId-shaped default and pin value %j',
    (nodeId) => {
      const profile = parseAgentProfile(`
schemaVersion = 2

[placement]
default_home_node = "${nodeId}"
"project:task" = "${nodeId}"
`)

      expect(profile.placement).toEqual({
        default_home_node: nodeId,
        pins: { 'project:task': nodeId },
      })
    }
  )

  test.each(['', 'bad/node', 'bad node', '*', 'a'.repeat(65)])(
    'rejects invalid default_home_node %j',
    (nodeId) => {
      expect(() =>
        parseAgentProfile(`
schemaVersion = 2

[placement]
default_home_node = "${nodeId}"
`)
      ).toThrow(ConfigValidationError)
    }
  )

  test.each(['local', '', 'bad/node', 'bad node', '*', 'a'.repeat(65)])(
    'rejects invalid pin node %j',
    (nodeId) => {
      expect(() =>
        parseAgentProfile(`
schemaVersion = 2

[placement]
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
schemaVersion = 2

[placement]
"${scopeKey}" = "lab"
`)
    ).toThrow(ConfigValidationError)
  })

  test.each(['"yes"', '1', '[]'])('rejects non-boolean claims_task source %s', (rawValue) => {
    expect(() =>
      parseAgentProfile(`
schemaVersion = 2
claims_task = ${rawValue}
`)
    ).toThrow(ConfigValidationError)
  })

  test('reports the offending placement key path', () => {
    try {
      parseAgentProfile(
        `
schemaVersion = 2

[placement]
"missing-colon" = "lab"
`,
        '/tmp/agent-profile.toml'
      )
      throw new Error('expected parseAgentProfile to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).validationErrors).toEqual([
        expect.objectContaining({ path: '/placement/missing-colon', keyword: 'pattern' }),
      ])
    }
  })
})
