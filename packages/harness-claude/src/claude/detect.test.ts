/**
 * Tests for claude detect module.
 *
 * WHY: Detection is the foundation of Claude invocation.
 * We test with a mock binary to avoid requiring actual Claude installation.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_SKIP_COMMON_PATHS_ENV,
  claudeCommandCandidates,
  clearClaudeCache,
  findClaudeBinary,
} from './detect.js'
import { buildClaudeArgs } from './invoke.js'

const originalPath = process.env.PATH
const originalSkipCommonPaths = process.env[CLAUDE_SKIP_COMMON_PATHS_ENV]

// Clear cache after each test to ensure isolation
afterEach(() => {
  clearClaudeCache()
  process.env.PATH = originalPath
  if (originalSkipCommonPaths === undefined) {
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = undefined
  } else {
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = originalSkipCommonPaths
  }
})

describe('findClaudeBinary', () => {
  it('finds a Claude binary reachable only through PATH', async () => {
    const tempDir = join(tmpdir(), `claude-path-detect-${Date.now()}`)
    const shim = join(tempDir, 'claude')
    await mkdir(tempDir, { recursive: true })
    await writeFile(shim, '#!/bin/sh\nexit 0\n')
    await chmod(shim, 0o755)

    try {
      process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = '1'
      process.env.PATH = tempDir

      expect(await findClaudeBinary()).toBe(shim)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps common install paths ahead of PATH candidates', () => {
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = undefined
    process.env.PATH = '/path-first:/path-second'

    const candidates = claudeCommandCandidates()

    expect(candidates[0]).toBe('/opt/homebrew/bin/claude')
    expect(candidates.indexOf('/usr/local/bin/claude')).toBeLessThan(
      candidates.indexOf('/path-first/claude')
    )
    expect(candidates.at(-1)).toBe('/path-second/claude')
  })
})

describe('buildClaudeArgs', () => {
  it('should build empty args for no options', () => {
    const args = buildClaudeArgs({})
    expect(args).toEqual([])
  })

  it('should add plugin directories', () => {
    const args = buildClaudeArgs({
      pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
    })
    expect(args).toEqual(['--plugin-dir', '/path/to/plugin1', '--plugin-dir', '/path/to/plugin2'])
  })

  it('should add mcp config', () => {
    const args = buildClaudeArgs({
      mcpConfig: '/path/to/mcp.json',
    })
    expect(args).toEqual(['--mcp-config', '/path/to/mcp.json'])
  })

  it('should add model', () => {
    const args = buildClaudeArgs({
      model: 'claude-3-opus',
    })
    expect(args).toEqual(['--model', 'claude-3-opus'])
  })

  it('should add permission mode', () => {
    const args = buildClaudeArgs({
      permissionMode: 'full',
    })
    expect(args).toEqual(['--permission-mode', 'full'])
  })

  it('should add pass-through args', () => {
    const args = buildClaudeArgs({
      args: ['--print', 'hello'],
    })
    expect(args).toEqual(['--print', 'hello'])
  })

  it('should combine all options', () => {
    const args = buildClaudeArgs({
      pluginDirs: ['/plugin'],
      mcpConfig: '/mcp.json',
      model: 'opus',
      permissionMode: 'full',
      args: ['--print', 'hello'],
    })
    expect(args).toEqual([
      '--plugin-dir',
      '/plugin',
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
