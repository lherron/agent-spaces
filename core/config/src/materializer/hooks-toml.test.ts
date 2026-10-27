import { filterHooksForHarness, translateToPiEvent } from './hooks-toml.js'
/**
 * Tests for hooks.toml parsing and translation
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CanonicalHookDefinition,
  type ClaudeHooksConfig,
  parseHooksToml,
  readHooksToml,
  readHooksWithPrecedence,
  toClaudeHooksConfig,
  translateToClaudeEvent,
} from './hooks-toml.js'

describe('parseHooksToml', () => {
  it("hooks.toml parsing keeps each hook's event, script, tools, matcher, blocking and harness, and a comment-only file yields no hooks", () => {
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

[[hook]]
event = "session_start"
script = "hooks/inject-priming.sh"
matcher = "compact"
`

    const result = parseHooksToml(content)

    expect(result.hook).toEqual([
      {
        event: 'pre_tool_use',
        script: 'hooks/pre-tool-use.sh',
        tools: ['Bash', 'Write'],
        matcher: undefined,
        blocking: true,
        harness: undefined,
      },
      {
        event: 'post_tool_use',
        script: 'hooks/post-tool-use.sh',
        tools: undefined,
        matcher: undefined,
        blocking: false,
        harness: undefined,
      },
      {
        event: 'session_end',
        script: 'hooks/cleanup.sh',
        tools: undefined,
        matcher: undefined,
        blocking: undefined,
        harness: 'claude',
      },
      {
        event: 'session_start',
        script: 'hooks/inject-priming.sh',
        tools: undefined,
        matcher: 'compact',
        blocking: undefined,
        harness: undefined,
      },
    ])

    expect(parseHooksToml('# Empty hooks file').hook).toEqual([])
  })
})

describe('translateToClaudeEvent', () => {
  it('every canonical hook event maps to its Claude hooks.json event key', () => {
    const canonicalEvents = [
      'pre_tool_use',
      'post_tool_use',
      'post_tool_use_failure',
      'permission_request',
      'notification',
      'user_prompt_submit',
      'stop',
      'subagent_start',
      'subagent_stop',
      'pre_compact',
      'session_start',
      'session_end',
    ]

    expect(
      Object.fromEntries(canonicalEvents.map((event) => [event, translateToClaudeEvent(event)]))
    ).toEqual({
      pre_tool_use: 'PreToolUse',
      post_tool_use: 'PostToolUse',
      post_tool_use_failure: 'PostToolUseFailure',
      permission_request: 'PermissionRequest',
      notification: 'Notification',
      user_prompt_submit: 'UserPromptSubmit',
      stop: 'Stop',
      subagent_start: 'SubagentStart',
      subagent_stop: 'SubagentStop',
      pre_compact: 'PreCompact',
      session_start: 'SessionStart',
      session_end: 'SessionEnd',
    })
  })
})

const pluginCommand = (script: string) => ({
  type: 'command' as const,
  command: `\${CLAUDE_PLUGIN_ROOT}/${script}`,
})

const claudeHooksCases: Array<[string, CanonicalHookDefinition[], ClaudeHooksConfig['hooks']]> = [
  [
    'tool events without tools get matcher * and plugin-rooted commands',
    [
      { event: 'pre_tool_use', script: 'hooks/validate.sh' },
      { event: 'post_tool_use', script: 'hooks/log.sh' },
    ],
    {
      PreToolUse: [{ matcher: '*', hooks: [pluginCommand('hooks/validate.sh')] }],
      PostToolUse: [{ matcher: '*', hooks: [pluginCommand('hooks/log.sh')] }],
    },
  ],
  [
    'hooks on one event and matcher group into one entry',
    [
      { event: 'pre_tool_use', script: 'hooks/first.sh' },
      { event: 'pre_tool_use', script: 'hooks/second.sh' },
    ],
    {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [pluginCommand('hooks/first.sh'), pluginCommand('hooks/second.sh')],
        },
      ],
    },
  ],
  [
    'a tools list becomes the tool-event matcher',
    [{ event: 'pre_tool_use', script: 'hooks/first.sh', tools: ['Write', 'Edit'] }],
    { PreToolUse: [{ matcher: 'Write|Edit', hooks: [pluginCommand('hooks/first.sh')] }] },
  ],
  [
    'claude and claude-agent-sdk hooks are kept',
    [
      { event: 'pre_tool_use', script: 'all.sh' },
      { event: 'post_tool_use', script: 'claude-only.sh', harness: 'claude' },
      { event: 'session_end', script: 'sdk-only.sh', harness: 'claude-agent-sdk' },
    ],
    {
      PreToolUse: [{ matcher: '*', hooks: [pluginCommand('all.sh')] }],
      PostToolUse: [{ matcher: '*', hooks: [pluginCommand('claude-only.sh')] }],
      SessionEnd: [{ hooks: [pluginCommand('sdk-only.sh')] }],
    },
  ],
  [
    'pi-only hooks are omitted',
    [
      { event: 'pre_tool_use', script: 'universal.sh' },
      { event: 'session_start', script: 'pi-init.sh', harness: 'pi' },
    ],
    { PreToolUse: [{ matcher: '*', hooks: [pluginCommand('universal.sh')] }] },
  ],
  [
    'events with no Claude mapping are omitted without a stray key',
    [
      { event: 'pre_tool_use', script: 'mapped.sh' },
      { event: 'totally_unknown', script: 'unmapped.sh' },
    ],
    { PreToolUse: [{ matcher: '*', hooks: [pluginCommand('mapped.sh')] }] },
  ],
  [
    'non-tool hooks with different matchers become separate entries',
    [
      { event: 'session_start', script: 'hooks/on-compact.sh', matcher: 'compact' },
      { event: 'session_start', script: 'hooks/on-startup.sh', matcher: 'startup' },
    ],
    {
      SessionStart: [
        { matcher: 'compact', hooks: [pluginCommand('hooks/on-compact.sh')] },
        { matcher: 'startup', hooks: [pluginCommand('hooks/on-startup.sh')] },
      ],
    },
  ],
  [
    'lifecycle hooks keep a declared matcher and omit an undeclared one',
    [
      {
        event: 'session_start',
        matcher: 'startup',
        script: 'hooks/scripts/session-ready.sh',
        harness: 'claude',
      },
      { event: 'user_prompt_submit', script: 'hooks/scripts/turn-started.sh', harness: 'claude' },
      { event: 'stop', script: 'hooks/scripts/turn-stopped.sh', harness: 'claude' },
    ],
    {
      SessionStart: [
        { matcher: 'startup', hooks: [pluginCommand('hooks/scripts/session-ready.sh')] },
      ],
      UserPromptSubmit: [{ hooks: [pluginCommand('hooks/scripts/turn-started.sh')] }],
      Stop: [{ hooks: [pluginCommand('hooks/scripts/turn-stopped.sh')] }],
    },
  ],
]

describe('toClaudeHooksConfig', () => {
  it.each(claudeHooksCases)(
    'hooks.toml hooks materialize into Claude hooks.json grouped by event and matcher: %s',
    (_case, hooks, expected) => {
      expect(toClaudeHooksConfig(hooks).hooks).toEqual(expected)
    }
  )
})

describe('readHooksToml', () => {
  let testDir: string
  let hooksDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'asp-hooks-toml-'))
    hooksDir = join(testDir, 'hooks')
    await mkdir(hooksDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('throws (does not silently return null) for a malformed hooks.toml', async () => {
    // Invalid TOML: unterminated string / bare junk that @iarna/toml rejects.
    await writeFile(join(hooksDir, 'hooks.toml'), 'this = is = not = valid = toml')

    await expect(readHooksToml(hooksDir)).rejects.toThrow()
  })
})

describe('readHooksWithPrecedence', () => {
  let testDir: string
  let hooksDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'asp-hooks-precedence-'))
    hooksDir = join(testDir, 'hooks')
    await mkdir(hooksDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  const tomlContent = `
[[hook]]
event = "pre_tool_use"
script = "from-toml.sh"
`
  const jsonContent = JSON.stringify({
    hooks: [{ event: 'post_tool_use', script: 'from-json.sh' }],
  })

  it.each<{
    files: string[]
    source: 'toml' | 'json' | 'none'
    hooks: Array<{ event: string; script: string }>
  }>([
    {
      files: ['hooks.toml', 'hooks.json'],
      source: 'toml',
      hooks: [{ event: 'pre_tool_use', script: 'from-toml.sh' }],
    },
    {
      files: ['hooks.json'],
      source: 'json',
      hooks: [{ event: 'post_tool_use', script: 'from-json.sh' }],
    },
    { files: [], source: 'none', hooks: [] },
  ])(
    'hooks.toml wins over hooks.json, hooks.json is the fallback, and neither yields no hooks (files: $files)',
    async ({ files, source, hooks }) => {
      if (files.includes('hooks.toml')) await writeFile(join(hooksDir, 'hooks.toml'), tomlContent)
      if (files.includes('hooks.json')) await writeFile(join(hooksDir, 'hooks.json'), jsonContent)

      const result = await readHooksWithPrecedence(hooksDir)

      expect(result.source).toBe(source)
      expect(result.hooks.map(({ event, script }) => ({ event, script }))).toEqual(hooks)
    }
  )

  it('normalizes Claude native event names to canonical snake case', async () => {
    const jsonContent = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'hooks/pre.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'hooks/post.sh' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'hooks/start.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'hooks/stop.sh' }] }],
      },
    })
    await writeFile(join(hooksDir, 'hooks.json'), jsonContent)

    const result = await readHooksWithPrecedence(hooksDir)

    expect(result.source).toBe('json')
    expect(result.hooks.map((hook) => hook.event)).toEqual([
      'pre_tool_use',
      'post_tool_use',
      'session_start',
      'stop',
    ])
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for hooks.toml parsing and translation
   */

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

    it('filters hooks for pi harness', () => {
      const filtered = filterHooksForHarness(hooks, 'pi')

      expect(filtered).toHaveLength(3)
      expect(filtered.map((h) => h.script)).toEqual(['all.sh', 'pi-only.sh', 'both.sh'])
    })
  })

  describe('readHooksWithPrecedence', () => {
    let testDir: string
    let hooksDir: string

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), 'hooks-precedence-'))
      hooksDir = join(testDir, 'hooks')
      await mkdir(hooksDir, { recursive: true })
    })

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true })
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

  describe('missing hooks file', () => {
    let hooksDir: string
    beforeEach(async () => {
      hooksDir = await mkdtemp(join(tmpdir(), 'hooks-missing-'))
    })
    afterEach(async () => {
      await rm(hooksDir, { recursive: true, force: true })
    })
    it('returns null when hooks.toml does not exist', async () => {
      const result = await readHooksToml(hooksDir)
      expect(result).toBeNull()
    })
  })
})
