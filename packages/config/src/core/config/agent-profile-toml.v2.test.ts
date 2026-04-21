/**
 * RED tests: agent-profile.toml v2 parser — identity, priming prompt, extended harness (T-00992)
 *
 * WHY: Agent-level defaults require schemaVersion 2 support in agent-profile.toml.
 * New sections: [identity], priming_prompt, priming_prompt_file, [harnessDefaults.claude],
 * [harnessDefaults.codex], harnessDefaults.yolo, and extended harnessByMode with sub-tables.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. parseAgentProfile accepts schemaVersion = 2
 * 2. [identity] section parsed with display, role, harness fields
 * 3. priming_prompt parsed as top-level string
 * 4. priming_prompt_file parsed as top-level string
 * 5. Both priming_prompt + priming_prompt_file simultaneously → ConfigValidationError
 * 6. harnessDefaults.yolo parsed as boolean
 * 7. harnessDefaults.claude parsed as ClaudeOptions sub-table
 * 8. harnessDefaults.codex parsed as CodexOptions sub-table
 * 9. harnessByMode.<mode>.claude and .codex parsed as sub-tables
 * 10. schemaVersion 1 profiles continue to parse unchanged (backward compat)
 * 11. AgentRuntimeProfile type has schemaVersion: 1 | 2 and new optional fields
 *
 * wrkq task: T-00992
 */

import { describe, expect, test } from 'bun:test'
import { ConfigValidationError } from '../errors.js'
import { parseAgentProfile } from './agent-profile-toml.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. schemaVersion 2 acceptance
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: schemaVersion 2', () => {
  test('accepts schemaVersion = 2', () => {
    const toml = `
schemaVersion = 2
`
    const result = parseAgentProfile(toml)
    expect(result.schemaVersion).toBe(2)
  })

  test('schemaVersion 1 still parses (backward compat)', () => {
    const toml = `
schemaVersion = 1
`
    const result = parseAgentProfile(toml)
    expect(result.schemaVersion).toBe(1)
  })

  test('rejects schemaVersion = 3', () => {
    const toml = `
schemaVersion = 3
`
    expect(() => parseAgentProfile(toml)).toThrow(ConfigValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. [identity] section
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: identity section', () => {
  test('parses identity with display, role, harness', () => {
    const toml = `
schemaVersion = 2

[identity]
display = "Larry"
role = "coder"
harness = "codex"
`
    const result = parseAgentProfile(toml)
    expect(result.identity).toEqual({
      display: 'Larry',
      role: 'coder',
      harness: 'codex',
    })
  })

  test('parses identity with only display', () => {
    const toml = `
schemaVersion = 2

[identity]
display = "Smokey"
`
    const result = parseAgentProfile(toml)
    expect(result.identity?.display).toBe('Smokey')
    expect(result.identity?.role).toBeUndefined()
    expect(result.identity?.harness).toBeUndefined()
  })

  test('rejects unknown keys in identity', () => {
    const toml = `
schemaVersion = 2

[identity]
display = "Larry"
favorite_color = "blue"
`
    expect(() => parseAgentProfile(toml)).toThrow(ConfigValidationError)
  })

  test('rejects non-string identity values', () => {
    const toml = `
schemaVersion = 2

[identity]
display = 42
`
    expect(() => parseAgentProfile(toml)).toThrow(ConfigValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2b. [session] section for reminder customization
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: session section (T-01045)', () => {
  test('parses session.additionalContext and session.additionalExec', () => {
    const toml = `
schemaVersion = 2

[session]
additionalContext = ["banner.md", "project-root:///README.md"]
additionalExec = ["printf 'task context'", "printf 'queue context'"]
`
    const result = parseAgentProfile(toml)
    expect(result.session).toEqual({
      additionalContext: ['banner.md', 'project-root:///README.md'],
      additionalExec: ["printf 'task context'", "printf 'queue context'"],
    })
  })

  test('rejects unknown keys in session', () => {
    const toml = `
schemaVersion = 2

[session]
additionalContext = ["banner.md"]
unexpected = "nope"
`
    expect(() => parseAgentProfile(toml)).toThrow(ConfigValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. priming_prompt and priming_prompt_file
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: priming prompt fields', () => {
  test('parses priming_prompt as string', () => {
    const toml = `
schemaVersion = 2

priming_prompt = "You are Larry, a coding agent."
`
    const result = parseAgentProfile(toml)
    expect(result.priming_prompt).toBe('You are Larry, a coding agent.')
  })

  test('parses multiline priming_prompt', () => {
    const toml = `
schemaVersion = 2

priming_prompt = """
You are Larry.

## Startup
1. Run agentchat info.
2. Wait for requests.
"""
`
    const result = parseAgentProfile(toml)
    expect(result.priming_prompt).toContain('You are Larry.')
    expect(result.priming_prompt).toContain('## Startup')
  })

  test('parses priming_prompt_file as string', () => {
    const toml = `
schemaVersion = 2

priming_prompt_file = "PRIMING.md"
`
    const result = parseAgentProfile(toml)
    expect(result.priming_prompt_file).toBe('PRIMING.md')
  })

  test('rejects both priming_prompt and priming_prompt_file', () => {
    const toml = `
schemaVersion = 2

priming_prompt = "inline prompt"
priming_prompt_file = "PRIMING.md"
`
    expect(() => parseAgentProfile(toml)).toThrow(ConfigValidationError)
  })

  test('neither priming_prompt nor priming_prompt_file is fine', () => {
    const toml = `
schemaVersion = 2
`
    const result = parseAgentProfile(toml)
    expect(result.priming_prompt).toBeUndefined()
    expect(result.priming_prompt_file).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. harnessDefaults extended fields
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: extended harnessDefaults', () => {
  test('parses harnessDefaults.yolo as boolean', () => {
    const toml = `
schemaVersion = 2

[harnessDefaults]
model = "claude-opus-4-6"
yolo = true
`
    const result = parseAgentProfile(toml)
    expect(result.harnessDefaults?.yolo).toBe(true)
  })

  test('parses harnessDefaults.remote_control as boolean', () => {
    const toml = `
schemaVersion = 2

[harnessDefaults]
model = "claude-opus-4-6"
remote_control = true
`
    const result = parseAgentProfile(toml)
    expect(result.harnessDefaults?.remote_control).toBe(true)
  })

  test('parses harnessDefaults.claude sub-table', () => {
    const toml = `
schemaVersion = 2

[harnessDefaults]
model = "claude-opus-4-6"

[harnessDefaults.claude]
permission_mode = "default"
args = ["--verbose"]
`
    const result = parseAgentProfile(toml)
    expect(result.harnessDefaults?.claude).toEqual({
      permission_mode: 'default',
      args: ['--verbose'],
    })
  })

  test('parses harnessDefaults.codex sub-table', () => {
    const toml = `
schemaVersion = 2

[harnessDefaults]
model = "claude-opus-4-6"

[harnessDefaults.codex]
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
status_line = ["model", "context-remaining", "git-branch"]
`
    const result = parseAgentProfile(toml)
    expect(result.harnessDefaults?.codex).toEqual({
      model_reasoning_effort: 'high',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      status_line: ['model', 'context-remaining', 'git-branch'],
    })
  })

  test('parses harnessDefaults with model, yolo, claude, and codex together', () => {
    const toml = `
schemaVersion = 2

[harnessDefaults]
model = "claude-opus-4-6"
yolo = false

[harnessDefaults.claude]
permission_mode = "default"

[harnessDefaults.codex]
model_reasoning_effort = "high"
`
    const result = parseAgentProfile(toml)
    expect(result.harnessDefaults?.model).toBe('claude-opus-4-6')
    expect(result.harnessDefaults?.yolo).toBe(false)
    expect(result.harnessDefaults?.claude?.permission_mode).toBe('default')
    expect(result.harnessDefaults?.codex?.model_reasoning_effort).toBe('high')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. harnessByMode with extended sub-tables
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: extended harnessByMode', () => {
  test('parses harnessByMode.<mode>.claude sub-table', () => {
    const toml = `
schemaVersion = 2

[harnessByMode.heartbeat]
model = "claude-haiku-4-5"

[harnessByMode.heartbeat.claude]
permission_mode = "auto-accept"
`
    const result = parseAgentProfile(toml)
    const heartbeat = result.harnessByMode?.heartbeat
    expect(heartbeat?.model).toBe('claude-haiku-4-5')
    expect(heartbeat?.claude?.permission_mode).toBe('auto-accept')
  })

  test('parses harnessByMode.<mode>.codex sub-table', () => {
    const toml = `
schemaVersion = 2

[harnessByMode.heartbeat]
model = "claude-haiku-4-5"

[harnessByMode.heartbeat.codex]
approval_policy = "never"
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]
`
    const result = parseAgentProfile(toml)
    expect(result.harnessByMode?.heartbeat?.codex?.approval_policy).toBe('never')
    expect(result.harnessByMode?.heartbeat?.codex?.status_line).toEqual([
      'model-with-reasoning',
      'context-remaining',
      'current-dir',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Full v2 profile
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentProfile: full v2 profile', () => {
  test('parses complete v2 profile with all new fields', () => {
    const toml = `
schemaVersion = 2

priming_prompt = "You are Larry, a coding agent."

[identity]
display = "Larry"
role = "coder"
harness = "codex"

[spaces]
base = ["space:defaults@dev"]

[instructions]
additionalBase = ["agent-root:///SOUL.md"]

[harnessDefaults]
model = "claude-opus-4-6"
yolo = false

[harnessDefaults.claude]
permission_mode = "default"

[harnessDefaults.codex]
model_reasoning_effort = "high"
approval_policy = "on-request"

[harnessByMode.heartbeat]
model = "claude-haiku-4-5"

[harnessByMode.heartbeat.codex]
approval_policy = "never"

[targets.review]
compose = ["space:agent-private-ops@dev"]
`
    const result = parseAgentProfile(toml)
    expect(result.schemaVersion).toBe(2)
    expect(result.identity?.display).toBe('Larry')
    expect(result.identity?.role).toBe('coder')
    expect(result.identity?.harness).toBe('codex')
    expect(result.priming_prompt).toBe('You are Larry, a coding agent.')
    expect(result.spaces?.base).toEqual(['space:defaults@dev'])
    expect(result.harnessDefaults?.model).toBe('claude-opus-4-6')
    expect(result.harnessDefaults?.yolo).toBe(false)
    expect(result.harnessDefaults?.claude?.permission_mode).toBe('default')
    expect(result.harnessDefaults?.codex?.model_reasoning_effort).toBe('high')
    expect(result.harnessByMode?.heartbeat?.model).toBe('claude-haiku-4-5')
    expect(result.harnessByMode?.heartbeat?.codex?.approval_policy).toBe('never')
    expect(result.targets?.review?.compose).toEqual(['space:agent-private-ops@dev'])
  })

  test('v1 profile with existing fields still works unchanged', () => {
    const toml = `
schemaVersion = 1

[spaces]
base = ["space:defaults@dev"]

[harnessDefaults]
model = "claude-opus-4-6"

[harnessByMode.heartbeat]
model = "claude-haiku-4-5"
`
    const result = parseAgentProfile(toml)
    expect(result.schemaVersion).toBe(1)
    expect(result.spaces?.base).toEqual(['space:defaults@dev'])
    expect(result.harnessDefaults?.model).toBe('claude-opus-4-6')
    // v1 should NOT have identity/priming fields
    expect(result.identity).toBeUndefined()
    expect(result.priming_prompt).toBeUndefined()
  })
})
