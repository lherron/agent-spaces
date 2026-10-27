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

describe('parseAgentProfile: v4 selection vocabulary', () => {
  test('accepts only version 4 and rejects versions 1 through 3 without translation', () => {
    expect(parseAgentProfile('version = 4\n').version).toBe(4)
    for (const source of ['version = 1\n', 'version = 2\n', 'version = 3\n']) {
      expect(rejectionOf(source)).toEqual([{ path: '/version', keyword: 'const' }])
    }
  })

  test('parses the operator capability and rejects non-boolean declarations', () => {
    expect(parseAgentProfile('version = 4\noperator = true\n').operator).toBe(true)
    expect(parseAgentProfile('version = 4\noperator = false\n').operator).toBe(false)

    for (const rawValue of ['"yes"', '1', '[]']) {
      expect(() => parseAgentProfile(`version = 4\noperator = ${rawValue}\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('parses identity.role as the default scope role', () => {
    const profile = parseAgentProfile(`
version = 4
[identity]
display = "Cody"
role = "implementer"
`)
    expect(profile.identity).toEqual({ display: 'Cody', role: 'implementer' })
  })

  test('parses first-class provisioning scalars and profile-only harness tables', () => {
    const profile = parseAgentProfile(`
version = 4
[provisioning]
harness = "codex"
model_provider = "openai-codex"
model = "gpt-5.6-sol"
reasoning_effort = "high"
presentation = true
node = "svc"
yolo = true
sandbox = "workspace-write"
approval = "never"
remote = true
default_scope_role = "implementer"

[provisioning.claude]
permission_mode = "default"
args = ["--verbose"]
ask_user_question = true

[provisioning.codex]
model_reasoning_summary = "concise"
status_line = ["model", "cwd"]
`)
    expect(profile.provisioning).toEqual({
      harness: 'codex',
      model_provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
      presentation: true,
      node: 'svc',
      yolo: true,
      sandbox: 'workspace-write',
      approval: 'never',
      remote: true,
      default_scope_role: 'implementer',
      claude: { permission_mode: 'default', args: ['--verbose'], ask_user_question: true },
      codex: {
        model_reasoning_summary: 'concise',
        status_line: ['model', 'cwd'],
      },
    })
  })

  test('rejects a non-boolean provisioning.claude.ask_user_question', () => {
    expect(() =>
      parseAgentProfile('version = 4\n[provisioning.claude]\nask_user_question = "yes"\n')
    ).toThrow(/ask_user_question/)
  })

  test.each([
    ['explicit false', 'presentation = false\n', { harness: 'codex', presentation: false }, true],
    ['omitted', '', { harness: 'codex' }, false],
  ])(
    'provisioning.presentation keeps explicit false and stays absent when omitted: %s',
    (_label, presentationLine, expected, present) => {
      const profile = parseAgentProfile(
        `version = 4\n[provisioning]\nharness = "codex"\n${presentationLine}`
      )

      expect(profile.provisioning).toEqual(expected)
      expect(Object.hasOwn(profile.provisioning ?? {}, 'presentation')).toBe(present)
    }
  )

  test('presentation derives its boolean kind from the scalar table', () => {
    for (const rawValue of ['"auto"', '1']) {
      expect(() =>
        parseAgentProfile(`version = 4\n[provisioning]\npresentation = ${rawValue}\n`)
      ).toThrow(ConfigValidationError)
    }
  })

  test.each([
    ['[provisioning]', 'viewer = "none"', '/provisioning/viewer'],
    ['[provisioning]', 'viewer = "auto"', '/provisioning/viewer'],
    ['[provisioning]', 'reasoning = "high"', '/provisioning/reasoning'],
    ['[identity]', 'default_scope_role = "implementer"', '/identity/default_scope_role'],
    ['[identity]', 'harness = "codex"', '/identity/harness'],
    ['[harnessDefaults]', 'model = "x"', '/harnessDefaults'],
    ['[harnessByMode.heartbeat]', 'model = "x"', '/harnessByMode'],
    ['[provisioning.codex]', 'profile = "meta"', '/provisioning/codex/profile'],
    ['(top level)', 'schemaVersion = 2', '/schemaVersion'],
  ])(
    'removed or unknown profile keys are rejected at their path without translation: %s %s',
    (table, line, path) => {
      const header = table === '(top level)' ? '' : `${table}\n`
      expect(rejectionOf(`version = 4\n${header}${line}\n`)).toEqual([
        { path, keyword: 'additionalProperties' },
      ])
    }
  )

  test('accepts the four canonical harness ids and rejects aliases, removed ids, and frontends without translation', () => {
    for (const harness of ['agent-harness', 'claude', 'codex', 'muse']) {
      expect(
        parseAgentProfile(`version = 4\n[provisioning]\nharness = "${harness}"\n`).provisioning
      ).toEqual({ harness })
    }
    for (const harness of [
      'claude-code',
      'codex-cli',
      'agent-sdk',
      'claude-agent-sdk',
      'pi',
      'pi-cli',
      'pi-sdk',
      'muse-cli',
      'agent-harness-tui',
      'viewer',
      '',
    ]) {
      expect(rejectionOf(`version = 4\n[provisioning]\nharness = "${harness}"\n`)).toEqual([
        { path: '/provisioning/harness', keyword: 'enum' },
      ])
    }
  })

  test('rejects provider-prefixed model strings', () => {
    for (const model of ['openai-codex/gpt-5.5', 'anthropic/claude-sonnet-4-5', 'owner/model']) {
      expect(() => parseAgentProfile(`version = 4\n[provisioning]\nmodel = "${model}"\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('rejects a provisioning default_scope_role that is not a role token', () => {
    for (const bad of ['not/a/role', 'has space', '']) {
      expect(() =>
        parseAgentProfile(`version = 4\n[provisioning]\ndefault_scope_role = "${bad}"\n`)
      ).toThrow(ConfigValidationError)
    }
  })

  test('priming, spaces base/modes and instructions base/modes parse into the profile', () => {
    const profile = parseAgentProfile(`
version = 4
priming = "Stand by"
[spaces]
base = ["space:defaults@dev"]
[spaces.modes.heartbeat]
base = ["space:heartbeat@dev"]
[instructions]
base = ["agent-root:///EXTRA.md"]
[instructions.modes.task]
base = ["agent-root:///TASK.md"]
`)
    expect(profile.priming).toBe('Stand by')
    expect(profile.spaces?.base).toEqual(['space:defaults@dev'])
    expect(profile.spaces?.modes?.heartbeat).toEqual(['space:heartbeat@dev'])
    expect(profile.instructions?.base).toEqual(['agent-root:///EXTRA.md'])
    expect(profile.instructions?.modes?.task).toEqual(['agent-root:///TASK.md'])
  })

  test('rejects both priming and priming_file', () => {
    expect(() =>
      parseAgentProfile('version = 4\npriming = "inline"\npriming_file = "PRIMING.md"\n')
    ).toThrow(ConfigValidationError)
  })

  test('rejects reserved family members in homes with INCONSISTENT_FAMILY_HOME', () => {
    try {
      parseAgentProfile(`
version = 4
[placement.homes]
primary = "max3"
primary-nova = "max3"
`)
      throw new Error('expected parser to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).validationErrors[0]?.keyword).toBe(
        'INCONSISTENT_FAMILY_HOME'
      )
    }
  })

  test('rejects reserved family members in pins with INCONSISTENT_FAMILY_HOME', () => {
    try {
      parseAgentProfile(`
version = 4
[placement.homes]
primary = "max3"
[placement.pins]
"hrc-runtime:primary-comet" = "svc"
`)
      throw new Error('expected parser to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).validationErrors[0]?.keyword).toBe(
        'INCONSISTENT_FAMILY_HOME'
      )
    }
  })

  test('does not reserve suffixes for undeclared bases', () => {
    const profile = parseAgentProfile(`
version = 4
[placement.homes]
research-nova = "svc"
`)
    expect(profile.placement?.homes).toEqual({ 'research-nova': 'svc' })
  })
})
