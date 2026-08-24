import { describe, expect, test } from 'bun:test'

import { ConfigValidationError } from '../errors.js'
import { parseAgentProfile } from './agent-profile-toml.js'

describe('parseAgentProfile: v3 hard cutover', () => {
  test('accepts version 3 and rejects v1/v2 spellings', () => {
    expect(parseAgentProfile('version = 3\n').version).toBe(3)
    for (const source of ['version = 1\n', 'version = 2\n', 'schemaVersion = 2\n']) {
      expect(() => parseAgentProfile(source)).toThrow(ConfigValidationError)
    }
  })

  test('parses identity.role as the default scope role', () => {
    const profile = parseAgentProfile(`
version = 3
[identity]
display = "Cody"
role = "implementer"
`)
    expect(profile.identity).toEqual({ display: 'Cody', role: 'implementer' })
  })

  test('rejects removed descriptive/default-role and identity harness keys', () => {
    for (const line of ['default_scope_role = "implementer"', 'harness = "codex"']) {
      expect(() => parseAgentProfile(`version = 3\n[identity]\n${line}\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('parses first-class provisioning scalars and profile-only harness tables', () => {
    const profile = parseAgentProfile(`
version = 3
[provisioning]
harness = "codex"
model = "gpt-5.6-sol"
reasoning = "high"
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
profile = "operator"
`)
    expect(profile.provisioning).toEqual({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      node: 'svc',
      yolo: true,
      sandbox: 'workspace-write',
      approval: 'never',
      remote: true,
      claude: { permission_mode: 'default', args: ['--verbose'] },
      codex: {
        model_reasoning_summary: 'concise',
        status_line: ['model', 'cwd'],
        profile: 'operator',
      },
    })
  })

  test('parses provisioning default_scope_role as a validated role token', () => {
    const profile = parseAgentProfile(
      `version = 3\n[provisioning]\nharness = "codex"\ndefault_scope_role = "implementer"\n`
    )
    expect(profile.provisioning).toEqual({ harness: 'codex', default_scope_role: 'implementer' })
  })

  test('rejects a provisioning default_scope_role that is not a role token', () => {
    for (const bad of ['not/a/role', 'has space', '']) {
      expect(() =>
        parseAgentProfile(`version = 3\n[provisioning]\ndefault_scope_role = "${bad}"\n`)
      ).toThrow(ConfigValidationError)
    }
  })

  test('rejects removed harnessDefaults and harnessByMode sections', () => {
    for (const section of ['harnessDefaults', 'harnessByMode.heartbeat']) {
      expect(() => parseAgentProfile(`version = 3\n[${section}]\nmodel = "x"\n`)).toThrow(
        ConfigValidationError
      )
    }
  })

  test('parses priming, priming_file, spaces.modes, and instructions base/modes', () => {
    const profile = parseAgentProfile(`
version = 3
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
      parseAgentProfile('version = 3\npriming = "inline"\npriming_file = "PRIMING.md"\n')
    ).toThrow(ConfigValidationError)
  })

  test('parses placement pins and homes', () => {
    const profile = parseAgentProfile(`
version = 3
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
      'version = 3\n[provisioning]\nnode = "local"\n',
      'version = 3\n[placement.homes]\nprimary = "local"\n',
      'version = 3\n[placement.pins]\n"p:t" = "local"\n',
    ]) {
      expect(() => parseAgentProfile(source)).toThrow(ConfigValidationError)
    }
  })

  test('rejects reserved family members in homes with INCONSISTENT_FAMILY_HOME', () => {
    try {
      parseAgentProfile(`
version = 3
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
version = 3
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
version = 3
[placement.homes]
research-nova = "svc"
`)
    expect(profile.placement?.homes).toEqual({ 'research-nova': 'svc' })
  })
})
