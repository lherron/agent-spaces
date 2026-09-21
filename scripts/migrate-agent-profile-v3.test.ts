import { describe, expect, test } from 'bun:test'

import TOML from '@iarna/toml'
import { parseAgentProfile, parseTargetsToml } from 'spaces-config'
import { migrateAgentProfile, migrateTargets } from './migrate-agent-profile-v3.js'

// T-08701: the legacy v2 -> v3 emitter is frozen. Its version-3 output is no
// longer readable by the production parser -- these tests pin the emitted
// structure AND prove the v4 boundary rejects it fail-closed (no dual
// reader, no translation).
describe('profile v3 migration', () => {
  const V2_PROFILE = `
schemaVersion = 2
priming_prompt = "Stand by"
[identity]
display = "Cody"
role = "descriptive-coder"
harness = "codex"
[instructions]
additionalBase = ["agent-root:///EXTRA.md"]
[spaces]
base = ["space:defaults@dev"]
[harnessDefaults]
model = "wrong-for-codex"
yolo = true
remote_control = true
[harnessDefaults.codex]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
model_reasoning_summary = "concise"
[harnessByMode.heartbeat]
model = "gpt-5.6-terra"
[placement]
default_home_node = "local"
"hrc-runtime:hrcdev" = "hrcdev"
[placement.task-defaults]
primary = "max3"
primary-nova = "max3"
minisvc = "svc"
minisvc-cosmos = "svc"
labprimary = "lab"
signal-score = "max3"
`

  test('promotes provisioning, removes dead fields, and collapses roster homes', () => {
    const migrated = migrateAgentProfile(V2_PROFILE)

    expect(migrated).not.toContain('harnessByMode')
    expect(migrated).not.toContain('primary-nova')
    expect(migrated).not.toContain('labprimary')
    const parsed = TOML.parse(migrated) as Record<string, any>
    expect(parsed['version']).toBe(3)
    expect(parsed['provisioning']).toMatchObject({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      yolo: true,
      remote: true,
    })
  })

  test('version-3 output fails closed at the v4 boundary', () => {
    const migrated = migrateAgentProfile(V2_PROFILE)
    expect(() => parseAgentProfile(migrated)).toThrow(
      'unsupported profile version; expected 4 (versions 1 through 3 are rejected without translation)'
    )
  })

  test('moves a non-local default home into provisioning.node', () => {
    const migrated = migrateAgentProfile(`
schemaVersion = 2
[identity]
harness = "claude-code"
[harnessDefaults]
model = "opus"
[placement]
default_home_node = "svc"
`)
    const parsed = TOML.parse(migrated) as Record<string, any>
    expect(parsed['provisioning']).toMatchObject({
      harness: 'claude-code',
      model: 'opus',
      node: 'svc',
    })
    // The claude-code alias is rejected, never translated, at the boundary.
    expect(() => parseAgentProfile(migrated)).toThrow('unsupported profile version')
  })
})

describe('asp-targets v3 migration', () => {
  const V1_TARGETS = `
schema = 1
[targets.cody]
compose = ["space:defaults@dev"]
harness = "codex"
yolo = true
priming_prompt_append = "Project context"
[targets.cody.codex]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
`

  test('nests target birth defaults under provisioning', () => {
    const migrated = migrateTargets(V1_TARGETS)
    const parsed = TOML.parse(migrated) as Record<string, any>
    expect(parsed['targets']['cody']).toMatchObject({
      compose: ['space:defaults@dev'],
      priming_append: 'Project context',
      provisioning: {
        harness: 'codex',
        model: 'gpt-5.6-sol',
        reasoning: 'high',
        yolo: true,
      },
    })
  })

  test('schema-1 output fails closed at the schema-2 boundary', () => {
    expect(() => parseTargetsToml(migrateTargets(V1_TARGETS))).toThrow(
      '/schema: must be equal to constant'
    )
  })
})
