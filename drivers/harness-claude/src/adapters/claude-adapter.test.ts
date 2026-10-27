/**
 * Tests for ClaudeAdapter binary detection and output layout.
 *
 * Per-surface suites live beside this file: claude-adapter.space.test.ts
 * (validate/materialize), claude-adapter.compose.test.ts (composeTarget) and
 * claude-adapter.launch.test.ts (run args, env and defaults).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_PATH_ENV,
  CLAUDE_SKIP_COMMON_PATHS_ENV,
  clearClaudeCache,
} from '../claude/detect.js'
import { ClaudeAdapter } from './claude-adapter.js'

const adapter = new ClaudeAdapter()

/** Restore an env var to its captured value, removing it when it was unset. */
function restoreEnv(key: string, value: string | undefined): void {
  if (value !== undefined) {
    process.env[key] = value
  } else {
    process.env[key] = undefined
  }
}

describe('ClaudeAdapter', () => {
  describe('detect', () => {
    let tmpDir: string
    let mockClaudePath: string
    const originalClaudePath = process.env[CLAUDE_PATH_ENV]
    const originalSkipCommonPaths = process.env[CLAUDE_SKIP_COMMON_PATHS_ENV]
    const originalPath = process.env['PATH']

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
      process.env[CLAUDE_PATH_ENV] = mockClaudePath
    }

    /**
     * Point ASP_CLAUDE_PATH at a stub claude that records each version probe
     * in `<dir>/probes`, so detection caching is visible as a probe count.
     */
    async function writeCountingShim(dir: string, version: string, exitCode = 0): Promise<string> {
      await mkdir(dir, { recursive: true })
      const shim = join(dir, 'claude')
      await writeFile(
        shim,
        `#!/bin/sh\necho x >> "${join(dir, 'probes')}"\necho "${version} (Claude Code)"\nexit ${exitCode}\n`
      )
      await chmod(shim, 0o755)
      process.env[CLAUDE_PATH_ENV] = shim
      return shim
    }

    async function probeCount(dir: string): Promise<number> {
      try {
        return (await readFile(join(dir, 'probes'), 'utf-8')).split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }

    function shimDir(): string {
      return join(tmpDir, `shim-${Date.now()}-${Math.random()}`)
    }

    beforeAll(async () => {
      tmpDir = join(tmpdir(), `claude-adapter-detect-${Date.now()}`)
      await mkdir(tmpDir, { recursive: true })
      mockClaudePath = join(tmpDir, 'mock-claude')
    })

    beforeEach(async () => {
      clearClaudeCache()
    })

    afterEach(() => {
      restoreEnv(CLAUDE_PATH_ENV, originalClaudePath)
      restoreEnv(CLAUDE_SKIP_COMMON_PATHS_ENV, originalSkipCommonPaths)
      restoreEnv('PATH', originalPath)
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
      expect(result.capabilities).toContain('multiPlugin')
      expect(result.capabilities).toContain('settingsFlag')
    })

    test('returns available: false when claude is not found', async () => {
      process.env[CLAUDE_PATH_ENV] = '/nonexistent/claude'

      const result = await adapter.detect()

      expect(result.available).toBe(false)
      expect(result.error).toBe('Claude CLI not found. Searched: /nonexistent/claude')
    })

    test('finds a Claude binary reachable only through PATH', async () => {
      const dir = shimDir()
      const shim = await writeCountingShim(dir, '2.1.0')
      restoreEnv(CLAUDE_PATH_ENV, undefined)
      process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = '1'
      process.env['PATH'] = dir

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(shim)
    })

    test('reuses a detection while the binary is unchanged', async () => {
      const dir = shimDir()
      await writeCountingShim(dir, '2.1.0')

      const first = await adapter.detect()
      const second = await adapter.detect()

      expect(first.version).toBe('2.1.0')
      expect(second).toEqual(first)
      expect(await probeCount(dir)).toBe(1)
    })

    test('re-probes after the binary is replaced', async () => {
      const dir = shimDir()
      const shim = await writeCountingShim(dir, '2.1.0')

      await adapter.detect()
      await writeCountingShim(dir, '2.2.0')
      await utimes(shim, new Date(), new Date(Date.now() + 5_000))

      expect((await adapter.detect()).version).toBe('2.2.0')
      expect(await probeCount(dir)).toBe(2)
    })

    test('does not cache an unknown version', async () => {
      const dir = shimDir()
      await writeCountingShim(dir, '2.1.0', 1)

      expect((await adapter.detect()).version).toBe('unknown')
      expect((await adapter.detect()).version).toBe('unknown')
      expect(await probeCount(dir)).toBe(2)
    })
  })

  describe('getTargetOutputPath', () => {
    test('returns correct path for target', () => {
      const path = adapter.getTargetOutputPath('/project/asp_modules', 'my-target')

      expect(path).toBe('/project/asp_modules/my-target/claude')
    })
  })
})
