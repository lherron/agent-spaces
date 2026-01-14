/**
 * Tests for Claude invocation.
 *
 * WHY: Claude invocation is critical - it's how we actually run Claude with plugins.
 * These tests use a mock Claude script to verify argument passing and process handling.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeInvocationError } from 'spaces-core'
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

  test('adds mcp config', () => {
    const args = buildClaudeArgs({
      mcpConfig: '/path/to/mcp.json',
    })
    expect(args).toEqual(['--mcp-config', '/path/to/mcp.json'])
  })

  test('adds model', () => {
    const args = buildClaudeArgs({
      model: 'claude-3-opus',
    })
    expect(args).toEqual(['--model', 'claude-3-opus'])
  })

  test('adds permission mode', () => {
    const args = buildClaudeArgs({
      permissionMode: 'full',
    })
    expect(args).toEqual(['--permission-mode', 'full'])
  })

  test('adds pass-through args', () => {
    const args = buildClaudeArgs({
      args: ['--print', 'hello'],
    })
    expect(args).toEqual(['--print', 'hello'])
  })

  test('combines all options in correct order', () => {
    const args = buildClaudeArgs({
      pluginDirs: ['/plugin1', '/plugin2'],
      mcpConfig: '/mcp.json',
      model: 'opus',
      permissionMode: 'full',
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
      '--print',
      'hello',
    ])
  })
})

describe('formatClaudeCommand', () => {
  test('formats basic command', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude', {})
    expect(command).toBe('/usr/local/bin/claude')
  })

  test('formats command with plugin dirs', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude', {
      pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
    })
    expect(command).toBe(
      '/usr/local/bin/claude --plugin-dir /path/to/plugin1 --plugin-dir /path/to/plugin2'
    )
  })

  test('formats command with all options', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude', {
      pluginDirs: ['/plugin1'],
      mcpConfig: '/mcp.json',
      model: 'opus',
      permissionMode: 'full',
    })
    expect(command).toBe(
      '/usr/local/bin/claude --plugin-dir /plugin1 --mcp-config /mcp.json --model opus --permission-mode full'
    )
  })

  test('quotes paths with spaces', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude', {
      pluginDirs: ['/path with spaces/plugin'],
    })
    expect(command).toBe("/usr/local/bin/claude --plugin-dir '/path with spaces/plugin'")
  })

  test('quotes paths with special characters', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude', {
      pluginDirs: ['/path$with/special'],
    })
    expect(command).toBe("/usr/local/bin/claude --plugin-dir '/path$with/special'")
  })

  test('escapes single quotes in paths', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude', {
      pluginDirs: ["/path'with/quote"],
    })
    // Single quote is escaped by: end quote, escaped quote, new quote
    expect(command).toBe("/usr/local/bin/claude --plugin-dir '/path'\\''with/quote'")
  })

  test('quotes claude path with spaces', () => {
    const command = formatClaudeCommand('/usr/local/bin/claude code', {})
    expect(command).toBe("'/usr/local/bin/claude code'")
  })
})

describe('getClaudeCommand', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `getcommand-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
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
    tmpDir = join(tmpdir(), `invoke-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
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

  test('invokes Claude and returns exit code', async () => {
    await createMockClaude('#!/bin/bash\nexit 0\n')

    const result = await invokeClaude({ captureOutput: true })
    expect(result.exitCode).toBe(0)
  })

  test('captures stdout', async () => {
    await createMockClaude('#!/bin/bash\necho "hello from claude"\n')

    const result = await invokeClaude({ captureOutput: true })
    expect(result.stdout).toContain('hello from claude')
  })

  test('captures stderr', async () => {
    await createMockClaude('#!/bin/bash\necho "error message" >&2\nexit 1\n')

    const result = await invokeClaude({ captureOutput: true })
    expect(result.stderr).toContain('error message')
    expect(result.exitCode).toBe(1)
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
})

describe('invokeClaudeOrThrow', () => {
  let tmpDir: string
  let mockClaudePath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `invoke-throw-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
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
    tmpDir = join(tmpdir(), `prompt-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
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
    await createMockClaude('#!/bin/bash\necho "$@"\n')

    const result = await runClaudePrompt('hello world')
    expect(result).toContain('--print')
    expect(result).toContain('hello world')
  })

  test('trims output', async () => {
    await createMockClaude('#!/bin/bash\necho "  response with whitespace  "\n')

    const result = await runClaudePrompt('test')
    expect(result).toBe('response with whitespace')
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
    tmpDir = join(tmpdir(), `spawn-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
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

    // Write to stdin using Bun's FileSink interface
    proc.stdin.write('test input\n')
    proc.stdin.end()

    // Read stdout
    const stdout = await new Response(proc.stdout).text()
    expect(stdout).toContain('received: test input')

    await proc.exited
  })
})
