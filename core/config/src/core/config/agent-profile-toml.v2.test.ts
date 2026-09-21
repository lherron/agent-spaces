import { describe, expect, test } from 'bun:test'

import { ConfigValidationError } from '../errors.js'
import { AGENT_PROFILE_PROVISIONING_KEYS, parseAgentProfile } from './agent-profile-toml.js'

const V4_AGENT_PROFILE_PROVISIONING_KEYS = [
  'harness',
  'model_provider',
  'model',
  'reasoning_effort',
  'presentation',
  'node',
  'yolo',
  'sandbox',
  'approval',
  'remote',
  'claude',
  'codex',
  'default_scope_role',
] as const

describe('parseAgentProfile: v4 selection vocabulary', () => {
  test('derived provisioning membership is exactly the v4 key set', () => {
    expect([...AGENT_PROFILE_PROVISIONING_KEYS]).toEqual([...V4_AGENT_PROFILE_PROVISIONING_KEYS])
  })

  test('accepts only version 4 and rejects versions 1 through 3 without translation', () => {
    expect(parseAgentProfile('version = 4\n').version).toBe(4)
    for (const source of [
      'version = 1\n',
      'version = 2\n',
      'version = 3\n',
      'schemaVersion = 2\n',
    ]) {
      expect(() => parseAgentProfile(source)).toThrow(ConfigValidationError)
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

  test('rejects removed descriptive/default-role and identity harness keys', () => {
    for (const line of ['default_scope_role = "implementer"', 'harness = "codex"']) {
      expect(() => parseAgentProfile(`version = 4\n[identity]\n${line}\n`)).toThrow(
        ConfigValidationError
      )
    }
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

[provisioning.claude]
permission_mode = "default"
args = ["--verbose"]

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
      claude: { permission_mode: 'default', args: ['--verbose'] },
      codex: {
        model_reasoning_summary: 'concise',
        status_line: ['model', 'cwd'],
      },
    })
  })

  test('accepts the first-party agent harness', () => {
    expect(
      parseAgentProfile('version = 4\n[provisioning]\nharness = "agent-harness"\n').provisioning
    ).toEqual({ harness: 'agent-harness' })
  })

  test('presentation is absent rather than materialized when the profile omits it', () => {
    const profile = parseAgentProfile(`
version = 4
[provisioning]
harness = "codex"
`)

    expect(profile.provisioning).toEqual({ harness: 'codex' })
    expect(Object.hasOwn(profile.provisioning ?? {}, 'presentation')).toBe(false)
  })

  test('explicit presentation false is preserved by property presence', () => {
    const profile = parseAgentProfile(`
version = 4
[provisioning]
harness = "codex"
presentation = false
`)

    expect(profile.provisioning).toEqual({ harness: 'codex', presentation: false })
    expect(Object.hasOwn(profile.provisioning ?? {}, 'presentation')).toBe(true)
  })

  test('presentation derives its boolean kind from the scalar table', () => {
    for (const rawValue of ['"auto"', '1']) {
      expect(() =>
        parseAgentProfile(`version = 4\n[provisioning]\npresentation = ${rawValue}\n`)
      ).toThrow(ConfigValidationError)
    }
  })

  test('rejects removed viewer and reasoning keys without translation', () => {
    for (const line of ['viewer = "none"', 'viewer = "auto"', 'reasoning = "high"']) {
      expect(() => parseAgentProfile(`version = 4\n[provisioning]\n${line}\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('rejects harness aliases and removed harness ids without translation', () => {
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
    ]) {
      expect(() =>
        parseAgentProfile(`version = 4\n[provisioning]\nharness = "${harness}"\n`)
      ).toThrow(ConfigValidationError)
    }
  })

  test('rejects provider-prefixed model strings', () => {
    for (const model of ['openai-codex/gpt-5.5', 'anthropic/claude-sonnet-4-5', 'owner/model']) {
      expect(() => parseAgentProfile(`version = 4\n[provisioning]\nmodel = "${model}"\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('parses provisioning default_scope_role as a validated role token', () => {
    const profile = parseAgentProfile(
      `version = 4\n[provisioning]\nharness = "codex"\ndefault_scope_role = "implementer"\n`
    )
    expect(profile.provisioning).toEqual({ harness: 'codex', default_scope_role: 'implementer' })
  })

  test('rejects a provisioning default_scope_role that is not a role token', () => {
    for (const bad of ['not/a/role', 'has space', '']) {
      expect(() =>
        parseAgentProfile(`version = 4\n[provisioning]\ndefault_scope_role = "${bad}"\n`)
      ).toThrow(ConfigValidationError)
    }
  })

  test('rejects removed harnessDefaults and harnessByMode sections', () => {
    for (const section of ['harnessDefaults', 'harnessByMode.heartbeat']) {
      expect(() => parseAgentProfile(`version = 4\n[${section}]\nmodel = "x"\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('parses priming, priming_file, spaces.modes, and instructions base/modes', () => {
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
    expect(profile.spaces?.modes?.heartbeat).toEqual(['space:heartbeat@dev'])
    expect(profile.instructions?.base).toEqual(['agent-root:///EXTRA.md'])
    expect(profile.instructions?.modes?.task).toEqual(['agent-root:///TASK.md'])
  })

  test('rejects both priming and priming_file', () => {
    expect(() =>
      parseAgentProfile('version = 4\npriming = "inline"\npriming_file = "PRIMING.md"\n')
    ).toThrow(ConfigValidationError)
  })

  test('parses placement pins and homes', () => {
    const profile = parseAgentProfile(`
version = 4
[placement.pins]
"hrc-runtime:hrcdev" = "hrcdev"
[placement.homes]
primary = "max3"
minisvc = "svc"
`)
    expect(profile.placement).toEqual({
      pins: { 'hrc-runtime:hrcdev': 'hrcdev' },
      homes: { primary: 'max3', minisvc: 'svc' },
    })
  })

  test('rejects local as a node sentinel everywhere', () => {
    for (const source of [
      'version = 4\n[provisioning]\nnode = "local"\n',
      'version = 4\n[placement.homes]\nprimary = "local"\n',
      'version = 4\n[placement.pins]\n"p:t" = "local"\n',
    ]) {
      expect(() => parseAgentProfile(source)).toThrow(ConfigValidationError)
    }
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

describe('parseAgentProfile: codex profile selector removed (T-08581)', () => {
  test('rejects [provisioning.codex] profile', () => {
    expect(() =>
      parseAgentProfile('version = 4\n[provisioning.codex]\nprofile = "meta"\n')
    ).toThrow(ConfigValidationError)
  })
})
