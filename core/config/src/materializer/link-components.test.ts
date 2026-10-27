import {
  COMPONENT_DIRS,
  INSTRUCTIONS_FILE_AGNOSTIC,
  INSTRUCTIONS_FILE_CLAUDE,
} from './link-components.js'
/**
 * Tests for link-components module.
 *
 * WHY: Component linking is how space content becomes plugin content.
 * These tests verify the instructions-file precedence for the Claude plugin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkInstructionsFile } from './link-components.js'

describe('linkInstructionsFile', () => {
  let tempDir: string
  let snapshotDir: string
  let pluginDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'asp-link-instructions-test-'))
    snapshotDir = join(tempDir, 'snapshot')
    pluginDir = join(tempDir, 'plugin')
    await mkdir(snapshotDir, { recursive: true })
    await mkdir(pluginDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('for Claude harness', () => {
    it('AGENT.md wins over a legacy CLAUDE.md when a space ships both, and a space with neither links no CLAUDE.md', async () => {
      const agentContent = '# Agent Instructions\nThis is AGENT.md'
      const claudeContent = '# Claude Instructions\nThis is CLAUDE.md'
      await writeFile(join(snapshotDir, 'AGENT.md'), agentContent)
      await writeFile(join(snapshotDir, 'CLAUDE.md'), claudeContent)

      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'claude')

      expect(result.linked).toBe(true)
      expect(result.sourceFile).toBe('AGENT.md')
      expect(result.destFile).toBe('CLAUDE.md')

      const linkedContent = await readFile(join(pluginDir, 'CLAUDE.md'), 'utf-8')
      expect(linkedContent).toBe(agentContent)

      // Row: no AGENT.md and no CLAUDE.md -> nothing linked, no CLAUDE.md in the plugin.
      const emptySnapshot = join(tempDir, 'empty-snapshot')
      const emptyPlugin = join(tempDir, 'empty-plugin')
      await mkdir(emptySnapshot, { recursive: true })
      await mkdir(emptyPlugin, { recursive: true })

      const none = await linkInstructionsFile(emptySnapshot, emptyPlugin, 'claude')

      expect(none.linked).toBe(false)
      expect(none.sourceFile).toBeUndefined()
      expect(none.destFile).toBeUndefined()
      expect(await Bun.file(join(emptyPlugin, 'CLAUDE.md')).exists()).toBe(false)
    })
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for link-components module.
   *
   * WHY: Component linking is how space content becomes plugin content.
   * These tests verify the component list and directory detection.
   */

  describe('linkInstructionsFile', () => {
    let tempDir: string
    let snapshotDir: string
    let pluginDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'asp-link-instructions-'))
      snapshotDir = join(tempDir, 'snapshot')
      pluginDir = join(tempDir, 'plugin')
      await mkdir(snapshotDir, { recursive: true })
      await mkdir(pluginDir, { recursive: true })
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    describe('for Pi harness', () => {
      it('should link AGENT.md as AGENT.md', async () => {
        const content = '# Agent Instructions\nThis is AGENT.md'
        await writeFile(join(snapshotDir, 'AGENT.md'), content)

        const result = await linkInstructionsFile(snapshotDir, pluginDir, 'pi')

        expect(result.linked).toBe(true)
        expect(result.sourceFile).toBe('AGENT.md')
        expect(result.destFile).toBe('AGENT.md')

        const linkedContent = await readFile(join(pluginDir, 'AGENT.md'), 'utf-8')
        expect(linkedContent).toBe(content)
      })

      it('should not link CLAUDE.md for Pi (Pi only uses AGENT.md)', async () => {
        const content = '# Claude Instructions\nThis is CLAUDE.md'
        await writeFile(join(snapshotDir, 'CLAUDE.md'), content)

        const result = await linkInstructionsFile(snapshotDir, pluginDir, 'pi')

        expect(result.linked).toBe(false)
        expect(result.sourceFile).toBeUndefined()
        expect(result.destFile).toBeUndefined()
      })

      it('should return not linked when no AGENT.md exists', async () => {
        const result = await linkInstructionsFile(snapshotDir, pluginDir, 'pi')

        expect(result.linked).toBe(false)
        expect(result.sourceFile).toBeUndefined()
        expect(result.destFile).toBeUndefined()
      })
    })
  })

  describe('published component names', () => {
    it('should include all expected directories', () => {
      expect(COMPONENT_DIRS).toContain('commands')
      expect(COMPONENT_DIRS).toContain('skills')
      expect(COMPONENT_DIRS).toContain('agents')
      expect(COMPONENT_DIRS).toContain('hooks')
      expect(COMPONENT_DIRS).toContain('scripts')
      expect(COMPONENT_DIRS).toContain('mcp')
    })
    it('should have correct agnostic filename', () => {
      expect(INSTRUCTIONS_FILE_AGNOSTIC).toBe('AGENT.md')
    })
    it('should have correct Claude filename', () => {
      expect(INSTRUCTIONS_FILE_CLAUDE).toBe('CLAUDE.md')
    })
  })
})
