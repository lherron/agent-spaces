/**
 * Agent-project merge (T-00992), driven through resolvePlacementContext.
 *
 * WHY: When asp agent runs, agent-profile.toml defaults merge with the optional
 * project-level asp-targets.toml target of the same name. These tests write
 * both files to disk and assert the effective config placement resolution
 * hands downstream: compose (replace/merge, byMode), priming (replace/append/
 * priming_file), provisioning scalars (target over agent, presence kept),
 * and field-level claude/codex option merge.
 *
 * toSelectionLayers stays a direct unit test: its consumer is the compiler's
 * harness-selection provenance, which has no surface test here yet.
 *
 * wrkq task: T-00992
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVISIONING_SCALAR_KINDS } from 'agent-scope'

import { resolvePlacementContext } from '../../../resolver/placement-resolver.js'
import { ConfigValidationError } from '../../errors.js'
import type { RunMode } from '../../types/agent-profile.js'
import { toSelectionLayers } from '../agent-project-merge.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_NAME = 'smokey'
const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Write agent-profile.toml (and asp-targets.toml when given) to a temp agent
 * root / project root and return the effective config placement resolves.
 */
async function resolveEffectiveConfig(options: {
  profile: string
  targets?: string
  runMode?: RunMode
  agentFiles?: Record<string, string>
}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-project-merge-'))
  tempRoots.push(root)
  const agentRoot = join(root, 'agent-root')
  const projectRoot = join(root, 'project-root')
  await mkdir(agentRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(agentRoot, 'SOUL.md'), '# Test Agent\n')
  await writeFile(join(agentRoot, 'agent-profile.toml'), options.profile)
  for (const [name, content] of Object.entries(options.agentFiles ?? {})) {
    await writeFile(join(agentRoot, name), content)
  }
  if (options.targets !== undefined) {
    await writeFile(join(projectRoot, 'asp-targets.toml'), options.targets)
  }

  const context = await resolvePlacementContext({
    agentRoot,
    projectRoot,
    runMode: options.runMode ?? 'query',
    bundle: { kind: 'agent-project', agentName: AGENT_NAME, projectRoot },
  })
  const effective = context.materialization.effectiveConfig
  if (effective === undefined) {
    throw new Error('agent-project placement returned no effectiveConfig')
  }
  return effective
}

type ScalarRecord = Record<string, string | boolean>

/** One value per declared provisioning scalar, so new scalars join the table automatically. */
function scalarValues(prefix: string, booleanValue: boolean, harness: string): ScalarRecord {
  return Object.fromEntries(
    Object.entries(PROVISIONING_SCALAR_KINDS).map(([key, kind]) => [
      key,
      key === 'harness' ? harness : kind === 'boolean' ? booleanValue : `${prefix}-${key}`,
    ])
  )
}

function tomlScalars(values: ScalarRecord): string {
  return Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Characterization
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: v4 projection characterization', () => {
  test('full named-field result and override precedence stay byte-identical', async () => {
    const result = await resolveEffectiveConfig({
      profile: `
version = 4
priming = "Agent priming."

[spaces]
base = ["space:agent@dev"]

[provisioning]
harness = "claude"
model_provider = "anthropic"
model = "agent-model"
reasoning_effort = "low"
sandbox = "read-only"
approval = "on-request"

[provisioning.claude]
model = "agent-claude-model"
permission_mode = "agent-permission"
args = ["--agent"]

[provisioning.codex]
model = "agent-codex-model"
model_reasoning_effort = "low"
model_reasoning_summary = "concise"
status_line = ["agent-status"]
approval_policy = "untrusted"
sandbox_mode = "read-only"
`,
      targets: `
schema = 2

[targets.smokey]
description = "Project description."
priming = "Project priming."
compose = ["space:project@dev"]

[targets.smokey.provisioning]
harness = "codex"
model_provider = "openai-codex"
model = "target-model"
reasoning_effort = "high"
presentation = false
sandbox = "danger-full-access"
approval = "never"

[targets.smokey.provisioning.claude]
model = "target-claude-model"
permission_mode = "target-permission"
args = ["--target"]

[targets.smokey.provisioning.codex]
model = "target-codex-model"
model_reasoning_effort = "medium"
model_reasoning_summary = "detailed"
status_line = ["target-status"]
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
`,
    })
    const { provisioning: _provisioning, ...projection } = result

    // No compose_mode on the target: the default is replace, so agent base spaces drop out.
    expect(JSON.stringify(projection)).toBe(
      '{"priming":"Project priming.","compose":["space:project@dev"],"yolo":false,"remoteControl":false,"harness":"codex","model_provider":"openai-codex","model":"target-model","reasoning_effort":"high","presentation":false,"sandbox":"danger-full-access","approval":"never","claude":{"model":"target-claude-model","permission_mode":"target-permission","args":["--target"]},"codex":{"model":"target-codex-model","model_reasoning_effort":"high","model_reasoning_summary":"detailed","status_line":["target-status"],"approval_policy":"never","sandbox_mode":"danger-full-access"},"description":"Project description."}'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning scalars
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: structural provisioning scalars', () => {
  test('omitted presentation stays absent; explicit false is preserved by presence', async () => {
    const explicitFalse = await resolveEffectiveConfig({
      profile: 'version = 4\n\n[provisioning]\nharness = "codex"\npresentation = false\n',
    })
    const omitted = await resolveEffectiveConfig({
      profile: 'version = 4\n\n[provisioning]\nharness = "codex"\n',
    })

    expect(explicitFalse.presentation).toBe(false)
    expect(Object.hasOwn(explicitFalse, 'presentation')).toBe(true)
    expect(explicitFalse.provisioning.presentation).toBe(false)
    expect(Object.hasOwn(explicitFalse.provisioning, 'presentation')).toBe(true)
    expect(Object.hasOwn(omitted, 'presentation')).toBe(false)
    expect(Object.hasOwn(omitted.provisioning, 'presentation')).toBe(false)
    expect(omitted.provisioning).toEqual({ harness: 'codex', yolo: false, remote: false })
  })

  const agentWithFalsePresentation = {
    ...scalarValues('agent', true, 'codex'),
    presentation: false,
  }

  test.each<{
    name: string
    agent: ScalarRecord
    target: ScalarRecord
    expected: ScalarRecord
    remoteControl: boolean
  }>([
    {
      name: 'target sets every scalar, so every target value wins',
      agent: scalarValues('agent', true, 'claude'),
      target: scalarValues('target', false, 'codex'),
      expected: scalarValues('target', false, 'codex'),
      remoteControl: false,
    },
    {
      name: 'target sets only model, so every other agent value (harness, remote=true, presentation=false) carries through',
      agent: agentWithFalsePresentation,
      target: { model: 'target-model' },
      expected: { ...agentWithFalsePresentation, model: 'target-model' },
      remoteControl: true,
    },
  ])(
    'every provisioning scalar takes the project target value when set and the agent value otherwise: $name',
    async ({ agent, target, expected, remoteControl }) => {
      const result = await resolveEffectiveConfig({
        profile: `version = 4\n\n[provisioning]\n${tomlScalars(agent)}\n`,
        targets: `schema = 2\n\n[targets.smokey]\ncompose = ["space:project@dev"]\n\n[targets.smokey.provisioning]\n${tomlScalars(target)}\n`,
      })

      expect(result.provisioning).toEqual(expected)
      expect(result.remoteControl).toBe(remoteControl)
      expect(result.harness).toBe(expected['harness'] as string)
      expect(Object.hasOwn(result.provisioning, 'presentation')).toBe(true)
    }
  )

  test.each([
    {
      name: 'agent, target and summon layers are wire-spelled; presence of false is kept; non-selection scalars are dropped',
      agent: {
        harness: 'claude',
        model_provider: 'anthropic',
        model: 'agent-model',
        reasoning_effort: 'low',
        presentation: false,
        node: 'agent-node',
        yolo: true,
      },
      target: { model: 'target-model', reasoning_effort: 'high' },
      summon: { presentation: true, model_provider: 'openai-codex' },
      expected: {
        agentProfile: {
          harness: 'claude',
          modelProvider: 'anthropic',
          model: 'agent-model',
          reasoningEffort: 'low',
          presentation: false,
        },
        projectTarget: { model: 'target-model', reasoningEffort: 'high' },
        summonDirectives: { presentation: true, modelProvider: 'openai-codex' },
      },
    },
    {
      name: 'all layers undefined -> no layers',
      agent: undefined,
      target: undefined,
      summon: undefined,
      expected: {},
    },
    {
      name: 'only non-selection scalars (node, yolo, sandbox) -> no layers',
      agent: { node: 'svc', yolo: true },
      target: { sandbox: 'workspace-write' },
      summon: undefined,
      expected: {},
    },
  ])(
    'toSelectionLayers emits wire-spelled layers with presence preserved: $name',
    ({ agent, target, summon, expected }) => {
      expect(toSelectionLayers(agent, target, summon)).toEqual(expected)
    }
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Agent-only (no project target)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: agent-only', () => {
  test('no project target → agent defaults pass through', async () => {
    const result = await resolveEffectiveConfig({
      profile: `
version = 4
priming = "You are TestAgent."

[spaces]
base = ["space:defaults@dev"]

[provisioning]
harness = "codex"
model = "claude-opus-4-6"
yolo = false
`,
    })
    expect(result.priming).toBe('You are TestAgent.')
    expect(result.compose).toEqual(['space:defaults@dev'])
    expect(result.harness).toBe('codex')
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.yolo).toBe(false)
  })

  test('agent with byMode spaces included for matching mode', async () => {
    const result = await resolveEffectiveConfig({
      profile: `
version = 4

[spaces]
base = ["space:defaults@dev"]

[spaces.modes]
heartbeat = ["space:heartbeat-extra@dev"]
`,
      runMode: 'heartbeat',
    })
    expect(result.compose).toContain('space:defaults@dev')
    expect(result.compose).toContain('space:heartbeat-extra@dev')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Compose mode: merge
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: compose merge', () => {
  test('compose_mode = merge → agent + project, deduplicated', async () => {
    const result = await resolveEffectiveConfig({
      profile: 'version = 4\n\n[spaces]\nbase = ["space:a@dev", "space:b@dev"]\n',
      targets: `
schema = 2

[targets.smokey]
compose_mode = "merge"
compose = ["space:b@dev", "space:c@dev"]
`,
    })
    // a, b from agent; b deduplicated; c from project
    expect(result.compose).toEqual(['space:a@dev', 'space:b@dev', 'space:c@dev'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Priming
// ─────────────────────────────────────────────────────────────────────────────

describe('mergePrimingPrompt', () => {
  test('priming_prompt_append with no agent default → agent default unchanged', async () => {
    const result = await resolveEffectiveConfig({
      profile: 'version = 4\n',
      targets: `
schema = 2

[targets.smokey]
compose = ["space:project@dev"]
priming_append = "## Extra context"
`,
    })
    expect(result.priming).toBeUndefined()
  })

  test('both priming_prompt + priming_prompt_append → ConfigValidationError', async () => {
    const resolution = resolveEffectiveConfig({
      profile: 'version = 4\npriming = "Agent prompt."\n',
      targets: `
schema = 2

[targets.smokey]
compose = ["space:project@dev"]
priming = "Replace."
priming_append = "Append."
`,
    })
    await expect(resolution).rejects.toBeInstanceOf(ConfigValidationError)
    await expect(resolution).rejects.toThrow(/cannot set both priming and priming_append/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Harness option merge (field-level)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: harness option merge', () => {
  test.each([
    {
      name: 'claude permission_mode overridden, args inherited',
      agentOptions: '[provisioning.claude]\npermission_mode = "default"\nargs = ["--verbose"]\n',
      targetOptions: '[targets.smokey.provisioning.claude]\npermission_mode = "auto-accept"\n',
      expected: { claude: { permission_mode: 'auto-accept', args: ['--verbose'] } },
    },
    {
      name: 'codex model_reasoning_effort overridden, approval_policy inherited',
      agentOptions:
        '[provisioning.codex]\nmodel_reasoning_effort = "high"\napproval_policy = "on-request"\n',
      targetOptions: '[targets.smokey.provisioning.codex]\nmodel_reasoning_effort = "low"\n',
      expected: { codex: { model_reasoning_effort: 'low', approval_policy: 'on-request' } },
    },
  ])(
    'project harness options override agent options field by field and inherit unset fields: $name',
    async ({ agentOptions, targetOptions, expected }) => {
      const result = await resolveEffectiveConfig({
        profile: `version = 4\n\n${agentOptions}`,
        targets: `schema = 2\n\n[targets.smokey]\ncompose = ["space:project@dev"]\n\n${targetOptions}`,
      })
      expect(result).toMatchObject(expected)
    }
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Target-level harness (T-00996, T-08701)
//
// An undeclared harness stays absent: config owns no default (the central
// compiler resolver applies the catalog default).
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: target-level harness (T-00996)', () => {
  test('harness stays absent when neither target nor profile declare it', async () => {
    const result = await resolveEffectiveConfig({
      profile: 'version = 4\n',
      targets: 'schema = 2\n\n[targets.smokey]\ncompose = ["space:project@dev"]\n',
    })
    expect(result.harness).toBeUndefined()
    expect(Object.hasOwn(result, 'harness')).toBe(false)
    expect(Object.hasOwn(result.provisioning, 'harness')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// priming / priming_file resolution from the agent root
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAgentPrimingPrompt', () => {
  test.each([
    {
      name: 'priming set -> returned verbatim',
      profile: 'version = 4\npriming = "Direct prompt."\n',
      agentFiles: {},
      expected: 'Direct prompt.',
    },
    {
      name: 'priming_file -> read from the agent root',
      profile: 'version = 4\npriming_file = "PRIMING.md"\n',
      agentFiles: { 'PRIMING.md': '# Agent Priming\nYou are a test agent.' },
      expected: '# Agent Priming\nYou are a test agent.',
    },
    {
      name: 'neither -> undefined',
      profile: 'version = 4\n',
      agentFiles: {},
      expected: undefined,
    },
  ])(
    'agent priming comes from priming, else from priming_file under the agent root, else is absent: $name',
    async ({ profile, agentFiles, expected }) => {
      const result = await resolveEffectiveConfig({ profile, agentFiles })
      expect(result.priming).toBe(expected)
    }
  )
})
