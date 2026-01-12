/**
 * Tests for hooks.toml parsing and translation
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CanonicalHookDefinition,
  filterHooksForHarness,
  generateClaudeHooksJson,
  parseHooksToml,
  readHooksToml,
  readHooksWithPrecedence,
  toClaudeHooksConfig,
  translateToClaudeEvent,
  translateToPiEvent,
  writeClaudeHooksJson,
} from './hooks-toml.js'

describe('parseHooksToml', () => {
  it('parses a valid hooks.toml with all fields', () => {
    const content = `
[[hook]]
event = "pre_tool_use"
script = "hooks/pre-tool-use.sh"
tools = ["Bash", "Write"]
blocking = true

[[hook]]
event = "post_tool_use"
script = "hooks/post-tool-use.sh"
blocking = false

[[hook]]
event = "session_end"
script = "hooks/cleanup.sh"
harness = "claude"
`

    const result = parseHooksToml(content)

    expect(result.hook).toHaveLength(3)

    expect(result.hook[0]).toEqual({
      event: 'pre_tool_use',
      script: 'hooks/pre-tool-use.sh',
      tools: ['Bash', 'Write'],
      blocking: true,
      harness: undefined,
    })

    expect(result.hook[1]).toEqual({
      event: 'post_tool_use',
      script: 'hooks/post-tool-use.sh',
      tools: undefined,
      blocking: false,
      harness: undefined,
    })

    expect(result.hook[2]).toEqual({
      event: 'session_end',
      script: 'hooks/cleanup.sh',
      tools: undefined,
      blocking: undefined,
      harness: 'claude',
    })
  })

  it('parses hooks.toml with minimal fields', () => {
    const content = `
[[hook]]
event = "pre_tool_use"
script = "validate.sh"
`

    const result = parseHooksToml(content)

    expect(result.hook).toHaveLength(1)
    expect(result.hook[0]).toEqual({
      event: 'pre_tool_use',
      script: 'validate.sh',
      tools: undefined,
      blocking: undefined,
      harness: undefined,
    })
  })

  it('returns empty array when no hooks defined', () => {
    const content = '# Empty hooks file'
    const result = parseHooksToml(content)
    expect(result.hook).toHaveLength(0)
  })
})

describe('translateToClaudeEvent', () => {
  it('translates pre_tool_use to PreToolUse', () => {
    expect(translateToClaudeEvent('pre_tool_use')).toBe('PreToolUse')
  })

  it('translates post_tool_use to PostToolUse', () => {
    expect(translateToClaudeEvent('post_tool_use')).toBe('PostToolUse')
  })

  it('translates session_end to Stop', () => {
    expect(translateToClaudeEvent('session_end')).toBe('Stop')
  })

  it('returns null for unknown events', () => {
    expect(translateToClaudeEvent('session_start')).toBeNull()
    expect(translateToClaudeEvent('unknown_event')).toBeNull()
  })
})

describe('translateToPiEvent', () => {
  it('translates pre_tool_use to tool_call', () => {
    expect(translateToPiEvent('pre_tool_use')).toBe('tool_call')
  })

  it('translates post_tool_use to tool_result', () => {
    expect(translateToPiEvent('post_tool_use')).toBe('tool_result')
  })

  it('translates session_start to session_start', () => {
    expect(translateToPiEvent('session_start')).toBe('session_start')
  })

  it('translates session_end to session_end', () => {
    expect(translateToPiEvent('session_end')).toBe('session_end')
  })

  it('returns original event for unknown events', () => {
    expect(translateToPiEvent('unknown_event')).toBe('unknown_event')
  })
})

describe('filterHooksForHarness', () => {
  const hooks: CanonicalHookDefinition[] = [
    { event: 'pre_tool_use', script: 'all.sh' },
    { event: 'post_tool_use', script: 'claude-only.sh', harness: 'claude' },
    { event: 'session_start', script: 'pi-only.sh', harness: 'pi' },
    { event: 'session_end', script: 'both.sh' },
  ]

  it('filters hooks for claude harness', () => {
    const filtered = filterHooksForHarness(hooks, 'claude')

    expect(filtered).toHaveLength(3)
    expect(filtered.map((h) => h.script)).toEqual(['all.sh', 'claude-only.sh', 'both.sh'])
  })

  it('filters hooks for pi harness', () => {
    const filtered = filterHooksForHarness(hooks, 'pi')

    expect(filtered).toHaveLength(3)
    expect(filtered.map((h) => h.script)).toEqual(['all.sh', 'pi-only.sh', 'both.sh'])
  })
})

describe('toClaudeHooksConfig', () => {
  it('converts canonical hooks to Claude format', () => {
    const hooks: CanonicalHookDefinition[] = [
      { event: 'pre_tool_use', script: 'hooks/validate.sh' },
      { event: 'post_tool_use', script: 'hooks/log.sh' },
    ]

    const config = toClaudeHooksConfig(hooks)

    expect(config.hooks.PreToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/validate.sh' }],
      },
    ])
    expect(config.hooks.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/log.sh' }],
      },
    ])
  })

  it('groups multiple hooks for the same event', () => {
    const hooks: CanonicalHookDefinition[] = [
      { event: 'pre_tool_use', script: 'hooks/first.sh' },
      { event: 'pre_tool_use', script: 'hooks/second.sh' },
    ]

    const config = toClaudeHooksConfig(hooks)

    expect(config.hooks.PreToolUse).toHaveLength(1)
    expect(config.hooks.PreToolUse?.[0]?.matcher).toBe('*')
    expect(config.hooks.PreToolUse?.[0]?.hooks).toHaveLength(2)
  })

  it('uses matcher from tools list when provided', () => {
    const hooks: CanonicalHookDefinition[] = [
      { event: 'pre_tool_use', script: 'hooks/first.sh', tools: ['Write', 'Edit'] },
    ]

    const config = toClaudeHooksConfig(hooks)

    expect(config.hooks.PreToolUse).toHaveLength(1)
    expect(config.hooks.PreToolUse?.[0]?.matcher).toBe('Write|Edit')
  })

  it('filters out Pi-only hooks', () => {
    const hooks: CanonicalHookDefinition[] = [
      { event: 'pre_tool_use', script: 'universal.sh' },
      { event: 'session_start', script: 'pi-init.sh', harness: 'pi' },
    ]

    const config = toClaudeHooksConfig(hooks)

    expect(config.hooks.PreToolUse).toHaveLength(1)
    expect(config.hooks.PreToolUse?.[0]?.matcher).toBe('*')
  })

  it('skips events that have no Claude mapping', () => {
    const hooks: CanonicalHookDefinition[] = [
      { event: 'pre_tool_use', script: 'mapped.sh' },
      { event: 'session_start', script: 'unmapped.sh' }, // Claude doesn't have session_start
    ]

    const config = toClaudeHooksConfig(hooks)

    expect(config.hooks.PreToolUse).toHaveLength(1)
    expect(config.hooks.PreToolUse?.[0]?.matcher).toBe('*')
  })
})

describe('generateClaudeHooksJson', () => {
  it('generates valid JSON string', () => {
    const hooks: CanonicalHookDefinition[] = [
      { event: 'pre_tool_use', script: 'hooks/validate.sh' },
    ]

    const json = generateClaudeHooksJson(hooks)
    const parsed = JSON.parse(json)

    expect(parsed.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('*')
  })
})

describe('readHooksToml / writeClaudeHooksJson', () => {
  const testDir = join(import.meta.dir, '../../.test-hooks-toml')
  const hooksDir = join(testDir, 'hooks')

  beforeEach(async () => {
    await mkdir(hooksDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('reads hooks.toml from directory', async () => {
    const tomlContent = `
[[hook]]
event = "pre_tool_use"
script = "validate.sh"
blocking = true
`
    await writeFile(join(hooksDir, 'hooks.toml'), tomlContent)

    const result = await readHooksToml(hooksDir)

    expect(result).not.toBeNull()
    expect(result?.hook).toHaveLength(1)
    expect(result?.hook[0]?.event).toBe('pre_tool_use')
  })

  it('returns null when hooks.toml does not exist', async () => {
    const result = await readHooksToml(hooksDir)
    expect(result).toBeNull()
  })

  it('writes Claude hooks.json from canonical hooks', async () => {
    const hooks: CanonicalHookDefinition[] = [{ event: 'pre_tool_use', script: 'validate.sh' }]

    await writeClaudeHooksJson(hooks, hooksDir)

    const file = Bun.file(join(hooksDir, 'hooks.json'))
    expect(await file.exists()).toBe(true)

    const content = await file.json()
    expect(content.hooks.PreToolUse).toHaveLength(1)
    expect(content.hooks.PreToolUse[0].matcher).toBe('*')
  })
})

describe('readHooksWithPrecedence', () => {
  const testDir = join(import.meta.dir, '../../.test-hooks-precedence')
  const hooksDir = join(testDir, 'hooks')

  beforeEach(async () => {
    await mkdir(hooksDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('prefers hooks.toml over hooks.json', async () => {
    // Create both files with different content
    const tomlContent = `
[[hook]]
event = "pre_tool_use"
script = "from-toml.sh"
`
    const jsonContent = JSON.stringify({
      hooks: [{ event: 'post_tool_use', script: 'from-json.sh' }],
    })

    await writeFile(join(hooksDir, 'hooks.toml'), tomlContent)
    await writeFile(join(hooksDir, 'hooks.json'), jsonContent)

    const result = await readHooksWithPrecedence(hooksDir)

    expect(result.source).toBe('toml')
    expect(result.hooks).toHaveLength(1)
    expect(result.hooks[0]?.event).toBe('pre_tool_use')
    expect(result.hooks[0]?.script).toBe('from-toml.sh')
  })

  it('falls back to hooks.json when no hooks.toml', async () => {
    const jsonContent = JSON.stringify({
      hooks: [{ event: 'post_tool_use', script: 'from-json.sh' }],
    })

    await writeFile(join(hooksDir, 'hooks.json'), jsonContent)

    const result = await readHooksWithPrecedence(hooksDir)

    expect(result.source).toBe('json')
    expect(result.hooks).toHaveLength(1)
    expect(result.hooks[0]?.event).toBe('post_tool_use')
  })

  it('returns empty when neither file exists', async () => {
    const result = await readHooksWithPrecedence(hooksDir)

    expect(result.source).toBe('none')
    expect(result.hooks).toHaveLength(0)
  })

  it('returns sourcePath for toml source', async () => {
    const tomlContent = `
[[hook]]
event = "pre_tool_use"
script = "validate.sh"
`
    await writeFile(join(hooksDir, 'hooks.toml'), tomlContent)

    const result = await readHooksWithPrecedence(hooksDir)

    expect(result.sourcePath).toBe(join(hooksDir, 'hooks.toml'))
  })

  it('returns sourcePath for json source', async () => {
    const jsonContent = JSON.stringify({
      hooks: [{ event: 'pre_tool_use', script: 'validate.sh' }],
    })
    await writeFile(join(hooksDir, 'hooks.json'), jsonContent)

    const result = await readHooksWithPrecedence(hooksDir)

    expect(result.sourcePath).toBe(join(hooksDir, 'hooks.json'))
  })
})
