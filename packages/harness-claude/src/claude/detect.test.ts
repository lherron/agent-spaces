/**
 * Tests for claude detect module.
 *
 * WHY: Detection is the foundation of Claude invocation.
 * We test with a mock binary to avoid requiring actual Claude installation.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { clearClaudeCache } from './detect.js'
import { buildClaudeArgs } from './invoke.js'

// Clear cache after each test to ensure isolation
afterEach(() => {
  clearClaudeCache()
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
