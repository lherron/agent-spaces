/**
 * Tests for ClaudeAdapter identity, binary detection and output layout.
 *
 * Per-surface suites live beside this file: claude-adapter.space.test.ts
 * (validate/materialize), claude-adapter.compose.test.ts (composeTarget) and
 * claude-adapter.launch.test.ts (run args, env and defaults).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearClaudeCache } from '../claude/detect.js'
import { ClaudeAdapter } from './claude-adapter.js'

const adapter = new ClaudeAdapter()

describe('ClaudeAdapter', () => {
  describe('id and name', () => {
    test('has correct id', () => {
      expect(adapter.id).toBe('claude')
    })

    test('has correct name', () => {
      expect(adapter.name).toBe('Claude Code')
    })
  })

  describe('detect', () => {
    let tmpDir: string
    let mockClaudePath: string
    let originalEnv: string | undefined

    /** Point ASP_CLAUDE_PATH at a stub claude that reports a version. */
    async function useMockClaude(): Promise<void> {
      await writeFile(
        mockClaudePath,
        `#!/bin/bash
echo "1.0.0"
exit 0
`
      )
      await chmod(mockClaudePath, 0o755)
      process.env['ASP_CLAUDE_PATH'] = mockClaudePath
    }

    beforeAll(async () => {
      tmpDir = join(tmpdir(), `claude-adapter-detect-${Date.now()}`)
      await mkdir(tmpDir, { recursive: true })
      mockClaudePath = join(tmpDir, 'mock-claude')
      originalEnv = process.env['ASP_CLAUDE_PATH']
    })

    beforeEach(async () => {
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

    test('returns available: true when claude is found', async () => {
      await useMockClaude()

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(mockClaudePath)
    })

    test('returns available: false when claude is not found', async () => {
      process.env['ASP_CLAUDE_PATH'] = '/nonexistent/claude'

      const result = await adapter.detect()

      expect(result.available).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('includes capabilities when available', async () => {
      await useMockClaude()

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.capabilities).toBeDefined()
      expect(result.capabilities).toContain('multiPlugin')
      expect(result.capabilities).toContain('settingsFlag')
    })
  })

  describe('getTargetOutputPath', () => {
    test('returns correct path for target', () => {
      const path = adapter.getTargetOutputPath('/project/asp_modules', 'my-target')

      expect(path).toBe('/project/asp_modules/my-target/claude')
    })

    test('handles different asp_modules paths', () => {
      const path = adapter.getTargetOutputPath('/custom/path', 'target')

      expect(path).toBe('/custom/path/target/claude')
    })
  })
})
