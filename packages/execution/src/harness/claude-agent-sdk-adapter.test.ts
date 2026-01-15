/**
 * Tests for ClaudeAgentSdkAdapter
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposedTargetBundle } from 'spaces-config'
import { clearClaudeCache } from '../claude/index.js'
import { ClaudeAdapter } from './claude-adapter.js'
import { ClaudeAgentSdkAdapter } from './claude-agent-sdk-adapter.js'
import { harnessRegistry } from './index.js'

describe('ClaudeAgentSdkAdapter', () => {
  describe('detect', () => {
    let tmpDir: string
    let mockClaudePath: string
    let originalEnv: string | undefined

    beforeAll(async () => {
      tmpDir = join(tmpdir(), `claude-agent-sdk-detect-${Date.now()}`)
      await mkdir(tmpDir, { recursive: true })
      mockClaudePath = join(tmpDir, 'mock-claude')
      originalEnv = process.env['ASP_CLAUDE_PATH']
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

    test('returns available when claude is found', async () => {
      const adapter = new ClaudeAgentSdkAdapter()
      await writeFile(
        mockClaudePath,
        `#!/bin/bash
echo \"1.0.0\"
exit 0
`
      )
      await chmod(mockClaudePath, 0o755)
      process.env['ASP_CLAUDE_PATH'] = mockClaudePath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(mockClaudePath)
    })
  })

  test('has correct id and name', () => {
    const adapter = new ClaudeAgentSdkAdapter()
    expect(adapter.id).toBe('claude-agent-sdk')
    expect(adapter.name).toBe('Claude Agent SDK')
  })

  test('is registered in the global harness registry', () => {
    expect(harnessRegistry.get('claude-agent-sdk')).toBeDefined()
  })

  test('uses harness-specific output path', () => {
    const adapter = new ClaudeAgentSdkAdapter()
    const path = adapter.getTargetOutputPath('/project/asp_modules', 'my-target')
    expect(path).toBe('/project/asp_modules/my-target/claude-agent-sdk')
  })

  test('buildRunArgs matches Claude adapter', () => {
    const adapter = new ClaudeAgentSdkAdapter()
    const claude = new ClaudeAdapter()

    const bundle: ComposedTargetBundle = {
      harnessId: 'claude-agent-sdk',
      targetName: 'test-target',
      rootDir: '/tmp/asp',
      pluginDirs: ['/tmp/asp/plugins/000-base'],
      mcpConfigPath: '/tmp/asp/mcp.json',
      settingsPath: '/tmp/asp/settings.json',
    }

    const options = { projectPath: '/project' }

    const args = adapter.buildRunArgs(bundle, options)
    const claudeArgs = claude.buildRunArgs({ ...bundle, harnessId: 'claude' }, options)

    expect(args).toEqual(claudeArgs)
  })
})
