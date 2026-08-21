import { describe, expect, test } from 'bun:test'

import { parseAgentProfile, parseTargetsToml } from 'spaces-config'
import { migrateAgentProfile, migrateTargets } from './migrate-agent-profile-v3.js'

describe('profile v3 migration', () => {
  test('promotes provisioning, removes dead fields, and collapses roster homes', () => {
    const migrated = migrateAgentProfile(`
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
`)

    expect(migrated).not.toContain('harnessByMode')
    expect(migrated).not.toContain('primary-nova')
    expect(migrated).not.toContain('labprimary')
    const profile = parseAgentProfile(migrated)
    expect(profile.identity).toEqual({ display: 'Cody' })
    expect(profile.provisioning).toEqual({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      yolo: true,
      remote: true,
      codex: { model_reasoning_summary: 'concise' },
    })
    expect(profile.instructions?.base).toEqual(['agent-root:///EXTRA.md'])
    expect(profile.placement).toEqual({
      pins: { 'hrc-runtime:hrcdev': 'hrcdev' },
      homes: { primary: 'max3', minisvc: 'svc', 'signal-score': 'max3' },
    })
  })

  test('moves a non-local default home into provisioning.node', () => {
    const profile = parseAgentProfile(
      migrateAgentProfile(`
schemaVersion = 2
[identity]
harness = "claude-code"
[harnessDefaults]
model = "opus"
[placement]
default_home_node = "svc"
`)
    )
    expect(profile.provisioning).toMatchObject({
      harness: 'claude-code',
      model: 'opus',
      node: 'svc',
    })
    expect(profile.placement).toBeUndefined()
  })
})

describe('asp-targets v3 migration', () => {
  test('nests target birth defaults under provisioning', () => {
    const manifest = parseTargetsToml(
      migrateTargets(`
schema = 1
[targets.cody]
compose = ["space:defaults@dev"]
harness = "codex"
yolo = true
priming_prompt_append = "Project context"
[targets.cody.codex]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
`)
    )
    expect(manifest.targets.cody).toEqual({
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
})
