import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import {
  type AgentLocalComponents,
  type AgentRuntimeProfile,
  type SpaceRefString,
  type TargetDefinition,
  resolveEffectiveCompose,
} from 'spaces-config'

import { useTempDirs } from '../../test/temp-dirs.js'
import { detectAgentLocalComponents, resolveAgentRunDefaults } from './agent-profile.js'

const createTempDir = useTempDirs()

const DEFAULTS_SPACE = 'space:defaults@stable' as SpaceRefString

// ---------------------------------------------------------------------------
// Agent-local skills/commands discovery threading (T-01067)
//
// run() computes `agentLocalComponents` from the agent root and threads it
// into materializeFromRefs(); the detector reports which component
// directories exist plus the absolute paths for each.
// ---------------------------------------------------------------------------

function expectedComponents(
  agentRoot: string,
  present: Pick<AgentLocalComponents, 'hasSkills' | 'hasCommands' | 'hasTools'>
): AgentLocalComponents {
  return {
    agentRoot,
    agentName: basename(agentRoot),
    ...present,
    skillsDir: join(agentRoot, 'skills'),
    commandsDir: join(agentRoot, 'commands'),
    toolsDir: join(agentRoot, 'tools'),
    toolsBinDir: join(agentRoot, 'tools', 'bin'),
    agentVarDir: join(agentRoot, 'var'),
  }
}

describe('agent-local component discovery (T-01067)', () => {
  const detected: Array<{
    name: string
    layout: (agentRoot: string) => Promise<void>
    present: Pick<AgentLocalComponents, 'hasSkills' | 'hasCommands' | 'hasTools'>
  }> = [
    {
      name: 'skills-only',
      layout: async (agentRoot) => {
        await mkdir(join(agentRoot, 'skills', 'review-code'), { recursive: true })
        await writeFile(join(agentRoot, 'skills', 'review-code', 'SKILL.md'), '# review\n')
      },
      present: { hasSkills: true, hasCommands: false, hasTools: false },
    },
    {
      name: 'commands-only',
      layout: async (agentRoot) => {
        await mkdir(join(agentRoot, 'commands'), { recursive: true })
        await writeFile(join(agentRoot, 'commands', 'deploy.md'), '# deploy\n')
      },
      present: { hasSkills: false, hasCommands: true, hasTools: false },
    },
    {
      name: 'skills and commands',
      layout: async (agentRoot) => {
        await mkdir(join(agentRoot, 'skills', 'triage'), { recursive: true })
        await mkdir(join(agentRoot, 'commands'), { recursive: true })
        await writeFile(join(agentRoot, 'skills', 'triage', 'SKILL.md'), '# triage\n')
        await writeFile(join(agentRoot, 'commands', 'deploy.md'), '# deploy\n')
      },
      present: { hasSkills: true, hasCommands: true, hasTools: false },
    },
    {
      name: 'tools-only',
      layout: async (agentRoot) => {
        await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })
      },
      present: { hasSkills: false, hasCommands: false, hasTools: true },
    },
  ]

  for (const { name, layout, present } of detected) {
    test(`detects ${name} agent roots`, async () => {
      const agentRoot = await createTempDir('smokey-agent-local-')
      await layout(agentRoot)

      await expect(detectAgentLocalComponents(agentRoot)).resolves.toEqual(
        expectedComponents(agentRoot, present)
      )
    })
  }

  const undetected: Array<{ name: string; layout: (agentRoot: string) => Promise<void> }> = [
    { name: 'neither skills nor commands', layout: async () => {} },
    {
      name: 'only var/',
      layout: async (agentRoot) => {
        await mkdir(join(agentRoot, 'var', 'state'), { recursive: true })
      },
    },
    {
      name: 'tools/bin as a file',
      layout: async (agentRoot) => {
        await mkdir(join(agentRoot, 'tools'), { recursive: true })
        await writeFile(join(agentRoot, 'tools', 'bin'), '')
      },
    },
  ]

  for (const { name, layout } of undetected) {
    test(`returns undefined when the agent root has ${name}`, async () => {
      const agentRoot = await createTempDir('smokey-agent-local-')
      await layout(agentRoot)

      await expect(detectAgentLocalComponents(agentRoot)).resolves.toBeUndefined()
    })
  }

  test('detectAgentLocalComponents has the signature run() expects', async () => {
    // Structural gate: run() in run.ts threads the detector's return value
    // into materializeFromRefs as `agentLocalComponents`. That call site
    // requires a Promise<{ hasSkills, hasCommands, ... } | undefined>.
    const agentRoot = await createTempDir('agent-local-signature-')
    await mkdir(join(agentRoot, 'skills'), { recursive: true })

    const components = await detectAgentLocalComponents(agentRoot)
    expect(components).toBeDefined()
    expect(components?.agentRoot).toBe(agentRoot)
    expect(typeof components?.hasSkills).toBe('boolean')
    expect(typeof components?.hasCommands).toBe('boolean')
    expect(typeof components?.hasTools).toBe('boolean')
    expect(typeof components?.skillsDir).toBe('string')
    expect(typeof components?.commandsDir).toBe('string')
    expect(typeof components?.toolsDir).toBe('string')
    expect(typeof components?.toolsBinDir).toBe('string')
    expect(typeof components?.agentVarDir).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Agent-profile integration for asp run (T-00995)
//
// `asp run` merges agent-profile.toml defaults into run options:
// resolveAgentRunDefaults loads <agentsRoot>/<target>/agent-profile.toml and
// returns merged yolo, model, claude/codex options and compose.
// See ASP_RUN_GAPS.md for the specification of each gap.
// ---------------------------------------------------------------------------

/** Write <agentsDir>/<agentName>/agent-profile.toml and return agentsDir. */
async function agentsDirWithProfile(
  prefix: string,
  agentName: string,
  toml: string
): Promise<string> {
  const agentsDir = await createTempDir(prefix)
  const agentDir = join(agentsDir, agentName)
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'agent-profile.toml'), toml)
  return agentsDir
}

const CODEX_HARNESS_PROFILE = `
version = 4

[identity]
display = "Larry"
role = "implementer"

[provisioning]
harness = "codex"
`

describe('agent-profile integration (asp run gaps)', () => {
  // Gap 1: when target and CLI both omit yolo, read profile provisioning.yolo.
  // Regression: animan lost yolo=true after Phase 5 migration.
  test('gap 1: yolo falls back to profile provisioning.yolo when target/CLI omit it', async () => {
    const agentsDir = await agentsDirWithProfile(
      'smokey-agents-yolo-',
      'animan',
      `
version = 4

[provisioning]
yolo = true
`
    )

    const defaults = resolveAgentRunDefaults(
      'animan',
      { compose: [DEFAULTS_SPACE] },
      { agentsRoot: agentsDir }
    )
    expect(defaults).toBeDefined()
    expect(defaults?.yolo).toBe(true)
  })

  // Gap 2: precedence is CLI --model > target-level model > profile
  // provisioning.model; with no CLI or target model the profile applies.
  test('gap 2: model falls back to profile provisioning.model when CLI/target omit it', async () => {
    const agentsDir = await agentsDirWithProfile(
      'smokey-agents-model-',
      'larry',
      `
version = 4

[provisioning]
model = "claude-opus-4-6"
`
    )

    const defaults = resolveAgentRunDefaults(
      'larry',
      { compose: [DEFAULTS_SPACE] },
      { agentsRoot: agentsDir }
    )
    expect(defaults).toBeDefined()
    expect(defaults?.model).toBe('claude-opus-4-6')
  })

  test('gap 2: target-level model overrides profile provisioning.model', async () => {
    const agentsDir = await agentsDirWithProfile(
      'smokey-agents-model-prec-',
      'larry',
      `
version = 4

[provisioning]
model = "claude-opus-4-6"
`
    )

    const defaults = resolveAgentRunDefaults(
      'larry',
      { compose: [DEFAULTS_SPACE], provisioning: { model: 'gpt-5.3-codex' } },
      { agentsRoot: agentsDir }
    )
    expect(defaults).toBeDefined()
    // Target codex.model should win over provisioning.model
    expect(defaults?.model).toBe('gpt-5.3-codex')
  })

  // Gap 3: profile provisioning.<harness> provides defaults; the target
  // overrides individual fields (field-level merge).
  test('gap 3: codex defaults from profile merge under target overrides', async () => {
    const agentsDir = await agentsDirWithProfile(
      'smokey-agents-codex-',
      'animata',
      `
version = 4

[provisioning]
model = "gpt-5.3-codex"

[provisioning.codex]
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
`
    )

    // Target overrides only model — other codex defaults should come from profile
    const defaults = resolveAgentRunDefaults(
      'animata',
      { compose: [DEFAULTS_SPACE], provisioning: { model: 'gpt-5.5-codex' } },
      { agentsRoot: agentsDir }
    )
    expect(defaults).toBeDefined()
    expect(defaults?.codex).toBeDefined()
    // Target model wins
    expect(defaults?.model).toBe('gpt-5.5-codex')
    // Profile defaults fill in the rest
    expect(defaults?.codex?.model_reasoning_effort).toBe('medium')
    expect(defaults?.codex?.approval_policy).toBe('on-failure')
    expect(defaults?.codex?.sandbox_mode).toBe('workspace-write')
  })

  test('gap 3: claude defaults from profile merge under target overrides', async () => {
    const agentsDir = await agentsDirWithProfile(
      'smokey-agents-claude-',
      'smokey',
      `
version = 4

[provisioning]
model = "claude-sonnet-4-6"

[provisioning.claude]
permission_mode = "plan"
`
    )

    // Target overrides permission_mode only
    const defaults = resolveAgentRunDefaults(
      'smokey',
      {
        compose: [DEFAULTS_SPACE],
        provisioning: { claude: { permission_mode: 'bypassPermissions' } },
      },
      { agentsRoot: agentsDir }
    )
    expect(defaults).toBeDefined()
    expect(defaults?.claude).toBeDefined()
    // Target override wins
    expect(defaults?.claude?.permission_mode).toBe('bypassPermissions')
    // Profile default fills in
    expect(defaults?.model).toBe('claude-sonnet-4-6')
  })

  // Gap 5: compose_mode = "merge" combines (deduplicated) agent profile
  // spaces with the project compose.
  test('gap 5: compose_mode merge combines agent profile spaces with project compose', async () => {
    const agentsDir = await agentsDirWithProfile(
      'smokey-agents-compose-',
      'smokey',
      `
version = 4

[spaces]
base = ["space:smokey@dev"]
`
    )

    const target: TargetDefinition = {
      compose: [DEFAULTS_SPACE, 'space:project@dev' as SpaceRefString],
      compose_mode: 'merge',
    }

    // resolveEffectiveCompose itself merges correctly...
    const profile: AgentRuntimeProfile = {
      version: 4,
      spaces: { base: ['space:smokey@dev' as SpaceRefString] },
    }
    const merged = resolveEffectiveCompose(profile, target, 'task')
    expect(merged).toContain('space:smokey@dev' as SpaceRefString)
    expect(merged).toContain(DEFAULTS_SPACE)
    expect(merged).toContain('space:project@dev' as SpaceRefString)

    // ...and resolveAgentRunDefaults returns that merged compose.
    const defaults = resolveAgentRunDefaults('smokey', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults?.compose).toBeDefined()
    expect(defaults?.compose).toContain('space:smokey@dev' as SpaceRefString)
    expect(defaults?.compose).toContain(DEFAULTS_SPACE)
    expect(defaults?.compose).toContain('space:project@dev' as SpaceRefString)
  })

  // Harness selection reaches the compiler; execution defaults retain only
  // launch/materialization data, whatever the profile or target declares.
  // CLI --harness precedence lives at the run() call site, not here.
  const harnessCases: Array<{
    name: string
    agentName: string
    profile: string
    target: TargetDefinition
  }> = [
    {
      name: 'agent-profile harness declarations are not a driver default or fallback',
      agentName: 'larry',
      profile: CODEX_HARNESS_PROFILE,
      target: { compose: [DEFAULTS_SPACE] },
    },
    {
      name: 'target provisioning does not restore harness selection to profile defaults',
      agentName: 'larry',
      profile: CODEX_HARNESS_PROFILE,
      target: { compose: [DEFAULTS_SPACE], provisioning: { harness: 'claude' } },
    },
    {
      name: 'gap 6c: no harness when neither target nor profile set one',
      agentName: 'smokey',
      profile: `
version = 4

[identity]
display = "Smokey"
role = "tester"
`,
      target: { compose: [DEFAULTS_SPACE] },
    },
  ]

  for (const { name, agentName, profile, target } of harnessCases) {
    test(name, async () => {
      const agentsDir = await agentsDirWithProfile('smokey-agents-harness-', agentName, profile)

      const defaults = resolveAgentRunDefaults(agentName, target, { agentsRoot: agentsDir })
      expect(defaults).toBeDefined()
      expect(defaults).not.toHaveProperty('harness')
    })
  }

  test('returns undefined when no agent profile exists for target', async () => {
    const agentsDir = await createTempDir('smokey-agents-empty-')

    const defaults = resolveAgentRunDefaults(
      'clod',
      { compose: [DEFAULTS_SPACE] },
      { agentsRoot: agentsDir }
    )
    expect(defaults).toBeUndefined()
  })
})
