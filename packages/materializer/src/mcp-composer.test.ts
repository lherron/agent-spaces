/**
 * Tests for mcp-composer module.
 *
 * WHY: MCP composition must correctly merge configs from multiple spaces.
 * These tests verify merging and collision detection.
 */

import { describe, expect, it } from 'bun:test'
import { type McpConfig, checkMcpCollisions, composeMcpConfigs } from './mcp-composer.js'

describe('composeMcpConfigs', () => {
  it('should compose multiple configs', () => {
    const config1: McpConfig = {
      mcpServers: {
        server1: { type: 'stdio', command: 'cmd1' },
      },
    }
    const config2: McpConfig = {
      mcpServers: {
        server2: { type: 'stdio', command: 'cmd2' },
      },
    }

    const composed = composeMcpConfigs([config1, config2])
    expect(Object.keys(composed.mcpServers).length).toBe(2)
    expect(composed.mcpServers['server1']?.command).toBe('cmd1')
    expect(composed.mcpServers['server2']?.command).toBe('cmd2')
  })

  it('should override earlier configs with later ones', () => {
    const config1: McpConfig = {
      mcpServers: {
        server1: { type: 'stdio', command: 'original' },
      },
    }
    const config2: McpConfig = {
      mcpServers: {
        server1: { type: 'stdio', command: 'override' },
      },
    }

    const composed = composeMcpConfigs([config1, config2])
    expect(composed.mcpServers['server1']?.command).toBe('override')
  })

  it('should handle empty configs', () => {
    const composed = composeMcpConfigs([])
    expect(Object.keys(composed.mcpServers).length).toBe(0)
  })
})

describe('checkMcpCollisions', () => {
  it('should detect collisions', () => {
    const configs = [
      {
        spaceId: 'space-a',
        config: { mcpServers: { shared: { type: 'stdio' as const, command: 'cmd' } } },
      },
      {
        spaceId: 'space-b',
        config: { mcpServers: { shared: { type: 'stdio' as const, command: 'cmd2' } } },
      },
    ]

    const collisions = checkMcpCollisions(configs)
    expect(collisions.length).toBe(1)
    expect(collisions[0]).toContain('shared')
    expect(collisions[0]).toContain('space-a')
    expect(collisions[0]).toContain('space-b')
  })

  it('should return empty for no collisions', () => {
    const configs = [
      {
        spaceId: 'space-a',
        config: { mcpServers: { server1: { type: 'stdio' as const, command: 'cmd' } } },
      },
      {
        spaceId: 'space-b',
        config: { mcpServers: { server2: { type: 'stdio' as const, command: 'cmd2' } } },
      },
    ]

    const collisions = checkMcpCollisions(configs)
    expect(collisions.length).toBe(0)
  })
})
