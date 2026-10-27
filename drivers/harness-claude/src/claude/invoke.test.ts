/**
 * Tests for Claude invocation.
 *
 * WHY: Claude invocation is critical - it's how we actually run Claude with plugins.
 * These tests use a mock Claude script to verify argument passing and process handling.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeInvocationError } from 'spaces-config'
import { clearClaudeCache } from './detect.js'
import {
  buildClaudeArgs,
  formatClaudeCommand,
  getClaudeCommand,
  invokeClaude,
  invokeClaudeOrThrow,
  runClaudePrompt,
  spawnClaude,
} from './invoke.js'

describe('buildClaudeArgs', () => {
  test('returns empty array for no options', () => {
    const args = buildClaudeArgs({})
    expect(args).toEqual([])
  })

  test('adds plugin directories', () => {
    const args = buildClaudeArgs({
      pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
    })
    expect(args).toEqual(['--plugin-dir', '/path/to/plugin1', '--plugin-dir', '/path/to/plugin2'])
  })

  test('combines all options in correct order', () => {
    const args = buildClaudeArgs({
      pluginDirs: ['/plugin1', '/plugin2'],
      mcpConfig: '/mcp.json',
      model: 'opus',
      permissionMode: 'full',
      disallowedTools: ['AskUserQuestion', 'WebFetch'],
      systemPrompt: 'You are Alice.',
      args: ['--print', 'hello'],
    })
    expect(args).toEqual([
      '--plugin-dir',
      '/plugin1',
      '--plugin-dir',
      '/plugin2',
      '--mcp-config',
      '/mcp.json',
      '--model',
      'opus',
      '--permission-mode',
      'full',
      '--disallowedTools',
      'AskUserQuestion',
      'WebFetch',
      '--system-prompt',
      'You are Alice.',
      '--print',
      'hello',
    ])
  })

  test('prefers append flag over replace flag when only append content is supplied', () => {
    // T-01016 red gate: append mode must survive argv generation intact.
    const args = buildClaudeArgs({
      appendSystemPrompt: 'append-only prompt',
      args: ['--print', 'hello'],
    } as any)

    expect(args).toEqual(['--append-system-prompt', 'append-only prompt', '--print', 'hello'])
    expect(args).not.toContain('--system-prompt')
  })
})

describe('formatClaudeCommand', () => {
  const cases: Array<[string, Parameters<typeof formatClaudeCommand>[1], string]> = [
    ['/usr/local/bin/claude', {}, '/usr/local/bin/claude'],
    [
      '/usr/local/bin/claude',
      { pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'] },
      '/usr/local/bin/claude --plugin-dir /path/to/plugin1 --plugin-dir /path/to/plugin2',
    ],
    [
      '/usr/local/bin/claude',
      { pluginDirs: ['/plugin1'], mcpConfig: '/mcp.json', model: 'opus', permissionMode: 'full' },
      '/usr/local/bin/claude --plugin-dir /plugin1 --mcp-config /mcp.json --model opus --permission-mode full',
    ],
    [
      '/usr/local/bin/claude',
      { pluginDirs: ['/path with spaces/plugin'] },
      "/usr/local/bin/claude --plugin-dir '/path with spaces/plugin'",
    ],
    [
      '/usr/local/bin/claude',
      { pluginDirs: ['/path$with/special'] },
      "/usr/local/bin/claude --plugin-dir '/path$with/special'",
    ],
    [
      '/usr/local/bin/claude',
      { pluginDirs: ["/path'with/quote"] },
      "/usr/local/bin/claude --plugin-dir '/path'\\''with/quote'",
    ],
    ['/usr/local/bin/claude code', {}, "'/usr/local/bin/claude code'"],
  ]
  test.each(cases)('formats %s and its options as a safe command', (binary, options, expected) => {
    expect(formatClaudeCommand(binary, options)).toBe(expected)
  })
})

describe('getClaudeCommand', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'getcommand-test-'))
    mockClaudePath = join(tmpDir, 'mock-claude')
    originalEnv = process.env['ASP_CLAUDE_PATH']
  })

  beforeEach(async () => {
    clearClaudeCache()
    // Create a mock claude binary
    await writeFile(mockClaudePath, '#!/bin/bash\nexit 0\n')
    await chmod(mockClaudePath, 0o755)
    process.env['ASP_CLAUDE_PATH'] = mockClaudePath
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_CLAUDE_PATH'] = originalEnv
    } else {
      process.env['ASP_CLAUDE_PATH'] = undefined
    }
    clearClaudeCache()
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('resolves claude path and formats command', async () => {
    const command = await getClaudeCommand({
      pluginDirs: ['/plugin1'],
    })
    expect(command).toContain(mockClaudePath)
    expect(command).toContain('--plugin-dir /plugin1')
  })
})

describe('invokeClaude', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'invoke-test-'))
    mockClaudePath = join(tmpDir, 'mock-claude')

    // Save original ASP_CLAUDE_PATH
    originalEnv = process.env['ASP_CLAUDE_PATH']
  })

  beforeEach(async () => {
    // Clear cache before each test
    clearClaudeCache()
  })

  afterEach(async () => {
    // Reset ASP_CLAUDE_PATH
    if (originalEnv !== undefined) {
      process.env['ASP_CLAUDE_PATH'] = originalEnv
    } else {
      process.env['ASP_CLAUDE_PATH'] = undefined
    }
    clearClaudeCache()
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function createMockClaude(script: string): Promise<void> {
    await writeFile(mockClaudePath, script)
    await chmod(mockClaudePath, 0o755)
    process.env['ASP_CLAUDE_PATH'] = mockClaudePath
  }

  test('captures stdout', async () => {
    await createMockClaude('#!/bin/bash\necho "hello from claude"\necho "error message" >&2\n')

    const result = await invokeClaude({ captureOutput: true })
    expect(result.stdout).toContain('hello from claude')
    expect(result.stderr).toContain('error message')
    expect(result.exitCode).toBe(0)
  })

  test('passes arguments correctly', async () => {
    // Create a script that echoes all arguments
    await createMockClaude('#!/bin/bash\necho "$@"\n')

    const result = await invokeClaude({
      pluginDirs: ['/path/to/plugin'],
      mcpConfig: '/mcp.json',
      captureOutput: true,
    })

    expect(result.stdout).toContain('--plugin-dir')
    expect(result.stdout).toContain('/path/to/plugin')
    expect(result.stdout).toContain('--mcp-config')
    expect(result.stdout).toContain('/mcp.json')
  })

  test('passes environment variables', async () => {
    await createMockClaude('#!/bin/bash\necho "TEST_VAR=$TEST_VAR"\n')

    const result = await invokeClaude({
      env: { TEST_VAR: 'test_value' },
      captureOutput: true,
    })

    expect(result.stdout).toContain('TEST_VAR=test_value')
  })

  test('uses working directory', async () => {
    await createMockClaude('#!/bin/bash\npwd\n')

    const result = await invokeClaude({
      cwd: tmpDir,
      captureOutput: true,
    })

    // macOS returns /private/var/... for pwd while tmpdir() returns /var/...
    // They're the same directory, just use the realpath to compare
    const { realpathSync } = await import('node:fs')
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(tmpDir))
  })

  test('handles non-zero exit codes', async () => {
    await createMockClaude('#!/bin/bash\nexit 42\n')

    const result = await invokeClaude({ captureOutput: true })
    expect(result.exitCode).toBe(42)
  })

  test('timeout kills a long-running child and still resolves', async () => {
    // Documents CURRENT behavior: when the timeout fires it kills the child,
    // and invokeClaude resolves normally (the kill produces a non-zero exit
    // code). It does NOT throw or otherwise signal that a timeout occurred —
    // that missing surface is tracked as wrkq T-10129 attachment BUGS.md (ATT-00153) harness-claude A4 and is
    // asserted in the `.todo` below.
    //
    // `exec sleep` so the kill signal reaches the sleep directly (otherwise
    // bash's child sleep survives and the stdout pipe never closes).
    await createMockClaude('#!/bin/bash\nexec sleep 30\n')

    const result = await invokeClaude({ captureOutput: true, timeout: 100 })

    // The child was killed before it could exit 0, so the exit code is not 0.
    expect(result.exitCode).not.toBe(0)
  }, 10_000)
})

describe('invokeClaudeOrThrow', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'invoke-throw-test-'))
    mockClaudePath = join(tmpDir, 'mock-claude')
    originalEnv = process.env['ASP_CLAUDE_PATH']
  })

  beforeEach(() => {
    clearClaudeCache()
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_CLAUDE_PATH'] = originalEnv
    } else {
      process.env['ASP_CLAUDE_PATH'] = undefined
    }
    clearClaudeCache()
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function createMockClaude(script: string): Promise<void> {
    await writeFile(mockClaudePath, script)
    await chmod(mockClaudePath, 0o755)
    process.env['ASP_CLAUDE_PATH'] = mockClaudePath
  }

  test('returns result on success', async () => {
    await createMockClaude('#!/bin/bash\necho "success"\nexit 0\n')

    const result = await invokeClaudeOrThrow({ captureOutput: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('success')
  })

  test('throws ClaudeInvocationError on non-zero exit', async () => {
    await createMockClaude('#!/bin/bash\necho "error" >&2\nexit 1\n')

    try {
      await invokeClaudeOrThrow({ captureOutput: true })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeInvocationError)
      expect((err as ClaudeInvocationError).exitCode).toBe(1)
    }
  })
})

describe('runClaudePrompt', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'prompt-test-'))
    mockClaudePath = join(tmpDir, 'mock-claude')
    originalEnv = process.env['ASP_CLAUDE_PATH']
  })

  beforeEach(() => {
    clearClaudeCache()
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_CLAUDE_PATH'] = originalEnv
    } else {
      process.env['ASP_CLAUDE_PATH'] = undefined
    }
    clearClaudeCache()
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function createMockClaude(script: string): Promise<void> {
    await writeFile(mockClaudePath, script)
    await chmod(mockClaudePath, 0o755)
    process.env['ASP_CLAUDE_PATH'] = mockClaudePath
  }

  test('adds --print flag with prompt', async () => {
    // Echo the arguments to verify --print is added
    await createMockClaude('#!/bin/bash\nprintf "  %s  \\n" "$*"\n')

    const result = await runClaudePrompt('hello world')
    expect(result).toBe('--print hello world')
  })

  test('throws on non-zero exit', async () => {
    await createMockClaude('#!/bin/bash\nexit 1\n')

    try {
      await runClaudePrompt('test')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeInvocationError)
    }
  })
})

describe('spawnClaude', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spawn-test-'))
    mockClaudePath = join(tmpDir, 'mock-claude')
    originalEnv = process.env['ASP_CLAUDE_PATH']
  })

  beforeEach(() => {
    clearClaudeCache()
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['ASP_CLAUDE_PATH'] = originalEnv
    } else {
      process.env['ASP_CLAUDE_PATH'] = undefined
    }
    clearClaudeCache()
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function createMockClaude(script: string): Promise<void> {
    await writeFile(mockClaudePath, script)
    await chmod(mockClaudePath, 0o755)
    process.env['ASP_CLAUDE_PATH'] = mockClaudePath
  }

  test('returns process handle and command', async () => {
    await createMockClaude('#!/bin/bash\necho "spawned"\nexit 0\n')

    const { proc, command } = await spawnClaude({ args: ['--test'] })

    expect(command).toContain(mockClaudePath)
    expect(command).toContain('--test')

    // Wait for process to complete
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  })

  test('allows piping stdin/stdout', async () => {
    // Script that reads stdin and echoes it
    await createMockClaude('#!/bin/bash\nread input\necho "received: $input"\n')

    const { proc } = await spawnClaude()

    // spawnClaude pipes stdio unless inheritStdio is set; narrow the generic Subprocess streams
    const { stdin, stdout: stdoutStream } = proc
    if (!stdin || typeof stdin === 'number') throw new Error('expected piped stdin FileSink')
    if (!stdoutStream || typeof stdoutStream === 'number') {
      throw new Error('expected piped stdout stream')
    }

    // Write to stdin using Bun's FileSink interface
    stdin.write('test input\n')
    stdin.end()

    // Read stdout
    const stdout = await new Response(stdoutStream).text()
    expect(stdout).toContain('received: test input')

    await proc.exited
  })
})
