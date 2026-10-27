import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import TOML from '@iarna/toml'

// T-08701: the legacy v2 -> v3 emitter is frozen. These tests pin the structure
// the script writes back over each file it is given. The production parser
// rejects version-3 output; that boundary is tested in spaces-config.
const script = join(import.meta.dir, 'migrate-agent-profile-v3.ts')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Writes `source` to a temp `fileName`, runs the migration script on it, returns the rewritten TOML. */
function migrateFile(fileName: 'agent-profile.toml' | 'asp-targets.toml', source: string) {
  const root = mkdtempSync(join(tmpdir(), 'asp-migrate-v3-'))
  roots.push(root)
  const path = join(root, fileName)
  writeFileSync(path, source)
  const result = spawnSync('bun', [script, path], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(path)
  const migrated = readFileSync(path, 'utf8')
  return { migrated, parsed: TOML.parse(migrated) as Record<string, any> }
}
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
    const { migrated, parsed } = migrateFile('agent-profile.toml', V2_PROFILE)

    expect(migrated).not.toContain('harnessByMode')
    expect(migrated).not.toContain('primary-nova')
    expect(migrated).not.toContain('labprimary')
    expect(parsed['version']).toBe(3)
    expect(parsed['provisioning']).toMatchObject({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      yolo: true,
      remote: true,
    })
  })

  test('moves a non-local default home into provisioning.node', () => {
    const { parsed } = migrateFile(
      'agent-profile.toml',
      `
schemaVersion = 2
[identity]
harness = "claude-code"
[harnessDefaults]
model = "opus"
[placement]
default_home_node = "svc"
`
    )
    expect(parsed['provisioning']).toMatchObject({
      harness: 'claude-code',
      model: 'opus',
      node: 'svc',
    })
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
    const { parsed } = migrateFile('asp-targets.toml', V1_TARGETS)
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
})
