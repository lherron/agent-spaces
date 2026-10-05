/**
 * ClaudeAdapter launch surface: the argv (buildRunArgs), environment
 * (getRunEnv) and manifest-derived defaults (getDefaultRunOptions) for a run.
 */

import { describe, expect, test } from 'bun:test'
import type { ComposedTargetBundle, HarnessRunOptions, ProjectManifest } from 'spaces-config'
import { ClaudeAdapter } from './claude-adapter.js'

const adapter = new ClaudeAdapter()

function bundle(overrides: Partial<ComposedTargetBundle> = {}): ComposedTargetBundle {
  return { harnessId: 'claude', targetName: 'test', rootDir: '/test', pluginDirs: [], ...overrides }
}

function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  expect(index).toBeGreaterThanOrEqual(0)
  const value = args[index + 1]
  expect(value).toBeDefined()
  return value as string
}

describe('ClaudeAdapter.buildRunArgs', () => {
  describe('permissions and tools', () => {
    test('names bypassPermissions explicitly for yolo targets', () => {
      const args = adapter.buildRunArgs(bundle(), { yolo: true })

      expect(args).toContain('--dangerously-skip-permissions')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    })

    test('does not name a permission mode when yolo is off', () => {
      const args = adapter.buildRunArgs(bundle(), {})

      expect(args).not.toContain('--permission-mode')
      expect(args).not.toContain('--dangerously-skip-permissions')
    })

    test('an explicit permission mode still wins over the yolo default', () => {
      const args = adapter.buildRunArgs(bundle(), { yolo: true, permissionMode: 'plan' })

      expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    })

    test('denies AskUserQuestion by default', () => {
      const args = adapter.buildRunArgs(bundle(), {})

      expect(args[args.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion')
    })

    test('keeps AskUserQuestion when the agent opts in', () => {
      const args = adapter.buildRunArgs(bundle(), { askUserQuestion: true })

      expect(args).not.toContain('AskUserQuestion')
    })

    test('adds the AskUserQuestion deny to a requested deny-list', () => {
      const args = adapter.buildRunArgs(bundle(), { disallowedTools: ['WebFetch'] })
      const start = args.indexOf('--disallowedTools') + 1

      expect(args.slice(start, start + 2)).toEqual(['WebFetch', 'AskUserQuestion'])
    })
  })

  // Each bundle field or run option surfaces as its flag and value in argv.
  const flagCases: Array<{
    name: string
    bundle?: Partial<ComposedTargetBundle>
    options?: HarnessRunOptions
    expected: string[]
  }> = [
    {
      name: 'builds args from bundle with plugin dirs',
      bundle: { pluginDirs: ['/plugin1', '/plugin2'] },
      expected: ['--plugin-dir', '/plugin1', '/plugin2'],
    },
    {
      name: 'builds args with MCP config',
      bundle: { mcpConfigPath: '/path/to/mcp.json' },
      expected: ['--mcp-config', '/path/to/mcp.json'],
    },
    {
      name: 'builds args with settings',
      bundle: { settingsPath: '/path/to/settings.json' },
      expected: ['--settings', '/path/to/settings.json'],
    },
    {
      name: 'defaults to opus[1m] when no model specified',
      expected: ['--model', 'opus[1m]'],
    },
    {
      name: 'builds args with model override',
      options: { model: 'sonnet' },
      expected: ['--model', 'sonnet'],
    },
    {
      name: 'includes extra args',
      options: { extraArgs: ['--print', 'hello'] },
      expected: ['--print', 'hello'],
    },
    {
      name: 'includes settingSources when provided',
      options: { settingSources: 'project,user' },
      expected: ['--setting-sources', 'project,user'],
    },
  ]

  for (const { name, bundle: overrides, options, expected } of flagCases) {
    test(name, () => {
      const args = adapter.buildRunArgs(bundle(overrides), options ?? {})

      for (const token of expected) {
        expect(args).toContain(token)
      }
    })
  }

  describe('remote-control session names', () => {
    const nameCases: Array<{
      name: string
      targetName: string
      options: HarnessRunOptions
      pattern: RegExp
      excludes?: string
    }> = [
      {
        name: 'falls back to cwd basename when no projectId is threaded',
        targetName: 'agent',
        options: { projectPath: '/work/project', taskId: 'task' },
        pattern: /^agent-project-task-[0-9a-z]{4}$/,
      },
      {
        name: 'keeps remote-control prefix before agent-project-task name',
        targetName: 'agent',
        options: { projectPath: '/work/project', taskId: 'task', sessionNamePrefix: 'dev' },
        pattern: /^dev-agent-project-task-[0-9a-z]{4}$/,
      },
      {
        // Headless dispatch: runtime cwd falls back to the agent root, but the
        // canonical projectId from the handle is threaded through.
        name: 'prefers handle projectId over cwd basename for the project segment',
        targetName: 'clod',
        options: { projectId: 'wrkq', projectPath: '/agents/clod', taskId: 'blah-latent-spaces' },
        pattern: /^clod-wrkq-blah-latent-spaces-[0-9a-z]{4}$/,
        excludes: 'clod-clod-blah-latent-spaces',
      },
    ]

    for (const { name, targetName, options, pattern, excludes } of nameCases) {
      test(name, () => {
        const args = adapter.buildRunArgs(bundle({ targetName }), {
          ...options,
          remoteControl: true,
        })

        const sessionName = flagValue(args, '--name')
        expect(sessionName).toMatch(pattern)
        if (excludes !== undefined) {
          expect(sessionName).not.toContain(excludes)
        }
      })
    }

    test('includes task id in remote-control session names', () => {
      const args = adapter.buildRunArgs(bundle({ targetName: 'agent' }), {
        projectPath: '/work/project',
        taskId: 'task',
        remoteControl: true,
      })

      const name = flagValue(args, '--name')
      expect(flagValue(args, '--remote-control-session-name-prefix')).toBe(name)
      expect(name).toMatch(/^agent-project-task-[0-9a-z]{4}$/)
    })
  })

  describe('session continuity', () => {
    test('fresh launches include a generated session id and do not resume', () => {
      const args = adapter.buildRunArgs(bundle(), {})

      expect(flagValue(args, '--session-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
      expect(args).not.toContain('--resume')
    })

    test('resume launches use --resume and do not allocate a fresh session id', () => {
      const args = adapter.buildRunArgs(bundle(), { continuationKey: 'claude-session-123' })

      expect(flagValue(args, '--resume')).toBe('claude-session-123')
      expect(args).not.toContain('--session-id')
    })
  })

  describe('prompts', () => {
    test('passes prompt as positional argument with -- separator in interactive mode', () => {
      const args = adapter.buildRunArgs(bundle(), {
        interactive: true,
        prompt: 'Start by checking failing tests',
      })

      expect(flagValue(args, '--')).toBe('Start by checking failing tests')
      expect(args).not.toContain('-p')
    })

    test('uses -p in non-interactive mode', () => {
      const args = adapter.buildRunArgs(bundle(), {
        interactive: false,
        prompt: 'Summarize repository health',
      })

      expect(flagValue(args, '-p')).toBe('Summarize repository health')
    })

    // T-01016 red/green: replace keeps replace semantics; append must not
    // clobber Claude's default prompt.
    for (const [mode, flag, otherFlag] of [
      ['replace', '--system-prompt', '--append-system-prompt'],
      ['append', '--append-system-prompt', '--system-prompt'],
    ] as const) {
      test(`routes ${mode} mode system prompts to ${flag}`, () => {
        const args = adapter.buildRunArgs(bundle(), {
          systemPrompt: `${mode} prompt`,
          systemPromptMode: mode,
        } as HarnessRunOptions)

        expect(args).toContain(flag)
        expect(args).toContain(`${mode} prompt`)
        expect(args).not.toContain(otherFlag)
      })
    }
  })
})

describe('ClaudeAdapter.getRunEnv', () => {
  const outputBundle = bundle({ rootDir: '/test/output' })

  test('includes ASP_PLUGIN_ROOT', () => {
    expect(adapter.getRunEnv(outputBundle, {})['ASP_PLUGIN_ROOT']).toBe('/test/output')
  })

  test('includes ASP_PRIMING_PROMPT when prompt is set', () => {
    const env = adapter.getRunEnv(outputBundle, {
      prompt: 'You are Ani. Read your facilitate skill.',
    })

    expect(env['ASP_PRIMING_PROMPT']).toBe('You are Ani. Read your facilitate skill.')
  })

  test('omits ASP_PRIMING_PROMPT when no prompt', () => {
    expect(adapter.getRunEnv(outputBundle, {})['ASP_PRIMING_PROMPT']).toBeUndefined()
  })
})

describe('ClaudeAdapter.getDefaultRunOptions', () => {
  test('includes priming_prompt as default prompt', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      targets: {
        claude: {
          compose: ['space:claude-space@stable'],
          priming: 'Register and send READY',
        },
      },
    }

    expect(adapter.getDefaultRunOptions(manifest, 'claude').prompt).toBe('Register and send READY')
  })

  test('carries provisioning.claude.ask_user_question into run options', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      targets: {
        claude: {
          compose: ['space:claude-space@stable'],
          provisioning: { claude: { ask_user_question: true } },
        },
      },
    }

    expect(adapter.getDefaultRunOptions(manifest, 'claude').askUserQuestion).toBe(true)
  })
})
