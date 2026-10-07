/**
 * CodexAdapter.materializeSpace: a space snapshot becomes codex prompts, skills,
 * mcp config, and instructions.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaterializeInput } from '../test-support/codex-adapter-inputs.js'
import { CodexAdapter } from './codex-adapter.js'

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
  })

  describe('materializeSpace', () => {
    let tmpDir: string
    let snapshotDir: string
    let cacheDir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `codex-adapter-materialize-${Date.now()}`)
      snapshotDir = join(tmpDir, 'snapshot')
      cacheDir = join(tmpDir, 'cache')
      await mkdir(snapshotDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })

      await mkdir(join(snapshotDir, 'skills', 'alpha'), { recursive: true })
      await writeFile(join(snapshotDir, 'skills', 'alpha', 'SKILL.md'), '# Alpha')

      await mkdir(join(snapshotDir, 'commands'), { recursive: true })
      await writeFile(join(snapshotDir, 'commands', 'prompt.md'), '# Prompt')

      await mkdir(join(snapshotDir, 'mcp'), { recursive: true })
      await writeFile(
        join(snapshotDir, 'mcp', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            server: { type: 'stdio', command: 'cmd' },
          },
        })
      )

      await writeFile(join(snapshotDir, 'AGENTS.md'), 'Agents instructions')
      await writeFile(join(snapshotDir, 'AGENT.md'), 'Agent instructions')
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('materializes prompts, skills, mcp, and instructions', async () => {
      const input = createMaterializeInput(snapshotDir, {
        codex: {
          config: { 'features.web_search_request': false },
        },
      })

      const result = await adapter.materializeSpace(input, cacheDir, {
        force: true,
        useHardlinks: false,
      })

      expect(result.files).toContain('skills/alpha')
      expect(result.files).toContain('prompts/prompt.md')
      expect(result.files).toContain('mcp/mcp.json')
      expect(result.files).toContain('instructions.md')
      expect(result.files).toContain('codex.config.json')

      const instructions = await readFile(join(cacheDir, 'instructions.md'), 'utf-8')
      expect(instructions).toBe('Agents instructions')
    })

    test('skips prompts and skills when disabled', async () => {
      const input = createMaterializeInput(snapshotDir, {
        codex: {
          prompts: { enabled: false },
          skills: { enabled: false },
        },
      })

      const result = await adapter.materializeSpace(input, cacheDir, {
        force: true,
        useHardlinks: false,
      })

      expect(result.files).not.toContain('skills/alpha')
      expect(result.files).not.toContain('prompts/prompt.md')
    })
  })
})
