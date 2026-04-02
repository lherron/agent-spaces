/**
 * RED tests: agent-project merge utilities (T-00992)
 *
 * WHY: When asp agent runs, agent-profile.toml defaults must merge with optional
 * project-level asp-targets.toml overrides. This merge covers compose (replace/merge),
 * priming prompt (replace/append), harness options (field-level), and priming_prompt_file
 * resolution from the agent root directory.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. mergeAgentWithProjectTarget exists and is importable from agent-project-merge.ts
 * 2. Agent-only (no project target) → agent defaults pass through
 * 3. compose_mode = 'replace' (default) → project compose replaces agent spaces
 * 4. compose_mode = 'merge' → project compose appended to agent spaces, deduplicated
 * 5. priming_prompt on project → replaces agent default
 * 6. priming_prompt_append on project → appended to agent default with newline
 * 7. Both priming_prompt + priming_prompt_append on project → ConfigValidationError
 * 8. Claude/codex options merge field-level (project overrides agent)
 * 9. yolo override from project target
 * 10. resolveAgentPrimingPrompt reads priming_prompt_file from agent root
 * 11. model cascading: project target > agent harnessDefaults
 *
 * wrkq task: T-00992
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigValidationError } from '../../errors.js'
import type { AgentRuntimeProfile } from '../../types/agent-profile.js'
import type { SpaceRefString } from '../../types/refs.js'
import type { TargetDefinition } from '../../types/targets.js'

// These imports will fail until the module is created — that's the RED gate.
import {
  mergeAgentWithProjectTarget,
  mergePrimingPrompt,
  resolveAgentPrimingPrompt,
} from '../agent-project-merge.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<AgentRuntimeProfile> = {}): AgentRuntimeProfile {
  return {
    schemaVersion: 2,
    identity: { display: 'TestAgent', role: 'coder', harness: 'codex' },
    priming_prompt: 'You are TestAgent.',
    spaces: {
      base: ['space:defaults@dev' as SpaceRefString],
    },
    harnessDefaults: {
      model: 'claude-opus-4-6',
      yolo: false,
      claude: { permission_mode: 'default' },
      codex: { model_reasoning_effort: 'high' },
    },
    ...overrides,
  } as AgentRuntimeProfile
}

function makeTarget(overrides: Partial<TargetDefinition> = {}): TargetDefinition {
  return {
    compose: ['space:project-space@dev' as SpaceRefString],
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Agent-only (no project target)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: agent-only', () => {
  test('no project target → agent defaults pass through', () => {
    const profile = makeProfile()
    const result = mergeAgentWithProjectTarget(profile, undefined, 'query')
    expect(result.priming_prompt).toBe('You are TestAgent.')
    expect(result.compose).toEqual(['space:defaults@dev'])
    expect(result.harness).toBe('codex')
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.yolo).toBe(false)
  })

  test('agent with byMode spaces included for matching mode', () => {
    const profile = makeProfile({
      spaces: {
        base: ['space:defaults@dev' as SpaceRefString],
        byMode: {
          heartbeat: ['space:heartbeat-extra@dev' as SpaceRefString],
        },
      },
    })
    const result = mergeAgentWithProjectTarget(profile, undefined, 'heartbeat')
    expect(result.compose).toContain('space:defaults@dev')
    expect(result.compose).toContain('space:heartbeat-extra@dev')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Compose mode: replace (default)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: compose replace', () => {
  test('compose_mode = replace → project replaces agent spaces entirely', () => {
    const profile = makeProfile()
    const target = makeTarget({
      compose_mode: 'replace',
      compose: ['space:project-only@dev' as SpaceRefString],
    })
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.compose).toEqual(['space:project-only@dev'])
  })

  test('compose_mode defaults to replace when not set', () => {
    const profile = makeProfile()
    const target = makeTarget({
      compose: ['space:project-only@dev' as SpaceRefString],
    })
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.compose).toEqual(['space:project-only@dev'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Compose mode: merge
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: compose merge', () => {
  test('compose_mode = merge → agent + project, deduplicated', () => {
    const profile = makeProfile({
      spaces: {
        base: ['space:a@dev' as SpaceRefString, 'space:b@dev' as SpaceRefString],
      },
    })
    const target = makeTarget({
      compose_mode: 'merge',
      compose: ['space:b@dev' as SpaceRefString, 'space:c@dev' as SpaceRefString],
    })
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    // a, b from agent; b deduplicated; c from project
    expect(result.compose).toEqual(['space:a@dev', 'space:b@dev', 'space:c@dev'])
  })

  test('compose_mode = merge includes byMode spaces', () => {
    const profile = makeProfile({
      spaces: {
        base: ['space:a@dev' as SpaceRefString],
        byMode: {
          heartbeat: ['space:hb@dev' as SpaceRefString],
        },
      },
    })
    const target = makeTarget({
      compose_mode: 'merge',
      compose: ['space:extra@dev' as SpaceRefString],
    })
    const result = mergeAgentWithProjectTarget(profile, target, 'heartbeat')
    expect(result.compose).toContain('space:a@dev')
    expect(result.compose).toContain('space:hb@dev')
    expect(result.compose).toContain('space:extra@dev')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Priming prompt merge
// ─────────────────────────────────────────────────────────────────────────────

describe('mergePrimingPrompt', () => {
  test('no project target → agent default', () => {
    const result = mergePrimingPrompt('Agent prompt.', undefined)
    expect(result).toBe('Agent prompt.')
  })

  test('project priming_prompt → replaces agent default', () => {
    const result = mergePrimingPrompt('Agent prompt.', {
      priming_prompt: 'Project prompt.',
    })
    expect(result).toBe('Project prompt.')
  })

  test('project priming_prompt_append → appended to agent default', () => {
    const result = mergePrimingPrompt('Agent prompt.', {
      priming_prompt_append: '## Extra context',
    })
    expect(result).toBe('Agent prompt.\n## Extra context')
  })

  test('priming_prompt_append with no agent default → agent default unchanged', () => {
    const result = mergePrimingPrompt(undefined, {
      priming_prompt_append: '## Extra context',
    })
    expect(result).toBeUndefined()
  })

  test('both priming_prompt + priming_prompt_append → ConfigValidationError', () => {
    expect(() =>
      mergePrimingPrompt('Agent prompt.', {
        priming_prompt: 'Replace.',
        priming_prompt_append: 'Append.',
      })
    ).toThrow(ConfigValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Harness option merge (field-level)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: harness option merge', () => {
  test('project claude options override agent claude defaults', () => {
    const profile = makeProfile({
      harnessDefaults: {
        claude: { permission_mode: 'default', args: ['--verbose'] },
      },
    })
    const target = makeTarget({
      claude: { permission_mode: 'auto-accept' },
    })
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.claude.permission_mode).toBe('auto-accept')
    // args inherited from agent since project didn't override
    expect(result.claude.args).toEqual(['--verbose'])
  })

  test('project codex options override agent codex defaults', () => {
    const profile = makeProfile({
      harnessDefaults: {
        codex: { model_reasoning_effort: 'high', approval_policy: 'on-request' },
      },
    })
    const target = makeTarget({
      codex: { model_reasoning_effort: 'low' },
    })
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.codex.model_reasoning_effort).toBe('low')
    // approval_policy inherited from agent
    expect(result.codex.approval_policy).toBe('on-request')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. yolo and model override
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: yolo and model', () => {
  test('project yolo overrides agent default', () => {
    const profile = makeProfile({
      harnessDefaults: { yolo: false },
    })
    const target = makeTarget({ yolo: true })
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.yolo).toBe(true)
  })

  test('agent yolo used when project does not set it', () => {
    const profile = makeProfile({
      harnessDefaults: { yolo: true },
    })
    const target = makeTarget({})
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.yolo).toBe(true)
  })

  test('model from agent harnessDefaults when project has none', () => {
    const profile = makeProfile({
      harnessDefaults: { model: 'claude-opus-4-6' },
    })
    const target = makeTarget({})
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.model).toBe('claude-opus-4-6')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Target-level harness precedence (T-00996)
//
// RED GATE: TargetDefinition does not yet have a `harness` field.
// mergeAgentWithProjectTarget must prefer target.harness over profile.identity.harness.
//
// Pass conditions:
// 1. TargetDefinition gains `harness?: string`
// 2. mergeAgentWithProjectTarget uses: target.harness ?? profile.identity.harness ?? 'claude-code'
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentWithProjectTarget: target-level harness (T-00996)', () => {
  test('target.harness overrides profile identity.harness', () => {
    const profile = makeProfile({
      identity: { display: 'Larry', role: 'implementer', harness: 'codex' },
    })
    const target = makeTarget({
      harness: 'claude-code',
    } as Partial<TargetDefinition>) // cast: harness not on TargetDefinition yet
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.harness).toBe('claude-code')
  })

  test('profile identity.harness used when target has no harness', () => {
    const profile = makeProfile({
      identity: { display: 'Larry', role: 'implementer', harness: 'codex' },
    })
    const target = makeTarget({}) // no harness field
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.harness).toBe('codex')
  })

  test('defaults to claude-code when neither target nor profile set harness', () => {
    const profile = makeProfile({
      identity: { display: 'Smokey', role: 'tester' },
    })
    const target = makeTarget({})
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.harness).toBe('claude-code')
  })

  test('target.harness = "agent-sdk" overrides profile harness = "claude-code"', () => {
    const profile = makeProfile({
      identity: { display: 'Animata', role: 'coordinator', harness: 'claude-code' },
    })
    const target = makeTarget({
      harness: 'agent-sdk',
    } as Partial<TargetDefinition>)
    const result = mergeAgentWithProjectTarget(profile, target, 'query')
    expect(result.harness).toBe('agent-sdk')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. priming_prompt_file resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAgentPrimingPrompt', () => {
  let agentRoot: string

  beforeEach(async () => {
    agentRoot = await mkdtemp(join(tmpdir(), 'agent-root-'))
  })

  afterEach(async () => {
    await rm(agentRoot, { recursive: true, force: true })
  })

  test('returns priming_prompt when set directly', () => {
    const profile = makeProfile({ priming_prompt: 'Direct prompt.' })
    const result = resolveAgentPrimingPrompt(profile, agentRoot)
    expect(result).toBe('Direct prompt.')
  })

  test('reads priming_prompt_file from agent root', async () => {
    await writeFile(join(agentRoot, 'PRIMING.md'), '# Agent Priming\nYou are a test agent.')
    const profile = makeProfile({
      priming_prompt: undefined,
      priming_prompt_file: 'PRIMING.md',
    } as Partial<AgentRuntimeProfile>)
    const result = resolveAgentPrimingPrompt(profile, agentRoot)
    expect(result).toContain('# Agent Priming')
    expect(result).toContain('You are a test agent.')
  })

  test('returns undefined when neither priming_prompt nor priming_prompt_file set', () => {
    const profile = makeProfile({
      priming_prompt: undefined,
    } as Partial<AgentRuntimeProfile>)
    const result = resolveAgentPrimingPrompt(profile, agentRoot)
    expect(result).toBeUndefined()
  })
})
