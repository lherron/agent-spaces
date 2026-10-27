import { describe, expect, test } from 'bun:test'
import { ConfigValidationError } from '../errors.js'
import { parseAgentProfile } from './agent-profile-toml.js'

function rejectionOf(source: string): Array<{ path: string; keyword: string }> {
  try {
    parseAgentProfile(source)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError)
    return (error as ConfigValidationError).validationErrors.map(({ path, keyword }) => ({
      path,
      keyword,
    }))
  }
  throw new Error('expected parseAgentProfile to reject')
}

describe('agent-profile federation policy (T-06604)', () => {
  test('a v4 profile with claims_task and [placement.pins]/[placement.homes] parses to exactly that placement policy', () => {
    const profile = parseAgentProfile(`
version = 4
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

  test.each(['"hrc"', '"never"', '""', '"Participant-Only"', 'true'])(
    'a [placement] launch other than "participant-only" is rejected at /placement/launch: %s',
    (rawValue) => {
      expect(rejectionOf(`version = 4\n\n[placement]\nlaunch = ${rawValue}\n`)).toEqual([
        { path: '/placement/launch', keyword: 'const' },
      ])
    }
  )

  test('defaults claims_task to false and leaves absent placement undeclared', () => {
    const profile = parseAgentProfile('version = 4\n')

    expect(profile.claims_task ?? false).toBe(false)
    expect(profile.placement).toBeUndefined()
  })

  test('accepts an empty placement table as a declared policy with no pins', () => {
    const profile = parseAgentProfile('version = 4\n\n[placement]\n')

    expect(profile.placement).toEqual({ pins: {}, homes: {} })
  })

  test.each(['lab', 'node.example', 'node_1', 'node-1', 'A9'])(
    'accepts nodeId-shaped default and pin value %j',
    (nodeId) => {
      const profile = parseAgentProfile(`
version = 4

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

  test.each([
    ['local', 'const'],
    ['', 'pattern'],
    ['bad/node', 'pattern'],
    ['bad node', 'pattern'],
    ['*', 'pattern'],
    ['a'.repeat(65), 'pattern'],
  ])('rejects invalid provisioning.node %j at /provisioning/node (%s)', (nodeId, keyword) => {
    expect(
      rejectionOf(`
version = 4

[provisioning]
node = "${nodeId}"
`)
    ).toEqual([{ path: '/provisioning/node', keyword }])
  })

  test.each([
    ['placement.pins', '"project:task"', 'local', 'const'],
    ['placement.pins', '"project:task"', '', 'pattern'],
    ['placement.pins', '"project:task"', 'bad/node', 'pattern'],
    ['placement.pins', '"project:task"', 'bad node', 'pattern'],
    ['placement.pins', '"project:task"', '*', 'pattern'],
    ['placement.pins', '"project:task"', 'a'.repeat(65), 'pattern'],
    ['placement.homes', 'labprimary', 'local', 'const'],
  ])('rejects invalid [%s] node value %s = %j', (table, key, nodeId, keyword) => {
    expect(
      rejectionOf(`
version = 4

[${table}]
${key} = "${nodeId}"
`)
    ).toEqual([{ path: `/${table.replace('.', '/')}/${key.replaceAll('"', '')}`, keyword }])
  })

  test.each([
    'project',
    ':task',
    'project:',
    'project:task:extra',
    'project:*',
    'project/task:task',
    `${'a'.repeat(65)}:task`,
    `project:${'a'.repeat(65)}`,
    'missing-colon',
  ])('rejects non-exact project:task pin key %j at its /placement/pins path', (scopeKey) => {
    expect(
      rejectionOf(`
version = 4

[placement.pins]
"${scopeKey}" = "lab"
`)
    ).toEqual([{ path: `/placement/pins/${scopeKey}`, keyword: 'pattern' }])
  })

  test.each(['', 'bad/task', 'bad task', '*', 'a'.repeat(65)])(
    'rejects invalid task-default key %j',
    (taskKey) => {
      expect(() =>
        parseAgentProfile(`
version = 4

[placement.homes]
"${taskKey}" = "lab"
`)
      ).toThrow(ConfigValidationError)
    }
  )

  test.each(['"yes"', '1', '[]'])('rejects non-boolean claims_task source %s', (rawValue) => {
    expect(() =>
      parseAgentProfile(`
version = 4
claims_task = ${rawValue}
`)
    ).toThrow(ConfigValidationError)
  })
})
